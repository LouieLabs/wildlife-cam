# Lilygo T-Halow-P4 port — plan + verified hardware facts

Port of the wildlife-camera node to **Target Board 2** (`.agents/rules/HARDWARE.md`).
Lives in `lilygo_p4_node/`. **Does not touch the Heltec firmware** — different
folder, different toolchain, different `BOARD_TYPE`.

> **In plain words.** Same camera brain, different body. It naps, wakes on
> motion, photographs, uploads to the same dashboard. The differences are all
> under the hood: a faster RISC-V chip, a camera that speaks a different bus,
> and no radio of its own (a helper chip does WiFi).

## Why this is a port, not a pin-swap

| | Heltec HT-HC33 | Lilygo T-Halow-P4 |
|---|---|---|
| MCU | ESP32-S3 (Xtensa) | ESP32-P4 (RISC-V) |
| Toolchain | Arduino IDE | **ESP-IDF v5.4** (Arduino is invalid) |
| Camera | OV3660, parallel DVP, `esp32-camera` | **MIPI-CSI**, `esp_video`/`esp_cam_sensor` |
| WiFi | native radio | **none** — via onboard ESP32-C6 companion |
| HaLow | onboard HT-HC01 | Taixin TX-AH-R900P (UART AT + SPI data) |

## Verified hardware facts (2026-07-15 research pass)

Sources: Lilygo `T-Halow-P4` README + `hardware/T-Halow-P4 V0.2.PDF` +
`examples/`; Espressif `esp-video-components`, `esp-hosted-mcu`.

**Camera (MIPI-CSI, connector J4, 24-pin 0.5 mm FPC, 2 data lanes)**
- ⚠️ **The board ships with NO camera.** README: *"By default, there is no
  Camera and LCD."* A sensor module must be attached.
- Lilygo's example targets **OV2710** (SCCB `0x36`); alternates **SC2336**
  (`0x30`), **OV5645** (`0x3C`). Use `esp_cam_sensor` — NOT legacy `esp32-camera`.
- SCCB shares the board I2C bus: **SDA=GPIO7, SCL=GPIO8**, level-shifted to 1.8 V.
- ⚠️ **Camera power is software-gated**: an **SGM38121 LDO at I2C `0x28`** must
  be programmed ON (DVDD 1.5 V, AVDD 1.7 V / 3.0 V) *before* the sensor answers.
  Skipping this looks exactly like "camera not found".
- **MCLK is an onboard oscillator** (the P4 does not drive it); **CAM_RST is an
  RC power-on reset, not a GPIO** — so no software reset line to toggle.

**WiFi via ESP32-C6 companion (esp-hosted, 4-bit SDIO)**
- CMD=19, CLK=18, D0=14, D1=15, D2=16, D3=17, slave reset=54, C6_WAKEUP=6.
- Pin map is **identical to Espressif's ESP32-P4-Function-EV-Board**, so stock
  `esp-hosted-mcu` host defaults apply.
- ⚠️ **The C6 ships BLANK on Lilygo boards.** `esp-hosted-mcu` *slave* firmware
  must be flashed onto it first via an external USB-serial adapter (C6 TX/RX are
  on header JP1; C6 BOOT→GND for download mode). Espressif's own board comes
  pre-flashed — Lilygo's does not.

**HaLow (Phase 2)**
- Taixin **TX-AH-R900P**: AT-command UART on **TX=IO12/RX=IO13 @ 115200**
  (`doc/AT_cmd.md`: `AT+MODE`, `AT+SSID`, `AT+PSK`, `AT+PAIR`), plus a 6-wire
  SPI data path (SCLK=43, MOSI=44, MISO=39, CS=42, INT=40). Module has its own
  4 MB flash + firmware.

**Board**
- Flash **16 MB** (solid). PSRAM: README says 32 MB, retail pages say 8 MB —
  **unresolved**; confirm from the boot log on real hardware before sizing frame
  buffers.
- USB-C flashing via a **CH343P UART bridge** on UART0 (GPIO37/38); the P4's
  native USB-OTG is wired to the same connector.

## Phases

**Phase 1 (in progress)** — parity with the Heltec node.
- [x] Project skeleton, partitions (dual OTA slots reserved), `idf.py build` green
- [x] Wake cycle, spurious-PIR filter, motion burst + quiet window, settings cache
- [x] Cloud protocol (status/command-poll/upload/capture-complete/ack), TLS **verified**
- [x] NVS identity, `set_wifi` trial + auto-revert, `set_id`, `wifi_trial_clear`
- [x] USB-serial provisioning (same protocol → same dashboard tool works)
- [x] LittleFS photo queue (upload → confirm → delete)
- [ ] `net.c` — esp-hosted/esp_wifi_remote over SDIO (**stub**)
- [ ] `camera_capture.c` — SGM38121 power-up → `esp_cam_sensor` → JPEG (**stub**)
- [ ] PIR GPIO choice verified against the schematic (currently a placeholder)
- [ ] Battery sense (circuit not yet identified; `cloud_battery_percent()` stubbed to 100)

**Phase 2** — OTA (slots already reserved), live-stream mode, HaLow radio +
gateway design (see `docs/lilygo t-halow-gateway-spec.md`), Cloud Build compile
for `builds/lilygo-t-halow-p4/` (TODOS.md item 4).

## Decision record

**2026-07-15 — ESP-IDF, not Arduino.** Mandated by HARDWARE.md and correct: the
P4's MIPI-CSI + esp-hosted stacks have no Arduino equivalent. Cost: a second
toolchain (`idf.py`) for students. Benefit: a real compiler (it caught two
defects in the first build) and proper TLS verification, which the Arduino build
skips with `setInsecure()`.

**2026-07-15 — protocol/NVS/provisioning kept byte-compatible with the S3 node.**
Same NVS namespace + keys, same serial provisioning verbs, same HTTP contract.
So the dashboard, the Web Serial "Set up a camera" tool, and the docs work for
both boards with zero changes; only `BOARD_TYPE` differs (OTA safety gate).
