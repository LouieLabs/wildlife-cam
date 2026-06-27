# motion_capture_sd — PIR motion-triggered photo capture (HT-HC33)

Deep-sleep wildlife trap: the board sleeps, a PIR motion sensor wakes it, it
takes a photo, saves it to the microSD card (`/wildcam/img_NNNNN.jpg`), and goes
back to sleep. No WiFi/website yet — photos accumulate on the card. Cloud upload
is a planned next step.

- **Board:** Heltec HT-HC33 — FQBN `heltec:esp_halow:HT-HC33` ("ESP32 HaLow" core)
- **Sensor:** HC-SR501 PIR on **GPIO1** (free + RTC-wake capable)

## Wiring

| PIR (HC-SR501) | HT-HC33 |
|---|---|
| OUT | GPIO1 |
| GND | GND |
| VCC | **5V** (see gotcha below) |

PIR tuning: time-delay knob → minimum, sensitivity → up, jumper → H, dome lens on.

## Build / flash

```bash
arduino-cli compile --fqbn heltec:esp_halow:HT-HC33 .
arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn heltec:esp_halow:HT-HC33 .
```

`DEBUG_STAY_AWAKE 1` at the top disables sleep and captures on each motion while
printing to serial — handy for bench testing. A camera-free sensor check lives in
`../hardware-tests/HT-HC33_PIRTest/`.

## Verified on hardware (2026-06-26)

Tested on a real HT-HC33 over `/dev/cu.usbserial-0001`:

- Camera initializes (`[CAM] init OK`).
- PIR wakes the board from deep sleep on motion — confirmed multiple cycles
  (`boot #N (woken by MOTION)`, `rst:0x5 (DSLEEP)`).
- Deep sleep re-arms after each capture.

## Known issues / gotchas (hit during bring-up)

1. **SD card MUST be FAT32 on an MBR partition.** This is currently the one
   unfinished piece — the test card was the wrong format, so photos did **not**
   save yet. The SD diagnostic reports the exact cause:
   - `f_mount result = 13 (NO_FILESYSTEM)` → wrong format. macOS Disk Utility
     defaults to GUID/exFAT, which the ESP32 can't read.
   - `f_mount result = 3 (NOT_READY)` → card not inserted/seated, or "wedged"
     (a reset does NOT power-cycle the slot — fully unplug the board ~5s).
   - Fix: move the card to a Mac, then
     `diskutil eraseDisk FAT32 WILDCAM MBRFormat /dev/diskN`
     (or Disk Utility → Show All Devices → select the **DEVICE** → Erase →
     MS-DOS (FAT), Scheme = **Master Boot Record**). See
     `../hardware-tests/HT-HC33_SDTest/` for the full diagnostic.

2. **HC-SR501 needs 5V.** On the 3.3V pin it would not trigger at all (the pin
   read a stuck value during bring-up). Moving VCC to 5V fixed detection
   immediately. The OUT signal is 3.3V logic, safe for GPIO1.

3. **PSRAM is off in the default build → camera falls back to VGA.** For
   full-resolution UXGA stills, build with the OPI PSRAM option:
   `arduino-cli compile --fqbn heltec:esp_halow:HT-HC33:PSRAM=opi .`
   (Arduino IDE: Tools → PSRAM → "OPI PSRAM"). The sketch auto-detects PSRAM at
   runtime and picks UXGA when present, VGA otherwise.
