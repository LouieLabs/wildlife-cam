# HT-HC33 SD card — integration notes (handoff)

> **Status (2026-06-29):** The fleet firmware ([`cloud_telemetry_node/`](../../cloud_telemetry_node/))
> now stores photos in **internal flash (LittleFS)**, not microSD. This sketch
> is kept for diagnosing flash hardware on a suspect board (or for projects
> that still need removable storage), not as the default storage path. See
> [`docs/FLASH_STORAGE_OTA_PLAN.md`](../../docs/FLASH_STORAGE_OTA_PLAN.md) for
> the decision context.

How to read/write the microSD card on the **Heltec HT-HC33** (ESP32-S3 Wi-Fi
HaLow Camera) from Arduino, plus a drop-in "what's wrong with the card"
diagnostic. All of this is verified working on real hardware.

## Toolchain / board

- **Core:** *ESP32 HaLow* (`heltec:esp_halow`), NOT the regular Heltec ESP32
  core. Install via Boards Manager ("ESP32 halow") or it's already installed.
- **FQBN:** `heltec:esp_halow:HT-HC33`
  (there is also a `HT-HC33-V2` variant if the board is the V2 revision).
- **Arduino IDE settings:** Board "HT-HC33" (or "HT-HC33(V2)" — same variant
  and pins), *USB CDC On Boot:* **Disabled** (the default), PSRAM: OPI PSRAM,
  Flash Size: 16MB.
  - Leave **USB CDC On Boot DISABLED.** Serial on this board goes through the
    external **CP2102** USB-UART bridge (it enumerates as `/dev/cu.usbserial-*`
    / "Silicon Labs CP210x"). Enabling USB CDC redirects `Serial` to the
    ESP32-S3's *native* USB, which is not wired to the USB-C port here — the
    serial monitor would go dead.
- arduino-cli build/flash:
  ```
  arduino-cli compile --fqbn heltec:esp_halow:HT-HC33 .
  arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn heltec:esp_halow:HT-HC33 .
  ```
  (CP2102 USB-serial; nothing holds the port — close any open Serial Monitor
  first or the upload fails with "port doesn't exist".)

### Expected compile warnings (harmless)

On Arduino IDE 2.3.x (e.g. 2.3.10) the sketch compiles clean but prints three
warnings. They're a metadata mismatch only — the bundled libraries are tagged
for the `esp32` architecture while this core's arch is `esp_halow`. **Operation
is unaffected:**

```
WARNING: library SPI claims to run on esp32 architecture(s) and may be incompatible with your current board which runs on esp_halow architecture(s).
WARNING: library SD claims to run on esp32 architecture(s) and may be incompatible with your current board which runs on esp_halow architecture(s).
WARNING: library FS claims to run on esp32 architecture(s) and may be incompatible with your current board which runs on esp_halow architecture(s).
Sketch uses 326585 bytes (8%) of program storage space. Maximum is 3670016 bytes.
Global variables use 14340 bytes (4%) of dynamic memory, leaving 313340 bytes for local variables. Maximum is 327680 bytes.
```

### Serial monitor and the 5-second re-run

After a flash, the board resets and runs immediately — the first pass prints in
the ~1.5 s before the serial monitor reattaches, so you'd miss it. To avoid that,
this sketch **re-runs the whole test every 5 seconds** from `loop()`: open the
monitor at any time and you get a fresh, full result within 5 s — no reset
needed, and no filler "heartbeat" line.

**Why not just auto-detect that the monitor opened?** You can't on this board.
That trick (`while(!Serial)`) needs the ESP32-S3's *native* USB, but serial here
goes through the external **CP2102** UART, which exposes no "host connected"
signal. Native USB isn't available either — its D+/D- pins (GPIO19/20) are used
for the RGB LED and the camera power-down. So the firmware has no way to know the
monitor was opened; the periodic re-run is the clean alternative.

**Use `serial_monitor_noreset.py`, not the IDE Serial Monitor, during dev.** The
Arduino IDE Serial Monitor toggles DTR/RTS when it opens — that **warm-resets the
board**. On a warm reset the SD card stays powered in its already-initialized SPI
state, and re-init can fail on a marginal card, so you'll see `f_mount = 3`
(`NOT_READY`) **even though the card mounted fine on the actual cold boot.** The
included monitor holds the reset line inactive so it never resets the board:

```bash
python3 serial_monitor_noreset.py        # defaults: /dev/cu.usbserial-0001 @ 115200
```

(Needs `pip3 install pyserial`; Ctrl-C to quit. Start it first, then power-cycle
to watch a fresh boot.) Reminder: only a true **power cycle** (USB unplug) clears
a wedged card — RST, reflash, and opening the IDE monitor do not.

## Library gotcha (important)

