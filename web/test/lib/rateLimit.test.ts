import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the firebase-admin Firestore wrapper. vi.mock is hoisted above all
// imports, so the mock spies have to be created with vi.hoisted() so they
// exist when the factory runs. We stub runTransaction to invoke the
// caller-supplied function with a fake tx whose .get() and .set() we control.
const { mockGet, mockSet, mockRunTransaction, mockDoc, mockCollection } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockSet = vi.fn();
  const mockRunTransaction = vi.fn(async (cb: any) => cb({ get: mockGet, set: mockSet }));
  const mockDoc = vi.fn(() => ({ id: 'fake-doc' }));
  const mockCollection = vi.fn(() => ({ doc: mockDoc }));
  return { mockGet, mockSet, mockRunTransaction, mockDoc, mockCollection };
});

vi.mock('@/lib/firebaseAdmin', () => ({
  adminFirestore: {
    collection: mockCollection,
    runTransaction: mockRunTransaction,
  },
}));

// Timestamp is only used to stamp `expiresAt`; we don't care about its shape
// in these tests, just that it's a value (so the mock can be a stub).
vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (ms: number) => ({ _seconds: Math.floor(ms / 1000) }) },
}));

import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin time to the Unix epoch so the math is trivial: with a 60_000 ms
    // window, windowStart for any time in [0, 60_000) is 0, windowEnd is 60_000.
    vi.setSystemTime(0);
    mockGet.mockReset();
    mockSet.mockReset();
    mockRunTransaction.mockClear();
    mockDoc.mockClear();
    mockCollection.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first hit in a fresh window (no doc yet)', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });
    const r = await checkRateLimit({ key: 'device:cam_01', limit: 5, windowMs: 60_000 });
    expect(r).toMatchObject({ allowed: true, count: 1, limit: 5, retryAfterMs: 0 });
    expect(mockSet).toHaveBeenCalledOnce();
    // We write the updated count + the literal expiration time.
    const written = mockSet.mock.calls[0][1];
    expect(written.count).toBe(1);
    expect(written.key).toBe('device:cam_01');
  });

  it('allows up to the limit then blocks the next request', async () => {
    // Last allowed hit: doc has count=4 (limit-1), request brings it to 5.
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ count: 4 }) });
    const ok = await checkRateLimit({ key: 'device:cam_01', limit: 5, windowMs: 60_000 });
    expect(ok.allowed).toBe(true);
    expect(ok.count).toBe(5);

    // Next hit: doc already at 5, would go to 6 -> over limit, blocked.
    mockSet.mockClear();
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ count: 5 }) });
    const blocked = await checkRateLimit({ key: 'device:cam_01', limit: 5, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(5); // we don't bump past the cap
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
    // No write on the blocked path — saves a Firestore op per blocked req.
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('reports retryAfterMs counting down to the window boundary', async () => {
    // Halfway through the 60s window -> retryAfter should be exactly 30s.
    vi.setSystemTime(30_000);
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({ count: 10 }) });
    const r = await checkRateLimit({ key: 'k', limit: 5, windowMs: 60_000 });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(30_000);
  });

  it('sanitizes key into the doc id (no slashes / oddballs)', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });
    await checkRateLimit({ key: 'ip:1.2.3.4:get-upload-url', limit: 5, windowMs: 60_000 });
    const passedId = mockDoc.mock.calls[0][0];
    // "." and ":" are NOT in our allowed [A-Za-z0-9_-] set, so they're replaced.
    expect(passedId).not.toContain('.');
    expect(passedId).not.toContain(':');
    expect(passedId).toContain('ip_1_2_3_4_get-upload-url');
  });
});

describe('rateLimitHeaders', () => {
  it('sets X-RateLimit-* and Retry-After in a 429-friendly shape', () => {
    const h = rateLimitHeaders({
      allowed: false,
      count: 60,
      limit: 60,
      windowMs: 60_000,
      retryAfterMs: 12_345,
    });
    expect(h['X-RateLimit-Limit']).toBe('60');
    expect(h['X-RateLimit-Remaining']).toBe('0');
    // Retry-After is in SECONDS, rounded UP -- minimum 1.
    expect(h['Retry-After']).toBe('13');
  });

  it('Retry-After is at least 1 second even for tiny windows', () => {
    const h = rateLimitHeaders({
      allowed: false, count: 1, limit: 1, windowMs: 100, retryAfterMs: 50,
    });
    expect(h['Retry-After']).toBe('1');
  });
});

describe('clientIp', () => {
  it('returns the leftmost x-forwarded-for entry (real client behind proxies)', () => {
    const r = new Request('http://x', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 192.168.1.1' },
    });
    expect(clientIp(r)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const r = new Request('http://x', { headers: { 'x-real-ip': '203.0.113.99' } });
    expect(clientIp(r)).toBe('203.0.113.99');
  });

  it('returns "unknown" when no IP headers are present (local dev)', () => {
    expect(clientIp(new Request('http://x'))).toBe('unknown');
  });
});
