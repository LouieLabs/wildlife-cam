import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';
import { analyzePendingCaptures } from '@/lib/analyzeCaptures';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';
// gemini-2.5-pro is slow per call; a batch needs room (same as analyze-pending).
export const maxDuration = 120;

// POST /api/analyze-cron — run the in-cloud AI over unanalyzed captures,
// WITHOUT needing a signed-in dashboard tab open.
//
// In plain words: /api/analyze-pending only fires while an admin is looking at
// the dashboard, so photos taken on a quiet day sat "analyzing…" until someone
// signed in. This route lets the analysis run on its own, two ways:
//
//  1. Scheduled (preferred): a Cloud Scheduler job POSTs here with the shared
//     CAMERA_API_KEY in x-camera-api-key — same key the camera pipeline routes
//     already use, no new secret. Full batch per call.
//  2. Public tick (zero-setup fallback): the WildWatch gallery pings this
//     (no auth) on load and every couple of minutes while anyone has it open.
//
// Why the public mode is safe to expose:
//  - It can only trigger work the server was going to do anyway: it processes
//    docs that are analyzed:false, and only the authenticated camera pipeline
//    can CREATE those. No pending docs -> a no-op that never calls the model.
//    Total model spend is therefore capped at "each real photo, once".
//  - A global 60 s lock (Firestore transaction) collapses any burst of public
//    ticks into at most one batch per minute, plus a per-IP rate limit.
const TICK_LOCK_DOC = 'wildlife_meta/analyze_tick';
// 25 s (was 60): with capture-complete now kicking analysis directly and the
// batch running concurrently, the lock only throttles pile-ups from many open
// gallery tabs -- it should not itself add a minute of photo latency.
const TICK_MIN_INTERVAL_MS = 25_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// CORS preflight: the louielabs.com gallery pings this route cross-origin.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req);

  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:analyze-cron`,
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { ...cors, ...rateLimitHeaders(rl) } });
  }

  try {
    const apiKey = req.headers.get('x-camera-api-key') || '';
    const expected = process.env.CAMERA_API_KEY || '';
    const scheduled = Boolean(expected) && Boolean(apiKey) && safeEqual(apiKey, expected);

    if (!scheduled) {
      // Public tick: claim the 60 s lock atomically; losers no-op. The lock is
      // claimed BEFORE analyzing so concurrent ticks can't double-run a batch.
      const lockRef = adminFirestore.doc(TICK_LOCK_DOC);
      const claimed = await adminFirestore.runTransaction(async (tx) => {
        const doc = await tx.get(lockRef);
        const last = (doc.exists && (doc.data() as any).lastRun) || 0;
        if (Date.now() - last < TICK_MIN_INTERVAL_MS) return false;
        tx.set(lockRef, { lastRun: Date.now() }, { merge: true });
        return true;
      });
      if (!claimed) {
        return NextResponse.json({ skipped: true, reason: 'ticked recently' }, { headers: cors });
      }
    }

    // Scheduled/keyed callers (Cloud Scheduler, capture-complete's instant kick)
    // get a burst-sized batch; public ticks a slightly smaller one (they fire
    // from many browsers). Batches run ANALYZE_CONCURRENCY photos in parallel,
    // so even the large batch stays well inside maxDuration.
    const result = await analyzePendingCaptures(scheduled ? 8 : 6);
    return NextResponse.json(result, { headers: cors });
  } catch (err) {
    console.error('[analyze-cron] failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: cors });
  }
}
