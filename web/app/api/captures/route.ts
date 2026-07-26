// GET /api/captures — public-facing read endpoint for the WildWatch gallery.
//
// Serves both:
//   * Unauthenticated visitors → only docs marked public:true
//   * Signed-in @louielabs.com users → all docs
//
// Returns CaptureCard[] matching docs/wildwatch-student-guide.md §04 exactly.
// Pulls images from the (private) GCS bucket via short-lived signed READ URLs
// so the bucket itself stays locked — same pattern as /api/detections.
//
// Filters by APP_ENV so dev and prod don't bleed across each other.

import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";
import { adminFirestore } from "@/lib/firebaseAdmin";
import { tryLouieLabsUser } from "@/lib/requireLouieLabsUser";
import { APP_ENV } from "@/lib/appEnv";
import { corsHeaders } from "@/lib/cors";

export const runtime = "nodejs";

const COLLECTION = "wildlife_detections";
const BUCKET = process.env.GCLOUD_STORAGE_BUCKET || "wildlife-camera-telemetry";
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });

const READ_URL_TTL_MS = 60 * 60 * 1000; // 1 hour
const OVERFETCH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Detection = {
  label: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
};

type CaptureCard = {
  id: string;
  imageUrl: string | null;
  timestamp: string;
  cameraId: string;
  species: string;
  confidence: number;
  temperatureF: number | null;
  humidityPercent: number | null;
  public: boolean;
  detections: Detection[];
  // Display rotation in degrees (0/90/180/270), set by an admin via
  // PATCH /api/captures/[id] when a camera was mounted sideways. Applied by
  // every gallery viewer so the photo reads upright for everyone.
  rotation: number;
  // Curation flag (PATCH /api/captures/[id] {hidden}). Public view never sees
  // hidden captures; signed-in views see them flagged.
  hidden: boolean;
};

// Existing pipeline writes detections[].box = [x, y, w, h] (array). The gallery
// schema wants detections[].bbox = { x, y, w, h }. Convert at read time so we
// don't have to migrate Firestore data.
function normalizeBbox(d: any): Detection {
  if (d.bbox && typeof d.bbox === "object") {
    return { label: d.label, confidence: d.confidence, bbox: d.bbox };
  }
  if (Array.isArray(d.box) && d.box.length === 4) {
    return {
      label: d.label,
      confidence: d.confidence,
      bbox: { x: d.box[0], y: d.box[1], w: d.box[2], h: d.box[3] },
    };
  }
  return {
    label: d.label,
    confidence: d.confidence,
    bbox: { x: 0, y: 0, w: 0, h: 0 },
  };
}

function toCaptureCard(id: string, data: any, imageUrl: string | null): CaptureCard {
  const detections: Detection[] = Array.isArray(data.detections)
    ? data.detections.map(normalizeBbox)
    : [];

  let species: string = data.species;
  let confidence: number = data.confidence;
  if (!species || typeof confidence !== "number") {
    const top = detections.length
      ? detections.reduce((a, b) => (a.confidence > b.confidence ? a : b))
      : null;
    if (!species && top) species = top.label;
    if (typeof confidence !== "number" && top) confidence = top.confidence;
  }

  return {
    id,
    imageUrl,
    timestamp: new Date(data.capturedAt || data.createdAt || Date.now()).toISOString(),
    cameraId: data.deviceId || "unknown",
    species: species || "unknown",
    confidence: typeof confidence === "number" ? confidence : 0,
    temperatureF: typeof data.temperatureF === "number" ? data.temperatureF : null,
    humidityPercent: typeof data.humidityPercent === "number" ? data.humidityPercent : null,
    // Default missing field to false (private) — only analyzer-confirmed publics
    // are shown to unauthenticated visitors.
    public: data.public === true,
    detections,
    // Only the four right angles are meaningful; anything else (missing field,
    // legacy junk) renders as "no rotation" rather than a skewed layout.
    rotation: [90, 180, 270].includes(data.rotation) ? data.rotation : 0,
    // Signed-in views receive hidden captures with this flag so the gallery
    // can mark them and offer "Unhide"; the public view never gets them.
    hidden: data.hidden === true,
  };
}

