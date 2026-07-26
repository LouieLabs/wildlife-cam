// Animal detection for the dashboard — SpeciesNet only, keyless.
//
// In plain words: photos land in Firestore as "not analyzed". This module picks
// up a batch and asks ONE model — Google's open-source SpeciesNet, the
// camera-trap specialist — two questions at once: "is there an animal here?"
// and "what species is it?". The answers (labels + boxes) get written back onto
// the same record, and the dashboard draws them.
//
// SpeciesNet does BOTH jobs, so there is no second model and no per-photo AI
// bill. It also honestly reports "animal" when it can't name the species,
// instead of inventing one.
//
// Security model (why there are NO API keys anywhere):
// - SpeciesNet runs as our own **private Cloud Run service** — Cloud Run's IAM
//   layer only admits this backend's identity, proven with a short-lived
//   Google-signed token (see lib/speciesnetClient.ts). Nothing to leak or rotate.
// - Analysis is triggered by an authed dashboard route (see
//   app/api/analyze-pending/route.ts), not by any outside caller.
//
// If SPECIESNET_SERVICE_URL is not set, analysis simply does not run: captures
// stay `analyzed:false` (and therefore private) until the service is deployed,
// then get picked up on the next tick. We never mark a photo analyzed that no
// model actually looked at.
//
// One-time GCP setup: deploy speciesnet-service/ and grant cloud-backend@
// roles/run.invoker on it — see speciesnet-service/README.md.

import { Storage } from '@google-cloud/storage';
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

// Drop animal detections below this confidence from the SAVED list — keeps the
// dashboard clear of low-conviction guesses. Person/dog are EXEMPT from this
// floor (see keepDetection): a faint "maybe a person" must still count, because
// it drives the privacy gate. Tunable without a redeploy.
const MIN_CONFIDENCE = Number(process.env.DETECTION_MIN_CONFIDENCE ?? '0.3');

// The GATE floor — distinct from MIN_CONFIDENCE above on purpose.
// MIN_CONFIDENCE filters what we SAVE; this filters what counts as "something
// is in the frame" at all. Below this bar a detection is treated as noise and
// the frame as empty.
//
// Set to 0.6 after a human-judged review of 172 real captures: below ~0.6 the
// detector's hits on these frames were spurious (weak "person" on empty yards),
// while its real animals scored well above it. Tune via env without a redeploy.
//
// NOTE this is the ANIMAL/attention gate only. Privacy is computed from the RAW
// detection list BEFORE this floor (see speciesnetSaysPersonOrDog), so a faint
// possible person keeps a photo private even though it's below 0.6 — fail-safe
// toward privacy, deliberately not subject to this threshold.
const SPECIESNET_MIN_CONFIDENCE = Number(process.env.SPECIESNET_GATE_MIN_CONFIDENCE ?? '0.6');

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

const isPersonOrDog = (label: string) => /\b(person|people|human|dog)\b/i.test(label);

// A label that names no actual species — SpeciesNet's classifier returns these
// when it detects something but can't identify it (common on hard night frames).
function isGenericLabel(label: string): boolean {
  return /^(animal|animals|unknown|mammal|blank|no ?cv ?result)$/i.test(label.trim());
}

