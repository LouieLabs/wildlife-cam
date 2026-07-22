# Louie Labs Wildlife Monitor — Web App

Next.js (App Router) control panel for the backyard wildlife cameras. Handles
keyless photo uploads to Google Cloud Storage, secure device registration, live
device control, and an AI-detection feed.

> **Plain-English summary.** This website lets a logged-in Louie Labs student add
> a camera, hands each camera a short random password, shows which cameras are
> online, lets you press "take a picture", and lists the animals the AI found.
> Cameras upload photos using short-lived "upload tickets" so they never hold any
> cloud keys.

**Deployed at:** `https://wildlife-dashboard-ee47ntxftq-uw.a.run.app`
(provisioning page: `/provision`). Auto-deploys from `main` via Cloud Build.

---

## Hybrid database layout (by design)

We use **two** Google databases, each for what it's best at:

| Database | Region | Holds | Why |
| --- | --- | --- | --- |
| **Realtime Database** | us-central1¹ | `/devices/<id>/state` (status, battery), `/devices/<id>/command` (e.g. `take_picture`), `/pre_shared_keys`, `/device_meta` | Fast, tiny, easy for an MCU to poll |
| **Firestore** (`wildlife-camera-telemetry-db`) | us-west1 | `wildlife_detections` (image URLs + Gemini bounding-box arrays) | Rich queries over structured detection records |

¹ **Realtime Database is not offered in us-west1** — Google only allows
us-central1 / europe-west1 / asia-southeast1. So the live-state DB sits in
us-central1 while the bucket and Firestore stay in us-west1. This is a Google
limitation, not a choice.

---

## How security works

| Concern | How it's handled |
| --- | --- |
| Who can register / command devices | A student signed in with a real **@louielabs.com Google account**, verified on the server (`requireLouieLabsUser`) |
| Device secret | **Random 10-char** secret (`XXX-XXX-XXXX`), server-generated, unrelated to the MAC. Stored in clear for recovery; never publicly readable |
| Realtime Database | Locked. Devices may only WRITE `/devices/<id>/state` if their secret matches the registry. `/devices/<id>/command` is fully private — cameras fetch commands via `/api/command-poll` (admin read). Everything else is closed |
| Firestore | Fully locked to clients; all detection reads/writes go through authenticated server routes using the Admin SDK |
| Cloud login | **Keyless** Application Default Credentials with service-account impersonation — no JSON key files anywhere |

**Trade-off chosen on purpose:** the secret is stored in clear so students can
recover it. The only feasible attack is online guessing against the database,
which the 10-char (`XXX-XXX-XXXX`, ~51-bit) secret defeats with a huge margin.

---

## Dev vs production data (automatic tagging)

Every artifact is **stamped with its environment at creation**, so dev test data
can be purged without ever touching production:

- Set by **`APP_ENV`** — `dev` locally (in `.env.local`), `prod` on Cloud Run.
  (Missing → treated as `prod` to fail safe.)
- **Images / movies (GCS):** the `get-upload-url` route — the *single door* every
  image passes through — prefixes the path: `dev/uploads/...` vs `prod/uploads/...`.
  So field auto-captures, "save" buttons, anything, are all tagged automatically.
- **Detections (Firestore):** docs carry an `env: "dev" | "prod"` field.
- **Telemetry (RTDB):** not tagged (the board writes it directly, and it's
  current-state that gets overwritten, not accumulated). Namespace dev device IDs
  if you want strict separation.

**Purge dev data:** `npm run clean:dev` (dry run) → `npm run clean:dev -- --yes`
(delete). It only removes the `dev/` prefix + `env=="dev"` docs, so it physically
cannot touch prod. Anything left **un-tagged** (no `dev/`/`prod/` prefix) is a
pre-convention straggler — visible with a single `gsutil ls`, easy to clean by hand.

---

## Files

```
web/
  app/
    login/page.tsx                Louie Labs Google sign-in
    register/page.tsx             authenticated "add a camera" form
    dashboard/page.tsx            live status, take-picture, detections, secret recovery
    api/
      get-upload-url/route.ts     camera -> 5-min v4 signed PUT URL (x-device-secret)
      register-device/route.ts    authed: mint + store random secret (RTDB)
      devices/route.ts            authed: read live device state (RTDB)
      device-secret/route.ts      authed: recover a lost secret (RTDB)
      command/route.ts            authed: set a device command e.g. take_picture (RTDB)
      detections/route.ts         GET authed (dashboard) / POST pipeline (Firestore)
      analyze-pending/route.ts    authed: run the in-cloud AI over unanalyzed captures
  lib/
    analyzeCaptures.ts            keyless Gemini (Vertex AI) zero-shot animal detection
    firebaseAdmin.ts              keyless Admin SDK -> RTDB + named Firestore
    firebaseClient.ts             browser Firebase (public web config)
    requireLouieLabsUser.ts       verify ID token + @louielabs.com domain
    secret.ts                     random 10-char secret generator
  firebase-rules.json             locked Realtime Database rules
  firestore.rules                 locked Firestore rules
  .env.local.example              copy to .env.local and fill in
```

