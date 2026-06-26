import { NextRequest, NextResponse } from 'next/server';
import { adminFirestore } from '@/lib/firebaseAdmin';
import { requireLouieLabsUser, HttpError } from '@/lib/requireLouieLabsUser';
import { timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';

const COLLECTION = 'wildlife_detections';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// GET: dashboard reads recent detections (signed-in Louie Labs user only).
export async function GET(req: NextRequest) {
  try {
    await requireLouieLabsUser(req);

    const snap = await adminFirestore
      .collection(COLLECTION)
      .orderBy('capturedAt', 'desc')
      .limit(50)
      .get();

    const detections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return NextResponse.json({ detections });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// POST: the detection pipeline (after a photo is uploaded and analyzed by
// Gemini) records a result. Protected by the shared CAMERA_API_KEY so only our
// trusted backend can write. Body shape:
//   { deviceId, imageUrl, capturedAt, detections: [{label, confidence, box:[x,y,w,h]}] }
export async function POST(req: NextRequest) {
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

    const doc = {
      deviceId,
      imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : null,
      capturedAt: typeof body.capturedAt === 'number' ? body.capturedAt : Date.now(),
      detections: Array.isArray(body.detections) ? body.detections : [],
      createdAt: Date.now(),
    };

    const ref = await adminFirestore.collection(COLLECTION).add(doc);
    return NextResponse.json({ id: ref.id });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
