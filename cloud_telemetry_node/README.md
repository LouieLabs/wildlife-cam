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
1. Register the device on the dashboard first → note its **device ID** and the
   **10-char secret** (`XXX-XXX-XXXX`).
2. `cp secrets.example.h secrets.h` and fill in Wi-Fi, `DEVICE_SECRET`, and
   `CAMERA_API_KEY` (match `web/.env.local`).
3. In `node_config.h`, set `DEVICE_ID` to match, and `SLEEP_SECONDS`
   (`10` to test fast, `30` normal).
4. Arduino IDE → Board **Heltec ESP32 HaLow → HT-HC33** → Upload. (Only you can
   flash; the board is on your USB port.)
5. Open Serial Monitor at **115200**. You should see a `wake #N … report SENT ✓`
   line, then it sleeps and repeats. Watch the dashboard — the device should show
   🟢 online.

## How it talks to the cloud
- **Status:** HTTPS `PUT` to `…/devices/<id>/state.json` with
  `{status, battery, secret, updatedAt}`. The database rule accepts it only
  because the secret matches the registry.
- **Command:** HTTPS `GET` of `…/devices/<id>/command.json` (public-read).
- **Photo (on `take_picture`):** `POST /api/get-upload-url` (with the API key) →
  PUT the JPEG to the signed link → `POST /api/capture-complete`, which clears
  the command and records the capture in Firestore. The dashboard then shows the
  photo (it mints a short-lived view link, since the bucket is private).
- **Basic SD test cycle** (`DO_CAPTURE_CYCLE=1` in `node_config.h`): every wake the
  board captures a photo, **saves it to the SD card** (`/wildcam`), waits 5 s, then
  uploads that saved file from SD (stand-in for the future PIR + "wait for a lull"
  flow). The photo stays on the card so it's never lost. Set to `0` for
  status-only.

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
