# PARKED — PlatformIO build path

> **Status:** PARKED. **Active build path is Arduino IDE + Heltec "ESP32 HaLow"
> core** (`heltec:esp_halow`, FQBN `heltec:esp_halow:HT-HC33`). This doc exists
> so a future attempt has the rationale + a starting `platformio.ini` to revive
> from, without leaving a `platformio.ini` at the repo root where it triggers
> false IDE/CI detection as an active PlatformIO project.

## Why parked

PlatformIO was installed while bringing up the Antigravity 2.0 AI IDE. That IDE
proved too complicated for the high-school students using it, and it failed to
produce a working SD-card test in its ~1 hour attempt (vs the ~4 hours it took
Claude Code to fully solve it — see
[`hardware-tests/HT-HC33_SDTest/`](../hardware-tests/HT-HC33_SDTest/) and
[`docs/for-students/sd-card-story.md`](for-students/sd-card-story.md)).
Antigravity is abandoned for now, so this PlatformIO config is left parked.

## Why PlatformIO doesn't fully support the Heltec HT-HC33

- **No HT-HC33 board definition exists in PlatformIO.** A generic
  `esp32-s3-devkitc-1` is the closest stand-in; flash size and PSRAM (the
  HT-HC33 uses OPI/QSPI) may need `board_build` overrides or the board won't
  boot reliably.
- **PlatformIO's `espressif32` platform uses the STANDARD arduino-esp32 core**,
  which does **not** include Heltec's HaLow stack. Consequences:
  - The Wi-Fi HaLow radio APIs are unavailable — the camera firmware depends on
    them, so **this is the actual blocker**.
  - `halow_SD.h` does not exist here; use the standard `<SD.h>` instead.
    SD-over-SPI is generic — same pins (CLK=15 / MISO=16 / MOSI=11 / CS=10 on
    HSPI) work fine with the stock SD library.
- **`ARDUINO_USB_CDC_ON_BOOT` MUST be `0`** on the HT-HC33: its USB-C port is
  wired to an external CP2102 UART, not the ESP32-S3's native USB. With it set
  to `1`, `Serial` is routed to native USB and the serial monitor stays blank.

## How to revive

If a HaLow-capable PIO platform shows up later — or you want to try non-HaLow
SD/sensor experiments under PIO — start from this config and drop a source
file into `src/`:

```ini
[platformio]
default_envs = heltec_hc33

[env:heltec_hc33]
platform = espressif32
board = esp32-s3-devkitc-1        ; generic ESP32-S3 stand-in; no real HT-HC33 board def in PIO
framework = arduino
monitor_speed = 115200
build_flags =
    -DARDUINO_USB_MODE=1
    -DARDUINO_USB_CDC_ON_BOOT=0   ; HT-HC33 serial is via external CP2102 UART, not native USB

[env:lilygo_t_halow_p4]
platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip
board = esp32-p4
framework = arduino
monitor_speed = 115200
build_flags =
    -DARDUINO_USB_MODE=1
    -DARDUINO_USB_CDC_ON_BOOT=1   ; different board (ESP32-P4); native USB CDC is appropriate here
```

Save as `platformio.ini` at the repo root, install [PlatformIO Core](https://platformio.org/),
then `pio run -e heltec_hc33`. Expect the Wi-Fi HaLow blocker above to bite
immediately for the camera firmware; non-HaLow experiments may build.

## Original location

The above config lived at the repo root as `platformio.ini` until it was moved
here to stop tooling from auto-detecting the repo as an active PlatformIO
project (see git history for the original file).
