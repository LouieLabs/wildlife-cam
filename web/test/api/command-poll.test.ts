import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireDeviceSecret: vi.fn(),
  rtdbGet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireDeviceSecret', () => ({ requireDeviceSecret: m.requireDeviceSecret }));
vi.mock('@/lib/rtdb', () => ({ rtdbGet: m.rtdbGet, rtdbSet: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { POST } from '@/app/api/command-poll/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/command-poll', () => {
  beforeEach(() => {
    m.requireDeviceSecret.mockReset().mockResolvedValue(undefined);
    m.rtdbGet.mockReset().mockResolvedValue('idle');
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('returns 429 BEFORE any auth or DB work when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a' } }));
    expect(res.status).toBe(429);
    expect(m.requireDeviceSecret).not.toHaveBeenCalled();
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('rejects when the per-device secret is wrong (401)', async () => {
    m.requireDeviceSecret.mockRejectedValueOnce(new HttpError(401, 'Unauthorized device'));
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'WRONG' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(401);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('returns the pending command on the happy path', async () => {
    m.rtdbGet.mockResolvedValueOnce('take_picture');
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'take_picture' });
    expect(m.rtdbGet).toHaveBeenCalledWith('devices/cam_a/command');
  });

  it('defaults to "idle" when the command path is missing/null', async () => {
    m.rtdbGet.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'idle' });
  });
});
