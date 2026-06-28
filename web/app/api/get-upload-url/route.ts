import { NextRequest, NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';
import { timingSafeEqual } from 'crypto';
import { APP_ENV } from '@/lib/appEnv';

// Must run on the Node.js runtime: signing needs the Google Cloud SDK + ADC.
export const runtime = 'nodejs';

// KEYLESS: no keyFilename / credentials passed. The SDK picks up Application
// Default Credentials (your impersonated service account locally, or the
// runtime service account in production).
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';

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

  // Optional deviceId in the body just shapes the object name; it is sanitized.
  let deviceId = 'unknown';
  try {
    const body = await req.json();
    if (body && typeof body.deviceId === 'string') {
      deviceId = body.deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'unknown';
    }
  } catch {
    // No JSON body is fine -- we fall back to the default object name.
  }

  // Tag the path by environment so dev images all live under "dev/" and can be
  // purged without touching prod. This is THE chokepoint -- every image reaching
  // the bucket (field auto-capture, a "save" button, future movies) comes
  // through here, so everything is tagged automatically.
  const objectName = `${APP_ENV}/uploads/${deviceId}/${Date.now()}.jpg`;
  const [uploadUrl] = await storage
    .bucket(BUCKET)
    .file(objectName)
    .getSignedUrl({
      version: 'v4',
      action: 'write',          // the camera does an HTTP PUT to this URL
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
      contentType: 'image/jpeg',
    });

  return NextResponse.json({ uploadUrl, objectName, expiresInSeconds: 300 });
}