---

## AI animal detection — in-cloud, keyless (Gemini via Vertex AI)

> **In plain words.** Photos land on the dashboard "not analyzed". While a
> signed-in student has the dashboard open, the server picks up a few pending
> photos at a time, shows each to Gemini ("what animals do you see, and
> where?"), and saves the species labels + bounding boxes back onto the same
> record. No separate worker to run, and **no API keys anywhere**: Gemini is
> called through Vertex AI with the same keyless service-account credentials
> the rest of this backend already uses.

Flow:

```
camera -> upload -> capture-complete            (doc: analyzed:false)
dashboard (any signed-in user, every 30 s)
   -> POST /api/analyze-pending                 (authed, rate-limited)
      -> lib/analyzeCaptures.ts: Gemini zero-shot per photo
      -> doc updated: detections, boxes, analyzed:true, public gate
```

- The **`public` gallery gate is computed server-side**: a capture is
  `public:true` only when no *person* or *dog* label is present. Fail-safe:
  docs start `public:false` and stay private if analysis never runs.
- Failed photos just stay `analyzed:false` and get retried on a later tick
  (one automatic retry per attempt covers transient Vertex hiccups).
- The prompt is tuned for camera-trap reality: **night infrared / grayscale**,
  motion blur, partial animals at the edge, and — the big one — it's told to
  return `[]` rather than hallucinate an animal in an empty frame (swaying
  branches, IR glare, timestamps are explicitly *not* animals). It's primed
  with the **local species** (Santa Cruz Mountains) to bias plausible IDs.
- **Confidence floor:** animal guesses below `DETECTION_MIN_CONFIDENCE` (0.3) are
  dropped from the saved list. **Person/dog are exempt** and always kept — a
  faint "maybe a person" still forces the capture private (fail-safe privacy).
- Config (all optional): `VERTEX_LOCATION` (default `us-central1`),
  `GEMINI_MODEL` (default `gemini-2.5-flash`),
  `DETECTION_MIN_CONFIDENCE` (default `0.3`), `REGION_SPECIES` (species hint),
  `SPECIESNET_SERVICE_URL` (unset = SpeciesNet gate OFF),
  `SPECIESNET_GATE_MIN_CONFIDENCE` (default `0.2`),
  `SPECIESNET_TIMEOUT_MS` (default `20000`).

**One-time GCP setup** (or the first analysis calls will 403):
1. Enable the **Vertex AI API** on `louielabs-animal-cams`.
2. Grant `cloud-backend@louielabs-animal-cams.iam.gserviceaccount.com` the
   **Vertex AI User** role (IAM page).
3. (SpeciesNet gate only) Deploy `speciesnet-service/` and grant
   `cloud-backend@…` **Cloud Run Invoker** on it — the exact commands are in
   `speciesnet-service/README.md`.

Decision record (2026-07-03): **in-cloud Gemini over an external worker.**
An external analyzer (SpeciesNet worker, PR #39, reverted in PR #40) needed a
shared `CAMERA_API_KEY` handed to whoever runs it — a secret to distribute and
a public server-to-server surface to defend. Running the model call inside the
backend removes both (nothing new to secure) at the cost of tying analysis to
Google's hosted model. Planned next steps: a Python Cloud Run job adds YOLOv8
alongside Gemini; later, a tiny on-device model gates uploads at the camera.

Decision record (2026-07-22): **SpeciesNet revived as a pre-detection gate —
the PR #39/#40 objections no longer apply.** PR #39's worker ran *outside* the
backend: a polling script that needed the shared `CAMERA_API_KEY` handed to
whoever ran it, plus a public server-to-server surface to defend. The revival
keeps SpeciesNet but removes both problems: it now runs as a **private Cloud
Run service the backend calls itself** (`speciesnet-service/`), authenticated
the same keyless way as everything else — the backend mints a short-lived
Google ID token, and Cloud Run IAM rejects any caller without `run.invoker`.
No shared key exists; no public surface exists. In plain words: instead of
trusting Gemini to look at every photo cold, we first ask a specialist
camera-trap model "is there actually an animal here, and where?". If it sees
nothing we skip Gemini entirely — which kills the old false alarms (a ceiling
light labeled as a deer) and saves money, since most motion photos are empty.
If it finds an animal, Gemini still runs, primed with the specialist's answer
to confirm or correct. We keep the specialist's boxes (more accurate), take
Gemini's name only when it's a real species, and if Gemini comes back empty we
trust the specialist rather than dropping to "nothing found" — so real animals
stop slipping through. The privacy gate is the **union** of both models: a
person or dog flagged by *either* keeps the photo private. The whole thing is
behind one switch (`SPECIESNET_SERVICE_URL`): unset, the pipeline is exactly
the old Gemini-only path — which is also the instant rollback.

---

## Setup

1. **Install** (from this `web/` folder): `npm install`
2. **Env:** `cp .env.local.example .env.local` and confirm the values.
3. **Keyless login (ADC + impersonation, no JSON keys):**
   ```bash
   gcloud auth application-default login \
     --impersonate-service-account=cloud-backend@louielabs-animal-cams.iam.gserviceaccount.com
   ```
   The `cloud-backend` service account needs:
   - **Storage Admin** on the bucket ✅ (already granted)
   - **Service Account Token Creator on itself** ✅ (already granted — required to
     sign v4 upload URLs without a key file)
   - **Firebase Realtime Database Admin** — grant this once you create the RTDB
   - **Cloud Datastore / Firestore access** ✅ (already has `datastore.owner`)
4. **Create the Realtime Database** (it doesn't exist yet) in **us-central1**, then
   confirm `FIREBASE_DATABASE_URL` matches its instance URL.
5. **Deploy the rules:**
   ```bash
   firebase deploy --only database     # firebase-rules.json
   firebase deploy --only firestore:rules   # firestore.rules
   ```
   (or paste each into the Firebase console). Installing the Firebase CLI:
   `npm i -g firebase-tools` — it isn't installed yet.
6. **Run:** `npm run dev`

---

## Tests

Tests live in `web/test/` and run via Vitest. There are TWO suites:

1. **Fast unit + route tests** (`web/test/lib/`, `web/test/api/`). All Firebase
   and Storage calls are mocked — no external services needed. ~half a second.

   ```bash
   npm test            # one-off run (what CI uses for the fast suite)
   npx vitest          # watch mode while you iterate
   ```

2. **Rules tests** (`web/test/rules/`). Boot the real Firebase emulator
   (Firestore + Realtime DB) against the committed `firebase-rules.json` and
   `firestore.rules`, then exercise client-side requests to verify the rules
   accept/reject the right things. **Needs Java** (the emulator JVM).

   ```bash
   npm run test:rules   # boots emulators, runs the suite, tears them down
   ```

What's covered:

- **Helpers** (`lib/requireDeviceSecret.ts`, `lib/rateLimit.ts`): auth + counter
  math + edge cases.
- **Routes** (every file in `app/api/*/route.ts`): missing/wrong auth → 401,
  rate-limited → 429, bad input → 400, happy path → 200 + expected body shape.
  Side effects to RTDB / Firestore / Storage are spied so a refactor that
  silently breaks the firmware contract fails the build.
- **Rules**: `/pre_shared_keys` and `/device_meta` and `/devices/{id}/command`
  are server-only; `/devices/{id}/state` write rejects mismatching secrets and
  accepts matching ones; ALL Firestore collections deny direct client access.

Cloud Build runs both suites as step 0 on every push to `main`; a failure aborts
the build before any deploy. See `web/cloudbuild.yaml`.

---

## Camera-side data flow (firmware)

- **Status (write):** node writes `devices/<id>/state` =
  `{ status, battery, secret, updatedAt }`. The RTDB rule accepts it only if
  `secret` matches the registry. Use the 10-char secret — **not** the MAC.
- **Commands (read):** node polls `devices/<id>/command` (e.g. `take_picture`),
  acts, then keeps reporting status. Only the signed-in dashboard can set a
  command.
- **Upload a photo:** `POST /api/get-upload-url` with header
  `x-device-secret: <this board's secret>` and `{ "deviceId": "..." }`; the
  server looks up the expected secret by deviceId, so each board has its own
  credential (a leak burns one board, not the fleet). Then HTTP **PUT** the
  JPEG to the returned URL within 5 minutes.
- **Detections (server-to-server):** after a photo is uploaded and analyzed by
  Gemini, the backend `POST /api/detections` (with the shared `x-camera-api-key`
  -- this endpoint is for trusted server callers, not boards) to record
  `{ deviceId, imageUrl, capturedAt, detections:[{label,confidence,box}] }`.

> Heads-up: GCS v4 signed URLs are time-limited, not literally single-use. The
> 5-minute window + unique object name is the control here.
