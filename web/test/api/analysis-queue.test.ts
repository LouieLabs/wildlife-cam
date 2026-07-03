import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';

const m = vi.hoisted(() => {
  // collection().where().limit().get() -> snapshot
  const get = vi.fn().mockResolvedValue({ docs: [] });
  const limit = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ limit }));
  const collection = vi.fn(() => ({ where }));
  return {
    checkRateLimit: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue(['https://signed.read/url']),
    get, limit, where, collection,
  };
});

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { collection: m.collection },
}));
vi.mock('@google-cloud/storage', () => {
  class Storage {
    bucket() { return { file: () => ({ getSignedUrl: m.getSignedUrl }) }; }
  }
  return { Storage };
});

import { GET } from '@/app/api/analysis-queue/route';

const okLimit = { allowed: true, count: 1, limit: 60, windowMs: 60_000, retryAfterMs: 0 };

describe('GET /api/analysis-queue (SpeciesNet worker inbox)', () => {
  beforeEach(() => {
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.get.mockReset().mockResolvedValue({ docs: [] });
    m.getSignedUrl.mockReset().mockResolvedValue(['https://signed.read/url']);
    m.where.mockClear();
    process.env.CAMERA_API_KEY = 'TEST-PIPELINE-KEY';
  });

  it('rejects missing key (401)', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(m.get).not.toHaveBeenCalled();
  });

  it('rejects wrong key (401)', async () => {
    const res = await GET(makeRequest({ headers: { 'x-camera-api-key': 'WRONG' } }));
    expect(res.status).toBe(401);
  });

  it('returns 429 BEFORE the key check when rate-limited', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 1000 });
    const res = await GET(makeRequest({ headers: { 'x-camera-api-key': 'WRONG' } }));
    expect(res.status).toBe(429);
    expect(m.get).not.toHaveBeenCalled();
  });

  it('returns pending captures with signed read URLs; filters analyzed:false', async () => {
    m.get.mockResolvedValueOnce({
      docs: [
        { id: 'p1', data: () => ({ deviceId: 'cam_a', objectPath: 'dev/uploads/a.jpg', capturedAt: 1700 }) },
      ],
    });
    const res = await GET(makeRequest({ headers: { 'x-camera-api-key': 'TEST-PIPELINE-KEY' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toEqual([
      {
        id: 'p1',
        deviceId: 'cam_a',
        objectPath: 'dev/uploads/a.jpg',
        capturedAt: 1700,
        imageUrl: 'https://signed.read/url',
      },
    ]);
    // The queue must only ever serve unanalyzed docs -- regression guard.
    expect(m.where).toHaveBeenCalledWith('analyzed', '==', false);
  });

  it('skips docs with no objectPath (they can never be analyzed)', async () => {
    m.get.mockResolvedValueOnce({
      docs: [
        { id: 'p1', data: () => ({ deviceId: 'cam_a', objectPath: null }) },
        { id: 'p2', data: () => ({ deviceId: 'cam_a', objectPath: 'dev/ok.jpg' }) },
      ],
    });
    const res = await GET(makeRequest({ headers: { 'x-camera-api-key': 'TEST-PIPELINE-KEY' } }));
    const body = await res.json();
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].id).toBe('p2');
  });
});
