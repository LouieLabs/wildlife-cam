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
//
// Two modes:
//   * body.id present  -> UPDATE the existing pending capture doc in place
//     (the doc capture-complete created with analyzed:false). This is what the
//     SpeciesNet worker uses -- no duplicate records.
//   * no body.id       -> legacy add() of a fresh record (kept for any caller
//     that never went through capture-complete).
//
// The `public` gallery gate is computed HERE, server-side, from the submitted
// labels -- never trusted from the caller: public means "no person, no dog".
// (See capture-complete: docs start public:false, fail-safe.)

// Case-insensitive person/dog screen for the unauthenticated gallery. Matches
// whole words so e.g. "dogwood" or "personata" can't false-positive.
function hasPersonOrDog(labels: string[]): boolean {
  return labels.some((l) => /\b(person|people|human|dog)\b/i.test(l));
}

// Keep only well-formed {label, confidence, box} entries; clamp label length so
// a buggy caller can't stuff a novel into Firestore.
function sanitizeDetections(raw: unknown): { label: string; confidence: number | null; box: number[] | null }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d: any) => d && typeof d.label === 'string' && d.label.trim().length > 0)
    .slice(0, 50)
    .map((d: any) => ({
      label: d.label.trim().slice(0, 80),
      confidence: typeof d.confidence === 'number' ? d.confidence : null,
      box:
        Array.isArray(d.box) && d.box.length === 4 && d.box.every((n: any) => typeof n === 'number')
          ? d.box
          : null,
    }));
}

// Optional pre-drawn boxes in the dashboard's DrawnBox shape
// ({class:'human'|'animal', bbox:[x,y,w,h]} in image pixels) -- the existing
// CaptureImage canvas renders these with zero frontend changes.
function sanitizeBoxes(raw: unknown): { class: 'human' | 'animal'; bbox: number[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (b: any) =>
        b &&
        (b.class === 'human' || b.class === 'animal') &&
        Array.isArray(b.bbox) &&
        b.bbox.length === 4 &&
        b.bbox.every((n: any) => typeof n === 'number')
    )
    .slice(0, 50)
    .map((b: any) => ({ class: b.class, bbox: b.bbox }));
}

export async function POST(req: NextRequest) {
  // 60/min per source IP -- the analyzer worker is a single backend caller,
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
    const deviceId = String(body.deviceId || '').trim();
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(deviceId)) {
      return NextResponse.json({ error: 'Invalid device ID' }, { status: 400 });
    }

    const detections = sanitizeDetections(body.detections);
    const isPublic = !hasPersonOrDog(detections.map((d) => d.label));

    // Mode 1: update the pending doc capture-complete already created.
    const docId = typeof body.id === 'string' ? body.id.trim() : '';
    if (docId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(docId)) {
        return NextResponse.json({ error: 'Invalid doc id' }, { status: 400 });
      }
      const update: Record<string, unknown> = {
        detections,
        analyzed: true,
        public: isPublic,
        analyzedAt: Date.now(),
      };
      const boxes = sanitizeBoxes(body.boxes);
      if (boxes.length) update.boxes = boxes; // dashboard draws these
      try {
        await adminFirestore.collection(COLLECTION).doc(docId).update(update);
      } catch {
        // update() throws when the doc doesn't exist -- tell the worker so it
        // drops the item instead of retrying forever.
        return NextResponse.json({ error: 'Unknown capture id' }, { status: 404 });
      }
      return NextResponse.json({ id: docId, public: isPublic });
    }

    // Mode 2 (legacy): record a fresh, already-analyzed detection.
    const ref = await adminFirestore.collection(COLLECTION).add({
      deviceId,
      env: APP_ENV, // tag so dev records can be purged without touching prod
      objectPath: typeof body.objectPath === 'string' ? body.objectPath : null,
      capturedAt: typeof body.capturedAt === 'number' ? body.capturedAt : Date.now(),
      detections,
      analyzed: true,
      public: isPublic,
      createdAt: Date.now(),
    });
    return NextResponse.json({ id: ref.id });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
