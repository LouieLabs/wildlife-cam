import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// Downstream commands to a camera (e.g. "take_picture"). A signed-in Louie Labs
// user sets the command; the camera polls /devices/<id>/command (public read --
// commands are not secret) and acts on it. The server (admin) is the only thing
// allowed to WRITE the command, so a stranger cannot order a camera around.
const ALLOWED = new Set(['take_picture', 'reboot', 'idle']);

export async function POST(req: NextRequest) {
  try {
    await requireLouieLabsUser(req);
    const body = await req.json();

    const deviceId = String(body.deviceId || '').toLowerCase().trim();
    const action = String(body.action || '').toLowerCase().trim();

    if (!/^[a-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }
    if (!ALLOWED.has(action)) {
      return NextResponse.json(
        { error: `Action must be one of: ${[...ALLOWED].join(', ')}` },
        { status: 400 }
      );
    }

    await adminDb.ref(`devices/${deviceId}/command`).set(action);
    return NextResponse.json({ deviceId, command: action });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
