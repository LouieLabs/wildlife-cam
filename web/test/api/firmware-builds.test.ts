import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  checkRateLimit: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('node:fs/promises', () => ({ readdir: m.readdir, stat: m.stat }));

import { GET } from '@/app/api/firmware/builds/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

// Helper: build a stat-like object with the fields the route uses.
const asBin = (size: number, mtimeMs: number) => ({
  isFile: () => true,
  size,
  mtimeMs,
});

describe('GET /api/firmware/builds', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.readdir.mockReset();
    m.stat.mockReset();
  });

  it('rejects unauthenticated (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(m.readdir).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited BEFORE touching the filesystem', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
    expect(m.readdir).not.toHaveBeenCalled();
  });

  it('returns builds: [] gracefully when the builds/ directory does not exist', async () => {
    // Fresh install / no Cloud Build has fired yet: the top-level readdir
    // throws. Route swallows and returns [] rather than 500.
    m.readdir.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builds: [] });
  });

  it('lists builds across board types, newest mtime first', async () => {
    // readdir sequence: buildsRoot, boardA-dir, boardB-dir
    m.readdir
      .mockResolvedValueOnce(['heltec-ht-hc33', 'lilygo-t-halow-p4'])
      .mockResolvedValueOnce(['a1b2c3d', 'deadbee'])      // heltec-ht-hc33/
      .mockResolvedValueOnce(['ff00aa1']);                // lilygo-t-halow-p4/
    // stat: three firmware.bin files
    m.stat
      .mockResolvedValueOnce(asBin(1100000, 1_700_000_000_000))   // heltec/a1b2c3d
      .mockResolvedValueOnce(asBin(1150000, 1_700_000_100_000))   // heltec/deadbee (newest of heltec)
      .mockResolvedValueOnce(asBin(1200000, 1_700_000_200_000));  // lilygo/ff00aa1 (newest overall)

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.builds).toEqual([
      { boardType: 'lilygo-t-halow-p4', sha: 'ff00aa1', sizeBytes: 1200000, mtime: 1_700_000_200_000 },
      { boardType: 'heltec-ht-hc33',    sha: 'deadbee', sizeBytes: 1150000, mtime: 1_700_000_100_000 },
      { boardType: 'heltec-ht-hc33',    sha: 'a1b2c3d', sizeBytes: 1100000, mtime: 1_700_000_000_000 },
    ]);
  });

  it('skips directory entries whose names do not match the boardType or sha convention', async () => {
    // Adversarial: someone drops a random file into public/firmware/builds/.
    // We only accept lowercase kebab boardType names and lowercase hex SHA names.
    m.readdir
      .mockResolvedValueOnce(['heltec-ht-hc33', 'INVALID_BOARD!', '.DS_Store'])
      .mockResolvedValueOnce(['a1b2c3d', 'not-a-sha', 'UPPERCASE'])
      .mockResolvedValueOnce([])   // INVALID_BOARD! -- unreachable, but readdir may be called
      .mockResolvedValueOnce([]);
    m.stat.mockResolvedValueOnce(asBin(1000, 1_700_000_000_000));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the one legitimate boardType/sha combination should appear.
    expect(body.builds).toEqual([
      { boardType: 'heltec-ht-hc33', sha: 'a1b2c3d', sizeBytes: 1000, mtime: 1_700_000_000_000 },
    ]);
  });

  it('skips sha dirs whose firmware.bin is missing (build failed halfway)', async () => {
    m.readdir
      .mockResolvedValueOnce(['heltec-ht-hc33'])
      .mockResolvedValueOnce(['abc1234', 'badbeef']);
    m.stat
      .mockResolvedValueOnce(asBin(1000, 1_700_000_000_000))
      .mockRejectedValueOnce(new Error('ENOENT: firmware.bin missing'));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.builds).toHaveLength(1);
    expect(body.builds[0].sha).toBe('abc1234');
  });

  it('skips zero-byte firmware.bin (partial write / disk full)', async () => {
    m.readdir
      .mockResolvedValueOnce(['heltec-ht-hc33'])
      .mockResolvedValueOnce(['a1b2c3d']);
    m.stat.mockResolvedValueOnce(asBin(0, 1_700_000_000_000));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builds: [] });
  });
});
