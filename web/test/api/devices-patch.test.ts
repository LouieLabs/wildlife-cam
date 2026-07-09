import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  rtdbGet: vi.fn(),
  rtdbSet: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rtdb', () => ({ rtdbGet: m.rtdbGet, rtdbSet: m.rtdbSet }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { PATCH } from '@/app/api/devices/[deviceId]/route';

const okLimit = { allowed: true, count: 1, limit: 30, windowMs: 60_000, retryAfterMs: 0 };
const ctx = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) });
const call = (deviceId: string, body: unknown) =>
  PATCH(makeRequest({ method: 'POST', headers: { Authorization: 'Bearer x' }, body }), ctx(deviceId));

describe('PATCH /api/devices/[deviceId] (set_wifi)', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbGet.mockReset();
    m.rtdbSet.mockReset().mockResolvedValue(undefined);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('rejects unauthenticated (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await call('cam_a', { action: 'set_wifi', networkSlug: 'school-wifi' });
    expect(res.status).toBe(401);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects an unsupported action (400) before DB work', async () => {
    const res = await call('cam_a', { action: 'frobnicate' });
    expect(res.status).toBe(400);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('404 when the camera does not exist', async () => {
    m.rtdbGet.mockResolvedValueOnce(null); // device_meta/cam_a
    const res = await call('cam_a', { action: 'set_wifi', networkSlug: 'school-wifi' });
    expect(res.status).toBe(404);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('400 for an external (non-networked) camera', async () => {
    m.rtdbGet.mockResolvedValueOnce({ cameraType: 'external' });
    const res = await call('cam_a', { action: 'set_wifi', networkSlug: 'school-wifi' });
    expect(res.status).toBe(400);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('404 when the saved network is not found', async () => {
    m.rtdbGet
      .mockResolvedValueOnce({ cameraType: 'networked' }) // meta
      .mockResolvedValueOnce(null);                       // networks/slug missing
    const res = await call('cam_a', { action: 'set_wifi', networkSlug: 'nope' });
    expect(res.status).toBe(404);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('happy path: queues set_wifi (payload before verb) and updates the meta record', async () => {
    m.rtdbGet
      .mockResolvedValueOnce({ cameraType: 'networked' }) // meta
      .mockResolvedValueOnce({ slug: 'school-wifi', ssid: 'School-WiFi', password: 'pw12345678' });
    const res = await call('cam_a', { action: 'set_wifi', networkSlug: 'school-wifi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 'cam_a', command: 'set_wifi', wifiSsid: 'School-WiFi' });

    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/wifiTarget', {
      ssid: 'School-WiFi',
      pass: 'pw12345678',
      netMode: 'wifi',
    });
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/command', 'set_wifi');
    expect(m.rtdbSet).toHaveBeenCalledWith('device_meta/cam_a/wifiSsid', 'School-WiFi');
    expect(m.rtdbSet).toHaveBeenCalledWith('device_meta/cam_a/wifiPass', 'pw12345678');

    // wifiTarget must be written before the command verb.
    const targetIdx = m.rtdbSet.mock.calls.findIndex((c) => c[0] === 'devices/cam_a/wifiTarget');
    const verbIdx = m.rtdbSet.mock.calls.findIndex((c) => c[0] === 'devices/cam_a/command');
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(targetIdx).toBeLessThan(verbIdx);
  });
});
