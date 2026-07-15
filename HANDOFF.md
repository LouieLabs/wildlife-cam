# Handoff — Adding Wi-Fi HaLow to the wildlife-cam (HT-HC33)

**Branch:** `halow-networking` (off `main`). All changes are in the working tree — **not committed or pushed yet**.
**Date:** 2026-07-14

## Goal
Add HaLow (802.11ah) networking to the Heltec **HT-HC33** camera firmware. Locked decisions:
connect to an **HT-H7608 gateway** (AP), **dual-radio** (HaLow primary + keep 2.4 GHz), full **install → port → build → flash**.

## Status at a glance
- ✅ ESP_HaLow core installed, sketch ported, compiles clean, flashed to the board.
- ✅ Heltec per-device **license activated** (`The board is actived`, `HaLow LwIP interface initialised`).
- ⛔ **HaLow not associating** with AP `ahwlan` — board loops at `Connecting HaLow.....`, never reaches `WL_CONNECTED`. **This is the current blocker.**

## Environment (set up during the session)
- **`gh` CLI**: `~/bin/gh` v2.96.0 (downloaded binary, no auto-update). Authed as `chloelien1` (`repo`,`read:org`,`gist`); `gh auth setup-git` done.
- **Heltec ESP_HaLow core**: `~/Documents/Arduino/hardware/heltec/esp32` (platform `heltec:esp32` 3.0.0). Separate from the espressif core — HaLow is unreachable from the stock esp32 core.
- **pyserial** installed for `/usr/bin/python3` (3.9.6). `arduino-cli` v1.5.1 in `~/bin`; user dir `~/Documents/Arduino`.

## Code changes (in `videowithinterfacesketch/`)
`videowithinterfacesketch.ino`:
1. Includes: added `<HaLow.h>`, `<HalowHTTPClient.h>`, `<HalowClientSecure.h>`; **removed `<HTTPClient.h>` and `<WiFiClientSecure.h>`** (HaLow's `HTTP_CODE_*` enum collides with stock `<HTTPClient.h>` — cannot include both in one file). Added `#define HALOW_REGION "US"`.
2. `httpGET()` (geolocation/weather enrichment) now uses `HalowHTTPClient` + `HalowClient`/`HalowClientSecure` over HaLow.
3. `setup()` networking: `HaLow.init(HALOW_REGION); HaLow.begin(HALOW_SSID, HALOW_PASSWORD);` + `WiFi.mode(WIFI_STA); WiFi.begin(...)`. Blocks only on HaLow; 2.4 GHz is best-effort secondary. Web server binds all interfaces (unchanged).

`secrets.h` (gitignored): `HALOW_SSID "ahwlan"`, `HALOW_PASSWORD "louielabs.com"`. `secrets.example.h`: placeholders added.

## Build & flash
- FQBN: **`heltec:esp32:HT-HC33`** (defaults: QSPI PSRAM, `default_8MB` partition; V1 and V2 share variant/pins — no menu overrides).
- Compile: **61% flash, 19% RAM**, clean.
- `arduino-cli compile --upload --fqbn heltec:esp32:HT-HC33 -p /dev/cu.usbserial-0001 .`
- Boots `Camera init OK`. (`Temp sensor unavailable` = die-temp sensor range errors on this core; cosmetic.)

## License gate (RESOLVED)
Heltec HaLow is license-gated per ChipID. This unit: **ChipID `1873E304A7AC`**.
License (from https://resource.heltec.cn/search): `0x896C59D4,0x6EE07390,0x8CB8894D,0xB83442E3`.
Write it over serial (115200), **exactly 41 bytes, no terminator**:
```
AT+CDKEY=896C59D46EE073908CB8894DB83442E3
```
Parser: `wifi-halow/src/chekuart.cpp` (needs `AT+CDKEY=` + 32 hex, 1 s poll loop). Success prints `The board is actived`; persists across reboot (RTC/NVS), lost only on flash erase.

## CURRENT BLOCKER — HaLow won't associate with `ahwlan`
After activation, stuck at `Connecting HaLow.....`. Our connect loop only prints dots (no diagnostics).

### Next steps (in order)
1. Re-watch serial ~60 s — rule out slow first association.
2. Verify the **HT-H7608**: powered, **AP mode**, SSID exactly `ahwlan`, password `louielabs.com`, **US region (902–928 MHz)**, HC33 in range. Check casing / hidden SSID / security type / channel-bandwidth.
3. **Scan from the HC33**: flash `wifi-halow/examples/HalowScan/HalowScan.ino` (temporarily) or add `HaLow.scanNetworks()` to the sketch. If `ahwlan` isn't seen → AP config/range/region problem, not firmware.

## Reference
- **Serial capture** (reliable reset; better than `arduino-cli monitor`): pyserial 115200, `dtr=False; rts=True`, `open()`, then `setRTS(False)`. **Use `python3 -u` / `flush=True`** — block-buffering hid output and left a process holding the port once this session.
- Board intermittently drops off USB (`/dev/cu.usbserial-0001` vanishes) — replug.
- HaLow API: `HaLow.init("US")` → `HaLow.begin(ssid,pw)` → `HaLow.status()/localIP()/RSSI()`; TCP `HalowClient`/`HalowClientSecure`; HTTP `HalowHTTPClient`. Never include stock `<HTTPClient.h>` alongside these.

## Not done yet
- HaLow association (blocker above).
- No git commit/push of `halow-networking`.
- End-to-end check that the camera stream is reachable over the HaLow IP.
