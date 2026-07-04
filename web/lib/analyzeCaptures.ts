// In-cloud AI animal detection — runs INSIDE the backend, keyless.
//
// In plain words: photos land in Firestore as "not analyzed". This module
// picks up a batch, shows each photo to Gemini (Google's vision model) with a
// zero-shot prompt ("what animals do you see, and where?"), and writes the
// labels + boxes back onto the same record. The dashboard then shows species
// names and draws the boxes.
//
// Security model (why there are NO API keys anywhere):
// - Gemini is called through **Vertex AI**, which authenticates with the same
//   keyless service-account credentials (ADC) the rest of this backend already
//   uses for Storage/Firestore. Nothing to leak, rotate, or hand to students.
// - Analysis is triggered by an authed dashboard route (see
//   app/api/analyze-pending/route.ts), not by any outside caller.
//
// One-time GCP setup (console, ~2 clicks — see PR description):
//   1. Enable the "Vertex AI API" on the project.
//   2. Grant the cloud-backend service account the "Vertex AI User" role.
//
// Phase 2 (future, with the team): a Python Cloud Run job adds YOLOv8 boxes
// before/alongside Gemini, and eventually a tiny on-device model gates uploads.

import { Storage } from '@google-cloud/storage';
import { VertexAI } from '@google-cloud/vertexai';
import { adminFirestore } from './firebaseAdmin';

const COLLECTION = 'wildlife_detections';
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';
const PROJECT = process.env.GCP_PROJECT_ID || 'louielabs-animal-cams';
// Vertex Gemini region. us-central1 has the widest model availability; this is
// independent of where the bucket/Firestore live (us-west1).
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const storage = new Storage({ projectId: PROJECT });

export type WireDetection = { label: string; confidence: number | null; box: number[] | null };
export type DrawnBox = { class: 'human' | 'animal'; bbox: number[] };

export type AnalyzeResult = {
  scanned: number;   // pending docs picked up
  analyzed: number;  // docs successfully updated
  errors: number;    // docs that failed this round (stay pending, retried later)
};

// The unauthenticated gallery may only ever show captures with no person and
// no dog. Whole-word match so "dogwood"/"personata"-style labels can't trip it.
export function hasPersonOrDog(labels: string[]): boolean {
  return labels.some((l) => /\b(person|people|human|dog)\b/i.test(l));
}

// Minimal JPEG dimension reader: scan for a Start-Of-Frame marker (C0-CF,
// minus the non-SOF C4/C8/CC) and read height/width from it. Avoids pulling in
// an image library just for two numbers. Returns null on anything unexpected.
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }              // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // no length
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// What we ask Gemini for. box_2d in [ymin, xmin, ymax, xmax] normalized to
// 0-1000 is the convention Gemini's detection training uses — asking in its
// native format gets far more reliable boxes than inventing our own.
const PROMPT = `You are analyzing a wildlife camera-trap photo (may be daytime, night IR, or low quality).
List every animal, person, and vehicle you can see. Respond with ONLY a JSON array, no prose:
[{"label": "<species or 'person' or 'vehicle'>", "confidence": <0..1>, "box_2d": [ymin, xmin, ymax, xmax]}]
box_2d values are integers 0-1000 normalized to the image. Use specific species when you can
(e.g. "mule deer", "coyote", "raccoon", "bobcat"); use "animal" if unsure of species.
If the image shows no animals/people/vehicles, respond with [].`;

// One Gemini call for one image. Exported for testing; not called outside.
export async function detectWithGemini(
  jpeg: Buffer,
  vertex?: VertexAI
): Promise<{ detections: WireDetection[]; boxes: DrawnBox[] }> {
  const ai = vertex ?? new VertexAI({ project: PROJECT, location: LOCATION });
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });

  const res = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
        { text: PROMPT },
      ],
    }],
  });

  const text = res.response.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 120)}`);
  }
  if (!Array.isArray(raw)) raw = [];

  const dims = jpegDimensions(jpeg);
  const detections: WireDetection[] = [];
  const boxes: DrawnBox[] = [];

  for (const d of raw as any[]) {
    if (!d || typeof d.label !== 'string' || !d.label.trim()) continue;
    const label = d.label.trim().slice(0, 80);
    const confidence = typeof d.confidence === 'number' ? Math.min(1, Math.max(0, d.confidence)) : null;

    // Convert Gemini's [ymin,xmin,ymax,xmax]/1000 into the dashboard's pixel
    // [x, y, w, h]. Without dimensions we keep the label but drop the box.
    let box: number[] | null = null;
    if (
      dims &&
      Array.isArray(d.box_2d) &&
      d.box_2d.length === 4 &&
      d.box_2d.every((n: any) => typeof n === 'number')
    ) {
      const [ymin, xmin, ymax, xmax] = d.box_2d;
      box = [
        Math.round((xmin / 1000) * dims.width),
        Math.round((ymin / 1000) * dims.height),
        Math.round(((xmax - xmin) / 1000) * dims.width),
        Math.round(((ymax - ymin) / 1000) * dims.height),
      ];
    }

    detections.push({ label, confidence, box });
    if (box) {
      boxes.push({ class: /\b(person|people|human)\b/i.test(label) ? 'human' : 'animal', bbox: box });
    }
    if (detections.length >= 20) break; // sanity cap
  }

  return { detections, boxes };
}

// Pick up to `limit` unanalyzed captures, run Gemini on each, update in place.
// Each doc is independent: one failure doesn't sink the batch, and a failed
// doc simply stays analyzed:false for the next round.
export async function analyzePendingCaptures(limit = 5, vertex?: VertexAI): Promise<AnalyzeResult> {
  // where()+limit() only (no orderBy) so no composite index is required.
  const snap = await adminFirestore
    .collection(COLLECTION)
    .where('analyzed', '==', false)
    .limit(limit)
    .get();

  const result: AnalyzeResult = { scanned: snap.docs.length, analyzed: 0, errors: 0 };

  for (const doc of snap.docs) {
    const data = doc.data() as any;
    if (!data.objectPath) continue; // can never be analyzed; leave for cleanup
    try {
      const [jpeg] = await storage.bucket(BUCKET).file(data.objectPath).download();
      const { detections, boxes } = await detectWithGemini(jpeg, vertex);
      const isPublic = !hasPersonOrDog(detections.map((d) => d.label));

      const update: Record<string, unknown> = {
        detections,
        analyzed: true,
        public: isPublic, // gate stays server-side, computed from what the model saw
        analyzedAt: Date.now(),
        analyzedBy: `vertex:${MODEL}`,
      };
      if (boxes.length) update.boxes = boxes; // dashboard canvas draws these

      await doc.ref.update(update);
      result.analyzed++;
    } catch (err) {
      result.errors++;
      console.error(`[analyze] ${doc.id} (${data.objectPath}) failed:`, err);
    }
  }
  return result;
}
