import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the rtdb module BEFORE importing the SUT, so its `import { rtdbGet }`
// resolves to our spy. vi.mock is hoisted ABOVE all imports, so the spy has to
// be created with vi.hoisted() to exist when the mock factory runs.
const { mockRtdbGet } = vi.hoisted(() => ({ mockRtdbGet: vi.fn() }));
vi.mock('@/lib/rtdb', () => ({
  rtdbGet: mockRtdbGet,
}));

import { requireDeviceSecret } from '@/lib/requireDeviceSecret';
import { HttpError } from '@/lib/requireLouieLabsUser';

// Tiny helper to build a fetch Request with the auth header set.
function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test', { headers });
}

describe('requireDeviceSecret', () => {
  beforeEach(() => {
    mockRtdbGet.mockReset();
  });

  it('rejects a malformed deviceId BEFORE touching the database', async () => {
    // Bad shape should fail fast -- no RTDB call, no timing-side-channel info.
    await expect(requireDeviceSecret(req({ 'x-device-secret': 'whatever' }), 'BAD ID!'))
      .rejects.toMatchObject({ status: 400, message: 'Invalid device ID' });
    expect(mockRtdbGet).not.toHaveBeenCalled();
  });

  it('rejects when the x-device-secret header is missing', async () => {
    await expect(requireDeviceSecret(req(), 'pond_cam_01'))
      .rejects.toMatchObject({ status: 401, message: 'Missing device secret' });
    expect(mockRtdbGet).not.toHaveBeenCalled();
  });

  it('rejects an unknown device (no entry in /pre_shared_keys)', async () => {
    mockRtdbGet.mockResolvedValueOnce(null);
    await expect(
      requireDeviceSecret(req({ 'x-device-secret': 'ABC-123-4567' }), 'ghost_cam')
    ).rejects.toMatchObject({ status: 401, message: 'Unauthorized device' });
    expect(mockRtdbGet).toHaveBeenCalledWith('pre_shared_keys/ghost_cam');
  });

  it('rejects when the presented secret does not match the stored one', async () => {
    mockRtdbGet.mockResolvedValueOnce('REAL-SEC-RET0');
    await expect(
      requireDeviceSecret(req({ 'x-device-secret': 'WRONG-WRONG' }), 'pond_cam_01')
    ).rejects.toMatchObject({ status: 401, message: 'Unauthorized device' });
  });

  it('resolves when the presented secret matches', async () => {
    mockRtdbGet.mockResolvedValueOnce('MATCHING-SECRET');
    await expect(
      requireDeviceSecret(req({ 'x-device-secret': 'MATCHING-SECRET' }), 'pond_cam_01')
    ).resolves.toBeUndefined();
  });

  it('throws HttpError instances (so routes can catch by type)', async () => {
    mockRtdbGet.mockResolvedValueOnce(null);
    try {
      await requireDeviceSecret(req({ 'x-device-secret': 'x' }), 'pond_cam_01');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
    }
  });
});
