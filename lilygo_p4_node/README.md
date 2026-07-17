# Lilygo T-Halow-P4 Wildlife Camera Node (ESP-IDF)

> # ⛔ DIFFERENT BOARD — NOT the Heltec HT-HC33
>
> **This folder is ONLY for the Lilygo T-Halow-P4.** It has nothing to do with
> `camera_code_v3_1/` or `cloud_telemetry_node/`, which are the **Heltec
> HT-HC33** firmware and are unaffected by anything in here.
>
> | | Heltec HT-HC33 | **Lilygo T-Halow-P4 (this folder)** |
> |---|---|---|
> | Folder | `camera_code_v3_1/`, `cloud_telemetry_node/` | **`lilygo_p4_node/`** |
> | Chip | ESP32-S3 (Xtensa) | **ESP32-P4 (RISC-V)** |
> | Build with | Arduino IDE | **ESP-IDF (`idf.py`) — Arduino will NOT work** |
> | `BOARD_TYPE` | `heltec-ht-hc33` | **`lilygo-t-halow-p4`** |
>
> **⚠️ NEVER cross-flash these images.** Different CPU architectures — a P4
> image on an S3 (or the reverse) is a guaranteed brick. The dashboard's OTA
> publisher filters by `BOARD_TYPE` for exactly this reason; keep that field
> accurate if you touch it.

The ESP32-P4 port of `camera_code_v3_1` / `cloud_telemetry_node`. Same cloud
protocol, same dashboard, same behavior contract as the Heltec HT-HC33 node —
different silicon, so every hardware-touching layer is reimplemented on
ESP-IDF v5.3+ (per `.agents/rules/HARDWARE.md`: RISC-V, MIPI-CSI camera,
NO Arduino).

> **In plain words.** This board naps, wakes on motion, takes a photo, uploads
> it to the same website as the other cameras, and goes back to sleep. It's
> the same wildlife camera brain in a faster body. The big differences under
> the hood: the P4 has no WiFi radio of its own (an onboard ESP32-C6 companion
> provides it), and the camera speaks MIPI-CSI instead of the old parallel bus.

## Status: PHASE 1 (bring-up)

| Piece | Status |
|---|---|
| Duty cycle (deep sleep, timer + PIR + button wakes) | ported |
| NVS identity/config + USB serial provisioning | ported |
| Photo store (LittleFS, upload-then-delete) | ported |
| Cloud protocol (status, command-poll, signed upload, capture-complete, ack) | ported |
| Motion burst w/ quiet window + dashboard-tunable settings | ported |
| set_wifi / set_id OTA config commands (+ wifi trial auto-revert) | ported |
| Camera capture (MIPI-CSI -> JPEG) | Phase 1 — filled from vendor/Espressif docs |
| WiFi via ESP32-C6 companion (esp-hosted / esp_wifi_remote) | Phase 1 — filled from vendor/Espressif docs |
| Firmware OTA | Phase 2 |
| Live-stream mode | Phase 2 |
| HaLow radio (TX-AH via AT commands) | Phase 2 — needs the gateway design (docs/lilygo t-halow-gateway-spec.md) |

## Build & flash

One-time setup (installs Espressif's toolchain, ~2 GB):

```bash
git clone -b v5.4 --recursive https://github.com/espressif/esp-idf.git ~/esp-idf
~/esp-idf/install.sh esp32p4
```

Every session:

```bash
. ~/esp-idf/export.sh
cd lilygo_p4_node
idf.py set-target esp32p4
idf.py build flash monitor        # board on USB; Ctrl-] exits monitor
```

`idf.py menuconfig` exposes the node options under "Wildlife node config".

## Layout

```
main/
  app_main.c        wake cycle (the old sketch's setup())
  node_config.h     tunables: sleep interval, burst cadence, endpoints
  device_config.*   NVS identity/wifi + set_wifi trial/auto-revert
  provisioning.*    USB-serial REPL (MAC?/SET/SAVE/EXIT) — dashboard flash tool
  net.*             connectivity via the C6 companion (esp-hosted)
  cloud_backend.*   HTTPs protocol to the dashboard backend (cJSON parsing)
  camera_capture.*  MIPI-CSI sensor -> JPEG still
  photo_store.*     LittleFS queue: save -> upload -> delete-on-confirm
  pir_wake.* / user_button.*  deep-sleep wake sources
  version.h         build stamp reported to the dashboard
```
