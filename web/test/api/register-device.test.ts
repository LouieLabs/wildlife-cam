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
    expect(body).toMatchObject({ deviceId: 'cam1', mac: 'AABBCCDDEEFF', secret: 'ABC-DEF-1234' });
    // GUARD: a regression that resurrects the fleet-wide camera key would re-add this field.
    expect(body).not.toHaveProperty('cameraKey');
    // Wrote to all three expected paths.
    expect(m.rtdbSet).toHaveBeenCalledWith('pre_shared_keys/cam1', 'ABC-DEF-1234');
    expect(m.rtdbSet).toHaveBeenCalledWith('device_meta/cam1', expect.objectContaining({ mac: 'AABBCCDDEEFF', registeredBy: FAKE_USER.email }));
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam1/command', 'idle');
  });
});
