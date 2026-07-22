// In-cloud AI animal detection — runs INSIDE the backend, keyless.
//
// In plain words: photos land in Firestore as "not analyzed". This module
// picks up a batch and, for each photo, asks up to two models:
//
//   1. SpeciesNet (optional, our private camera-trap specialist service):
//      "is there actually an animal here, and where?" If it sees nothing, we
//      stop — no Gemini call, no hallucinated deer in an empty frame.
//   2. Gemini (Vertex AI): fine species labeling, primed with what the
//      specialist found so it confirms/refines instead of free-associating.
//
// The merged labels + boxes are written back onto the same record; the
// dashboard shows species names and draws the boxes. If the SpeciesNet
// service is unset (SPECIESNET_SERVICE_URL) or unreachable, the pipeline is
// exactly the old Gemini-only path — never worse than before.
//
// Security model (why there are NO API keys anywhere):
// - Gemini is called through **Vertex AI** (via the @google/genai SDK in
//   vertexai mode), which authenticates with the same keyless service-account
//   credentials (ADC) the rest of this backend already uses for
//   Storage/Firestore. Nothing to leak, rotate, or hand to students.
// - SpeciesNet runs as our own **private Cloud Run service** — Cloud Run IAM
//   only admits this backend's identity (see lib/speciesnetClient.ts).
// - Analysis is triggered by an authed dashboard route (see
//   app/api/analyze-pending/route.ts), not by any outside caller.
//
// One-time GCP setup (console — see PR description):
//   1. Enable the "Vertex AI API" on the project.
//   2. Grant the cloud-backend service account the "Vertex AI User" role.
//   3. (For the SpeciesNet gate) deploy speciesnet-service/ and grant
//      cloud-backend@ roles/run.invoker on it — see speciesnet-service/README.md.

import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';
import { adminFirestore } from './firebaseAdmin';
import {
  isSpeciesNetEnabled,
  getDefaultSpeciesNetClient,
  type SpeciesNetClient,
  type SpeciesNetDetection,
} from './speciesnetClient';

const COLLECTION = 'wildlife_detections';
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || 'wildlife-camera-telemetry';
const PROJECT = process.env.GCP_PROJECT_ID || 'louielabs-animal-cams';
// Vertex Gemini region. us-central1 has the widest model availability; this is
// independent of where the bucket/Firestore live (us-west1).
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
// gemini-2.5-pro: more accurate on the hard camera-trap frames (night IR,
// motion blur, partial animals) than -flash. Slower + costs a bit more per
// photo — override to gemini-2.5-flash via env if latency/cost matters more.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

// Drop animal detections below this confidence from the SAVED list — keeps the
// dashboard clear of the model's low-conviction guesses. Person/dog are EXEMPT
// from this floor (see keepDetection): a faint "maybe a person" must still
// count, because it drives the privacy gate. Tunable without a redeploy.
const MIN_CONFIDENCE = Number(process.env.DETECTION_MIN_CONFIDENCE ?? '0.3');

// The GATE floor — distinct from MIN_CONFIDENCE above on purpose. MIN_CONFIDENCE
// filters what we SAVE; this filters what counts as "something is in the frame"
// at all. A SpeciesNet detection below this bar is treated as noise and the
// frame as empty (Gemini never runs).
//
// Set to 0.6 after a human-judged review of 172 real captures: below ~0.6 the
// detector's hits on these frames were spurious (weak "person" on empty yards),
// while its real animals scored well above it. Tune via env without a redeploy.
//
// NOTE this is the ANIMAL/attention gate only. Privacy is still computed from
// the RAW detection list BEFORE this floor (see speciesnetSaysPersonOrDog), so a
// faint possible person keeps the photo private even though it's below 0.6 —
// fail-safe toward privacy, deliberately not subject to this threshold.
const SPECIESNET_MIN_CONFIDENCE = Number(process.env.SPECIESNET_GATE_MIN_CONFIDENCE ?? '0.6');

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
- ROTATED 90°/180° (the camera is often mounted sideways, so subjects may be lying
  on their side or upside down) — mentally rotate the scene and identify anyway

Report every distinct animal, person, or vehicle. For each, give a bounding box.
Likely species at this location: ${REGION_SPECIES}. Prefer these when the image supports it,
but do NOT force a match — report what you actually see.

Rules:
- Use a specific species label when you are reasonably sure (e.g. "mule deer", "raccoon").
  Use "animal" only when you truly cannot tell what kind.
- Label a human as "person" and a dog as "dog" (these drive a privacy filter).
- confidence is your genuine 0..1 certainty. Be HONEST and conservative — it is
  far better to return [] than to hallucinate an animal in an empty frame. Vegetation,
  shadows, ceiling lights, furniture, rain streaks, timestamps, and IR glare are NOT animals.
