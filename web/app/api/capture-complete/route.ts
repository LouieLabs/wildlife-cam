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
//     yet"; a later analysis step fills in the bounding boxes.
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
    const deviceId = String(body.deviceId || '').trim();
    // Accept either objectPath or objectName (what get-upload-url returns).
    const objectPath = String(body.objectPath || body.objectName || '').trim();

    await requireDeviceSecret(req, deviceId);

    // 1) clear the command
    await rtdbSet(`devices/${deviceId}/command`, 'idle');

    // 2) record the capture (analysis pending)
    //
    // Fields with default values matter once /api/captures starts serving the
    // student gallery: `public` gates the unauth view (the analyzer sets true /
    // false based on person/dog/deterrent-cam detection), and temperatureF /
    // humidityPercent are reserved for a future per-camera weather lookup
    // (and eventually an onboard sensor). See docs/wildwatch-student-guide.md §04.
    const ref = await adminFirestore.collection('wildlife_detections').add({
      deviceId,
      env: APP_ENV, // tag so dev records can be purged without touching prod
      objectPath: objectPath || null,
      capturedAt: Date.now(),
      detections: [], // the analyzer fills this in later
      analyzed: false,
      public: false,           // safer default — set true only after verifying no person/dog
      temperatureF: null,      // city-weather lookup (planned) or onboard sensor (later) will fill these
      humidityPercent: null,
      createdAt: Date.now(),
    });

    // 3) Kick the analyzer NOW instead of waiting for the next gallery/dashboard
    // tick (which added up to 2 minutes before a photo could go public). We
    // self-POST /api/analyze-cron in "scheduled" mode (the CAMERA_API_KEY is in
    // our own env) and deliberately DON'T wait for the analysis to finish -- the
    // camera is on battery and must not sit awake through a model call. We wait
    // just long enough (<=350 ms) for the request to leave this instance, then
    // respond; the analyze-cron request keeps running on its own.
    // Any failure here is swallowed: the periodic ticks remain as the fallback.
    try {
      const key = process.env.CAMERA_API_KEY || '';
      if (key) {
        const ctrl = new AbortController();
        const abortTimer = setTimeout(() => ctrl.abort(), 3_000);
        const kick = fetch(new URL('/api/analyze-cron', req.nextUrl.origin), {
          method: 'POST',
          headers: { 'x-camera-api-key': key },
          signal: ctrl.signal,
        }).catch(() => {}).finally(() => clearTimeout(abortTimer));
        await Promise.race([kick, new Promise((r) => setTimeout(r, 350))]);
      }
    } catch { /* never block or fail the camera's call over this */ }

    return NextResponse.json({ id: ref.id, command: 'idle' });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
