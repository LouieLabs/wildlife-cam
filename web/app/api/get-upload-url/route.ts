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
  // Wake reason ("PIR" / "BUTTON" / "TIMER" / "COLDBOOT" / "UNKNOWN") and the
  // ORIGINAL capture time (epoch ms; 0 if NTP wasn't synced). The firmware
  // passes both -- for pending-photo uploads it parses them out of the LittleFS
  // filename so the cloud name reflects when the photo was TAKEN, not when it
  // was finally uploaded. Defensive sanitization: clamp reason to a small set;
  // fall back to upload-time clock if capturedAt is missing/zero.
  const ALLOWED_REASONS = new Set(['PIR', 'BUTTON', 'TIMER', 'COLDBOOT', 'UNKNOWN']);
  const reasonRaw = String(body?.wakeReason || '').toUpperCase();
  const reason = ALLOWED_REASONS.has(reasonRaw) ? reasonRaw : 'UNKNOWN';
  const capturedAt = Number(body?.capturedAt) > 0 ? Number(body.capturedAt) : Date.now();

  try {
    await requireDeviceSecret(req, deviceId);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  // Build descriptive object name: <deviceId>_YYMMDD-HHMMSS_<REASON>.jpg
  // UTC chosen over local TZ so names sort cleanly across cameras in different
  // timezones. Tag the parent path by environment so dev images all live under
  // "dev/" and can be purged without touching prod -- this is THE chokepoint
  // for every image reaching the bucket.
  const d = new Date(capturedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    String(d.getUTCFullYear()).slice(-2) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  const objectName = `${APP_ENV}/uploads/${deviceId}/${deviceId}_${stamp}_${reason}.jpg`;
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
