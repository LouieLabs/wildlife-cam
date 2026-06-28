import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// Downstream commands to a camera. A signed-in Louie Labs user sets the
// command; the camera fetches it from /api/command-poll (which reads the now-
// private command path with admin credentials) and acts on it. The server
// (admin) is the only thing allowed to WRITE the command, so a stranger
// cannot order a camera around.
//
// 'update' tells the camera to check the published OTA manifest and, if it's
// newer than what's running, download + boot the new image. The command stays
// pending until the camera's first-boot acceptance photo is uploaded (which
// calls /api/capture-complete -> clears it to idle) OR the admin clicks Idle.
const ALLOWED = new Set(['take_picture', 'reboot', 'idle', 'update']);

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

    await rtdbSet(`devices/${deviceId}/command`, action);
    return NextResponse.json({ deviceId, command: action });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
