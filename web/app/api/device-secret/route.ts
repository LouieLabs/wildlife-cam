import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// Recovery lookup: a signed-in Louie Labs student can retrieve a device's
// secret if they lose it. This is why we store secrets in clear. Access still
// requires a valid Louie Labs sign-in -- the public can never reach this.
export async function GET(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 30/min per signed-in user -- recovery lookup is rare; a tighter cap here
    // protects against a stolen token being used to enumerate every device's
    // secret quickly.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:device-secret`,
      limit: 30,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const deviceId = (new URL(req.url).searchParams.get('deviceId') || '')
      .toLowerCase()
      .trim();
    if (!/^[a-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

    const secret = await rtdbGet<string>(`pre_shared_keys/${deviceId}`);
    if (secret === null) {
      return NextResponse.json({ error: 'No such device' }, { status: 404 });
    }

    return NextResponse.json({ deviceId, secret });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
