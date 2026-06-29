import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => {
  const add = vi.fn().mockResolvedValue({ id: 'doc-123' });
  const collection = vi.fn(() => ({ add }));
  return {
    requireDeviceSecret: vi.fn(),
    rtdbSet: vi.fn().mockResolvedValue(undefined),
    checkRateLimit: vi.fn(),
    add,
    collection,
  };
});

vi.mock('@/lib/requireDeviceSecret', () => ({ requireDeviceSecret: m.requireDeviceSecret }));
vi.mock('@/lib/rtdb', () => ({ rtdbSet: m.rtdbSet, rtdbGet: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/appEnv', () => ({ APP_ENV: 'dev' }));
vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { collection: m.collection },
}));

import { POST } from '@/app/api/capture-complete/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/capture-complete', () => {
  beforeEach(() => {
    m.requireDeviceSecret.mockReset().mockResolvedValue(undefined);
    m.rtdbSet.mockClear();
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.add.mockClear().mockResolvedValue({ id: 'doc-123' });
    m.collection.mockClear();
  });

  it('returns 429 BEFORE any auth or writes when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', objectPath: 'dev/x.jpg' } }));
    expect(res.status).toBe(429);
    expect(m.requireDeviceSecret).not.toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('rejects when the per-device secret is wrong (401)', async () => {
    m.requireDeviceSecret.mockRejectedValueOnce(new HttpError(401, 'Unauthorized device'));
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', objectPath: 'x.jpg' } }));
    expect(res.status).toBe(401);
    expect(m.add).not.toHaveBeenCalled();
    expect(m.rtdbSet).not.toHaveBeenCalled();
  });

  it('clears command + writes Firestore doc on happy path', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      body: { deviceId: 'cam_a', objectPath: 'dev/uploads/cam_a/123.jpg' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'doc-123', command: 'idle' });
    // Both side-effects fired (clear command + log detection).
    expect(m.rtdbSet).toHaveBeenCalledWith('devices/cam_a/command', 'idle');
    expect(m.collection).toHaveBeenCalledWith('wildlife_detections');
    expect(m.add).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'cam_a',
      env: 'dev', // env-tag so clean:dev can scope deletes -- regression guard
      objectPath: 'dev/uploads/cam_a/123.jpg',
      analyzed: false,
      detections: [],
    }));
  });

  it('accepts objectName as a synonym for objectPath (firmware uses objectName)', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      body: { deviceId: 'cam_a', objectName: 'dev/uploads/cam_a/456.jpg' },
    }));
    expect(res.status).toBe(200);
    expect(m.add).toHaveBeenCalledWith(expect.objectContaining({ objectPath: 'dev/uploads/cam_a/456.jpg' }));
  });
});
