import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';

const m = vi.hoisted(() => {
  const get = vi.fn().mockResolvedValue({ docs: [] });
  const limit = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ limit }));
  const orderBy = vi.fn(() => ({ where, limit }));
  const collection = vi.fn(() => ({ orderBy }));
  return {
    tryLouieLabsUser: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue(['https://signed.read/url']),
    collection, orderBy, where, limit, get,
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
});