// Should this detection survive into the saved list? Animals must clear the
// confidence floor; person/dog ALWAYS survive (even a faint one), because they
// drive the privacy gate and a missed person is a privacy leak, not just a
// missed label. A null confidence is kept — unknown is not the same as low.
function keepDetection(label: string, confidence: number | null): boolean {
  if (isPersonOrDog(label)) return true;
  return confidence === null || confidence >= MIN_CONFIDENCE;
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

// SpeciesNet detection -> the shape Firestore stores. Label falls back to the
// category word ("animal"/"person"/"vehicle") when the classifier had no name.
function speciesnetToWire(d: SpeciesNetDetection): WireDetection {
  return {
    label: ((d.label ?? '').trim() || d.category).slice(0, 80),
    confidence: Math.min(1, Math.max(0, d.confidence)),
    box: d.box.map((n) => Math.round(n)),
  };
}

// Privacy check on the RAW detection list (before any confidence floor):
// a person-category box OR a dog-ish species name keeps the photo private.
function speciesnetSaysPersonOrDog(raw: SpeciesNetDetection[]): boolean {
  return raw.some(
    (d) => d.category === 'person' || (typeof d.label === 'string' && isPersonOrDog(d.label))
  );
}

export type AnalyzeImageResult = {
  detections: WireDetection[];
  boxes: DrawnBox[];
  // The final public-gallery verdict, decided HERE so every path has to answer
  // it explicitly. Fail-safe toward private.
  isPublic: boolean;
  analyzedBy: string; // which path produced this — auditable later in Firestore
};

// null = not configured (SPECIESNET_SERVICE_URL unset and nothing injected).
function resolveSpeciesNet(client?: SpeciesNetClient): SpeciesNetClient | null {
  if (client) return client;
  return isSpeciesNetEnabled() ? getDefaultSpeciesNetClient() : null;
}

// Analyze one photo.
//
//   nothing >= gate floor ──► empty frame        "speciesnet-empty"
//   detections found      ──► labels + boxes     "speciesnet"
//
// Throws if the service is unavailable — the caller leaves the doc pending so
// it retries later, rather than marking it analyzed with no labels.
export async function analyzeImage(
  jpeg: Buffer,
  clients?: { speciesnet?: SpeciesNetClient }
): Promise<AnalyzeImageResult> {
  const speciesnet = resolveSpeciesNet(clients?.speciesnet);
  if (!speciesnet) throw new Error('SpeciesNet is not configured (SPECIESNET_SERVICE_URL unset)');

  const raw = (await speciesnet.detect(jpeg)).detections;

  const personOrDog = speciesnetSaysPersonOrDog(raw); // RAW, pre-floor — fail-safe private
  const gated = raw.filter((d) => d.confidence >= SPECIESNET_MIN_CONFIDENCE);

  if (gated.length === 0) {
    return { detections: [], boxes: [], isPublic: !personOrDog, analyzedBy: 'speciesnet-empty' };
  }

  const detections = gated.map(speciesnetToWire).filter((d) => keepDetection(d.label, d.confidence));

  // Unnamed-animal rule: an animal the classifier couldn't NAME (it said
  // blank/unknown — common on hard night frames) might be a dog, and dogs are
  // barred from the public gallery. With no second opinion to rule that out,
  // the photo stays private. A specifically-named non-dog animal (e.g. "gray
  // fox") may still go public.
  const unnamedAnimal = gated.some(
    (d) => d.category === 'animal' && (!d.label || isGenericLabel(d.label))
  );

  return {
    detections,
    boxes: boxesFromDetections(detections),
    isPublic: !personOrDog && !unnamedAnimal,
    analyzedBy: 'speciesnet',
  };
}

// How many photos are analyzed at once inside a batch. A motion BURST drops
// many photos at nearly the same moment; analyzing them one-by-one made a
// 10-photo burst take minutes to reach the gallery. Four at a time keeps a
// whole burst inside one request window.
const ANALYZE_CONCURRENCY = 4;

// Pick up to `limit` unanalyzed captures, run SpeciesNet on each, update in
// place. Each doc is independent: one failure doesn't sink the batch, and a
// failed doc simply stays analyzed:false for the next round.
export async function analyzePendingCaptures(
  limit = 5,
  speciesnetClient?: SpeciesNetClient
): Promise<AnalyzeResult> {
  // No analyzer configured: do nothing at all rather than scanning and failing
  // once per photo. Captures stay pending (and private) until the service is
  // deployed, then the backlog gets picked up on the next tick.
  if (!resolveSpeciesNet(speciesnetClient)) {
    console.warn('[analyze] SPECIESNET_SERVICE_URL not set — analysis disabled; captures stay pending.');
    return { scanned: 0, analyzed: 0, errors: 0 };
  }

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
      // RAW person/dog signal (not the confidence-filtered saved list), so a
      // faint person dropped from `detections` still keeps the capture private.
      const { detections, boxes, isPublic, analyzedBy } = await analyzeImage(jpeg, {
        speciesnet: speciesnetClient,
      });

      const update: Record<string, unknown> = {
        detections,
        analyzed: true,
        public: isPublic, // gate stays server-side, computed from what the model saw
        analyzedAt: Date.now(),
        analyzedBy, // which path ran — audit gate quality from Firestore
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
