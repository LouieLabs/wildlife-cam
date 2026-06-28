import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet, rtdbUpdate } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// Rename a board. MAC is the stable hardware id; the device_id (the name an
// admin types) is a swappable label. We:
//   - Copy the existing per-device secret to pre_shared_keys/<new>
//     and DELETE pre_shared_keys/<old> -- the old login no longer exists.
//   - Tombstone device_meta/<old> = { status:"renamed", renamedTo, renamedAt, ... }
//   - Write device_meta/<new> with previousId pointing back to <old>.
//   - Queue devices/<old>/command = "rename:<new>" so the board, on its next
//     wake, persists the new id to NVS + restarts under it.
// All of the above goes through a single atomic RTDB multi-path PATCH so we
// can't end up with a half-renamed device.
//
// History preservation: devices/<old>/state (telemetry history), the GCS
// photos under prod/uploads/<old>/, and the Firestore wildlife_detections
// rows with deviceId=<old> are LEFT IN PLACE -- they are real history about
// what that hardware did under its old label.
//
// Strict collision check: the new id is rejected if it matches ANY existing
// pre_shared_keys OR device_meta key, active or tombstoned. (Tombstones are
// part of the audit trail; reusing a tombstoned name would let the same
// label point at two different MACs in history.) An admin who really wants
// to reuse a name can manually delete the tombstone from RTDB first.

const ID_RE = /^[a-z0-9_-]{3,40}$/;

export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);
    const body = await req.json();

    const oldId = String(body.oldId || '').toLowerCase().trim();
    const newId = String(body.newId || '').toLowerCase().trim();

    if (!ID_RE.test(oldId)) {
      return NextResponse.json({ error: 'oldId is not a valid device id' }, { status: 400 });
    }
    if (!ID_RE.test(newId)) {
      return NextResponse.json(
        { error: 'newId must be 3-40 chars: letters, numbers, _ or -' },
        { status: 400 }
      );
    }
    if (oldId === newId) {
      return NextResponse.json({ error: 'newId must differ from oldId' }, { status: 400 });
    }

    // Read existing state for both ids.
    const [oldSecret, oldMeta, existingNewPsk, existingNewMeta] = await Promise.all([
      rtdbGet<string>(`pre_shared_keys/${oldId}`),
      rtdbGet<Record<string, any>>(`device_meta/${oldId}`),
      rtdbGet<string>(`pre_shared_keys/${newId}`),
      rtdbGet<Record<string, any>>(`device_meta/${newId}`),
    ]);

    if (!oldSecret) {
      return NextResponse.json({ error: `${oldId} is not registered` }, { status: 404 });
    }
    if (!oldMeta) {
      return NextResponse.json({ error: `${oldId} has no metadata to rename` }, { status: 404 });
    }
    if (oldMeta.status === 'renamed') {
      return NextResponse.json(
        { error: `${oldId} was already renamed to ${oldMeta.renamedTo}` },
        { status: 409 }
      );
    }

    // Strict: refuse to collide with anything in either index, even tombstones.
    if (existingNewPsk || existingNewMeta) {
      return NextResponse.json(
        { error: `${newId} is already in use (active or archived) -- pick a different name` },
        { status: 409 }
      );
    }

    const now = Date.now();

    // Build the new + tombstone meta objects. We carry the network expectation
    // (SSIDs, mode) forward to the new name because the hardware hasn't moved.
    const newMeta = {
      ...oldMeta,                  // mac, ssid, mode, original registeredBy/At
      previousId: oldId,
      renamedAt: now,
      renamedBy: user.email,
    };
    delete (newMeta as any).status;       // a fresh active entry, not a tombstone
    delete (newMeta as any).renamedTo;

    const tombstone = {
      mac: oldMeta.mac ?? null,
      status: 'renamed' as const,
      renamedTo: newId,
      renamedAt: now,
      renamedBy: user.email,
      // Preserve the original audit trail.
      registeredBy: oldMeta.registeredBy ?? null,
      registeredAt: oldMeta.registeredAt ?? null,
    };

    // Atomic multi-path update across the four touched paths.
    await rtdbUpdate({
      [`pre_shared_keys/${newId}`]: oldSecret,
      [`pre_shared_keys/${oldId}`]: null,         // delete old PSK
      [`device_meta/${newId}`]:    newMeta,
      [`device_meta/${oldId}`]:    tombstone,
      [`devices/${oldId}/command`]: `rename:${newId}`,
    });

    return NextResponse.json({ oldId, newId, renamedAt: now });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
