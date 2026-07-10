import { NextRequest, NextResponse } from 'next/server';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import { analyzePendingCaptures } from '@/lib/analyzeCaptures';

export const runtime = 'nodejs';
// gemini-2.5-pro is slower per call than -flash; give a batch of them room so
// the platform doesn't cut the request off mid-analysis.
export const maxDuration = 120;

// POST /api/analyze-pending — run the in-cloud AI over unanalyzed captures.
//
// In plain words: the dashboard calls this on its refresh loop. The server
// picks up a few "not analyzed" photos, asks Gemini what's in them (keyless,
// via Vertex AI — see lib/analyzeCaptures.ts), and saves the answers. No
// external worker, no shared API key, nothing new to secure: the only way to
// trigger it is to be a signed-in @louielabs.com user, same as the rest of
// the dashboard.
//
// Idempotent + cheap when idle: if nothing is pending it does no model calls
// and returns {scanned: 0}. Firestore picks the batch; concurrent triggers
// mostly see an empty queue.
export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 10/min per user: the dashboard polls every ~30s, and each call can fan
    // out to several model invocations — keep a lid on accidental loops.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:analyze-pending`,
      limit: 10,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    // 3 per tick: -pro is slower, and the dashboard re-triggers every 30s, so a
    // backlog still drains steadily while each request stays well under maxDuration.
    const result = await analyzePendingCaptures(3);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[analyze-pending] failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
