# Wildlife Cam

ESP32-S3 HaLow camera (Heltec **HT-HC33**) with a web interface, live MJPEG
stream, and metadata overlays. Captures on the device; renders/records on a
phone or computer.

---

## Setup

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

## Files

| Path | What |
|---|---|
| `videowithinterfacesketch/videowithinterfacesketch.ino` | Main firmware (camera + web UI) |
| `videowithinterfacesketch/secrets.h` | WiFi credentials (gitignored) |
| `videowithinterfacesketch/secrets.example.h` | Credentials template |
| `record.py` | Desktop recorder → MP4 with overlay |

---

## Notes

- Repo is **private**; `secrets.h` is gitignored so credentials stay local.
- Recording (browser or `record.py`) runs only while your device is open and on
  the **same network** as the camera.
- The HaLow core lacks `tm_gmtoff`; the sketch computes the UTC offset manually.
