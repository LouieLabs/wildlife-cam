import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireDeviceSecret: vi.fn(),
  checkRateLimit: vi.fn(),
  getSignedUrl: vi.fn().mockResolvedValue(['https://signed.example/upload?sig=abc']),
}));

vi.mock('@/lib/requireDeviceSecret', () => ({ requireDeviceSecret: m.requireDeviceSecret }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/appEnv', () => ({ APP_ENV: 'dev' }));
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket() { return { file: () => ({ getSignedUrl: m.getSignedUrl }) }; }
  }
  return { Storage };
});

import { POST } from '@/app/api/get-upload-url/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/get-upload-url', () => {
  beforeEach(() => {
    m.requireDeviceSecret.mockReset().mockResolvedValue(undefined);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.getSignedUrl.mockClear().mockResolvedValue(['https://signed.example/upload?sig=abc']);
  });

  it('returns 429 BEFORE any auth or signing work when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a' } }));
    expect(res.status).toBe(429);
    expect(m.requireDeviceSecret).not.toHaveBeenCalled();
    expect(m.getSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects when the per-device secret is wrong (401)', async () => {
    m.requireDeviceSecret.mockRejectedValueOnce(new HttpError(401, 'Unauthorized device'));
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a' } }));
    expect(res.status).toBe(401);
    expect(m.getSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects bad deviceId via the auth helper (400)', async () => {
    m.requireDeviceSecret.mockRejectedValueOnce(new HttpError(400, 'Invalid device ID'));
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'BAD!' } }));
    expect(res.status).toBe(400);
  });

  it('returns a signed URL with env-tagged objectName on happy path', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: {
      deviceId: 'cam_a',
      wakeReason: 'PIR',
      capturedAt: Date.UTC(2026, 5, 30, 2, 10, 26), // 2026-06-30 02:10:26 UTC
    } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadUrl).toBe('https://signed.example/upload?sig=abc');
    // Path MUST start with the APP_ENV prefix so npm run clean:dev can scope deletes.
    // Descriptive name: <id>_YYMMDD-HHMMSS_REASON.jpg in UTC.
    expect(body.objectName).toBe('dev/uploads/cam_a/cam_a_260630-021026_PIR.jpg');
    expect(body.expiresInSeconds).toBe(300);
  });

  it('clamps an unknown wakeReason to UNKNOWN', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: {
      deviceId: 'cam_a',
      wakeReason: 'NONSENSE',
      capturedAt: Date.UTC(2026, 5, 30, 2, 10, 26),
    } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.objectName).toBe('dev/uploads/cam_a/cam_a_260630-021026_UNKNOWN.jpg');
  });

  it('falls back to upload time when capturedAt is missing', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: {
      deviceId: 'cam_a',
      wakeReason: 'BUTTON',
    } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // No firmware-supplied time -> server uses Date.now(), so we can't pin the
    // exact stamp. Verify shape only: prefix, suffix, and reason match.
    expect(body.objectName).toMatch(/^dev\/uploads\/cam_a\/cam_a_\d{6}-\d{6}_BUTTON\.jpg$/);
  });
});
