import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet } from '@/lib/rtdb';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';

export const runtime = 'nodejs';

// Recovery lookup: a signed-in Louie Labs student can retrieve a device's
// secret if they lose it. This is why we store secrets in clear. Access still
// requires a valid Louie Labs sign-in -- the public can never reach this.
export async function GET(req: NextRequest) {
  try {
    await requireLouieLabsUser(req);

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
