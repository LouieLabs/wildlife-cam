# Flash Storage + OTA Plan (Heltec HT-HC33)

> **Status:** ACTIVE — created 2026-06-27. Supersedes the microSD storage approach
> (see *Decision Record* below). No code written yet; this is the agreed plan.
> **Audience:** LouieLabs students + whoever (human or Claude) implements it next.

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

### Step 1 — 16 MB OTA-ready partition table  *(do first; foundation; no logic changes)*
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
- **Open question to resolve first:** how to apply a custom flash size + partition CSV
  with the Heltec core. Check `<core>/.../boards.txt` for `ht-hc33.menu.FlashSize.*` /
  `ht-hc33.menu.PartitionScheme.*`. If those menus exist, add an option and select it via
  the FQBN. If not, use a `boards.local.txt` beside `boards.txt` overriding
  `ht-hc33.build.flash_size=16MB`, `ht-hc33.build.partitions=<csvname>`,
  `ht-hc33.upload.maximum_size=2097152`, and drop the CSV in the core's `tools/partitions/`.
  (A sketch-local `partitions.csv` sets the table but **not** the flash size.)
- **Verify:** compile shows app `Maximum is 2097152 bytes`; at runtime
  `LittleFS.totalBytes()` ≈ 11.5 MB.

### Step 2 — flash storage layer  *(after Step 1)*
In `cloud_telemetry_node`, retire the SD logic in `sd_store.{h,cpp}` and add a modular
`flash_store.{h,cpp}` (separate files, per the team rule):
- **Flow:** capture → write `/img_<seq>.jpg` to LittleFS → upload via the existing
  signed-URL path (`cloud_backend`) → delete on success, keep on failure for retry.
- Add `picsRemaining()` = `(LittleFS.totalBytes() - LittleFS.usedBytes()) / runningAvgJpegBytes`.
- `#include <LittleFS.h>`, `LittleFS.begin(true)`. Wear is a non-issue at capture-and-clear volumes.

### Step 3 — OTA update code  *(last; independent of the data layout)*
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

## How to keep this doc honest

A design doc is a *snapshot of intent*; code is *current reality*. They drift apart. Keep
both useful by separating the two kinds of knowledge:
- **The "why" (this doc + the Decision Record)** can't be recovered from code — capture it
  *at decision time*. Mark sections `SUPERSEDED` rather than deleting them (matches the
  existing `CAMERA_REGISTRATION_ARCHITECTURE.md` convention).
- **The "what" (current structure)** *can* be regenerated from code — periodically have an
  agent reverse-engineer an "as-built" summary, feeding it **both the code and this doc** so
  it can flag where reality diverged from the plan (those diffs are new decisions to record).