async function signReadUrl(objectPath: string): Promise<string | null> {
  try {
    const [url] = await storage
      .bucket(BUCKET)
      .file(objectPath)
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + READ_URL_TTL_MS,
      });
    return url;
  } catch {
    return null;
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const cors = corsHeaders(req);

  try {
    const user = await tryLouieLabsUser(req);
    const showPrivate = user !== null;

    const url = new URL(req.url);
    const species = url.searchParams.get("species") || undefined;
    const cameraId = url.searchParams.get("cameraId") || undefined;
    const after = url.searchParams.get("after") || undefined;
    const before = url.searchParams.get("before") || undefined;
    const publicOnlyParam = url.searchParams.get("publicOnly") === "true";
    const requestedLimit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
    const limit = Math.max(1, Math.min(MAX_LIMIT, isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));

    // The unauth view is always public-only. A signed-in user can opt in to
    // ?publicOnly=true (e.g. to preview what unauthenticated visitors see).
    const restrictToPublic = !showPrivate || publicOnlyParam;

    // Overfetch with a single ordered query, then filter in memory. Keeps us
    // off composite indexes for the small data sizes we expect (<1000 docs).
    //
    // Pagination: when `before` is present it becomes a REAL range on the
    // query (not just the in-memory filter below) — otherwise a page-2 request
    // could only ever see the newest OVERFETCH docs and older history would be
    // unreachable. A range + orderBy on the SAME field needs no composite
    // index. `before` accepts epoch-ms or an ISO date string.
    // Both cursors accept epoch-ms ("1720000000000") or an ISO date string;
    // NaN (unparseable input) disables that cursor rather than erroring.
    const parseCursor = (v: string | undefined): number | null => {
      if (!v) return null;
      const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      return Number.isFinite(ms) ? ms : null;
    };
    const beforeMs = parseCursor(before);
    const afterMs = parseCursor(after);

    let query = adminFirestore
      .collection(COLLECTION)
      .orderBy("capturedAt", "desc");
    if (beforeMs !== null) {
      query = query.where("capturedAt", "<", beforeMs);
    }
    const snap = await query.limit(OVERFETCH).get();

    let docs = snap.docs
      .map((d) => ({ id: d.id, data: d.data() as any }))
      .filter(({ data }) => data.analyzed === true)
      .filter(({ data }) => (data.env || "prod") === APP_ENV);

    if (restrictToPublic) docs = docs.filter(({ data }) => data.public === true);
    // Curation: hidden captures never reach the public view. Signed-in users
    // keep seeing them (flagged in the card) so they can unhide.
    if (restrictToPublic) docs = docs.filter(({ data }) => data.hidden !== true);
    if (species) docs = docs.filter(({ data }) => data.species === species);
    if (cameraId) docs = docs.filter(({ data }) => data.deviceId === cameraId);
    if (afterMs !== null) docs = docs.filter(({ data }) => new Date(data.capturedAt).getTime() >= afterMs);
    if (beforeMs !== null) docs = docs.filter(({ data }) => new Date(data.capturedAt).getTime() < beforeMs);

    docs = docs.slice(0, limit);

    const captures = await Promise.all(
      docs.map(async ({ id, data }) => {
        const imageUrl = data.objectPath ? await signReadUrl(data.objectPath) : null;
        return toCaptureCard(id, data, imageUrl);
      }),
    );

    // no-store: the gallery polls this for freshness -- a browser/proxy-cached
    // response would silently re-add the latency the polling exists to remove.
    return NextResponse.json(captures, { headers: { ...cors, 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error("GET /api/captures failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500, headers: cors });
  }
}
