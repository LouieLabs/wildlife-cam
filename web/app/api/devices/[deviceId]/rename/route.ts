import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet, rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// POST /api/devices/[deviceId]/rename
// Body: { newId: "<new-device-id>" }
//
// Renames a camera's id and PUSHES the change to the board over the air. The id
// is the primary key everywhere (RTDB registry, the board's NVS, the GCS photo
// prefix), so we can't just relabel one record. Instead we run a small handshake
// that keeps the camera authenticated the whole way through:
//
//   1. Copy the OLD registration to the NEW id, REUSING THE SAME SECRET. Now the
//      board can authenticate as either id with the secret it already holds.
//   2. Queue a `set_id` command on the OLD node (the board still polls as the
//      old id). On its next wake it writes the new id to NVS and reboots.
//   3. When the board acks (POST /api/command-ack), the server deletes the OLD
//      registration -- see that route. Until then both cards may briefly show.
//
// Historical photos stay under the OLD id's GCS prefix (moving objects is a
// separate batch job; this matches the DELETE route's "photos are not moved"
// behavior). New photos land under the new id.
export async function POST(req: NextRequest, ctx: { params: Promise<{ deviceId: string }> }) {
  try {
    const user = await requireLouieLabsUser(req);
    const { deviceId: oldId } = await ctx.params;

    if (!/^[A-Za-z0-9_-]{3,40}$/.test(oldId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:devices-rename`,
      limit: 10,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const body = await req.json().catch(() => ({}));
    const newId = String(body.newId || '').trim();
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(newId)) {
      return NextResponse.json(
        { error: 'New ID must be 3-40 chars: letters (A-Z, a-z), numbers, _ or -' },
        { status: 400 }
      );
    }
    if (newId === oldId) {
      return NextResponse.json({ error: 'New ID is the same as the current one' }, { status: 400 });
    }

    const [oldMeta, oldSecret, oldNode] = await Promise.all([
      rtdbGet<Record<string, any>>(`device_meta/${oldId}`),
      rtdbGet<string>(`pre_shared_keys/${oldId}`),
      rtdbGet<Record<string, any>>(`devices/${oldId}`),
    ]);

    if (!oldMeta) {
      return NextResponse.json({ error: 'Camera not found' }, { status: 404 });
    }
    // No secret => external / non-networked camera. There's no board to push a
    // rename to, so refuse rather than silently only-relabel.
    if (!oldSecret) {
      return NextResponse.json(
        { error: 'This camera has no command channel (external camera); it cannot be renamed over the air' },
        { status: 400 }
      );
    }

    // Refuse to clobber an existing camera.
    const [newMeta, newSecret] = await Promise.all([
      rtdbGet<Record<string, any>>(`device_meta/${newId}`),
      rtdbGet<string>(`pre_shared_keys/${newId}`),
    ]);
    if (newMeta || newSecret) {
      return NextResponse.json({ error: `A camera with id "${newId}" already exists` }, { status: 409 });
    }

    // 1) Copy OLD -> NEW, keeping the same secret so the board stays authed.
    const newMetaRec = { ...oldMeta, renamedFrom: oldId, renamedAt: Date.now() };
    await Promise.all([
      rtdbSet(`pre_shared_keys/${newId}`, oldSecret),
      rtdbSet(`device_meta/${newId}`, newMetaRec),
      rtdbSet(`devices/${newId}/command`, 'idle'),
      // Seed last-known state so the new card isn't blank until the board reports.
      oldNode?.state ? rtdbSet(`devices/${newId}/state`, oldNode.state) : Promise.resolve(),
    ]);

    // 2) Queue the rename on the OLD node (payload first, then the verb).
    await rtdbSet(`devices/${oldId}/idTarget`, { newId });
    await rtdbSet(`devices/${oldId}/command`, 'set_id');

    return NextResponse.json({ renamed: { from: oldId, to: newId }, pending: true });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
