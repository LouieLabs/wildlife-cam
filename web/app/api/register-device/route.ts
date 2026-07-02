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

    // cameraType controls whether this device gets a secret + command channel.
    //  - 'networked' (default): a fleet camera that polls for commands and
    //    authenticates uploads with its own secret. MAC required.
    //  - 'external': a non-networked data source (trail cam, imported dataset).
    //    No secret, no command channel; MAC optional. Ingest happens
    //    server-side via developer credentials.
    const cameraType = String(body.cameraType || 'networked');
    if (cameraType !== 'networked' && cameraType !== 'external') {
      return NextResponse.json({ error: "cameraType must be 'networked' or 'external'" }, { status: 400 });
    }

    if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json(
        { error: 'Device ID must be 3-40 chars: letters (A-Z, a-z), numbers, _ or -' },
        { status: 400 }
      );
    }
    if (cameraType === 'networked' && mac.length !== 12) {
      return NextResponse.json({ error: 'MAC must be 12 hex characters' }, { status: 400 });
    }
    if (cameraType === 'external' && mac.length > 0 && mac.length !== 12) {
      return NextResponse.json({ error: 'MAC (optional for external cams) must be 12 hex characters or blank' }, { status: 400 });
    }

    // Optional network creds: the provision page sends what it just wrote to
    // NVS so the dashboard can show "this camera is on network X" without
    // having to ask the board. Stored in device_meta alongside MAC; visible
    // to any signed-in @louielabs.com user via /api/devices. Empty strings
    // mean "not provisioned on that radio".
    const netMode = String(body.netMode || '').trim();           // wifi|halow|both|""
    const wifiSsid = String(body.wifiSsid || '');
    const wifiPass = String(body.wifiPass || '');
    const halowSsid = String(body.halowSsid || '');
    const halowPsk = String(body.halowPsk || '');

    // Optional external-camera metadata (surfaces on the dashboard so students
    // can tell which "camera" a capture came from — WPS trail cam vs. Heltec
    // fleet cam etc.). Ignored/stored-as-null for networked cameras.
    const manufacturer = String(body.manufacturer || '').trim();
    const model = String(body.model || '').trim();
    const nightMode = String(body.nightMode || '').trim();       // infrared|white_flash|""
    const deployment = String(body.deployment || '').trim();

    const secret = cameraType === 'networked' ? generateDeviceSecret() : null;
    const macToStore = mac.length === 12 ? mac : null;

    if (secret) {
      // Registry + metadata live in the Realtime Database (admin-only paths).
      // Secret is stored in CLEAR (per project decision) so it can be recovered.
      await rtdbSet(`pre_shared_keys/${deviceId}`, secret);
    }
    await rtdbSet(`device_meta/${deviceId}`, {
      mac: macToStore,
      cameraType,
      manufacturer: manufacturer || null,
      model: model || null,
      nightMode: nightMode || null,
      deployment: deployment || null,
      registeredBy: user.email,
      registeredAt: Date.now(),
      netMode: netMode || null,
      wifiSsid: wifiSsid || null,
      wifiPass: wifiPass || null,
      halowSsid: halowSsid || null,
      halowPsk: halowPsk || null,
    });
    // Seed an idle command only for networked cams — external sources don't poll.
    if (cameraType === 'networked') {
      await rtdbSet(`devices/${deviceId}/command`, 'idle');
    }

    // The per-device `secret` is what a networked board uses to authenticate
    // to BOTH the database (status writes) and the backend HTTP routes
    // (uploads, command poll, capture-complete). External cams have no
    // secret; ingest happens via developer credentials from a script.
    return NextResponse.json({
      deviceId,
      mac: macToStore,
      secret,
      cameraType,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
