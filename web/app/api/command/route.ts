import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// Downstream commands to a camera (e.g. "take_picture"). A signed-in Louie Labs
// user sets the command; the camera fetches it from /api/command-poll (which
// reads the now-private command path with admin credentials) and acts on it.
// The server (admin) is the only thing allowed to WRITE the command, so a
// stranger cannot order a camera around.
const ALLOWED = new Set(['take_picture', 'reboot', 'idle']);

export async function POST(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 30/min per signed-in user -- clicking take-picture is human-paced.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:command`,
      limit: 30,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

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
