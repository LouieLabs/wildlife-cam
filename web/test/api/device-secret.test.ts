import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  rtdbGet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rtdb', () => ({ rtdbGet: m.rtdbGet, rtdbSet: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { GET } from '@/app/api/device-secret/route';

const okLimit = { allowed: true, count: 1, limit: 30, windowMs: 60_000, retryAfterMs: 0 };

describe('GET /api/device-secret', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbGet.mockReset();
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('rejects unauthenticated (401) -- secrets must NEVER leak to the public', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await GET(makeRequest({ url: 'http://x/api/device-secret?deviceId=cam_a' }));
    expect(res.status).toBe(401);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 5000 });
    const res = await GET(makeRequest({ url: 'http://x/api/device-secret?deviceId=cam_a' }));
    expect(res.status).toBe(429);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('rejects malformed deviceId (400) without touching RTDB', async () => {
    const res = await GET(makeRequest({ url: 'http://x/api/device-secret?deviceId=BAD%21' }));
    expect(res.status).toBe(400);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('returns 404 when the device is unknown', async () => {
    m.rtdbGet.mockResolvedValue(null);
    const res = await GET(makeRequest({ url: 'http://x/api/device-secret?deviceId=ghost' }));
    expect(res.status).toBe(404);
  });

  it('returns the secret for a known device', async () => {
    m.rtdbGet.mockResolvedValue('XYZ-123-ABCD');
    const res = await GET(makeRequest({ url: 'http://x/api/device-secret?deviceId=cam_a' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', secret: 'XYZ-123-ABCD' });
    expect(m.rtdbGet).toHaveBeenCalledWith('pre_shared_keys/cam_a');
  });
});
