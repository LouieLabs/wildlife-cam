import { NextRequest, NextResponse } from 'next/server';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

const COLLECTION = 'wildlife_detections';
// Firestore caps a WriteBatch at 500 ops; sweep in chunks until done.
const BATCH_SIZE = 400;
// Hard ceiling per request as a runaway guard — a backyard collection is a few
// thousand docs at most; call it again if there are somehow more.
const MAX_DOCS_PER_CALL = 4000;

// CORS preflight: the louielabs.com gallery calls this cross-origin.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

// POST /api/captures/hide-before
// Body: { before: <epoch ms> }
// One-shot curation sweep for launch day: marks EVERY capture taken before the
// given moment as hidden (hidden:true on the doc). The public gallery stops
// showing them; signed-in users still see them flagged and can unhide
// individual keepers. Nothing is deleted, and photos taken AFTER the sweep
// moment are untouched -- so "hide everything before now" gives the public
// site a clean slate without losing history.
export async function POST(req: NextRequest) {
  const cors = corsHeaders(req);
  try {
    const user = await requireLouieLabsUser(req);

    // 5/min per user -- this is a launch-day button, not a polling target.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:captures-hide-before`,
      limit: 5,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { ...cors, ...rateLimitHeaders(rl) } });
    }

    const body = await req.json().catch(() => ({}));
    const before = Number(body.before);
    if (!Number.isFinite(before) || before <= 0) {
      return NextResponse.json({ error: 'before must be a timestamp in epoch milliseconds' }, { status: 400, headers: cors });
    }

    const snap = await adminFirestore
      .collection(COLLECTION)
      .where('capturedAt', '<', before)
      .limit(MAX_DOCS_PER_CALL)
      .get();

    // Skip docs that are already hidden so re-running the sweep is a cheap
    // no-op instead of thousands of pointless writes.
    const toHide = snap.docs.filter((d) => (d.data() as any).hidden !== true);

    const now = Date.now();
    for (let i = 0; i < toHide.length; i += BATCH_SIZE) {
      const batch = adminFirestore.batch();
      for (const doc of toHide.slice(i, i + BATCH_SIZE)) {
        batch.update(doc.ref, { hidden: true, hiddenBy: user.email, hiddenAt: now });
      }
      await batch.commit();
    }

    return NextResponse.json(
      { hidden: toHide.length, alreadyHidden: snap.docs.length - toHide.length },
      { headers: cors },
    );
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
    }
    console.error('[hide-before] failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: cors });
  }
}
