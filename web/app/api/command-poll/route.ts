import { NextRequest, NextResponse } from 'next/server';
import { rtdbGet } from '@/lib/rtdb';
import { requireDeviceSecret } from '@/lib/requireDeviceSecret';
import { HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

// Must run on the Node.js runtime: rtdbGet needs the Google Cloud SDK + ADC.
export const runtime = 'nodejs';

// The camera polls HERE for its pending command instead of reading the database
// directly. The database's `command` path is no longer world-readable, so this
// route (which reads it with admin credentials, bypassing the rules) is the only
// way in. Authenticated via the per-device secret in the x-device-secret header.

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:command-poll`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  let deviceId = '';
  try {
    const body = await req.json();
    deviceId = String(body.deviceId || '').toLowerCase().trim();
  } catch {
    // fall through; requireDeviceSecret will reject the empty/invalid id
  }

  try {
    await requireDeviceSecret(req, deviceId);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const command = (await rtdbGet<string>(`devices/${deviceId}/command`)) ?? 'idle';
  return NextResponse.json({ deviceId, command });
}
