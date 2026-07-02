import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

// Mocks must be created via vi.hoisted -- vi.mock is hoisted above all imports.
const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  rtdbSet: vi.fn().mockResolvedValue(undefined),
  generateDeviceSecret: vi.fn().mockReturnValue('ABC-DEF-1234'),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1, limit: 10, windowMs: 60_000, retryAfterMs: 0 }),
}));

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rtdb', () => ({ rtdbSet: m.rtdbSet, rtdbGet: vi.fn() }));
vi.mock('@/lib/secret', () => ({ generateDeviceSecret: m.generateDeviceSecret }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));

import { POST } from '@/app/api/register-device/route';

describe('POST /api/register-device', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbSet.mockClear();
    m.generateDeviceSecret.mockClear().mockReturnValue('ABC-DEF-1234');
    m.checkRateLimit.mockClear().mockResolvedValue({ allowed: true, count: 1, limit: 10, windowMs: 60_000, retryAfterMs: 0 });
  });

  it('rejects an unauthenticated caller (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'Missing sign-in token'));
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam1', mac: 'AABBCCDDEEFF' } }));
    expect(res.status).toBe(401);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('returns 429 when the rate limit is exceeded', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 11, limit: 10, windowMs: 60_000, retryAfterMs: 30_000 });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam1', mac: 'AABBCCDDEEFF' } }));
    expect(res.status).toBe(429);
    expect(m.generateDeviceSecret).not.toHaveBeenCalled();
  });

  it('rejects a malformed deviceId (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'X', mac: 'AABBCCDDEEFF' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/device id/i);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects a malformed MAC (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam1', mac: 'no-mac' } }));
    expect(res.status).toBe(400);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('mints + stores a secret on the happy path and returns it (no cameraKey)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam1', mac: 'aa:bb:cc:dd:ee:ff' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ deviceId: 'cam1', mac: 'AABBCCDDEEFF', secret: 'ABC-DEF-1234', cameraType: 'networked' });
    // GUARD: a regression that resurrects the fleet-wide camera key would re-add this field.
    expect(body).not.toHaveProperty('cameraKey');
    // Wrote to all three expected paths.
    expect(m.rtdbSet).toHaveBeenCalledWith('pre_shared_keys/cam1', 'ABC-DEF-1234');
    expect(m.rtdbSet).toHaveBeenCalledWith(
      'device_meta/cam1',
      expect.objectContaining({ mac: 'AABBCCDDEEFF', cameraType: 'networked', registeredBy: FAKE_USER.email })
    );
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam1/command', 'idle');
  });

  it('rejects an invalid cameraType (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam1', mac: 'AABBCCDDEEFF', cameraType: 'garbage' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cameratype/i);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('external camera: no MAC required, no secret minted, no pre_shared_keys or command written', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      body: {
        deviceId: 'WPS-1',
        mac: '',
        cameraType: 'external',
        manufacturer: 'UOVision/WPS',
        model: 'Home Guard W5 L5P-W',
        nightMode: 'infrared',
        deployment: 'multiple spots in LL backyard',
      },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ deviceId: 'WPS-1', mac: null, secret: null, cameraType: 'external' });
    // No secret minted for external cams.
    expect(m.generateDeviceSecret).not.toHaveBeenCalled();
    // No pre_shared_keys entry.
    expect(m.rtdbSet).not.toHaveBeenCalledWith('pre_shared_keys/WPS-1', expect.anything());
    // No command seed (external cams don't poll).
    expect(m.rtdbSet).not.toHaveBeenCalledWith('devices/WPS-1/command', expect.anything());
    // device_meta captures the trail-cam identity + type.
    expect(m.rtdbSet).toHaveBeenCalledWith(
      'device_meta/WPS-1',
      expect.objectContaining({
        mac: null,
        cameraType: 'external',
        manufacturer: 'UOVision/WPS',
        model: 'Home Guard W5 L5P-W',
        nightMode: 'infrared',
        deployment: 'multiple spots in LL backyard',
        registeredBy: FAKE_USER.email,
      })
    );
  });

  it('external camera: rejects a partial MAC (400)', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      body: { deviceId: 'WPS-1', mac: 'AABB', cameraType: 'external' },
    }));
    expect(res.status).toBe(400);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('external camera: accepts a valid MAC when provided (12 hex)', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      body: { deviceId: 'WPS-1', mac: 'AABBCCDDEEFF', cameraType: 'external' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ deviceId: 'WPS-1', mac: 'AABBCCDDEEFF', secret: null, cameraType: 'external' });
    expect(m.rtdbSet).toHaveBeenCalledWith(
      'device_meta/WPS-1',
      expect.objectContaining({ mac: 'AABBCCDDEEFF', cameraType: 'external' })
    );
  });
});
