# Flash Storage + OTA Plan (Heltec HT-HC33)

> **Status (updated 2026-06-29):** Steps 1 & 2 **SHIPPED** on `main`; Step 3
> (OTA update code) is the only piece still open. See the Decision Record
> below for the 2026-06-29 entry. Supersedes the microSD storage approach.
> **Audience:** LouieLabs students + whoever (human or Claude) implements
> Step 3 next.

## In plain words

We stopped using microSD cards on the Heltec camera board — only 1 of our 4 cards
worked reliably, and the failures were the *cards*, not the format or the board.
Instead we'll store photos in the board's **own built-in flash memory** (the chip
that already holds the program), and we'll reserve room for **wireless firmware
updates (OTA)** from the very beginning. Photos survive sleep and power-loss, just
like the SD card promised — without the flaky cards.

There's **one rule that drives everything**: the flash has to be divided up (the
"partition table") *once*, correctly, before we store anything. Re-dividing it
later erases everything in flash — including photos already sitting on a camera out
in the field. That's why we reserve the OTA space up front even though we'll write
the OTA code last.

## Key facts (verified 2026-06-27)

| Thing | Value | Note |
|---|---|---|
| Flash chip size | **16 MB** | Confirmed by reading the chip (`esptool flash_id` → Device 4018). |
| Core's configured flash | **8 MB** (`default_8MB`) | The Heltec core under-uses the chip by half today. Step 1 fixes this. |
| Firmware size | **~1.11 MB** | `cloud_telemetry_node`, 31% of the current 3.5 MB app slot. |
| Board / build | FQBN `heltec:esp_halow:HT-HC33`, upload **460800** baud | 921600 corrupts. USB CDC On Boot = Disabled. |
| Core location | `/Users/alan/Documents/Arduino/hardware/heltec/esp_halow` | Manual install, **not** in `~/Library/Arduino15`. esptool at `<core>/tools/esptool/esptool`. |
| Monitoring | `hardware-tests/HT-HC33_SDTest/serial_monitor_noreset.py` | Avoids DTR/RTS resets that wedge the board. |

## The three steps (order matters)

### Step 1 — 16 MB OTA-ready partition table  *(✅ SHIPPED — see [`firmware/heltec-core-overrides/`](../firmware/heltec-core-overrides/))*
Switch the board to 16 MB and apply a layout with **two app slots** (for OTA) plus a
large LittleFS data area:

```
# name,    type, subtype,  offset,    size       # notes
nvs,       data, nvs,      0x9000,    0x5000      # 20 KB  settings
otadata,   data, ota,      0xe000,    0x2000      # 8 KB   which slot to boot
app0,      app,  ota_0,    0x10000,   0x200000    # 2 MB   firmware (fits 1.11 MB + growth)
app1,      app,  ota_1,    0x210000,  0x200000    # 2 MB   OTA spare slot
spiffs,    data, spiffs,   0x410000,  0xBE0000    # ~11.9 MB LittleFS photo store
coredump,  data, coredump, 0xFF0000,  0x10000     # 64 KB  crash logs
```
- **Result:** ~11.5 MB usable LittleFS ≈ **~46 full-3 MP to ~287 VGA photos**, persistent.
- **Keep the data partition labeled `spiffs`** so the default `LittleFS.begin()` finds it.
- **Resolved (2026-06-29):** the `boards.local.txt` + custom partition CSV
  approach worked. Files live in [`firmware/heltec-core-overrides/`](../firmware/heltec-core-overrides/);
  see that directory's README for install steps. Gotcha discovered along the
  way: the **variant**'s `partitions.csv` outranks `build.partitions`, so
  the override has to land in the right variant directory.
- **Verify:** compile shows app `Maximum is 2097152 bytes`; at runtime
  `LittleFS.totalBytes()` ≈ 11.5 MB.

### Step 2 — flash storage layer  *(✅ SHIPPED — see [`cloud_telemetry_node/flash_store.{h,cpp}`](../cloud_telemetry_node/))*
In `cloud_telemetry_node`, retire the SD logic in `sd_store.{h,cpp}` and add a modular
`flash_store.{h,cpp}` (separate files, per the team rule):
- **Flow:** capture → write `/img_<seq>.jpg` to LittleFS → upload via the existing
  signed-URL path (`cloud_backend`) → delete on success, keep on failure for retry.
- Add `picsRemaining()` = `(LittleFS.totalBytes() - LittleFS.usedBytes()) / runningAvgJpegBytes`.
- `#include <LittleFS.h>`, `LittleFS.begin(true)`. Wear is a non-issue at capture-and-clear volumes.

### Step 3 — OTA update code  *(⏳ OPEN — last; independent of the data layout)*
On wake, read a firmware version/URL from RTDB `/devices/<id>/state` (or a new
`/devices/<id>/ota` field). If newer than the running version: HTTPS-download the `.bin`
(`WiFiClientSecure` + `Update.writeStream()`) into the **inactive** app slot → verify →
switch boot partition → reboot. Serve the firmware `.bin` from GCS via the existing
keyless cloud backend.

## Decision Record

This section is **append-only** — add a dated entry whenever a decision changes; don't
rewrite history. (See the maintenance note below for why.)

- **2026-06-27 — Abandon microSD on the Heltec.** Full board×card matrix showed only 1
  of 4 Kingston cards reliable; a failing card was reformatted with the proven
  `diskutil … FAT32 … MBRFormat` and *still* failed `f_mount=13` on a known-good board,
  proving the cards (not the format) fail over the board's SPI link. Cards read fine in a
  PC reader, which is misleading. → Store in internal flash instead. Cards retained for
  non-Heltec boards. *(The Lilygo T-Halow-P4 has no SD slot at all.)*
- **2026-06-27 — Use internal Flash (LittleFS), not PSRAM.** PSRAM (8 MB) is volatile —
  wiped on deep sleep / power loss — so it can only stage a few in-flight images, not store
  them. Flash is non-volatile and far larger after we unlock the full 16 MB.
- **2026-06-27 — Reserve OTA from the start.** User chose dual-app-slot OTA over
  single-app max-storage (~11.5 MB vs ~14 MB LittleFS). Rationale: repartitioning later to
  add OTA would wipe field photos, so the slots must exist up front; the ~2.5 MB of storage
  given up is worth remote updatability.
- **2026-06-29 — Steps 1 & 2 shipped on `main`.** The 16 MB OTA-ready partition
  table landed in [`firmware/heltec-core-overrides/`](../firmware/heltec-core-overrides/)
  (boards.local.txt + custom CSV in the variant directory); the flash storage layer
  landed in [`cloud_telemetry_node/flash_store.{h,cpp}`](../cloud_telemetry_node/),
  retiring the SD code path. The capture → LittleFS → upload → delete-on-success
  flow is live in the fleet firmware. **Step 3 (OTA update code) is the only
  remaining piece of the original plan.**

## How to keep this doc honest

A design doc is a *snapshot of intent*; code is *current reality*. They drift apart. Keep
both useful by separating the two kinds of knowledge:
- **The "why" (this doc + the Decision Record)** can't be recovered from code — capture it
  *at decision time*. Mark sections `SUPERSEDED` rather than deleting them (matches the
  existing `CAMERA_REGISTRATION_ARCHITECTURE.md` convention).
- **The "what" (current structure)** *can* be regenerated from code — periodically have an
  agent reverse-engineer an "as-built" summary, feeding it **both the code and this doc** so
  it can flag where reality diverged from the plan (those diffs are new decisions to record).
