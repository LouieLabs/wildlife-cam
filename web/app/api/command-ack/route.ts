import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet, rtdbSet } from '@/lib/rtdb';
import { requireDeviceSecret } from '@/lib/requireDeviceSecret';
import { HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// The camera calls this right after it APPLIES a one-shot config command
// (set_wifi / set_id) and before it reboots -- while it's still on the working
// connection. The device can't write the command path itself (RTDB rules), so
// the server does the follow-up here:
//
//   * set_wifi -> clear the command back to "idle" and drop the wifiTarget, so
//                 the board doesn't re-apply it on the next wake.
//   * set_id   -> the board just adopted its NEW id; FINALIZE the rename by
//                 deleting the OLD registration (pre_shared_keys/device_meta/
//                 devices). The NEW registration was created when the rename was
//                 requested (POST /api/devices/[id]/rename), sharing the same
//                 secret, so the board keeps authenticating after it reboots.
//
// We read the REAL pending command from the database and only act on what's
// actually queued, so a device authing as itself can't trigger an unexpected
// deletion by lying about what it applied.
//
// Authenticated via the per-device secret in the x-device-secret header.
export async function POST(req: NextRequest) {
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:command-ack`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  let deviceId = '';
  try {
    const body = await req.json();
    deviceId = String(body.deviceId || '').trim();
  } catch {
    // fall through; requireDeviceSecret rejects the empty/invalid id
  }

  try {
    await requireDeviceSecret(req, deviceId);

    const command = (await rtdbGet<string>(`devices/${deviceId}/command`)) ?? 'idle';

    if (command === 'set_id') {
      // The board applied the rename and is about to reboot under the new id.
      // Remove the old registration so it doesn't linger as a duplicate/offline
      // card. Photos already in GCS under the old id are intentionally left in
      // place (matches the DELETE route's "photos are not moved" behavior).
      const target = await rtdbGet<{ newId?: string }>(`devices/${deviceId}/idTarget`);
      const newId = typeof target?.newId === 'string' ? target.newId : null;
      await Promise.all([
        rtdbSet(`pre_shared_keys/${deviceId}`, null),
        rtdbSet(`device_meta/${deviceId}`, null),
        rtdbSet(`devices/${deviceId}`, null),
      ]);
      return NextResponse.json({ finalized: newId, removedOldId: deviceId });
    }

    // set_wifi (or any other one-shot): clear the command + its payload.
    await Promise.all([
      rtdbSet(`devices/${deviceId}/command`, 'idle'),
      rtdbSet(`devices/${deviceId}/wifiTarget`, null),
    ]);
    return NextResponse.json({ deviceId, command: 'idle' });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
