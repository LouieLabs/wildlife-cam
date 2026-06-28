# Implementation Plan — Cloud-native, no-dev camera onboarding

> **In plain words:** Today, setting up a camera needs a developer (Arduino IDE,
> hand-edited `secrets.h`, USB flashing). This plan makes it so an **admin can
> set up a camera from the dashboard** — plug it into a laptop, click *Flash*,
> type the Wi-Fi, done — and developers stop deploying the website by hand.
> The whole thing hinges on **one change**: moving each camera's Wi-Fi + secret
> out of the *code* and onto the *board itself*, so one pre-built program works
> for every camera.

## Decisions locked in
- **Production = `main`.** The dashboard auto-deploys from `main`. (Today `web/`
  isn't on `main` yet — Phase 1 fixes that.)
- **Per-device identity moves from `secrets.h` (compile-time) → on-chip storage
  (runtime / NVS).** This is the linchpin for both browser-flashing and OTA.
- **No captive-portal Wi-Fi setup.** Wi-Fi is typed into the browser-flash page
  during the first (always-wired) USB flash.
- **Shared values stay compiled in:** `CAMERA_API_KEY` and `BACKEND_BASE_URL`
  are the same for every camera, so they remain part of the firmware image.
- **Admin-driven registration**, keyed by the board's **factory MAC**; the
  dashboard shows MAC → device_id → secret so an admin can label each board.

## Sub-decisions still open (flagged in their phases)
- **How the browser tool writes per-device config:** (a) flash a generated NVS
  partition image, or (b) firmware listens for a short serial "provisioning"
  command after flashing. _Leaning (a); decide at Phase 2._
- **device_id:** admin-typed friendly name, or server-auto-assigned. _Decide at
  Phase 3._

---

## Phase 1 — Auto-deploy the dashboard (CI/CD)  ·  *Option A*
**Goal:** push to `main` → Cloud Build builds + deploys to Cloud Run. No more
manual `./deploy.sh`. **This first deploy also ships the already-built
`/api/command-poll` route + locked-down rules**, turning the camera's current
`404` into a real command.

1. **Merge `web/` to `main`** (PR from `adding-sdcard-and-cloud`, including the
   `feature/alan-private-command-poll` fix).
2. **`web/cloudbuild.yaml`** — builds `web/Dockerfile`, deploys service
   `wildlife-dashboard` (us-west1) as `cloud-backend@`, with the same env vars +
   `camera-api-key` secret as `deploy.sh`. _(Written — see the file.)_
3. **Connect GitHub repo to Cloud Build** — one-time OAuth in the GCP console.
   🔒 *Human step (interactive).*
4. **Create the trigger** — on push to `main`, run `web/cloudbuild.yaml`, with an
   included-files filter `web/**` so firmware-only commits don't redeploy.
5. **IAM grants** — Cloud Build SA needs `roles/run.admin` +
   `roles/iam.serviceAccountUser` on `cloud-backend@`. *(gcloud — needs a fresh
   `gcloud auth login`.)*
6. **Publish the locked-down RTDB rules** (Firebase console, or automate later).
7. Keep `deploy.sh` as a documented manual fallback.

**Who:** Claude writes the cloudbuild + PR + the exact gcloud/IAM commands. You
do the GitHub connection + `gcloud auth login`.

## Phase 2 — Firmware: identity in on-chip storage (NVS)  ·  *linchpin*
**Goal:** one pre-built binary; per-device Wi-Fi + `DEVICE_ID` + `DEVICE_SECRET`
live in NVS, read at boot.

1. New `device_config.{h,cpp}` using the `Preferences`/NVS API: `loadConfig()` at
   boot reads `wifi_ssid`, `wifi_pass`, `device_id`, `device_secret` from an NVS
   namespace. Missing → clean "needs provisioning" state (LED + serial log, no
   brick; just idle/sleep).
2. Replace the four compile-time `#define`s with the runtime values. Keep
   `CAMERA_API_KEY` + `BACKEND_BASE_URL` compiled (shared across all boards).
3. Define the **provisioning write path** (sub-decision a vs b above).
4. Keep a **dev override**: if `secrets.h` is present + a build flag is set, use
   hardcoded values (bench testing). Integrate with existing `dev_mode.cpp`.
5. **⚠️ Partition audit first:** confirm an `nvs` partition exists and survives
   alongside LittleFS. (See memory: the variant `partitions.csv` can outrank
   `build.partitions` — verify before relying on NVS.)

## Phase 3 — Browser-flash + admin onboarding UI  ·  *Option B core*
**Goal:** dashboard "Set up a camera": plug in → click *Flash* → page reads MAC,
registers the board, flashes firmware + writes per-device config; registry shows
MAC ↔ device_id ↔ secret.

1. **Publish a pre-built firmware image** (a build step compiles
   `cloud_telemetry_node` and uploads `firmware.bin` + bootloader + partition
   table + manifest to GCS).
2. **Provision page** using ESP Web Tools / esptool-js (Web Serial):
   read chip MAC → call authenticated `/api/register-device` (MAC-first; returns
   `device_id` + minted `device_secret`) → admin enters Wi-Fi → flash firmware →
   write the NVS config → show the mapping.
3. **Registry view:** admin-only table of devices (MAC, device_id, secret,
   registered-by/at, last-seen). Reuses `devices` / `device-secret` routes +
   `device_meta.mac`.
4. **Note:** Web Serial works on desktop Chrome/Edge only — document it.

## Phase 4 — OTA field upgrades (#3)  ·  *later*
**Goal:** push new firmware without USB; per-device NVS config survives.
1. Firmware OTA client (HTTP-pull): on wake, check a version endpoint; if newer,
   download from GCS + apply, keep NVS config.
2. Server: firmware version manifest + hosting (reuse Phase 3's GCS bucket).
3. **Dual app partitions (ota_0/ota_1)** + rollback-on-failed-boot — the biggest
   partition change; plan with the Phase 2 audit.

---

## Cross-cutting
- **Partition table** (NVS + LittleFS + future dual-OTA) — audit early; gates
  Phases 2 & 4.
- **Security:** registry routes stay admin-only (`requireLouieLabsUser`); DB
  rules already locked (command path private).
- **Student docs:** add a plain-English onboarding guide under
  `docs/for-students/`.

## Recommended order
Phase 1 → Phase 2 → Phase 3 → Phase 4. Phase 1 is small and unblocks everything;
Phase 2 is the foundation Phases 3 & 4 both stand on.
