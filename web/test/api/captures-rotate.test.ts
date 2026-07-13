import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => {
  const update = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue({ exists: true });
  const doc = vi.fn(() => ({ get, update }));
  const collection = vi.fn(() => ({ doc }));
  return {
    requireLouieLabsUser: vi.fn(),
    checkRateLimit: vi.fn(),
    collection, doc, get, update,
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
  adminFirestore: { collection: m.collection },
}));

import { PATCH } from '@/app/api/captures/[id]/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('PATCH /api/captures/[id] (save display rotation)', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.get.mockReset().mockResolvedValue({ exists: true });
    m.update.mockReset().mockResolvedValue(undefined);
  });

  it('rejects unauthenticated (401) without touching Firestore', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await PATCH(
      makeRequest({ method: 'POST', body: { rotation: 90 } }),
      ctx('abc123')
    );
    expect(res.status).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('rejects a rotation that is not one of the four right angles', async () => {
    const res = await PATCH(
      makeRequest({ method: 'POST', body: { rotation: 45 } }),
      ctx('abc123')
    );
    expect(res.status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed capture id', async () => {
    const res = await PATCH(
      makeRequest({ method: 'POST', body: { rotation: 90 } }),
      ctx('not/a/valid/id')
    );
    expect(res.status).toBe(400);
  });

  it('404s when the capture does not exist', async () => {
    m.get.mockResolvedValueOnce({ exists: false });
    const res = await PATCH(
      makeRequest({ method: 'POST', body: { rotation: 90 } }),
      ctx('missing1')
    );
    expect(res.status).toBe(404);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('saves the rotation with an audit trail on the happy path', async () => {
    const res = await PATCH(
      makeRequest({ method: 'POST', body: { rotation: 270 } }),
      ctx('abc123')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'abc123', rotation: 270 });
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ rotation: 270, rotatedBy: FAKE_USER.email })
    );
  });

  it('accepts rotation 0 (reset to upright)', async () => {
    const res = await PATCH(
      makeRequest({ method: 'POST', body: { rotation: 0 } }),
      ctx('abc123')
    );
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ rotation: 0 }));
  });
});
