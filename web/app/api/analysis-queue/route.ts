import { NextRequest, NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { timingSafeEqual } from 'crypto';
import { checkRateLimit, clientIp, rateLimitHeaders } from '@/lib/rateLimit';

export const runtime = 'nodejs';

// GET /api/analysis-queue — the SpeciesNet worker's inbox.
//
// In plain words: the analyzer (a Python script running SpeciesNet — Google's
// open-source camera-trap model) asks "any photos nobody has analyzed yet?".
// We return up to MAX_BATCH pending captures, each with a short-lived signed
// READ link so the worker can download the image without holding any cloud
// keys — the same private-bucket pattern as /api/detections GET.
//
// Auth: this is a server-to-server path (NOT called by boards or browsers), so
// it's guarded by the shared CAMERA_API_KEY env var — the same guard as
// POST /api/detections, which is where the worker sends its results back.

const COLLECTION = 'wildlife_detections';
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';

// Small on purpose: the worker loops, so a modest batch keeps each signed URL
// well inside its expiry even when the model runs slowly on CPU.
const MAX_BATCH = 8;

// Signed-URL lifetime. Generous (15 min) because the worker downloads the whole
// batch first and then runs the model — on a slow CPU that can take minutes.
const URL_TTL_MS = 15 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  // 60/min per source IP — one polling worker, so this is a bot/abuse guard.
  const rl = await checkRateLimit({
    key: `ip:${clientIp(req)}:analysis-queue`,
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
    // Plain where() + limit(), no orderBy: a where+orderBy combo on different
    // fields needs a composite Firestore index; skipping the sort keeps this
    // deployable with zero console steps. The worker doesn't care about order.
    const snap = await adminFirestore
      .collection(COLLECTION)
      .where('analyzed', '==', false)
      .limit(MAX_BATCH)
      .get();

    const pending = (
      await Promise.all(
        snap.docs.map(async (d) => {
          const data = d.data() as any;
          // A capture with no objectPath can never be analyzed — skip it here
          // rather than making every worker re-discover that.
          if (!data.objectPath) return null;
          try {
            const [url] = await storage
              .bucket(BUCKET)
              .file(data.objectPath)
              .getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + URL_TTL_MS,
              });
            return {
              id: d.id,
              deviceId: data.deviceId ?? null,
              objectPath: data.objectPath,
              capturedAt: data.capturedAt ?? null,
              imageUrl: url,
            };
          } catch {
            return null; // can't sign (object gone?) — let the rest through
          }
        })
      )
    ).filter(Boolean);

    return NextResponse.json({ pending });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
