import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// DELETE /api/devices/[deviceId]
// Removes a camera from the RTDB registry: pre_shared_keys, device_meta, and
// devices/<id> (state + command). Photos in GCS and detections in Firestore
// are intentionally NOT touched -- re-registering the same deviceId later
// causes new uploads to land in the same GCS prefix, alongside the historical
// photos. That's the explicit product call: "duplicate named camera after
// delete is okay, data will be added to that camera name."
//
// After delete, the board's stored secret no longer matches anything in
// pre_shared_keys, so its status writes + camera-API calls start failing.
// On the field side a delete is effectively a soft-kill; physically wiping
// the board still requires re-flashing or re-provisioning.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ deviceId: string }> }) {
  try {
    const user = await requireLouieLabsUser(req);
    const { deviceId } = await ctx.params;
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:devices-delete`,
      limit: 20,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    // RTDB removes a key by setting it to null. Done in parallel to keep the
    // window where a half-deleted device exists as short as possible.
    await Promise.all([
      rtdbSet(`pre_shared_keys/${deviceId}`, null),
      rtdbSet(`device_meta/${deviceId}`, null),
      rtdbSet(`devices/${deviceId}`, null),
    ]);

    return NextResponse.json({ deleted: deviceId });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
