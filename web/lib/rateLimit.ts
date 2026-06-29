// Shared, server-side rate limiter for our public API.
//
// Why a SHARED store: Cloud Run runs many stateless instances at once, so an
// in-memory counter would only see the requests that landed on THIS instance --
// an attacker can punch through it by spraying connections. Firestore is already
// wired up, so we use it as the shared store with a transaction (atomic
// compare-and-increment).
//
// Model: classic FIXED WINDOW. For each (key, windowStart), we keep a count
// doc. If the count exceeds `limit` in that window, we return a 429-shaped
// result. Fixed window has a known boundary-burst weakness (2x limit across a
// boundary) -- fine for our threat model (bot abuse, not a precision quota).
//
// Cleanup: each doc has an `expiresAt` Timestamp. Configure a Firestore TTL on
// the `rate_limits` collection's `expiresAt` field in the GCP console so old
// docs auto-delete; without that they accumulate.
import { adminFirestore } from './firebaseAdmin';
import { Timestamp } from 'firebase-admin/firestore';

const COLLECTION = 'rate_limits';

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterMs: number;
  windowMs: number;
};

// Firestore doc IDs can't contain "/" and have to stay reasonable. Our real
// keys are deviceId / uid / ip, all narrow -- this just defends against weird
// input (colons in v6 IPs, etc.) without hashing.
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
}

export async function checkRateLimit(opts: {
  key: string;          // e.g. "device:pond_cam_01" or "ip:1.2.3.4"
  limit: number;        // max requests per window
  windowMs: number;     // window length in ms (e.g. 60_000 for a 1-min window)
}): Promise<RateLimitResult> {
  const { key, limit, windowMs } = opts;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const docId = `${sanitize(key)}__${windowStart}`;
  const docRef = adminFirestore.collection(COLLECTION).doc(docId);

  // Atomic compare-and-increment: only one of N concurrent callers wins each
  // count. Two cents per million reads/writes is fine for our volume; if this
  // ever becomes hot, swap the backing store, not the call sites.
  const { allowed, count } = await adminFirestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const current = (snap.exists ? Number(snap.data()?.count) : 0) || 0;
    const next = current + 1;
    if (next > limit) {
      // Don't bump past the limit -- saves a write per blocked request and keeps
      // the count honest if you ever want to log it.
      return { allowed: false, count: current };
    }
    tx.set(
      docRef,
      {
        key,
        windowStart,
        count: next,
        // expire one window AFTER the window ends, so the doc is around long
        // enough for late-arriving probes to find it before TTL purges it.
        expiresAt: Timestamp.fromMillis(windowStart + windowMs * 2),
      },
      { merge: true }
    );
    return { allowed: true, count: next };
  });

  return {
    allowed,
    count,
    limit,
    windowMs,
    retryAfterMs: allowed ? 0 : (windowStart + windowMs) - now,
  };
}

// Convenience: produce a 429 NextResponse from a blocked result. Keep this
// separate from checkRateLimit so the helper stays runtime-agnostic.
export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(Math.max(0, r.limit - r.count)),
    'Retry-After': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))),
  };
}

// Pull the client IP from the request. On Cloud Run / behind an LB the real
// caller is in `x-forwarded-for` (a comma-separated list, leftmost = original
// client). Locally none of those exist -> fall back to a constant so dev still
// rate-limits coherently (without false-positive sharing between machines, the
// dev server is single-user anyway).
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  if (xff) return xff.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
