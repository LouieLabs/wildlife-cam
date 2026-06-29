# Cloud Telemetry Node (Heltec HT-HC33)

A low-power firmware that wakes, reports the camera's status to the cloud, checks
for a command, and deep-sleeps. It's the **bridge** between a Heltec board and
the `web/` dashboard.

> **Plain words:** the board naps to save battery. Every ~30 seconds it wakes up,
> phones home ("I'm online, battery 100%"), peeks at whether you pressed a button
> on the website, then goes back to sleep.

## This is a separate mode from the live-stream sketch
A board that deep-sleeps **cannot** also run the always-on camera web stream
(`videowithinterfacesketch`). Pick one per board: streaming OR low-power
telemetry. They can't run at the same time.

## Dev mode vs Field mode (automatic, one codebase)
On a **cold boot**, the node waits `DEV_MODE_LISTEN_MS` (10 s) for a keypress on
the USB serial port:
- **Press a key** (a computer is connected) → **DEV MODE**: the board brings up a
  self-contained Wi-Fi hotspot `wildcam-<device_id>` (password `DEV_AP_PASSWORD`)
  + a camera website. Connect to that Wi-Fi and open `http://192.168.4.1/`. Ideal
  for offsite dev with no network or HaLow gateway. Stays awake (no deep sleep).
- **No key** (deployed) → **FIELD MODE**: the normal low-power cycle below.
  Deep-sleep timer wakes skip the listen, so it's a one-time cold-boot cost.

It keys off "is a developer connected" (the serial port), not power — so a
solar/USB charger can't accidentally flip a field unit into Wi-Fi mode. Battery
% is read from the real divider (`ADC_Ctrl` on GPIO20 → `ADC_IN` on GPIO1).

## Setup & flashing

There are **two paths to give the board its Wi-Fi + identity**. Pick one. Both
work on the same firmware image; **NVS overrides `secrets.h`** if both are set.

### Path A — Dashboard provisioning (recommended)
The board's identity (`DEVICE_ID`, secret) and Wi-Fi credentials live in on-chip
**NVS** (non-volatile storage). They're written *once* via the dashboard's "Set
up a camera" page over USB Web Serial, and **survive reflashes**. Production
firmware is built with `secrets.h` blank so it MUST be provisioned.

1. Build & flash the firmware (Arduino IDE → Board **Heltec ESP32 HaLow → HT-HC33**
   → Upload Speed **460800** → Upload). With `secrets.h` blank, the board boots
   into a 10-second provisioning window on every cold boot.
2. On a desktop **Chrome / Edge** (Web Serial isn't on Safari / mobile), open the
   dashboard's `/provision` page (see [`web/README.md`](../web/README.md) for the
   URL). Sign in with your `@louielabs.com` account.
3. Click **Connect** → pick the board's serial port. The page resets the board,
   reads its MAC, registers the device (mints the 10-char secret server-side),
   then writes Wi-Fi + identity into NVS. ~30 s end-to-end.
4. The board reboots into normal operation. Open Serial Monitor at **115200** to
   confirm — you should see `wake #N … report SENT ✓` and the dashboard should
   show the device 🟢 online.

### Path B — `secrets.h` fallback (bench / no-network)
For dev work without the dashboard (e.g. testing a new code path on a board you
haven't registered yet):

1. Register the device on the dashboard *or* invent a `DEVICE_ID` + secret pair
   that matches the registry.
2. `cp secrets.example.h secrets.h` and fill in Wi-Fi + `DEVICE_SECRET` (the
   10-char value, format `XXX-XXX-XXXX`). The board uses that same secret for
   both the database status writes AND the backend HTTP calls — no fleet-wide
   key needed.
3. In `node_config.h`, set `DEVICE_ID` to match, and `SLEEP_SECONDS`
   (`10` to test fast, `30` normal).
4. Arduino IDE → Board **Heltec ESP32 HaLow → HT-HC33** → Upload Speed **460800**
   → Upload.
5. Open Serial Monitor at **115200**. Same expected output as Path A.

> If a board has NVS values from a prior provisioning AND you set `secrets.h`,
> NVS wins. To force the `secrets.h` path, clear NVS first (`nvs_flash_erase`
> in firmware or wipe via `esptool erase_flash` and reflash).

## How it talks to the cloud
- **Status:** HTTPS `PUT` to `…/devices/<id>/state.json` with
  `{status, battery, secret, updatedAt}`. The database rule accepts it only
  because the secret matches the registry.
- **Command:** `POST /api/command-poll` (header `x-device-secret: <board's
  secret>`); the backend reads the now-private command path with admin
  credentials and returns it.
- **Photo (on `take_picture`):** `POST /api/get-upload-url` (same per-device
  secret header) → PUT the JPEG to the signed link → `POST /api/capture-complete`,
  which clears the command and records the capture in Firestore. The dashboard
  then shows the photo (it mints a short-lived view link, since the bucket is
  private).
- **Capture cycle** (`DO_CAPTURE_CYCLE=1` in `node_config.h`): every wake the
  board captures a photo, **saves it to internal flash** (`LittleFS`, under
  `/wildcam/`, via [`flash_store.{h,cpp}`](flash_store.h)), waits 5 s, then
  uploads that saved file from flash (stand-in for the future PIR + "wait for a
  lull" flow). The photo stays on flash until the upload succeeds, so a
  network blip doesn't lose it. Set to `0` for status-only. (microSD support
  was retired 2026-06-27 — see [`docs/FLASH_STORAGE_OTA_PLAN.md`](../docs/FLASH_STORAGE_OTA_PLAN.md).)

> Set `BACKEND_BASE_URL` in `node_config.h` to where the web app is reachable
> from the board. While testing against `npm run dev`, that's your computer's
> **LAN address**, e.g. `http://192.168.1.50:3000` (Next prints a "Network:" URL
> on startup) — `localhost` won't work from the board.

## Known limitations / honest notes
- **TLS check is skipped** (`setInsecure()`) to keep testing simple. Fine on your
  own network; revisit before any real deployment.
- **Gemini analysis isn't wired yet.** A capture is recorded with an empty
  `detections` array (`analyzed: false`); a later Gemini step fills in the
  bounding boxes via `POST /api/detections`. That's the next piece.
- **Battery % is a stub** (`100`) until you tell me the battery sense pin /
  divider in `node_config.h`.
- **Commands are delayed** by up to one sleep cycle, since the board is asleep
  in between — expected for a low-power node.