This core renames the SD header. Use:

```cpp
#include <SPI.h>
#include <halow_SD.h>     // NOT <SD.h> — this core ships halow_SD.h
#include <sd_diskio.h>    // only needed for the low-level fault diagnostic
```

`halow_SD.h` still provides the standard global `SD` object (`fs::SDFS SD`) and
the normal Arduino `File` / `fs::FS` API (`open`, `print`, `read`, `mkdir`,
`remove`, `rename`, `exists`, …). `<SD.h>` does **not** exist in this core and
will fail to compile.

## SD pins (fixed by the PCB) + bus

| Signal  | GPIO |
|---------|------|
| SD_CLK  | 15   |
| SD_MISO | 16   |
| SD_MOSI | 11   |
| SD_CS   | 10   |

Drive it on the **HSPI** peripheral with its own `SPIClass` instance (this is
what Heltec's own `As_VideoWebServer` example does — the default global `SPI`
/ FSPI did not work reliably in testing):

```cpp
static const int SD_SCK = 15, SD_MISO = 16, SD_MOSI = 11, SD_CS = 10;
SPIClass SD_SPI(HSPI);

void mountSD() {
  SD_SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  if (!SD.begin(SD_CS, SD_SPI)) {       // 4 MHz default; format_if_empty = false
    // handle failure (see diagnostic below)
    return;
  }
  // SD is ready: SD.cardType(), SD.cardSize(), SD.open(...), etc.
}
```

`SD.begin()` full signature:
```cpp
SD.begin(uint8_t ssPin = SS, SPIClass &spi = SPI, uint32_t frequency = 4000000,
         const char *mountpoint = "/sd", uint8_t max_files = 5,
         bool format_if_empty = false);
```
Leave `format_if_empty = false` in production so a bad/foreign card is never
silently erased. Setting it `true` makes the board reformat the card to FAT if
the filesystem can't be mounted (**erases the card**).

These pins do not collide with the camera (Y2..Y9 = 17/13/12/14/18/46/48/38,
XCLK 47, PCLK 21, VSYNC 40, HREF 39, SIOD 45, SIOC 42, PWDN 20) or the HaLow
module (GPIO 2–9), so SD + camera + HaLow can coexist.

## Card formatting requirement (the #1 failure cause)

The ESP32 SD driver only reads cards with a **Master Boot Record (MBR)**
partition table and a **FAT32 or exFAT** filesystem.

macOS Disk Utility defaults to **GUID Partition Map**, which mounts fine on the
Mac but the ESP32 **cannot read** — `SD.begin()` just returns `false`.

### Format on a Mac with Disk Utility (GUI)

Put the card in the Mac's SD slot or a USB card reader, then:

1. Open **Disk Utility** (Applications → Utilities).
2. Menu bar: **View → Show All Devices.** This is the critical step — without
   it you only see the *volume* and the **Scheme** option is hidden.
