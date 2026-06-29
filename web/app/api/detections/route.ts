import { NextRequest, NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { APP_ENV } from '@/lib/appEnv';
import { timingSafeEqual } from 'crypto';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

const COLLECTION = 'wildlife_detections';
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// GET: dashboard reads recent detections (signed-in Louie Labs user only).
// The bucket is private, so for each record we mint a short-lived signed READ
// URL from its objectPath -- that's what the browser can actually open.
export async function GET(req: NextRequest) {
  try {
    const user = await requireLouieLabsUser(req);

    // 120/min per signed-in user -- the dashboard polls this alongside /devices.
    const rl = await checkRateLimit({
      key: `uid:${user.uid}:detections`,
      limit: 120,
      windowMs: 60_000,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
    }

    const snap = await adminFirestore
      .collection(COLLECTION)
      .orderBy('capturedAt', 'desc')
      .limit(50)
      .get();

    const detections = await Promise.all(
      snap.docs.map(async (d) => {
        const data = d.data() as any;
        let imageUrl: string | null = null;
        if (data.objectPath) {
          try {
            const [url] = await storage
              .bucket(BUCKET)
              .file(data.objectPath)
              .getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + 5 * 60 * 1000,
              });
            imageUrl = url;
          } catch {
            imageUrl = null;
          }
        }
        return { id: d.id, ...data, imageUrl };
      })
    );

    return NextResponse.json({ detections });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// POST: the Gemini detection pipeline records analysis results. This is a
// server-to-server hook (NOT called by boards), so it stays guarded by the
// shared CAMERA_API_KEY env var. Body:
//   { deviceId, objectPath, capturedAt, detections: [{label, confidence, box:[x,y,w,h]}] }
export async function POST(req: NextRequest) {
  // 60/min per source IP -- the Gemini pipeline will be a single backend caller,
  // so this is mostly a bot/abuse guard on this public path.
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:detections-post`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  const apiKey = req.headers.get('x-camera-api-key') || '';
  const expected = process.env.CAMERA_API_KEY || '';
  if (!expected || !safeEqual(apiKey, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const deviceId = String(body.deviceId || '').toLowerCase().trim();
    if (!/^[a-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

    const ref = await adminFirestore.collection(COLLECTION).add({
      deviceId,
      env: APP_ENV, // tag so dev records can be purged without touching prod
      objectPath: typeof body.objectPath === 'string' ? body.objectPath : null,
      capturedAt: typeof body.capturedAt === 'number' ? body.capturedAt : Date.now(),
      detections: Array.isArray(body.detections) ? body.detections : [],
      analyzed: true,
      createdAt: Date.now(),
    });
    return NextResponse.json({ id: ref.id });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
