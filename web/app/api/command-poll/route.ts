import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { rtdbGet } from '@/lib/rtdb';

// Must run on the Node.js runtime: rtdbGet needs the Google Cloud SDK + ADC.
export const runtime = 'nodejs';

// The camera polls HERE for its pending command instead of reading the database
// directly. The database's `command` path is no longer world-readable, so this
// route (which reads it with admin credentials, bypassing the rules) is the only
// way in. Same shared-key auth as /api/get-upload-url and /api/capture-complete.

// Compare without leaking timing info about how many characters matched.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-camera-api-key') || '';
  const expected = process.env.CAMERA_API_KEY || '';
  if (!expected || !safeEqual(apiKey, expected)) {
    return NextResponse.json({ error: 'Unauthorized camera' }, { status: 401 });
  }

  let deviceId = '';
  try {
    const body = await req.json();
    deviceId = String(body.deviceId || '').toLowerCase().trim();
  } catch {
    // fall through to the validation below, which rejects an empty id
  }
  if (!/^[a-z0-9_-]{3,40}$/.test(deviceId)) {
    return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
  }

  const command = (await rtdbGet<string>(`devices/${deviceId}/command`)) ?? 'idle';
  return NextResponse.json({ deviceId, command });
}