- box_2d are integers 0-1000 normalized to the image (ymin, xmin, ymax, xmax, top-left origin),
  drawn in the image AS GIVEN (do not rotate the coordinates).

Respond with ONLY a JSON array, no prose, no markdown. Worked examples:
- A deer standing on the right side:
  [{"label":"mule deer","confidence":0.94,"box_2d":[300,600,900,860]}]
- A person close to the lens + a dog beside them:
  [{"label":"person","confidence":0.9,"box_2d":[80,380,1000,720]},{"label":"dog","confidence":0.82,"box_2d":[640,120,980,360]}]
- A raccoon at night, only its head visible at the edge:
  [{"label":"raccoon","confidence":0.6,"box_2d":[400,0,700,180]}]
- An empty room, just lights/furniture/glare (NOTHING alive):
  []

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

// Turn SpeciesNet's findings into a prompt addendum for Gemini. The base
// PROMPT stays untouched; this block is appended only when the specialist
// found something, so Gemini confirms/refines a real candidate instead of
// free-associating. boxNorm is [x,y,w,h] 0..1, converted to Gemini's native
// [ymin,xmin,ymax,xmax] 0-1000 — no pixel dimensions needed.
// Labels are sanitized (letters/digits/space/hyphen, length-clamped) before
// they touch the prompt; the block explicitly allows Gemini to reject a
// candidate, so a bad label can't force a false positive through.
function candidateBlock(candidates: SpeciesNetDetection[]): string {
  const lines = candidates.map((c) => {
    const name =
      (c.label ?? c.category).replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 40) || c.category;
    const [x, y, w, h] = c.boxNorm;
    const box = [y, x, y + h, x + w].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 1000));
    return `- ${name} (confidence ${c.confidence.toFixed(2)}) around box_2d [${box.join(',')}]`;
  });
  return (
    '\n\nA specialist camera-trap detector already scanned this photo and flagged:\n' +
    lines.join('\n') +
    '\nConfirm or correct each candidate. If you agree, reuse that species name; if it is ' +
    'wrong, give the correct one; if it is not really an animal/person/vehicle, omit it. ' +
    'You may also report anything the detector missed. Same JSON-only output rules.'
  );
}

// One Gemini call for one image, with a retry on transient failures. Exported
// for testing; not called outside this module. Uses the current @google/genai
// SDK in Vertex mode (keyless ADC) — the old @google-cloud/vertexai SDK is EOL
// (removed June 2026) and was returning empty/degenerate responses.
export async function detectWithGemini(
  jpeg: Buffer,
  client?: GenAIClient,
  opts?: { candidates?: SpeciesNetDetection[] }
): Promise<{ detections: WireDetection[]; boxes: DrawnBox[]; containsPersonOrDog: boolean }> {
  const ai: GenAIClient =
    client ?? (new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION }) as unknown as GenAIClient);

  const prompt = opts?.candidates?.length ? PROMPT + candidateBlock(opts.candidates) : PROMPT;
  const request = {
    model: MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
        { text: prompt },
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
  // Privacy gate is computed from the RAW model output (before the confidence
  // floor and BEFORE the 20-item cap below), so a low-confidence person — or
  // one appearing late in a crowded output — still forces the capture private.
  const containsPersonOrDog = (raw as any[]).some(
    (d) => d && typeof d.label === 'string' && isPersonOrDog(d.label)
  );

  for (const d of raw as any[]) {
    if (!d || typeof d.label !== 'string' || !d.label.trim()) continue;
    const label = d.label.trim().slice(0, 80);

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
    if (detections.length >= 20) break; // sanity cap
  }

  return { detections, boxes: boxesFromDetections(detections), containsPersonOrDog };
}

