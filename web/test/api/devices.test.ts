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

import { GET } from '@/app/api/devices/route';

const okLimit = { allowed: true, count: 1, limit: 120, windowMs: 60_000, retryAfterMs: 0 };

describe('GET /api/devices', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbGet.mockReset();
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
  });

  it('rejects unauthenticated (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
    expect(m.rtdbGet).not.toHaveBeenCalled();
  });

  it('maps RTDB state + meta + secrets into the dashboard list shape', async () => {
    m.rtdbGet.mockImplementation(async (path: string) => {
      if (path === 'devices') {
        return {
          cam_a: {
            state: { status: 'online', battery: 87, updatedAt: 1700000000000, firmwareVersion: 'abc1234 (Jun 30)', secret: 'IGNORED-FROM-STATE' },
            command: 'take_picture',
          },
          cam_b: {},
        };
      }
      if (path === 'device_meta') {
        return {
          cam_a: {
            mac: 'AABBCCDDEEFF',
            netMode: 'wifi',
            wifiSsid: 'Aloha',
            wifiPass: 'Honolulu',
            halowSsid: null,
            halowPsk: null,
          },
        };
      }
      if (path === 'pre_shared_keys') {
        // Admin-visible per project decision (matches saved-networks notebook).
        // The route reads this so the dashboard can show the secret per camera.
        return { cam_a: 'CAM-A-SECRET' };
      }
      return null;
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Order isn't guaranteed (Set union); sort by deviceId for a stable assert.
    const byId = (a: any, b: any) => a.deviceId.localeCompare(b.deviceId);
    expect(body.devices.sort(byId)).toEqual([
      {
        deviceId: 'cam_a',
        status: 'online',
        battery: 87,
        lastUpdate: 1700000000000,
        firmwareVersion: 'abc1234 (Jun 30)',
        command: 'take_picture',
        mac: 'AABBCCDDEEFF',
        netMode: 'wifi',
        wifiSsid: 'Aloha',
        wifiPass: 'Honolulu',
        halowSsid: null,
        halowPsk: null,
        secret: 'CAM-A-SECRET',
      },
      {
        deviceId: 'cam_b',
        status: 'unknown',
        battery: null,
        lastUpdate: null,
        firmwareVersion: null,
        command: 'idle',
        mac: null,
        netMode: null,
        wifiSsid: null,
        wifiPass: null,
        halowSsid: null,
        halowPsk: null,
        secret: null,
      },
    ]);
    // The route reads pre_shared_keys (the authoritative secret store) and
    // ignores any 'secret' that might leak into devices/<id>/state. Guard
    // against a refactor regression that would echo state.secret instead.
    expect(JSON.stringify(body)).not.toContain('IGNORED-FROM-STATE');
  });

  it('includes registered-but-never-reported cameras (in device_meta only)', async () => {
    m.rtdbGet.mockImplementation(async (path: string) => {
      if (path === 'devices') return null;
      if (path === 'device_meta') return { fresh_cam: { mac: '112233445566', netMode: 'wifi' } };
      if (path === 'pre_shared_keys') return { fresh_cam: 'NEW-SECRET' };
      return null;
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({
      deviceId: 'fresh_cam',
      status: 'unknown',
      mac: '112233445566',
      secret: 'NEW-SECRET',
    });
  });

  it('handles an empty database (no devices yet)', async () => {
    m.rtdbGet.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [] });
  });
});
