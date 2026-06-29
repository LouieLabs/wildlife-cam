import { NextRequest, NextResponse } from 'next/server';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { rtdbSet } from '@/lib/rtdb';
import { APP_ENV } from '@/lib/appEnv';
import { requireDeviceSecret } from '@/lib/requireDeviceSecret';
import { HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// The camera calls this right after it uploads a photo. Two jobs:
//  1) clear the device's command back to "idle" -- the device itself can't write
//     the command path (rules), so the server does it here, which stops the
//     camera re-shooting on every wake.
//  2) record the capture in Firestore (wildlife_detections) as "not analyzed
//     yet"; a later Gemini step fills in the bounding boxes.
// Authenticated via the per-device secret in the x-device-secret header.
export async function POST(req: NextRequest) {
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:capture-complete`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  try {
    const body = await req.json();
    const deviceId = String(body.deviceId || '').toLowerCase().trim();
    // Accept either objectPath or objectName (what get-upload-url returns).
    const objectPath = String(body.objectPath || body.objectName || '').trim();

    await requireDeviceSecret(req, deviceId);

    // 1) clear the command
    await rtdbSet(`devices/${deviceId}/command`, 'idle');

    // 2) record the capture (analysis pending)
    const ref = await adminFirestore.collection('wildlife_detections').add({
      deviceId,
      env: APP_ENV, // tag so dev records can be purged without touching prod
      objectPath: objectPath || null,
      capturedAt: Date.now(),
      detections: [], // Gemini fills this in later
      analyzed: false,
      createdAt: Date.now(),
    });

    return NextResponse.json({ id: ref.id, command: 'idle' });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
