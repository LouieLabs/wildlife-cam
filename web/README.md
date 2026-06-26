# Louie Labs Wildlife Monitor — Web App

Next.js (App Router) control panel for the backyard wildlife cameras. Handles
keyless photo uploads to Google Cloud Storage, secure device registration, and a
live dashboard. Region target: **`us-west1`**.

> **Plain-English summary.** This website lets a logged-in Louie Labs student add
> a new camera, gives each camera a short random password, and shows a live page
> of which cameras are online and their battery. Cameras upload photos using
> short-lived "upload tickets" so they never hold any cloud keys.

---

## How security works here (and how it differs from the first draft)

The original spec had three holes. Here's what we do instead:

| Concern | First draft (insecure) | This app (secure) |
| --- | --- | --- |
| Who can register a device | Anyone who emails `camera-reg@` (the `From` line is spoofable) | A student signed in with a real **@louielabs.com Google account**; verified on the server |
| The device "secret" | `louie_labs_7x29_` + the MAC (both guessable/public) | A **random 6-char** secret, generated server-side, unrelated to the MAC |
| Database exposure | `".read": true` made *everything* (incl. secrets) world-readable | Database is **locked**; the dashboard reads through an authenticated server route; secrets never reach the browser |

**Known trade-off we chose on purpose:** secrets are stored in *clear text* (not
hashed) so a student can recover one if they lose it. That's acceptable because
the registry is never publicly readable and only reachable by a signed-in Louie
Labs user. A 6-char secret is also short — fine for a low-stakes backyard project,
but if you ever scale up, bump the length in `lib/secret.ts` and consider rate
limiting writes.

---

## Files

```
web/
  app/
    page.tsx                      landing page
    login/page.tsx                Louie Labs Google sign-in
    register/page.tsx             authenticated "add a camera" form
    dashboard/page.tsx            live status + secret recovery
    api/
      get-upload-url/route.ts     camera -> 5-min v4 signed PUT URL (CAMERA_API_KEY)
      register-device/route.ts    authed: mint + store random secret
      devices/route.ts            authed: server-side read for the dashboard
      device-secret/route.ts      authed: recover a lost secret
  lib/
    firebaseAdmin.ts              keyless Admin SDK (ADC)
    firebaseClient.ts             browser Firebase (public web config)
    requireLouieLabsUser.ts       verify ID token + @louielabs.com domain
    secret.ts                     random 6-char secret generator
  firebase-rules.json             locked-down Realtime Database rules
  .env.local.example              copy to .env.local and fill in
```

---

## Setup

1. **Install** (from this `web/` folder):
   ```bash
   npm install
   ```

2. **Environment**: copy and fill in:
   ```bash
   cp .env.local.example .env.local
   ```

3. **Keyless Google Cloud login (ADC + impersonation, no JSON keys):**
   ```bash
   gcloud auth application-default login \
     --impersonate-service-account=wildlife-web@<PROJECT_ID>.iam.gserviceaccount.com
   ```
   The service account needs:
   - **Storage Object Admin** (or narrower) on the `wildlife-camera-telemetry` bucket.
   - **Service Account Token Creator** on *itself* — required so the Storage SDK
     can sign v4 URLs over the IAM API without a private key file.
   - **Firebase Realtime Database Admin** for the registry writes/reads.

4. **Deploy the database rules** (locks the database):
   ```bash
   firebase deploy --only database
   # or paste firebase-rules.json into Firebase Console -> Realtime Database -> Rules
   ```

5. **Run:**
   ```bash
   npm run dev
   ```

---

## Camera-side notes (firmware)

- **Upload a photo:** `POST /api/get-upload-url` with header
  `x-camera-api-key: <CAMERA_API_KEY>` and JSON `{ "deviceId": "pond_cam_01" }`.
  You get back `{ uploadUrl }`; then HTTP **PUT** the JPEG bytes to that URL
  within 5 minutes (`Content-Type: image/jpeg`).
- **Telemetry write:** the node writes to `devices/<deviceId>` with
  `{ status, battery, secret, updatedAt }`. The database rule accepts the write
  only if `secret` matches the registry value. Use the 6-char secret from
  registration — **not** the MAC.

> Heads-up: GCS v4 signed URLs are time-limited, not literally single-use. The
> 5-minute window + unique object name is the control here.
