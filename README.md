# Wildlife Cam

ESP32-S3 HaLow camera (Heltec **HT-HC33**) with a web interface, live MJPEG
stream, and metadata overlays. Captures on the device; renders/records on a
phone or computer.

---

## Setup

> **Two modes — pick one** (a single board does one or the other, not both):
>
> - **A. Live-stream camera** — one board, always on, served over your local
>   Wi-Fi to a browser. No cloud account, no dashboard. Setup below uses
>   [`videowithinterfacesketch/`](videowithinterfacesketch/).
> - **B. Cloud dashboard fleet** — one or more low-power boards that wake,
>   check in, and upload photos to a web dashboard. Wi-Fi credentials are
>   provisioned **once over USB** (no `secrets.h` editing). Jump to
>   [Cloud dashboard](#cloud-dashboard-optional--web--cloud_telemetry_node)
>   below and start there.

The steps below set up **Mode A**.

1. **WiFi credentials** live in `secrets.h` (gitignored — never committed).
   Copy the template and fill in your network:
   ```bash
   cp videowithinterfacesketch/secrets.example.h videowithinterfacesketch/secrets.h
   ```
   ```c
   #define WIFI_SSID     "your-wifi-name"
   #define WIFI_PASSWORD "your-wifi-password"
   ```
   > ⚠️ ESP32 only joins **2.4 GHz** WiFi (not 5 GHz). On a new network, edit
   > `secrets.h` and **re-upload** the sketch.

2. Open `videowithinterfacesketch/videowithinterfacesketch.ino` in the Arduino
   IDE and **Upload**.

3. Open **Serial Monitor** at **115200 baud** to see the camera's IP:
   ```
   >>> Open: http://192.168.x.x/
   ```
   Open that address in a browser.

---

## Web interface

- **Live stream** with scroll-to-zoom and drag-to-pan.
- **Camera settings** (resolution, quality, exposure, gain, white balance,
  mirror/flip, etc.) — apply **live**, no pause needed.
- **Scene presets:** Underwater · Daylight · Night.
- **Status bar:** date/time (NTP, US Pacific), auto location (from the camera's
  IP) and current outdoor temperature (weather API).
- **Snapshot** — downloads a JPEG with a caption strip burned across the bottom
  (`camera name · date/time · location · °F`) and the same info plus a **GPS
  geotag** in the photo's EXIF.
- **● Record** — records the live feed *with the overlay burned in* to a
  `.webm` video, straight from the browser. Click to start (turns red), click
  **■ Stop** to download. No extra tools needed.

### Change the camera name
Edit one line near the top of the page script in the sketch:
```js
// ====== CHANGE YOUR CAMERA NAME HERE ======
const CAMERA_NAME = "Camera 1";
```

---

## Recording to MP4 (optional) — `record.py`

The in-browser button makes `.webm`. For a small, universal **MP4** with the
same overlay, use the desktop recorder (needs [ffmpeg](https://ffmpeg.org)):

```bash
brew install ffmpeg                      # one-time
python3 record.py <camera-ip> -o clip.mp4 --camera-name "Camera 1"
# ...records until you press Ctrl-C
```
Quick test: `python3 record.py <camera-ip> --seconds 10 -o test.mp4`

It pulls the live stream and polls `/status` once a second, then ffmpeg burns
the metadata (bottom-left, white text + black outline) while encoding to H.264.

---

## Animal detection (optional) — `detect.py`

Runs a YOLO detector over a saved photo or recording, draws labeled **bounding
boxes**, and logs detections to a CSV. Targets people, dogs, rats, and Santa
Cruz Mountains wildlife.

```bash
pip install -r requirements.txt          # ultralytics + opencv
python3 detect.py photo.jpg              # -> photo_detected.jpg + photo_detections.csv
python3 detect.py clip.mp4 --conf 0.35   # works on videos too
```

**Model coverage (important):** the default model (`yolo11n.pt`, COCO) only
knows ~80 everyday classes — from the target list it detects **person, dog,
cat, bird, bear** reliably, but **not** deer, coyote, bobcat, mountain lion,
raccoon, fox, skunk, or rat. For real wildlife species, pass a wildlife-trained
model:

```bash
python3 detect.py photo.jpg --model path/to/wildlife.pt
```

The right tool for camera-trap wildlife is **MegaDetector** (detects animal /
person / vehicle on essentially any species). No detector is 100% accurate —
treat low-confidence boxes with suspicion.

---

## Cloud dashboard (optional) — `web/` + `cloud_telemetry_node/`

> **In plain words:** a web control panel for a *fleet* of cameras. It shows
> which cameras are online and their battery, lets you press **Take picture**,
> and lists the photos with the animals the AI found. Cameras nap to save
> battery and check in every ~30 seconds.

This is a **separate system** from the live-stream above — a low-power camera
deep-sleeps, so it can't also serve the always-on video stream. Pick one mode
per board.

- **`web/`** — the Next.js dashboard + cloud APIs. Sign in with a **@louielabs.com**
  Google account. Uploads photos to Google Cloud Storage with short-lived signed
  links, stores live device state in Firebase Realtime Database and photo/AI
  records in Firestore. All keyless (no JSON key files). Setup + security details:
  [`web/README.md`](web/README.md).
- **`cloud_telemetry_node/`** — the low-power Heltec **HT-HC33** firmware that
  reports status, listens for a `take_picture` command, and uploads photos.
  Setup + flashing: [`cloud_telemetry_node/README.md`](cloud_telemetry_node/README.md).

Run the dashboard locally with `npm run dev` in `web/` (→ `http://localhost:3000`).

> ⚠️ When flashing the telemetry node, use **Upload Speed 460800** (921600 can
> corrupt the upload) and make sure nothing else is holding the serial port.

## Files

| Path | What |
|---|---|
| `videowithinterfacesketch/videowithinterfacesketch.ino` | Main firmware (camera + web UI) |
| `videowithinterfacesketch/secrets.h` | WiFi credentials (gitignored) |
| `videowithinterfacesketch/secrets.example.h` | Credentials template |
| `record.py` | Desktop recorder → MP4 with overlay |
| `detect.py` | Animal/human detection + bounding boxes on photos/videos |
| `requirements.txt` | Python deps for `detect.py` |
| `web/` | Cloud dashboard (Next.js) + keyless cloud APIs — see `web/README.md` |
| `cloud_telemetry_node/` | Low-power HT-HC33 firmware that reports to the dashboard |

---

## Notes

- Repo is **private**; `secrets.h` is gitignored so credentials stay local.
- Recording (browser or `record.py`) runs only while your device is open and on
  the **same network** as the camera.
- The HaLow core lacks `tm_gmtoff`; the sketch computes the UTC offset manually.
- **Build toolchain: Arduino IDE + Heltec "ESP32 HaLow" core** (`heltec:esp_halow`),
  not PlatformIO. A `platformio.ini` exists but is **parked/experimental** —
  PlatformIO has no HT-HC33 board definition and its standard arduino-esp32 core
  lacks Heltec's HaLow stack (no Wi-Fi HaLow APIs, no `halow_SD.h`). See the
  header comment in `platformio.ini` for the full caveats and how to revive it.
