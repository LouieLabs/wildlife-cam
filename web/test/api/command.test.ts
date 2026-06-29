import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  rtdbSet: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rtdb', () => ({ rtdbSet: m.rtdbSet, rtdbGet: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { POST } from '@/app/api/command/route';

const okLimit = { allowed: true, count: 1, limit: 30, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/command', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbSet.mockClear();
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('rejects unauthenticated (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', action: 'take_picture' } }));
    expect(res.status).toBe(401);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 5000 });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', action: 'take_picture' } }));
    expect(res.status).toBe(429);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects malformed deviceId (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: '??', action: 'take_picture' } }));
    expect(res.status).toBe(400);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects unknown action -- enforces the allow-list', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', action: 'rm -rf /' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/take_picture/);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it.each(['take_picture', 'reboot', 'idle'])('writes the command for allowed action %s', async (action) => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', action } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: action });
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/command', action);
  });
});
