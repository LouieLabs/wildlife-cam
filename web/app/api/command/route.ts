import { NextRequest, NextResponse } from 'next/server';
import { rtdbSet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

// CORS preflight: the louielabs.com gallery calls this route cross-origin.
// Auth is unchanged -- corsHeaders only echoes allowlisted origins.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

// Downstream commands to a camera (e.g. "take_picture"). A signed-in Louie Labs
// user sets the command; the camera fetches it from /api/command-poll (which
// reads the now-private command path with admin credentials) and acts on it.
// The server (admin) is the only thing allowed to WRITE the command, so a
// stranger cannot order a camera around.
const ALLOWED = new Set(['take_picture', 'reboot', 'idle']);

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req);
  try {
    const user = await requireLouieLabsUser(req);

    // 30/min per signed-in user -- clicking take-picture is human-paced.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:command`,
      limit: 30,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { ...cors, ...rateLimitHeaders(rl) } });
    }

    const body = await req.json();

    const deviceId = String(body.deviceId || '').trim();
    const action = String(body.action || '').toLowerCase().trim();

    if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400, headers: cors });
    }
    if (!ALLOWED.has(action)) {
      return NextResponse.json(
        { error: `Action must be one of: ${[...ALLOWED].join(', ')}` },
        { status: 400, headers: cors }
      );
    }

    await rtdbSet(`devices/${deviceId}/command`, action);
    return NextResponse.json({ deviceId, command: action }, { headers: cors });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: cors });
  }
}
