import { NextRequest, NextResponse } from 'next/server';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

const COLLECTION = 'wildlife_detections';

// Only the four right angles are meaningful for a sideways-mounted camera.
const ALLOWED_ROTATIONS = new Set([0, 90, 180, 270]);

// CORS preflight: the louielabs.com gallery calls this route cross-origin.
// Auth is unchanged -- corsHeaders only echoes allowlisted origins.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

// PATCH /api/captures/[id]
// Body: { rotation?: 0 | 90 | 180 | 270, hidden?: boolean } -- at least one.
// - rotation: display rotation so a photo from a sideways-mounted camera reads
//   upright for EVERY viewer (the gallery applies it on render).
// - hidden: curation for the public gallery. Hidden captures disappear for
//   anonymous visitors; signed-in users still see them (marked) so they can
//   unhide. Nothing is deleted.
// Signed-in @louielabs.com users only -- anonymous visitors can still rotate
// locally in their own browser, it just isn't saved.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(req);
  try {
    const user = await requireLouieLabsUser(req);
    const { id } = await ctx.params;
    // Firestore auto-ids are 20 url-safe chars; be lenient but bounded.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return NextResponse.json({ error: 'Invalid capture id' }, { status: 400, headers: cors });
    }

    // 60/min per user -- straightening a burst of sideways photos is bursty,
    // but still human-paced clicking.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:captures-rotate`,
      limit: 60,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { ...cors, ...rateLimitHeaders(rl) } });
    }

    const body = await req.json().catch(() => ({}));
    // Build the update from whichever fields were sent; reject a request that
    // carries neither (or an invalid value) rather than writing nothing.
    const update: Record<string, unknown> = {};
    if (body.rotation !== undefined) {
      const rotation = Number(body.rotation);
      if (!ALLOWED_ROTATIONS.has(rotation)) {
        return NextResponse.json({ error: 'rotation must be 0, 90, 180, or 270' }, { status: 400, headers: cors });
      }
      update.rotation = rotation;
      update.rotatedBy = user.email;
      update.rotatedAt = Date.now();
    }
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== 'boolean') {
        return NextResponse.json({ error: 'hidden must be true or false' }, { status: 400, headers: cors });
      }
      update.hidden = body.hidden;
      update.hiddenBy = user.email;
      update.hiddenAt = Date.now();
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Send rotation and/or hidden' }, { status: 400, headers: cors });
    }

    const ref = adminFirestore.collection(COLLECTION).doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      return NextResponse.json({ error: 'Capture not found' }, { status: 404, headers: cors });
    }

    await ref.update(update);

    const out: Record<string, unknown> = { id };
    if (update.rotation !== undefined) out.rotation = update.rotation;
    if (update.hidden !== undefined) out.hidden = update.hidden;
    return NextResponse.json(out, { headers: cors });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: cors });
  }
}
