import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRequest, FAKE_USER } from '../_helpers';
import { HttpError } from '@/lib/requireLouieLabsUser';

const m = vi.hoisted(() => ({
  requireLouieLabsUser: vi.fn(),
  checkRateLimit: vi.fn(),
  analyzePendingCaptures: vi.fn(),
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
vi.mock('@/lib/analyzeCaptures', () => ({
  analyzePendingCaptures: m.analyzePendingCaptures,
}));

import { POST } from '@/app/api/analyze-pending/route';

const okLimit = { allowed: true, count: 1, limit: 10, windowMs: 60_000, retryAfterMs: 0 };

describe('POST /api/analyze-pending (dashboard-triggered in-cloud AI)', () => {
  beforeEach(() => {
    m.requireLouieLabsUser.mockReset().mockResolvedValue(FAKE_USER);
    m.checkRateLimit.mockReset().mockResolvedValue(okLimit);
    m.analyzePendingCaptures.mockReset().mockResolvedValue({ scanned: 0, analyzed: 0, errors: 0 });
  });

  it('rejects unauthenticated callers (401) without running any analysis', async () => {
    m.requireLouieLabsUser.mockRejectedValueOnce(new HttpError(401, 'no auth'));
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(401);
    expect(m.analyzePendingCaptures).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited, without running any analysis', async () => {
    m.checkRateLimit.mockResolvedValueOnce({ ...okLimit, allowed: false, retryAfterMs: 5000 });
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(429);
    expect(m.analyzePendingCaptures).not.toHaveBeenCalled();
  });

  it('runs a batch and returns the summary', async () => {
    m.analyzePendingCaptures.mockResolvedValueOnce({ scanned: 3, analyzed: 2, errors: 1 });
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: 3, analyzed: 2, errors: 1 });
    expect(m.analyzePendingCaptures).toHaveBeenCalledWith(6);
  });

  it('500s (not crashes) when the analyzer throws', async () => {
    m.analyzePendingCaptures.mockRejectedValueOnce(new Error('vertex down'));
    const res = await POST(makeRequest({ method: 'POST' }));
    expect(res.status).toBe(500);
  });
});
