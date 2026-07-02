# Trail-cam ingest pipeline — handoff spec

**Status:** draft, awaiting implementation (2026-07-01).
**Origin:** this plan was designed in a session that started on PIR firmware and drifted into how to seed the wildlife-cam dataset with real backyard imagery captured from a borrowed trail cam.

## Project context

LouieLabs Wildlife-cam. Wildlife camera fleet on Heltec HT-HC33 (ESP32-S3),
fleet firmware in [`cloud_telemetry_node/`](../cloud_telemetry_node/), Next.js
dashboard in [`web/`](../web/) deployed to Cloud Run at
https://wildlife-dashboard-ee47ntxftq-uw.a.run.app. GCS bucket
`gs://wildlife-camera-telemetry/`, Firestore captures under
`wildlife_detections`. Existing capture object naming:
`prod/uploads/<deviceId>/<deviceId>_YYMMDD-HHMMSS_REASON.jpg`. Deep-sleep
firmware wakes on PIR/USER-button/timer/cold-boot, reports status to RTDB,
uploads via signed URL. See [`docs/wiring-ht-hc33.md`](wiring-ht-hc33.md)
for hardware and [`docs/for-students/fleet-setup.md`](for-students/fleet-setup.md)
for the provisioning flow.

## Immediate task

Ingest a set of trail-cam photos (borrowed camera, backyard, past few weeks)
into the same system alongside real fleet captures. Not a separate collection
— these are legitimate backyard imagery, just from a different sensor.

## What the user has on their laptop

- **236 raw JPEGs** from the trail cam, in one directory
- **246 duplicate JPEGs with drawn boxes**, in a separate directory, downloaded
  later so the counts don't match. **Red boxes = humans, yellow boxes = animals**;
  up to multiple boxes per image
- Mix of **color** and **IR monochrome** shots
- **Metadata burned into the bottom strip** of each JPEG: UTC date/time,
  temperature, possibly other trail-cam settings
- **Filenames don't cleanly correspond between the two directories.** The script
  has to figure out which raw pairs with which boxed via image content, not
  filename.

## Plan (locked)

### 1. Reusable ingest script `scripts/ingest-photos.py`

CLI:
```
scripts/ingest-photos.py \
  --raw-dir <path>   \
  --boxed-dir <path> \
  --camera-manufacturer <str> \
  --camera-model <str> \
  --night-mode <infrared|white_flash> \
  --deployment "<free-text description>" \
  [--dry-run] [--verify-only] [--limit N]
```

Behavior:
- Camera specs asked ONCE per batch (via CLI flags, not per photo).
- Idempotent by content hash of the raw JPEG — safe to re-run.
- Python: OpenCV (box extraction), pytesseract (OCR — fall back to Google
  Vision API if accuracy <95% on a 5-photo sample), google-cloud-storage
  (upload).

### 2. Auto-pair raw ↔ boxed images (mandatory first step)

Filenames don't reliably match. The script must pair each raw JPEG with its
boxed counterpart using image content:

1. **Perceptual hash first (dHash or pHash).** Compute over the whole image;
   the drawn boxes cover a small fraction of pixels so the hash should still
   cluster the pair. Match each raw to its nearest-neighbor boxed image and
   verify the Hamming distance is under a threshold.
2. **Timestamp OCR tiebreak.** If two boxed candidates are within threshold
   of one raw, use the OCR'd timestamp from the bottom strip to
   disambiguate — burst shots on the same second are rare but possible.
3. **Report unmatched files at the end.** Given 236 raw + 246 boxed, expect
   ~10 boxed orphans (the user downloaded some boxed images later without
   their raw counterparts). Print a clear list; either the user hand-maps
   them, they get skipped, or a follow-up download brings the missing raws.

### 3. Verification loop BEFORE commit

After auto-extracting box coordinates from a boxed JPEG:

1. Render the extracted coords onto the raw as an overlay (same red/yellow
   colors as the source).
2. Generate a side-by-side thumbnail vs the original boxed JPEG.
3. Ship as a small HTML review page (`out/verify/index.html`) that surfaces
   MISMATCHES ONLY. Skip photos where the extraction looks visually correct.
4. User approves in bulk or flags failures for hand-correction. Only
   verified pairs get uploaded.

### 4. Client-side box rendering in the viewer

