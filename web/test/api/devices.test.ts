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

  it('maps RTDB state + meta into the dashboard list shape', async () => {
    m.rtdbGet.mockImplementation(async (path: string) => {
      if (path === 'devices') {
        return {
          cam_a: {
            state: { status: 'online', battery: 87, updatedAt: 1700000000000, secret: 'SHOULD-NOT-LEAK' },
            command: 'take_picture',
          },
          cam_b: {},
        };
      }
      if (path === 'device_meta') {
        return { cam_a: { mac: 'AABBCCDDEEFF' } };
      }
      return null;
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toEqual([
      { deviceId: 'cam_a', status: 'online', battery: 87, lastUpdate: 1700000000000, command: 'take_picture', mac: 'AABBCCDDEEFF' },
      { deviceId: 'cam_b', status: 'unknown', battery: null, lastUpdate: null, command: 'idle', mac: null },
    ]);
    // CRITICAL guard: per-device secret must never reach the client. If a refactor
    // ever leaks state.secret into the response, this assertion fails.
    expect(JSON.stringify(body)).not.toContain('SHOULD-NOT-LEAK');
  });

  it('handles an empty database (no devices yet)', async () => {
    m.rtdbGet.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [] });
  });
});
