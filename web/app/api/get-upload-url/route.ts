import { NextRequest, NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';
import { APP_ENV } from '@/lib/appEnv';
import { requireDeviceSecret } from '@/lib/requireDeviceSecret';
import { HttpError } from '@/lib/requireLouieLabsUser';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

// Must run on the Node.js runtime: signing needs the Google Cloud SDK + ADC.
export const runtime = 'nodejs';

// KEYLESS: no keyFilename / credentials passed. The SDK picks up Application
// Default Credentials (your impersonated service account locally, or the
// runtime service account in production).
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';

export async function POST(req: NextRequest) {
  // Rate-limit by IP, BEFORE auth: a wrong-secret attacker would otherwise be
  // free to spray the endpoint, and IP is the only identifier we trust pre-auth.
  // Legit boards wake ~every 30s and make 2 calls per wake -- 60/min has ~15x
  // headroom over normal usage.
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:get-upload-url`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // missing body falls through to the deviceId check below
  }
  const deviceId = String(body?.deviceId || '').trim();

  try {
    await requireDeviceSecret(req, deviceId);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
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
