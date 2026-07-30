import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';

const m = vi.hoisted(() => {
  const get = vi.fn().mockResolvedValue({ docs: [] });
  const limit = vi.fn(() => ({ get }));
  const startAfter = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, startAfter }));
  const orderBy = vi.fn(() => ({ where, limit, startAfter }));
  const collection = vi.fn(() => ({ orderBy }));
  return {
    tryLouieLabsUser: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue(['https://signed.read/url']),
    collection, orderBy, where, limit, startAfter, get,
  };
});

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, tryLouieLabsUser: m.tryLouieLabsUser };
});
vi.mock('@/lib/appEnv', () => ({ APP_ENV: 'dev' }));
vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { collection: m.collection },
}));
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket() { return { file: () => ({ getSignedUrl: m.getSignedUrl }) }; }
  }
  return { Storage };
});

import { GET } from '@/app/api/captures/route';

// A minimal analyzed+public capture doc as capture-complete + the AI write it.
function doc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    data: () => ({
      deviceId: 'cam_a',
      env: 'dev',
      objectPath: `dev/uploads/${id}.jpg`,
      capturedAt: 1_700_000_000_000,
      analyzed: true,
      public: true,
      detections: [],
      ...over,
    }),
  };
}

describe('GET /api/captures', () => {
  beforeEach(() => {
    m.tryLouieLabsUser.mockReset().mockResolvedValue(null); // anonymous by default
    m.get.mockReset().mockResolvedValue({ docs: [] });
    m.where.mockClear();
    m.orderBy.mockClear();
    m.startAfter.mockClear();
    m.getSignedUrl.mockReset().mockResolvedValue(['https://signed.read/url']);
  });

  it('passes a saved rotation through to the card, defaulting to 0', async () => {
    m.get.mockResolvedValueOnce({
      docs: [doc('r1', { rotation: 90 }), doc('r2'), doc('r3', { rotation: 45 })],
    });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    expect(res.status).toBe(200);
    const cards = await res.json();
    expect(cards.map((c: any) => c.rotation)).toEqual([90, 0, 0]); // 45 is not a right angle -> 0
  });

  it('anonymous visitors only see public captures', async () => {
    m.get.mockResolvedValueOnce({
      docs: [doc('pub1'), doc('priv1', { public: false })],
    });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    const cards = await res.json();
    expect(cards.map((c: any) => c.id)).toEqual(['pub1']);
  });

  it('a `before` cursor becomes a real range on the Firestore query (epoch ms)', async () => {
    m.get.mockResolvedValueOnce({ docs: [doc('old1', { capturedAt: 1_600_000_000_000 })] });
    const res = await GET(
      makeRequest({ url: 'http://localhost/api/captures?before=1650000000000' })
    );
    expect(res.status).toBe(200);
    expect(m.where).toHaveBeenCalledWith('capturedAt', '<', 1_650_000_000_000);
    const cards = await res.json();
    expect(cards.map((c: any) => c.id)).toEqual(['old1']);
  });

  it('accepts an ISO string as the `before` cursor', async () => {
    m.get.mockResolvedValueOnce({ docs: [] });
    await GET(makeRequest({ url: 'http://localhost/api/captures?before=2023-01-01T00:00:00.000Z' }));
    expect(m.where).toHaveBeenCalledWith('capturedAt', '<', Date.parse('2023-01-01T00:00:00.000Z'));
  });

  it('no cursor -> no range filter (plain newest-first query)', async () => {
    m.get.mockResolvedValueOnce({ docs: [] });
    await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    expect(m.where).not.toHaveBeenCalled();
  });

  it('an unparseable cursor is ignored instead of erroring', async () => {
    m.get.mockResolvedValueOnce({ docs: [doc('x1')] });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures?before=banana' }));
    expect(res.status).toBe(200);
    expect(m.where).not.toHaveBeenCalled();
  });

  it('signed-in users see private captures too', async () => {
    m.tryLouieLabsUser.mockResolvedValueOnce(FAKE_USER);
    m.get.mockResolvedValueOnce({
      docs: [doc('pub1'), doc('priv1', { public: false })],
    });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    const cards = await res.json();
    expect(cards.map((c: any) => c.id)).toEqual(['pub1', 'priv1']);
  });

  it('anonymous visitors never see hidden captures', async () => {
    m.get.mockResolvedValueOnce({
      docs: [doc('shown1'), doc('hid1', { hidden: true })],
    });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    const cards = await res.json();
    expect(cards.map((c: any) => c.id)).toEqual(['shown1']);
  });

  it('signed-in users see hidden captures, flagged', async () => {
    m.tryLouieLabsUser.mockResolvedValueOnce(FAKE_USER);
    m.get.mockResolvedValueOnce({
      docs: [doc('shown1'), doc('hid1', { hidden: true })],
    });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    const cards = await res.json();
    expect(cards.map((c: any) => [c.id, c.hidden])).toEqual([['shown1', false], ['hid1', true]]);
  });

  // ── Backlog eviction ───────────────────────────────────────────────────────
  // Regression guard for the 2026-07-29 blackout: pending captures are the
  // NEWEST docs, so a burst of them filled a flat 200-doc window and pushed
  // every analyzed photo out of view. The gallery reported "no photos" while
  // 172 sat one page further back.
  const pageOf = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => doc(`d${i}`, over));

  it('pages past a full window of unanalyzed captures instead of reporting none', async () => {
    m.get
      .mockResolvedValueOnce({ docs: pageOf(200, { analyzed: false }) })
      .mockResolvedValueOnce({ docs: [doc('good1'), doc('good2')] });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    expect(res.status).toBe(200);
    const cards = await res.json();
    expect(cards.map((c: any) => c.id)).toEqual(['good1', 'good2']);
    expect(m.startAfter).toHaveBeenCalled(); // it really did page, not re-query
  });

  it('one page is enough in normal operation — no extra reads', async () => {
    m.get.mockResolvedValue({ docs: pageOf(200) });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures?limit=50' }));
    const cards = await res.json();
    expect(cards).toHaveLength(50);
    expect(m.get).toHaveBeenCalledTimes(1);
  });

  it('stops at the scan cap rather than paging forever', async () => {
    m.get.mockResolvedValue({ docs: pageOf(200, { analyzed: false }) });
    const res = await GET(makeRequest({ url: 'http://localhost/api/captures' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(m.get).toHaveBeenCalledTimes(10); // MAX_SCAN_DOCS 2000 / SCAN_PAGE 200
  });

  it('keeps the `before` range on every page it scans', async () => {
    m.get
      .mockResolvedValueOnce({ docs: pageOf(200, { analyzed: false }) })
      .mockResolvedValueOnce({ docs: [doc('old1', { capturedAt: 1_600_000_000_000 })] });
    await GET(makeRequest({ url: 'http://localhost/api/captures?before=1650000000000' }));
    expect(m.where).toHaveBeenCalledTimes(2);
    expect(m.where).toHaveBeenLastCalledWith('capturedAt', '<', 1_650_000_000_000);
  });
});
