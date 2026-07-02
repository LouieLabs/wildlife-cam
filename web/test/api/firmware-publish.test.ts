import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

// Hoisted mocks -- vi.mock is lifted above the imports; refs must exist first.
const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  rtdbGet: vi.fn(),
  rtdbSet: vi.fn(),
  checkRateLimit: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
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
vi.mock('node:fs/promises', () => ({
  stat: m.stat,
  readFile: m.readFile,
}));

import { POST } from '@/app/api/firmware/publish/route';

const okLimit = { allowed: true, count: 1, limit: 10, windowMs: 60_000, retryAfterMs: 0 };

// Reusable payload -- 1 KB of zeros -> a stable SHA256 for assertion.
const FAKE_BIN = Buffer.alloc(1024, 0);
// echo -n | dd if=/dev/zero bs=1024 count=1 | shasum -a 256
const FAKE_BIN_SHA256 = '5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef';

// buildSha of the "publish" call. Not equal to FAKE_BIN_SHA256 -- server
// computes SHA256 from the file, not from the buildSha, so an operator can't
// accidentally hand-supply a wrong hash.
const VALID_BUILD_SHA = 'a1b2c3d';
const VALID_BOARD     = 'heltec-ht-hc33';

describe('POST /api/firmware/publish', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.rtdbGet.mockReset();
    m.rtdbSet.mockReset().mockResolvedValue(undefined);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.stat.mockReset().mockResolvedValue({ isFile: () => true, size: FAKE_BIN.length });
    m.readFile.mockReset().mockResolvedValue(FAKE_BIN);
  });

  const validBody = () => ({
    deviceIds: ['cam_a'],
    buildSha: VALID_BUILD_SHA,
    boardType: VALID_BOARD,
  });

  // ---- 1. Auth ------------------------------------------------------------
  it('rejects an unauthenticated caller (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'Missing sign-in token'));
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(401);
    expect(m.rtdbSet).not.toHaveBeenCalled();
    expect(m.stat).not.toHaveBeenCalled();
  });

  it('rejects a non-@louielabs signed-in user (403)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(403, 'Not a Louie Labs account'));
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(403);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  // ---- 2. Rate limit ------------------------------------------------------
  it('returns 429 when rate-limited BEFORE touching the filesystem', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 5000 });
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(429);
    expect(m.stat).not.toHaveBeenCalled();
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  // ---- 3. Body validation ------------------------------------------------
  it('rejects an empty deviceIds array (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { ...validBody(), deviceIds: [] } }));
    expect(res.status).toBe(400);
    expect(m.stat).not.toHaveBeenCalled();
  });

  it('rejects deviceIds > 50 entries (400)', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `cam_${i}`);
    const res = await POST(makeRequest({ method: 'POST', body: { ...validBody(), deviceIds: many } }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed device ID inside deviceIds (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { ...validBody(), deviceIds: ['cam_a', '??'] } }));
    expect(res.status).toBe(400);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects an invalid buildSha (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { ...validBody(), buildSha: 'zzz' } }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid boardType (400)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { ...validBody(), boardType: 'Not_A_Board!' } }));
    expect(res.status).toBe(400);
  });

  // ---- 4. Build-exists check ---------------------------------------------
  it('returns 404 when the .bin does not exist on disk', async () => {
    m.stat.mockRejectedValueOnce(new Error('ENOENT'));
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.error).toMatch(new RegExp(VALID_BUILD_SHA));
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('returns 500 when the file exists but is empty', async () => {
    m.stat.mockResolvedValueOnce({ isFile: () => true, size: 0 });
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(500);
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  // ---- 5. Server-side SHA256 ---------------------------------------------
  it('computes SHA256 server-side and echoes it in the response + otaTarget', async () => {
    m.rtdbGet.mockResolvedValueOnce(VALID_BOARD);   // state/boardType
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sha256).toBe(FAKE_BIN_SHA256);
    expect(body.published).toEqual(['cam_a']);
    expect(m.rtdbSet).toHaveBeenCalledWith(
      'devices/cam_a/otaTarget',
      expect.objectContaining({
        sha256: FAKE_BIN_SHA256,
        boardType: VALID_BOARD,
        version: VALID_BUILD_SHA,
        sizeBytes: FAKE_BIN.length,
      }),
    );
  });

  // ---- 6. Board-type gate + per-device atomic ----------------------------
  it('rejects a device whose state.boardType is NOT set', async () => {
    m.rtdbGet.mockResolvedValueOnce(null);   // camera hasn't reported yet
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toEqual([]);
    expect(body.errors).toEqual([
      { deviceId: 'cam_a', reason: expect.stringMatching(/boardType/) },
    ]);
    expect(m.rtdbSet).not.toHaveBeenCalled();   // never wrote otaTarget for the mismatched camera
  });

  it('rejects a device whose state.boardType != body.boardType (guaranteed-brick guard)', async () => {
    m.rtdbGet.mockResolvedValueOnce('lilygo-t-halow-p4');
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toEqual([]);
    expect(body.errors[0].reason).toMatch(/lilygo-t-halow-p4/);
    expect(body.errors[0].reason).toMatch(new RegExp(VALID_BOARD));
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('publishes mixed: one matches, one board-mismatches, one unregistered', async () => {
    m.rtdbGet
      .mockResolvedValueOnce(VALID_BOARD)       // cam_ok
      .mockResolvedValueOnce('lilygo-t-halow-p4') // cam_wrong_board
      .mockResolvedValueOnce(null);              // cam_missing

    const res = await POST(makeRequest({
      method: 'POST',
      body: { ...validBody(), deviceIds: ['cam_ok', 'cam_wrong_board', 'cam_missing'] },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toEqual(['cam_ok']);
    expect(body.errors.map((e: { deviceId: string }) => e.deviceId).sort()).toEqual(
      ['cam_missing', 'cam_wrong_board'],
    );
    // Only the good device gets otaTarget + command writes.
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_ok/otaTarget', expect.any(Object));
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_ok/command', 'update_firmware');
    expect(m.rtdbSet).toHaveBeenCalledTimes(2);
  });

  // ---- 7. Payload fields land in RTDB (contract with Slice A firmware) ---
  it('the otaTarget it writes has every field Slice A firmware expects', async () => {
    m.rtdbGet.mockResolvedValueOnce(VALID_BOARD);
    const res = await POST(makeRequest({ method: 'POST', body: validBody() }));
    expect(res.status).toBe(200);
    const setCall = m.rtdbSet.mock.calls.find((c) => c[0] === 'devices/cam_a/otaTarget');
    expect(setCall).toBeDefined();
    const target = setCall![1] as Record<string, unknown>;
    // Field-by-field so an accidental rename in the source breaks a specific
    // test line, not the whole snapshot.
    expect(target.url).toMatch(new RegExp(`/firmware/builds/${VALID_BOARD}/${VALID_BUILD_SHA}/firmware\\.bin$`));
    expect(target.sha256).toBe(FAKE_BIN_SHA256);
    expect(target.sizeBytes).toBe(FAKE_BIN.length);
    expect(target.version).toBe(VALID_BUILD_SHA);
    expect(target.boardType).toBe(VALID_BOARD);
    expect(target.expectedSeconds).toBeGreaterThanOrEqual(10);
    expect(target.minBytesPerSec).toBe(20_000);
    expect(target.maxSeconds).toBeLessThanOrEqual(120);
  });
});
