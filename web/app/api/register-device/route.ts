import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { generateDeviceSecret } from '@/lib/secret';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// Authenticated device registration. A signed-in Louie Labs student submits a
// device ID + MAC, and the SERVER mints a random secret. The MAC is only an
// identifier here -- it is NOT the secret.
export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 10/min per signed-in user: registering a board is rare, so this catches a
    // misbehaving script or stolen token without blocking real onboarding.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:register-device`,
      limit: 10,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const body = await req.json();

    const deviceId = String(body.deviceId || '').trim();
    const mac = String(body.mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');

    if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json(
        { error: 'Device ID must be 3-40 chars: letters (A-Z, a-z), numbers, _ or -' },
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

    // The per-device `secret` is what the board uses to authenticate to BOTH
    // the database (status writes) and the backend HTTP routes (uploads,
    // command poll, capture-complete). There is no longer a fleet-wide shared
    // key in the board image.
    return NextResponse.json({
      deviceId,
      mac,
      secret,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
