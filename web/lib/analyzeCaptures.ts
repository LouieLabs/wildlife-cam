// In-cloud AI animal detection — runs INSIDE the backend, keyless.
//
// In plain words: photos land in Firestore as "not analyzed". This module
// picks up a batch, shows each photo to Gemini (Google's vision model) with a
// zero-shot prompt ("what animals do you see, and where?"), and writes the
// labels + boxes back onto the same record. The dashboard then shows species
// names and draws the boxes.
//
// Security model (why there are NO API keys anywhere):
// - Gemini is called through **Vertex AI** (via the @google/genai SDK in
//   vertexai mode), which authenticates with the same keyless service-account
//   credentials (ADC) the rest of this backend already uses for
//   Storage/Firestore. Nothing to leak, rotate, or hand to students.
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
import { GoogleGenAI } from '@google/genai';
import { adminFirestore } from './firebaseAdmin';

const COLLECTION = 'wildlife_detections';
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';
const PROJECT = process.env.GCP_PROJECT_ID || 'louielabs-animal-cams';
// Vertex Gemini region. us-central1 has the widest model availability; this is
// independent of where the bucket/Firestore live (us-west1).
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Drop animal detections below this confidence from the SAVED list — keeps the
// dashboard clear of the model's low-conviction guesses. Person/dog are EXEMPT
// from this floor (see keepDetection): a faint "maybe a person" must still
// count, because it drives the privacy gate. Tunable without a redeploy.
const MIN_CONFIDENCE = Number(process.env.DETECTION_MIN_CONFIDENCE ?? '0.3');

// One retry on a transient Vertex hiccup (429/503/socket). Cheap insurance so a
// single blip doesn't leave a photo stuck "pending" until the next dashboard tick.
const MAX_ATTEMPTS = 2;

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

// Region hint — biases the model toward species that actually occur here
// (the cameras are in the Santa Cruz Mountains, CA). Overridable per-deploy for
// other sites without touching code.
const REGION_SPECIES =
  process.env.REGION_SPECIES ||
  'mule deer, coyote, bobcat, mountain lion, raccoon, gray fox, striped skunk, ' +
  'opossum, wild turkey, gray squirrel, rat, domestic dog, domestic cat';

// What we ask Gemini for. box_2d in [ymin, xmin, ymax, xmax] normalized to
// 0-1000 is the convention Gemini's detection training uses — asking in its
// native format gets far more reliable boxes than inventing our own. The prompt
// is tuned for the real failure modes of camera-trap frames: night infrared
// (grayscale), motion blur, partial animals at the frame edge, and — most
// important — false positives on empty scenes (a swaying branch is NOT a deer).
const PROMPT = `You are an expert wildlife biologist reviewing a motion-triggered CAMERA-TRAP photo.

The image may be:
- night INFRARED / black-and-white (glowing eyes, washed-out fur — still identify the animal)
- motion-blurred, grainy, or badly lit
- showing only PART of an animal at the frame edge

Report every distinct animal, person, or vehicle. For each, give a bounding box.
Likely species at this location: ${REGION_SPECIES}. Prefer these when the image supports it,
but do NOT force a match — report what you actually see.

Rules:
- Use a specific species label when you are reasonably sure (e.g. "mule deer", "raccoon").
  Use "animal" only when you truly cannot tell.
- Label a human as "person" and a dog as "dog" (these drive a privacy filter).
- confidence is your genuine 0..1 certainty. Be HONEST and conservative — it is
  far better to return [] than to hallucinate an animal in an empty frame. Vegetation,
  shadows, rain streaks, timestamps, and IR glare are NOT animals.

Respond with ONLY a JSON array, no prose, no markdown:
[{"label": "<species|person|vehicle|animal>", "confidence": <0..1>, "box_2d": [ymin, xmin, ymax, xmax]}]
box_2d are integers 0-1000 normalized to the image (top-left origin).
If there is no animal, person, or vehicle, respond with exactly: []`;