GCS stores **raw + coord JSON** only. Dashboard reads the box array from the
Firestore record, overlays via `<canvas>` at render time (~15 LOC), toggle
button per image (persists in `localStorage`). **Boxed JPEGs are NEVER
uploaded** — the user's laptop is the source-of-truth for the annotations.

### 5. Filename convention (mirrors fleet)

```
seed-trailcam_YYMMDD-HHMMSS_<CLASS>.jpg
```
where CLASS is one of `HUMAN`, `ANIMAL`, `HUMAN_ANIMAL`, `EMPTY`. Extract
`YYMMDD-HHMMSS` from the OCR'd bottom strip; CLASS from the box extractor.
Makes `gsutil ls | grep _ANIMAL_` immediately browsable.

### 6. Register `seed-trailcam` as a normal device

Call `/api/register-device` once with `deviceId = 'seed-trailcam'`, a
placeholder MAC (`AAAAAAAAAAAA`), and empty network fields. Device shows up
on the dashboard like any fleet camera; all ingested photos appear as its
captures. The `source` field in each capture record (see schema below) tags
them as trailcam-origin so downstream consumers can filter.

## Schema evolution — `wildlife_detections` Firestore

Extend the existing capture record with optional fields:

```typescript
{
  // ...existing fields (deviceId, objectPath, capturedAt, ...)...
  boxes?: [{ class: 'human' | 'animal', bbox: [x, y, w, h] }],
  illumination?: 'color' | 'ir',
  source?: {
    kind: 'trailcam' | 'fleet',
    manufacturer?: string,      // e.g. 'Bushnell'
    model?: string,             // e.g. 'Trophy Cam HD'
    nightMode?: 'infrared' | 'white_flash',
    deployment?: string,        // e.g. 'backyard, 2m north-facing'
  },
  overlayMetadata?: {           // OCR'd from the bottom strip
    capturedAtUtc: string,      // ISO-8601
    tempF?: number,
    raw?: string,               // original OCR text as fallback
  },
}
```

All fields optional — fleet captures without boxes just don't set them.

## Explicit non-goals

- **Do NOT** create a separate Firestore collection or dashboard section for
  training data. Same collection, same viewer. Confirmed with user.
- **Do NOT** store boxed JPEGs in GCS. Client-side render only.
- **Do NOT** auto-identify species. Future work (Gemini Vision pass over the
  uploaded raw set).
- **Do NOT** touch fleet firmware, RTDB rules, or existing camera-API auth.
  This is a data-ingest + viewer task only.

## Positives-only caveat

All 236 photos have animals or humans. A binary classifier can't learn "no
animal" from a positives-only set. Get negatives by letting `LL-cam1` (or a
future fleet camera) collect empty-frame photos over its next week of
deployment — PIR false-positives from wind/leaves/shadows will produce
plenty. Same ingest script, class=`EMPTY`.

## Concrete first tasks for the new session

1. Read this file.
2. Ask user for camera manufacturer + model + night mode + deployment
   description (five short questions).
3. Create a feature branch, scaffold `scripts/ingest-photos.py` with the CLI
   signature above.
4. Dry-run the auto-pair + OCR + box extraction on a 5-photo sample from
   each directory. Eyeball quality.
5. If OK, batch-ingest all 236 (~10 boxed orphans skipped and reported). If
   OCR accuracy is <95%, swap `pytesseract` for the Google Vision API and
   re-verify.
6. Firestore schema extension in the ingest script (uses Admin SDK
   server-side; no new API endpoint needed since the ingest runs
   authenticated as the developer, not as a camera).
7. Dashboard: `boxes` overlay rendering + toggle button on the existing
   capture cards.

## References in the repo

- [`cloud_telemetry_node/cloud_backend.cpp`](../cloud_telemetry_node/cloud_backend.cpp) — see how existing captures POST to `/api/get-upload-url` + `/api/capture-complete`
- [`web/app/api/get-upload-url/route.ts`](../web/app/api/get-upload-url/route.ts) — filename convention this pipeline mirrors
- [`web/app/api/register-device/route.ts`](../web/app/api/register-device/route.ts) — how to register `seed-trailcam`
- [`web/app/dashboard/page.tsx`](../web/app/dashboard/page.tsx) — where box overlay + toggle land
- [`web/app/api/devices/route.ts`](../web/app/api/devices/route.ts) — how `seed-trailcam` appears in the device list
- [`web/lib/rtdb.ts`](../web/lib/rtdb.ts) — admin-side RTDB helpers if the script needs to read/write RTDB paths
