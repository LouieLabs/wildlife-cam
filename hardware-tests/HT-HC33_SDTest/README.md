# HT-HC33 SD card — integration notes (handoff)

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

### Serial monitor shows nothing until you reset

After a flash, the board resets and runs `setup()` immediately — its output
prints in the first ~1.5 s, before the serial monitor reattaches. So the monitor
opens onto an already-finished program and looks dead until the board resets
again.

This sketch handles that by running the test once in `setup()` and ending with a
`>>> Press the RST button to run the test again. <<<` line. Whenever the board
resets you get the full result, then silence — no repeating output. Opening the
serial monitor toggles the reset line (DTR/RTS → EN), so it usually re-runs
`setup()` on its own; if your monitor doesn't, just tap **RST**.

**Why not auto-detect that the monitor opened?** You can't on this board. That
trick (`while(!Serial)`) needs the ESP32-S3's *native* USB, but serial here goes
through the external **CP2102** UART, which exposes no "host connected" signal.
Native USB isn't available either — its D+/D- pins (GPIO19/20) are used for the
RGB LED and the camera power-down. So the firmware has no way to know the monitor
was opened; a periodic re-run or the RST-driven re-run above are the only
options.

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
   - **Format:** **MS-DOS (FAT)** for cards up to ~32 GB, or **ExFAT** for larger
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

## Drop-in fault diagnostic

`SD.begin()` only returns a bool, so it can't tell the user *why* it failed.
This helper distinguishes the two real-world cases without erasing anything:

- **card not detected** (not inserted / bad wiring / dead card) — the card
  never initializes, so `card->type` stays `CARD_NONE`/`CARD_UNKNOWN`
- **wrong format** (card present, filesystem unreadable) — the card initializes
  fine, so `card->type` is `CARD_SD`/`CARD_SDHC`/`CARD_MMC`, but `f_mount` fails

Mechanism: `sdcard_init()` only reserves a FATFS slot + sets up CS — it does
**not** contact the card. The card is first contacted during the mount
(`f_mount` → `ff_sd_initialize`), which sets `card->type`. So we re-init and
re-mount at the low level purely to read `card->type` and classify. `card->type`
remains valid after a failed mount (the wrapper doesn't reset it before we read).

```cpp
#include <sd_diskio.h>   // sdcard_init / sdcard_mount / sdcard_type / sdcard_uninit

void diagnoseSDFailure() {
  uint8_t pdrv = sdcard_init(SD_CS, &SD_SPI, 400000);   // slow, robust
  if (pdrv == 0xFF) { Serial.println("[SD] no free FATFS slot"); return; }

  bool mounted = sdcard_mount(pdrv, "/sddiag", 5, false);   // expected to fail
  sdcard_type_t type = sdcard_type(pdrv);
  bool cardInitialized =
      (type == CARD_SD || type == CARD_SDHC || type == CARD_MMC);

  if (mounted) {
    sdcard_unmount(pdrv);
    Serial.println("[SD] mounted on retry (transient glitch)");
  } else if (!cardInitialized) {
    Serial.println("[SD] No card detected: not inserted / wiring / dead card.");
  } else {
    Serial.println("[SD] Card present but filesystem unreadable -> WRONG FORMAT.");
    Serial.println("     Reformat FAT32/exFAT with an MBR partition scheme.");
  }
  sdcard_uninit(pdrv);   // release the slot we grabbed for the probe
}
```

Call it only after `SD.begin()` returns false. It re-acquires its own FATFS
slot (the failed `SD.begin()` already freed its slot and unregistered `/sd`),
so use a distinct mountpoint like `/sddiag` and always `sdcard_uninit()` after.

### Why classify on `card->type` and not `CARD_NONE` alone

`ff_sd_initialize()` jumps to a `unknown_card:` label on *any* SPI comms
failure, which sets `card->type = CARD_UNKNOWN` (not `CARD_NONE`). So "no card"
and "bad wiring" both surface as `CARD_UNKNOWN`. Only a card that fully
initializes gets a concrete `CARD_SD`/`CARD_SDHC`/`CARD_MMC`. Hence the test is
"did it initialize" (one of the three real types), not "type != NONE".

## Verified behavior (on real HT-HC33 hardware)

- Correct pins + FAT32/MBR card → `Mounted OK. Type SDHC, size 15360 MB`;
  write / read / append / re-read all succeed.
- Card present, filesystem unreadable → diagnostic prints **WRONG FORMAT**.
- Card unreachable (broken command line) → diagnostic prints **No card detected**.

See `HT-HC33_SDTest.ino` in this folder for the full working sketch.
