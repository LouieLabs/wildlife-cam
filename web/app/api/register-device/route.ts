import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { generateDeviceSecret } from '@/lib/secret';

export const runtime = 'nodejs';

// Authenticated device registration. A signed-in Louie Labs student submits a
// device ID + MAC, and the SERVER mints a random secret. The MAC is only an
// identifier here -- it is NOT the secret.
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

    const secret = generateDeviceSecret();

    // Registry + metadata live in the Realtime Database (admin-only paths).
    // Secret is stored in CLEAR (per project decision) so it can be recovered.
    await rtdbSet(`pre_shared_keys/${deviceId}`, secret);
    await rtdbSet(`device_meta/${deviceId}`, {
      mac,
      registeredBy: user.email,
      registeredAt: Date.now(),
    });
    // Seed an idle command so the device has something to poll on first boot.
    await rtdbSet(`devices/${deviceId}/command`, 'idle');

    return NextResponse.json({ deviceId, mac, secret });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
