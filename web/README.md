# Louie Labs Wildlife Monitor — Web App

Next.js (App Router) control panel for the backyard wildlife cameras. Handles
keyless photo uploads to Google Cloud Storage, secure device registration, live
device control, and an AI-detection feed.

> **Plain-English summary.** This website lets a logged-in Louie Labs student add
> a camera, hands each camera a short random password, shows which cameras are
> online, lets you press "take a picture", and lists the animals the AI found.
> Cameras upload photos using short-lived "upload tickets" so they never hold any
> cloud keys.

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
  lib/
    firebaseAdmin.ts              keyless Admin SDK -> RTDB + named Firestore
    firebaseClient.ts             browser Firebase (public web config)
    requireLouieLabsUser.ts       verify ID token + @louielabs.com domain
    secret.ts                     random 10-char secret generator
  firebase-rules.json             locked Realtime Database rules
  firestore.rules                 locked Firestore rules
  .env.local.example              copy to .env.local and fill in
```

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