const isPersonOrDog = (label: string) => /\b(person|people|human|dog)\b/i.test(label);

// Gemini can wrap JSON in ```json fences despite responseMimeType — strip them
// before parsing so one stray fence doesn't fail an otherwise-good response.
function stripFences(t: string): string {
  return t.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// Should this detection survive into the saved list? Animals must clear the
// confidence floor; person/dog ALWAYS survive (even a faint one), because they
// drive the privacy gate and a missed person is a privacy leak, not just a
// missed label. A null confidence (model omitted it) is kept — unknown ≠ low.
function keepDetection(label: string, confidence: number | null): boolean {
  if (isPersonOrDog(label)) return true;
  return confidence === null || confidence >= MIN_CONFIDENCE;
}

// Minimal shape of the genai client we use — lets tests inject a fake without
// standing up the real GoogleGenAI.
export type GenAIClient = { models: { generateContent: (req: any) => Promise<{ text?: string }> } };

// One Gemini call for one image, with a retry on transient failures. Exported
// for testing; not called outside this module. Uses the current @google/genai
// SDK in Vertex mode (keyless ADC) — the old @google-cloud/vertexai SDK is EOL
// (removed June 2026) and was returning empty/degenerate responses.
export async function detectWithGemini(
  jpeg: Buffer,
  client?: GenAIClient
): Promise<{ detections: WireDetection[]; boxes: DrawnBox[]; containsPersonOrDog: boolean }> {
  const ai: GenAIClient =
    client ?? (new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION }) as unknown as GenAIClient);

  const request = {
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
        { text: PROMPT },
      ],
    }],
    config: { temperature: 0, responseMimeType: 'application/json' },
  };

  let res: { text?: string } | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await ai.models.generateContent(request);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new Error('Gemini call failed');

  const text = (res.text ?? '').trim();
  let raw: unknown;
  if (text === '') {
    // An empty response means "nothing detected" — treat as a clean empty scene
    // rather than an error, so the capture is marked analyzed and not retried
    // forever. (The old EOL SDK returned empty on flaky calls; the new one is
    // reliable, so a real empty here is a genuine no-op frame.)
    raw = [];
  } else {
    try {
      raw = JSON.parse(stripFences(text));
    } catch {
      throw new Error(`Gemini returned non-JSON: ${text.slice(0, 120)}`);
    }
  }
  if (!Array.isArray(raw)) raw = [];

  const dims = jpegDimensions(jpeg);
  const detections: WireDetection[] = [];
  const boxes: DrawnBox[] = [];
  // Privacy gate is computed from the RAW model output (before the confidence
  // floor), so a low-confidence person still forces the capture private.
  let containsPersonOrDog = false;

  for (const d of raw as any[]) {
    if (!d || typeof d.label !== 'string' || !d.label.trim()) continue;
    const label = d.label.trim().slice(0, 80);
    if (isPersonOrDog(label)) containsPersonOrDog = true;

    const confidence = typeof d.confidence === 'number' ? Math.min(1, Math.max(0, d.confidence)) : null;
    if (!keepDetection(label, confidence)) continue; // low-confidence animal guess — drop

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

  return { detections, boxes, containsPersonOrDog };
}

// Pick up to `limit` unanalyzed captures, run Gemini on each, update in place.
// Each doc is independent: one failure doesn't sink the batch, and a failed
// doc simply stays analyzed:false for the next round.
export async function analyzePendingCaptures(limit = 5, client?: GenAIClient): Promise<AnalyzeResult> {
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
      const { detections, boxes, containsPersonOrDog } = await detectWithGemini(jpeg, client);
      // Use the model's RAW person/dog signal, not the (confidence-filtered)
      // saved list — a faint person that was dropped from `detections` must
      // still keep the capture private. Fail-safe toward privacy.
      const isPublic = !containsPersonOrDog;

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
