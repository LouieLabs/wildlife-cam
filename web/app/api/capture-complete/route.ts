import { NextRequest, NextResponse } from 'next/server';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { rtdbSet } from '@/lib/rtdb';
import { APP_ENV } from '@/lib/appEnv';
import { timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// The camera calls this right after it uploads a photo. Two jobs:
//  1) clear the device's command back to "idle" -- the device itself can't write
//     the command path (rules), so the server does it here, which stops the
//     camera re-shooting on every wake.
//  2) record the capture in Firestore (wildlife_detections) as "not analyzed
//     yet"; a later Gemini step fills in the bounding boxes.
// Protected by the shared CAMERA_API_KEY.
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-camera-api-key') || '';
  const expected = process.env.CAMERA_API_KEY || '';
  if (!expected || !safeEqual(apiKey, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const deviceId = String(body.deviceId || '').toLowerCase().trim();
    // Accept either objectPath or objectName (what get-upload-url returns).
    const objectPath = String(body.objectPath || body.objectName || '').trim();

    if (!/^[a-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

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
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
