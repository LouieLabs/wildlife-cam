import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireDeviceSecret: vi.fn(),
  rtdbGet: vi.fn(),
  rtdbSet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireDeviceSecret', () => ({ requireDeviceSecret: m.requireDeviceSecret }));
vi.mock('@/lib/rtdb', () => ({ rtdbGet: m.rtdbGet, rtdbSet: m.rtdbSet }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { POST } from '@/app/api/command-ack/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/command-ack', () => {
  beforeEach(() => {
    m.requireDeviceSecret.mockReset().mockResolvedValue(undefined);
    m.rtdbGet.mockReset().mockResolvedValue('idle');
    m.rtdbSet.mockReset().mockResolvedValue(undefined);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('returns 429 BEFORE any auth/DB work when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a' } }));
    expect(res.status).toBe(429);
    expect(m.requireDeviceSecret).not.toHaveBeenCalled();
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects a wrong device secret (401) and writes nothing', async () => {
    m.requireDeviceSecret.mockRejectedValueOnce(new HttpError(401, 'bad secret'));
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'WRONG' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(401);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('set_wifi ack clears the command and drops the wifiTarget', async () => {
    m.rtdbGet.mockResolvedValueOnce('set_wifi'); // devices/cam_a/command
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'idle' });
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/command', 'idle');
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/wifiTarget', null);
    // The old registration must NOT be deleted on a wifi ack.
    expect(m.rtdbSet).not.toHaveBeenCalledWith('pre_shared_keys/cam_a', null);
  });

  it('set_id ack finalizes the rename by deleting ONLY the old registration', async () => {
    m.rtdbGet
      .mockResolvedValueOnce('set_id')            // devices/cam_a/command
      .mockResolvedValueOnce({ newId: 'cam_b' }); // devices/cam_a/idTarget
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ finalized: 'cam_b', removedOldId: 'cam_a' });
    expect(m.rtdbSet).toHaveBeenCalledWith('pre_shared_keys/cam_a', null);
    expect(m.rtdbSet).toHaveBeenCalledWith('device_meta/cam_a', null);
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a', null);
    // Never touches the NEW id, and never just idles the (being-deleted) old command.
    expect(m.rtdbSet).not.toHaveBeenCalledWith('devices/cam_a/command', 'idle');
    expect(m.rtdbSet).not.toHaveBeenCalledWith('pre_shared_keys/cam_b', null);
  });

  it('a plain idle ack only resets the command (no deletion)', async () => {
    m.rtdbGet.mockResolvedValueOnce('idle');
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-device-secret': 'RIGHT' },
      body: { deviceId: 'cam_a' },
    }));
    expect(res.status).toBe(200);
    expect(m.rtdbSet).not.toHaveBeenCalledWith('pre_shared_keys/cam_a', null);
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/command', 'idle');
  });
});
