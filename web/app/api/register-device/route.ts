import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { generateDeviceSecret } from '@/lib/secret';

export const runtime = 'nodejs';

// Trim, drop control chars, cap at WPA's 32-octet SSID limit. Empty in -> ''.
function sanitizeSsid(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.slice(0, 32);
}

// Authenticated device registration. A signed-in Louie Labs student submits a
// device ID + MAC, and the SERVER mints a random secret. The MAC is only an
// identifier here -- it is NOT the secret.
//
// Optional non-secret metadata: the EXPECTED Wi-Fi / HaLow SSID and the chosen
// network mode. We store these for debugging ("expects Aloha, last seen 2h
// ago") -- but NEVER any passwords/PSKs (those stay board-only over USB
// serial). Any password-shaped field in the body is dropped here defensively.
export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);
    const body = await req.json();

    const deviceId = String(body.deviceId || '').toLowerCase().trim();
    const mac = String(body.mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');

    if (!/^[a-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json(
        { error: 'Device ID must be 3-40 chars: letters, numbers, _ or -' },
        { status: 400 }
      );
    }
    if (mac.length !== 12) {
      return NextResponse.json({ error: 'MAC must be 12 hex characters' }, { status: 400 });
    }

    // Optional non-secret network metadata. Passwords/PSKs are NEVER read from
    // the body -- only SSIDs (which are broadcast publicly) and the mode.
    const wifiSsid  = sanitizeSsid(body.wifiSsid);
    const halowSsid = sanitizeSsid(body.halowSsid);
    const rawMode   = String(body.netMode || '').toLowerCase().trim();
    const netMode   = (['wifi', 'halow', 'both'] as const).includes(rawMode as any)
      ? (rawMode as 'wifi' | 'halow' | 'both')
      : '';

    const secret = generateDeviceSecret();

    // Registry + metadata live in the Realtime Database (admin-only paths).
    // Secret is stored in CLEAR (per project decision) so it can be recovered.
    await rtdbSet(`pre_shared_keys/${deviceId}`, secret);
    await rtdbSet(`device_meta/${deviceId}`, {
      mac,
      registeredBy: user.email,
      registeredAt: Date.now(),
      ...(wifiSsid  ? { wifiSsid }  : {}),
      ...(halowSsid ? { halowSsid } : {}),
      ...(netMode   ? { netMode }   : {}),
    });
    // Seed an idle command so the device has something to poll on first boot.
    await rtdbSet(`devices/${deviceId}/command`, 'idle');

    // cameraKey is the shared upload/command key, written to the board's NVS by
    // the provisioning page so it never has to be compiled into the public image.
    return NextResponse.json({
      deviceId,
      mac,
      secret,
      cameraKey: process.env.CAMERA_API_KEY || '',
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
