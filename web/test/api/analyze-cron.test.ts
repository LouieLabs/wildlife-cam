import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest } from '../_helpers';

const m = vi.hoisted(() => {
  const state = { lockLastRun: 0 };
  const txSet = vi.fn();
  const runTransaction = vi.fn(async (fn: any) =>
    fn({
      get: async () => ({ exists: state.lockLastRun > 0, data: () => ({ lastRun: state.lockLastRun }) }),
      set: txSet,
    })
  );
  return {
    checkRateLimit: vi.fn(),
    analyzePendingCaptures: vi.fn(),
    runTransaction,
    txSet,
    doc: vi.fn(() => ({})),
    state,
  };
});

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: m.checkRateLimit,
  rateLimitHeaders: () => ({}),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/analyzeCaptures', () => ({
  analyzePendingCaptures: m.analyzePendingCaptures,
}));
vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: { doc: m.doc, runTransaction: m.runTransaction },
}));

import { POST } from '@/app/api/analyze-cron/route';

const okLimit = { allowed: true, count: 1, limit: 10, windowMs: 60_000, retryAfterMs: 0 };
const KEY = 'test-camera-key-123';

describe('POST /api/analyze-cron (scheduled + public-tick AI trigger)', () => {
  beforeEach(() => {
    process.env.CAMERA_API_KEY = KEY;
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.analyzePendingCaptures.mockReset().mockResolvedValue({ scanned: 2, analyzed: 2, errors: 0 });
    m.runTransaction.mockClear();
    m.txSet.mockClear();
    m.state.lockLastRun = 0;
  });

  it('returns 429 when rate-limited, without analyzing or touching the lock', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 5000 });
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(429);
    expect(m.analyzePendingCaptures).not.toHaveBeenCalled();
    expect(m.runTransaction).not.toHaveBeenCalled();
  });

  it('scheduled mode (valid x-camera-api-key): full batch, no tick lock', async () => {
    const res = await POST(makeRequest({ method: 'POST', headers: { 'x-camera-api-key': KEY } }));
    expect(res.status).toBe(200);
    expect(m.analyzePendingCaptures).toHaveBeenCalledWith(8);
    expect(m.runTransaction).not.toHaveBeenCalled();   // scheduler never waits on the lock
  });

  it('public tick with a free lock: claims it and runs the smaller batch', async () => {
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(200);
    expect(m.txSet).toHaveBeenCalled();                // lock claimed
    expect(m.analyzePendingCaptures).toHaveBeenCalledWith(6);
  });

  it('public tick inside the 60 s window: skips without analyzing', async () => {
    m.state.lockLastRun = Date.now() - 5_000;          // ticked 5 s ago
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(m.analyzePendingCaptures).not.toHaveBeenCalled();
  });

  it('a WRONG api key falls back to the public-tick path (never the full batch)', async () => {
    const res = await POST(makeRequest({ method: 'POST', headers: { 'x-camera-api-key': 'nope' } }));
    expect(res.status).toBe(200);
    expect(m.analyzePendingCaptures).toHaveBeenCalledWith(6);
  });

  it('an expired lock (older than 60 s) lets a public tick run again', async () => {
    m.state.lockLastRun = Date.now() - 61_000;
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(200);
    expect(m.analyzePendingCaptures).toHaveBeenCalledWith(6);
  });

  it('surfaces an analysis failure as a 500', async () => {
    m.analyzePendingCaptures.mockRejectedValueOnce(new Error('vertex down'));
    const res = await POST(makeRequest({ method: 'POST', headers: { 'x-camera-api-key': KEY } }));
    expect(res.status).toBe(500);
  });
});
