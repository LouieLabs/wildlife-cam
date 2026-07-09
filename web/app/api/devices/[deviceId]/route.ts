import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet, rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import type { SavedNetwork } from '@/lib/networks';

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

// PATCH /api/devices/[deviceId]
// Body: { action: "set_wifi", networkSlug: "<saved-network-slug>" }
// Re-points a camera's 2.4 GHz Wi-Fi to a saved network, PUSHED to the board
// over the air: we queue a `set_wifi` command (+ a wifiTarget payload the
// command-poll route hands to the firmware) and optimistically update the
// dashboard's stored creds so the card reflects the target network. The board
// applies it on its next wake, then reverts on its own if the new network never
// connects (see WIFI_TRIAL_WAKES in the firmware) -- so a wrong pick can't
// permanently strand a camera.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ deviceId: string }> }) {
  try {
    const user = await requireLouieLabsUser(req);
    const { deviceId } = await ctx.params;
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

    const rl = await checkRateLimit({
      key: `uid:${user.uid}:devices-patch`,
      limit: 30,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    if (action !== 'set_wifi') {
      return NextResponse.json({ error: "Unsupported action (only 'set_wifi')" }, { status: 400 });
    }

    // The camera must exist and be a networked (command-polling) camera -- an
    // external data source has no board to push creds to.
    const meta = await rtdbGet<Record<string, any>>(`device_meta/${deviceId}`);
    if (!meta) {
      return NextResponse.json({ error: 'Camera not found' }, { status: 404 });
    }
    if (meta.cameraType && meta.cameraType !== 'networked') {
      return NextResponse.json({ error: 'Only networked cameras can be re-pointed over the air' }, { status: 400 });
    }

    const networkSlug = String(body.networkSlug || '').trim();
    const net = await rtdbGet<SavedNetwork>(`networks/${networkSlug}`);
    if (!net || !net.ssid) {
      return NextResponse.json({ error: 'Saved network not found' }, { status: 404 });
    }

    const netMode = 'wifi';   // 2.4 GHz is the only radio the firmware connects with today
    // Write the payload BEFORE the command so the board never polls a `set_wifi`
    // whose wifiTarget hasn't landed yet.
    await rtdbSet(`devices/${deviceId}/wifiTarget`, { ssid: net.ssid, pass: net.password, netMode });
    await rtdbSet(`devices/${deviceId}/command`, 'set_wifi');

    // Optimistically reflect the target network on the card. (If the board later
    // reverts because the network is unreachable, this record will read ahead of
    // reality until it's re-pointed -- an acceptable, rare cosmetic gap.)
    await Promise.all([
      rtdbSet(`device_meta/${deviceId}/netMode`, netMode),
      rtdbSet(`device_meta/${deviceId}/wifiSsid`, net.ssid),
      rtdbSet(`device_meta/${deviceId}/wifiPass`, net.password),
    ]);

    return NextResponse.json({ deviceId, command: 'set_wifi', wifiSsid: net.ssid });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