// The dashboard's canvas overlay shape: red boxes for humans, yellow for
// everything else. Skips detections that carry no box.
function boxesFromDetections(detections: WireDetection[]): DrawnBox[] {
  const boxes: DrawnBox[] = [];
  for (const d of detections) {
    if (d.box) {
      boxes.push({ class: /\b(person|people|human)\b/i.test(d.label) ? 'human' : 'animal', bbox: d.box });
    }
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// SpeciesNet + Gemini composition
// ---------------------------------------------------------------------------

// "Overlap score" of two [x,y,w,h] pixel boxes (intersection over union,
// 0 = separate, 1 = identical). Used to decide when the two models are
// talking about the same animal.
function boxIoU(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

// A label that names no actual species — never allowed to overwrite a real one.
function isGenericLabel(label: string): boolean {
  return /^(animal|animals|unknown|mammal|blank|no ?cv ?result)$/i.test(label.trim());
}

// SpeciesNet detection -> the shape Firestore stores. Label falls back to the
// category word ("animal"/"person"/"vehicle") when the classifier had no name.
function speciesnetToWire(d: SpeciesNetDetection): WireDetection {
  return {
    label: ((d.label ?? '').trim() || d.category).slice(0, 80),
    confidence: Math.min(1, Math.max(0, d.confidence)),
    box: d.box.map((n) => Math.round(n)),
  };
}

// Privacy check on the RAW SpeciesNet list (before any confidence floor):
// a person-category box OR a dog-ish species name keeps the photo private.
function speciesnetSaysPersonOrDog(raw: SpeciesNetDetection[]): boolean {
  return raw.some(
    (d) => d.category === 'person' || (typeof d.label === 'string' && isPersonOrDog(d.label))
  );
}

// Combine what both models saw. In plain words: the specialist detector draws
// the boxes and proves the frame isn't empty; Gemini's job is to NAME what the
// specialist found. So the specialist's box always wins for a matched pair,
// Gemini's name wins only when it's a real species (it may not downgrade
// "bobcat" back to a vague "animal"), and anything extra Gemini spotted on its
// own is kept only if it, too, names a real species — vague extras are exactly
// the hallucinations we're trying to get rid of.
export function mergeDetections(sn: WireDetection[], gm: WireDetection[]): WireDetection[] {
  const merged: WireDetection[] = [];
  const usedGm = new Set<number>();

  for (const s of sn) {
    let bestIdx = -1;
    let bestIoU = 0;
    gm.forEach((g, i) => {
      if (usedGm.has(i) || !s.box || !g.box) return;
      const iou = boxIoU(s.box, g.box);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0 && bestIoU >= 0.5) {
      usedGm.add(bestIdx);
      const g = gm[bestIdx];
      const geminiNames = !isGenericLabel(g.label);
      merged.push({
        label: geminiNames ? g.label : s.label,
        confidence: geminiNames ? g.confidence ?? s.confidence : s.confidence,
        box: s.box, // the specialist's box always wins
      });
    } else {
      merged.push(s); // Gemini missed it — keep the specialist's answer whole
    }
  }

  gm.forEach((g, i) => {
    if (!usedGm.has(i) && !isGenericLabel(g.label)) merged.push(g);
  });

  return merged;
}

export type AnalyzeImageResult = {
  detections: WireDetection[];
  boxes: DrawnBox[];
  // The final public-gallery verdict, decided HERE so every routing path has
  // to answer it explicitly. false whenever either model saw a person/dog —
  // and also when we couldn't rule one out (see the unnamed-animal rule in
  // speciesnetOnly). Fail-safe toward private.
  isPublic: boolean;
  analyzedBy: string; // which path produced this — auditable later in Firestore
};

// null = feature off (env unset, nothing injected) -> pure-Gemini path.
function resolveSpeciesNet(client?: SpeciesNetClient): SpeciesNetClient | null {
  if (client) return client;
  return isSpeciesNetEnabled() ? getDefaultSpeciesNetClient() : null;
}

// The full two-model routing for one photo:
//
//   SpeciesNet unavailable ──► Gemini-only            "speciesnet-down+vertex:…"
//   feature off            ──► Gemini-only            "vertex:…"
//   nothing ≥ gate floor   ──► empty, skip Gemini     "speciesnet-gate"
//   person/vehicle only    ──► keep boxes, skip Gemini "speciesnet-only"
//   animal found           ──► Gemini w/ candidates, merge
//                              (Gemini fails ► keep SpeciesNet) "speciesnet-only"
export async function analyzeImage(
  jpeg: Buffer,
  clients?: { gemini?: GenAIClient; speciesnet?: SpeciesNetClient }
): Promise<AnalyzeImageResult> {
  const speciesnet = resolveSpeciesNet(clients?.speciesnet);
  if (!speciesnet) {
    const g = await detectWithGemini(jpeg, clients?.gemini);
    return { detections: g.detections, boxes: g.boxes, isPublic: !g.containsPersonOrDog, analyzedBy: `vertex:${MODEL}` };
  }

  let snRaw: SpeciesNetDetection[];
  try {
    snRaw = (await speciesnet.detect(jpeg)).detections;
  } catch (err) {
    // Fail OPEN: a down/cold/misconfigured service must never stall the
    // pipeline — this photo just runs the old Gemini-only path.
    console.warn('[analyze] SpeciesNet unavailable, Gemini-only for this photo:', err);
    const g = await detectWithGemini(jpeg, clients?.gemini);
    return {
      detections: g.detections,
      boxes: g.boxes,
      isPublic: !g.containsPersonOrDog,
      analyzedBy: `speciesnet-down+vertex:${MODEL}`,
    };
  }

  const snPersonOrDog = speciesnetSaysPersonOrDog(snRaw); // RAW, pre-floor — fail-safe private
  const gated = snRaw.filter((d) => d.confidence >= SPECIESNET_MIN_CONFIDENCE);

  // Empty frame: the whole point of the gate. No Gemini call, no hallucinations.
  if (gated.length === 0) {
    return { detections: [], boxes: [], isPublic: !snPersonOrDog, analyzedBy: 'speciesnet-gate' };
  }

  const speciesnetOnly = (): AnalyzeImageResult => {
    const detections = gated.map(speciesnetToWire).filter((d) => keepDetection(d.label, d.confidence));
    // Unnamed-animal rule: on this path Gemini never weighed in, so an animal
    // the specialist couldn't NAME (classifier said blank/unknown — common on
    // hard night frames) might still be a dog. Without a second opinion to
    // rule that out, the photo stays private. A specifically-named non-dog
    // animal (e.g. "gray fox") may still go public.
    const unnamedAnimal = gated.some(
      (d) => d.category === 'animal' && (!d.label || isGenericLabel(d.label))
    );
    return {
      detections,
      boxes: boxesFromDetections(detections),
      isPublic: !snPersonOrDog && !unnamedAnimal,
      analyzedBy: 'speciesnet-only',
    };
  };

  // Person/vehicle but no animal: Gemini's value-add is fine species naming,
  // which doesn't apply — and a person photo is private no matter what Gemini
  // would say. Keep the specialist's boxes and stop here.
  if (!gated.some((d) => d.category === 'animal')) return speciesnetOnly();

  let g: { detections: WireDetection[]; boxes: DrawnBox[]; containsPersonOrDog: boolean };
  try {
    g = await detectWithGemini(jpeg, clients?.gemini, { candidates: gated });
  } catch (err) {
    // We already KNOW there's an animal with a good box; banking that beats
    // flapping the doc back to pending to re-run both models.
    console.warn('[analyze] Gemini failed after gate-pass; saving SpeciesNet-only:', err);
    return speciesnetOnly();
  }

  const merged = mergeDetections(gated.map(speciesnetToWire), g.detections).filter((d) =>
    keepDetection(d.label, d.confidence)
  );
  return {
    detections: merged,
    boxes: boxesFromDetections(merged),
    // Union — either model can veto public. Both saw the photo, so a person
    // or dog flagged by just one of them is enough to keep it private.
    isPublic: !snPersonOrDog && !g.containsPersonOrDog,
    analyzedBy: `speciesnet-gate+vertex:${MODEL}`,
  };
}

// How many Gemini calls run at once inside a batch. A motion BURST drops many
// photos at nearly the same moment; analyzing them one-by-one serialized the
// slow model (~10-20 s each) and a 10-photo burst took several minutes to go
// public. Four concurrent calls keep a whole burst inside one request window.
const ANALYZE_CONCURRENCY = 4;

// Pick up to `limit` unanalyzed captures, run the two-model analysis on each,
// update in place. Each doc is independent: one failure doesn't sink the
// batch, and a failed doc simply stays analyzed:false for the next round.
export async function analyzePendingCaptures(
  limit = 5,
  client?: GenAIClient,
  speciesnetClient?: SpeciesNetClient
): Promise<AnalyzeResult> {
  // where()+limit() only (no orderBy) so no composite index is required.
  const snap = await adminFirestore
    .collection(COLLECTION)
    .where('analyzed', '==', false)
    .limit(limit)
    .get();

  const result: AnalyzeResult = { scanned: snap.docs.length, analyzed: 0, errors: 0 };

  async function analyzeOne(doc: (typeof snap.docs)[number]): Promise<void> {
    const data = doc.data() as any;
    if (!data.objectPath) return; // can never be analyzed; leave for cleanup
    try {
      const [jpeg] = await storage.bucket(BUCKET).file(data.objectPath).download();
      // analyzeImage owns the public/private verdict: it's computed from the
      // models' RAW person/dog signals (not the confidence-filtered saved
      // list), so a faint person that was dropped from `detections` still
      // keeps the capture private. Fail-safe toward privacy.
      const { detections, boxes, isPublic, analyzedBy } = await analyzeImage(jpeg, {
        gemini: client,
        speciesnet: speciesnetClient,
      });

      const update: Record<string, unknown> = {
        detections,
        analyzed: true,
        public: isPublic, // gate stays server-side, computed from what the models saw
        analyzedAt: Date.now(),
        analyzedBy, // which routing path ran — audit gate quality from Firestore
      };
      if (boxes.length) update.boxes = boxes; // dashboard canvas draws these

      await doc.ref.update(update);
      result.analyzed++;
    } catch (err) {
      result.errors++;
      console.error(`[analyze] ${doc.id} (${data.objectPath}) failed:`, err);
    }
  }

  // Chunked concurrency: up to ANALYZE_CONCURRENCY photos in flight at once.
  for (let i = 0; i < snap.docs.length; i += ANALYZE_CONCURRENCY) {
    await Promise.all(snap.docs.slice(i, i + ANALYZE_CONCURRENCY).map(analyzeOne));
  }
  return result;
}
