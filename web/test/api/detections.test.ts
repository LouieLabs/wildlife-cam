import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => {
  const add = vi.fn().mockResolvedValue({ id: 'doc-x' });
  // Build a tiny Firestore query mock: collection().orderBy().limit().get() -> snapshot
  const get = vi.fn().mockResolvedValue({ docs: [] });
  const limit = vi.fn(() => ({ get }));
  const orderBy = vi.fn(() => ({ limit }));
  const collection = vi.fn(() => ({ add, orderBy }));
  return {
    requireLouieLabsUser: vi.fn(),
    checkRateLimit: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue(['https://signed.read/url']),
    add, get, limit, orderBy, collection,
  };
});

vi.mock('@/lib/requireLouieLabsUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/requireLouieLabsUser')>('@/lib/requireLouieLabsUser');
  return { ...actual, requireLouieLabsUser: m.requireLouieLabsUser };
});
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/appEnv', () => ({ APP_ENV: 'dev' }));
vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { collection: m.collection },
}));
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket() { return { file: () => ({ getSignedUrl: m.getSignedUrl }) }; }
  }
  return { Storage };
});

import { GET, POST } from '@/app/api/detections/route';

const okLimit = { allowed: true, count: 1, limit: 120, windowMs: 60_000, retryAfterMs: 0 };

describe('GET /api/detections', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.get.mockReset().mockResolvedValue({ docs: [] });
    m.getSignedUrl.mockReset().mockResolvedValue(['https://signed.read/url']);
  });

  it('rejects unauthenticated (401)', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 5000 });
    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
  });

  it('mints signed read URLs for each detection that has an objectPath', async () => {
    m.get.mockResolvedValueOnce({
      docs: [
        { id: 'd1', data: () => ({ deviceId: 'cam_a', objectPath: 'dev/p1.jpg', detections: [] }) },
        { id: 'd2', data: () => ({ deviceId: 'cam_a', objectPath: null, detections: [] }) },
      ],
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detections).toHaveLength(2);
    expect(body.detections[0]).toMatchObject({ id: 'd1', imageUrl: 'https://signed.read/url' });
    expect(body.detections[1]).toMatchObject({ id: 'd2', imageUrl: null });
  });
});

describe('POST /api/detections (server-to-server, shared CAMERA_API_KEY)', () => {
  beforeEach(() => {
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.add.mockReset().mockResolvedValue({ id: 'doc-x' });
    m.collection.mockClear();
    process.env.CAMERA_API_KEY = 'TEST-PIPELINE-KEY';
  });

  it('rejects missing key (401)', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { deviceId: 'cam_a', detections: [] } }));
    expect(res.status).toBe(401);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('rejects wrong key (401)', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-camera-api-key': 'WRONG' },
      body: { deviceId: 'cam_a', detections: [] },
    }));
    expect(res.status).toBe(401);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('returns 429 BEFORE the key check when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-camera-api-key': 'WRONG' },
      body: { deviceId: 'cam_a', detections: [] },
    }));
    expect(res.status).toBe(429);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('rejects malformed deviceId (400)', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-camera-api-key': 'TEST-PIPELINE-KEY' },
      body: { deviceId: 'BAD!', detections: [] },
    }));
    expect(res.status).toBe(400);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('writes a Firestore detection on happy path (analyzed=true)', async () => {
    const res = await POST(makeRequest({
      method: 'POST',
      headers: { 'x-camera-api-key': 'TEST-PIPELINE-KEY' },
      body: {
        deviceId: 'cam_a',
        objectPath: 'dev/p1.jpg',
        capturedAt: 1700000000000,
        detections: [{ label: 'deer', confidence: 0.91, box: [10, 20, 30, 40] }],
      },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'doc-x' });
    expect(m.collection).toHaveBeenCalledWith('wildlife_detections');
    expect(m.add).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'cam_a',
      env: 'dev',
      analyzed: true,
      detections: [{ label: 'deer', confidence: 0.91, box: [10, 20, 30, 40] }],
    }));
  });
});