3. In the left sidebar, select the **device** — the top-level entry (e.g.
   "Generic SD/MMC Reader Media" or the card's brand/size), **not** the indented
   volume beneath it.
4. Click **Erase**.
5. Set:
   - **Name:** anything (e.g. `WILDCAM`)
   - **Format:** **MS-DOS (FAT)** (= FAT32). **Do NOT use ExFAT** — this board's
     FatFs is built with `FF_FS_EXFAT=0`, so exFAT cards won't mount. For cards
     >32 GB, still use FAT32 (via the CLI below), not ExFAT.
   - **Scheme:** **Master Boot Record**  ← only appears because you selected the
     device, not the volume
6. **Erase** → done.

If "Scheme" isn't shown, you picked the volume — go up one level to the device.

> **"MS-DOS (FAT)" → FAT32 here.** That menu item is a family label; macOS picks
> the variant by size (FAT16 below ~2 GB, FAT32 above). A 16 GB card becomes
> FAT32. The "FAT32 ≤ 32 GB" rule is a *Windows tool* limit, not a FAT32 limit.

### Format from the command line (explicit, scriptable)

```bash
diskutil list                 # find the card — verify by SIZE + "external, physical"
diskutil eraseDisk FAT32 WILDCAM MBRFormat /dev/diskN
```
`eraseDisk <format> <name> <scheme> <device>` → `FAT32` + `MBRFormat` is exactly
what the ESP32 needs. **⚠️ Triple-check `diskN`** — `eraseDisk` wipes whatever
you point it at; never target `disk0` (the internal drive).

Verify the result:
```bash
diskutil info /dev/diskNs1 | grep -i "personality"
# -> File System Personality: MS-DOS FAT32
```

## Fault diagnostic (error-code based)

`SD.begin()` only returns a bool, so on failure the sketch does a single
low-level `f_mount` probe and prints the **exact FatFs error code** — which
pins down the real failure mode:

| `f_mount` | Code | Meaning | What to do |
|---|---|---|---|
| `0`  | `FR_OK` | mounted on retry | transient glitch |
| `3`  | `FR_NOT_READY` | card didn't initialize | not inserted / wiring — **or a WEDGED card**: power-cycle (see below) |
| `1`  | `FR_DISK_ERR` | card responds, reads fail | marginal card/slot/cable — reseat, clean contacts, shorter/known-good cable |
| `13` | `FR_NO_FILESYSTEM` | card read OK, no valid FAT | wrong format (GUID/exFAT/no-MBR) **or** a marginal link returning bad data |

```cpp
#include <ff.h>          // FatFs API for FRESULT
#include <sd_diskio.h>   // sdcard_init / sdcard_uninit

uint8_t pdrv = sdcard_init(SD_CS, &SD_SPI, 400000);   // slow, robust init
static FATFS fs; char drv[3] = {(char)('0' + pdrv), ':', 0};
FRESULT fr = f_mount(&fs, drv, 1);     // 1 = mount immediately
Serial.printf("f_mount = %d\n", fr);   // classify per the table above
f_mount(NULL, drv, 0); sdcard_uninit(pdrv);
```

Note: `sdcard_init()` only reserves a FATFS slot + sets up CS — the card isn't
contacted until the mount. Do a **single** probe; hammering init with repeated
back-to-back `SD.begin()` attempts can itself wedge a marginal card.

## Troubleshooting & lessons learned

A long debugging session ("the SD slot doesn't work") came down to a handful of
non-obvious things. If a card won't mount, check these **in order**:

1. **Power-cycle the card — RST is not enough.** This was the #1 trap. Once a
   card lands in `FR_NOT_READY` it stays stuck through every reset, reflash, and
   DTR toggle, because **none of those drop the SD card's 3.3 V**. Only a full
   **USB unplug/replug** power-cycles the card. Most "still broken" results were
   just a wedged card re-tested without real power.
2. **Format is rarely the cause.** We chased "WRONG FORMAT" for ages — red
   herring. The card's FAT32 was always valid (verified by decoding the boot
   sector *and* `diskutil verifyVolume` passing on the Mac). `FR_NO_FILESYSTEM`
   can also come from a *marginal link returning garbage*, not a bad filesystem.
   Confirm the format independently before reformatting.
3. **Power source matters.** Through a **USB hub** the link is marginal — 4 MHz
   reads occasionally fail and the sketch falls back to 1 MHz. **Direct to the
   computer** was rock-solid at 4 MHz every time. A flaky/charge-only cable or
   hub also makes the serial port repeatedly drop and re-enumerate — treat that
   as a power/cable warning sign.
4. **"Reads in the Mac" ≠ "reads on the board."** A card that the Mac reads
   perfectly can still be flaky over SPI, because the Mac uses a robust SDIO
   reader, not this board's SPI link. (In the end, with proper power cycling,
   every card and both boards worked.)
5. **Don't re-mount in `loop()`.** Repeated `SD.begin()` can wedge a marginal
   card. Mount **once** in `setup()`; re-run only the file I/O in `loop()`.

### Ruled out (so you don't re-chase them)

- ❌ **Format** (GUID / exFAT / FAT32-without-MBR) — valid FAT32 confirmed on
  both the board's decode and the Mac's `fsck`.
- ❌ **SPI speed** — fails identically at 4 MHz, 1 MHz, and 400 kHz when wedged.
- ❌ **Repeated `SD.begin()` in loop alone** (arduino-esp32 #7565) — it failed
  even mounting once in `setup()`.
- ❌ **A permanently bad board/slot** — board 1 looked dead, but works fine
  direct + power-cycled; its failures were the hub + a wedged card.

### Confirmed-working recipe

- Either board, a FAT32 + MBR card (16–32 GB; avoid 128 GB SDXC over SPI).
- **Insert the card with the board unplugged → plug in (clean power) → mounts at
  4 MHz**, full read/write.
- Prefer **direct USB**; a hub works but leans on the 1 MHz fallback.
- To recover anything stuck: **unplug/replug, not RST.**

## Verified on real HT-HC33 hardware

- Board 1 **and** board 2, two different 16 GB cards, direct USB, clean power
  cycle → `Mounted OK at 4000000 Hz`; write/read/append/re-read all pass, stable
  every 5 s.
- Via hub → mounts, occasionally through the 1 MHz fallback.
- Injected faults reproduce each diagnostic: broken MOSI → `FR_NOT_READY` /
  no-card; GUID / foreign filesystem → `FR_NO_FILESYSTEM` / wrong-format.

See `HT-HC33_SDTest.ino` in this folder for the full working sketch.
