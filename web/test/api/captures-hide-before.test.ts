import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => {
  const get = vi.fn().mockResolvedValue({ docs: [] });
  const limit = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ limit }));
  const collection = vi.fn(() => ({ where }));
  const batchUpdate = vi.fn();
  const batchCommit = vi.fn().mockResolvedValue(undefined);
  const batch = vi.fn(() => ({ update: batchUpdate, commit: batchCommit }));
  return {
    requireLouieLabsUser: vi.fn(),
    checkRateLimit: vi.fn(),
    collection, where, limit, get, batch, batchUpdate, batchCommit,
  };
});

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { collection: m.collection, batch: m.batch },
}));

import { POST } from '@/app/api/captures/hide-before/route';

const okLimit = { allowed: true, count: 1, limit: 5, windowMs: 60_000, retryAfterMs: 0 };
const fdoc = (id: string, hidden = false) => ({ ref: { id }, data: () => ({ hidden }) });

describe('POST /api/captures/hide-before (launch-day curation sweep)', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.get.mockReset().mockResolvedValue({ docs: [] });
    m.where.mockClear();
    m.batch.mockClear();
    m.batchUpdate.mockClear();
    m.batchCommit.mockClear();
  });

  it('rejects unauthenticated callers (401) without querying', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await POST(makeRequest({ method: 'POST', body: { before: 1000 } }));
    expect(res.status).toBe(401);
    expect(m.get).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid before timestamp', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { before: 'yesterday' } }));
    expect(res.status).toBe(400);
    expect(m.get).not.toHaveBeenCalled();
  });

  it('hides everything older than the cutoff, skipping already-hidden docs', async () => {
    m.get.mockResolvedValueOnce({ docs: [fdoc('a'), fdoc('b'), fdoc('c', true)] });
    const res = await POST(makeRequest({ method: 'POST', body: { before: 1_700_000_000_000 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hidden: 2, alreadyHidden: 1 });
    expect(m.where).toHaveBeenCalledWith('capturedAt', '<', 1_700_000_000_000);
    expect(m.batchUpdate).toHaveBeenCalledTimes(2);   // c was already hidden
    expect(m.batchUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hidden: true, hiddenBy: FAKE_USER.email })
    );
    expect(m.batchCommit).toHaveBeenCalledTimes(1);
  });

  it('is a cheap no-op when everything is already hidden', async () => {
    m.get.mockResolvedValueOnce({ docs: [fdoc('a', true), fdoc('b', true)] });
    const res = await POST(makeRequest({ method: 'POST', body: { before: 1_700_000_000_000 } }));
    expect(await res.json()).toEqual({ hidden: 0, alreadyHidden: 2 });
    expect(m.batchCommit).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 9000 });
    const res = await POST(makeRequest({ method: 'POST', body: { before: 1000 } }));
    expect(res.status).toBe(429);
    expect(m.get).not.toHaveBeenCalled();
  });
});
