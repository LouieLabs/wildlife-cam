/*
 * HT-HC33 SD card read/write test  + card-fault diagnostics
 * ---------------------------------------------------------
 * Board:  Heltec ESP32-S3 Wi-Fi HaLow Camera (HT-HC33)
 * FQBN:   heltec:esp_halow:HT-HC33   (the "ESP32 HaLow" core)
 *
 * The HT-HC33 wires its microSD slot in SPI mode on the HSPI peripheral.
 * Pins are fixed by the PCB (per the datasheet "SD Card Connector" map and
 * Heltec's own As_VideoWebServer example):
 *
 *      SD_CLK  -> GPIO15
 *      SD_MISO -> GPIO16
 *      SD_MOSI -> GPIO11
 *      SD_CS   -> GPIO10
 *
 * Flow:
 *   1. Probe the card electrically (low-level, non-destructive).
 *      - no response  -> not inserted / not seated / wiring / dead card
 *   2. Mount the FAT filesystem.
 *      - card present but mount fails -> WRONG FORMAT (e.g. GUID partition
 *        scheme instead of MBR, or a non-FAT filesystem)
 *   3. Write / read / append / re-read a test file.
 *
 * Arduino IDE settings: Board "HT-HC33" (or "HT-HC33(V2)" -- same pins),
 * USB CDC On Boot: DISABLED (default), PSRAM: OPI PSRAM, Flash Size: 16MB.
 * Uses the core's bundled SD + SPI libs.
 *
 * Serial goes through the board's external CP2102 USB-UART bridge (it shows up
 * as /dev/cu.usbserial-* / "Silicon Labs CP210x"), so leave USB CDC On Boot
 * DISABLED -- enabling it redirects Serial to the native USB peripheral, which
 * is not wired to the USB-C port here, and the serial monitor would go dead.
 *
 * Compiles clean on Arduino IDE 2.3.x. These three warnings are EXPECTED and
 * harmless -- the bundled libs are tagged "esp32" while the core's arch is
 * "esp_halow"; it's just a metadata mismatch, operation is unaffected:
 *   WARNING: library SPI claims to run on esp32 architecture(s) ...
 *   WARNING: library SD  claims to run on esp32 architecture(s) ...
 *   WARNING: library FS  claims to run on esp32 architecture(s) ...
 */

#include <SPI.h>
#include <halow_SD.h>   // HaLow core's SD library (provides fs::SDFS SD)
#include <sd_diskio.h>  // low-level sdcard_init/type/num_sectors for diagnostics
#include <ff.h>         // FatFs API -- to read the exact f_mount FRESULT

// --- HT-HC33 SD pins (SPI mode, HSPI bus) ---
static const int SD_SCK = 15;
static const int SD_MISO = 16;
static const int SD_MOSI = 11;
static const int SD_CS = 10;

// Heltec drives the SD slot on the HSPI peripheral with its own SPIClass.
SPIClass SD_SPI(HSPI);

static const char *TEST_PATH = "/predupe_sdtest.txt";

// ---- file helpers --------------------------------------------------------

void writeFile(fs::FS &fs, const char *path, const char *message) {
  Serial.printf("Writing file: %s\n", path);
  File file = fs.open(path, FILE_WRITE);
  if (!file) {
    Serial.println("  -> open for write FAILED");
    return;
  }
  file.print(message) ? Serial.println("  -> write OK")
                      : Serial.println("  -> write FAILED");
  file.close();
}

void appendFile(fs::FS &fs, const char *path, const char *message) {
  Serial.printf("Appending to file: %s\n", path);
  File file = fs.open(path, FILE_APPEND);
  if (!file) {
    Serial.println("  -> open for append FAILED");
    return;
  }
  file.print(message) ? Serial.println("  -> append OK")
                      : Serial.println("  -> append FAILED");
  file.close();
}

void readFile(fs::FS &fs, const char *path) {
  Serial.printf("Reading file: %s\n", path);
  File file = fs.open(path);
  if (!file) {
    Serial.println("  -> open for read FAILED");
    return;
  }
  Serial.print("  -> contents: \"");
  while (file.available()) Serial.write(file.read());
  Serial.println("\"");
  file.close();
}

// Print the specific reason a mount failed, without erasing anything.
//
// Diagnose why the mount failed using the EXACT FatFs error code. We do a
// single low-level f_mount probe (extra init attempts can wedge a marginal
// card) and classify on its FRESULT:
//   FR_OK (0)             -> mounted on retry (transient glitch)
//   FR_NOT_READY (3)      -> card did not initialize: not inserted, bad wiring/
//                            slot, OR a WEDGED card. After a failed access the
//                            card can stay stuck until a real power cycle --
//                            an RST/reflash does NOT drop the SD card's VDD.
//   FR_DISK_ERR (1)       -> card responds but reads fail -> marginal card/slot
//   FR_NO_FILESYSTEM (13) -> card read OK but no valid FAT -> wrong format
//                            (GUID/exFAT/no-MBR), or a marginal link returning
//                            bad data
void diagnoseSDFailure() {
  uint8_t pdrv = sdcard_init(SD_CS, &SD_SPI, 400000);  // slow, robust init
  if (pdrv == 0xFF) {
    Serial.println("[SD] Internal: no free SD slot (unexpected).");
    return;
  }

  static FATFS s_diagfs;
  char drv[3] = { (char)('0' + pdrv), ':', 0 };
  FRESULT fr = f_mount(&s_diagfs, drv, 1);  // 1 = mount immediately
  Serial.printf("[SD] f_mount result = %d  (0=OK 1=DISK_ERR 3=NOT_READY 13=NO_FILESYSTEM)\n",
                (int)fr);

  if (fr == FR_OK) {
    Serial.println("[SD] Mounted on retry -- previous failure was a transient glitch.");
  } else if (fr == FR_NOT_READY) {
    Serial.println("[SD] Card did NOT initialize.");
    Serial.println("     -> Is a microSD fully inserted (push-push click)?");
    Serial.println("     -> Wiring: CLK=15, MISO=16, MOSI=11, CS=10 on HSPI.");
    Serial.println("     -> If it worked before, the card may be WEDGED: fully UNPLUG");
    Serial.println("        the board for ~5s (RST/reflash does NOT power-cycle the");
    Serial.println("        card), then retry. Otherwise reseat or try another card.");
  } else if (fr == FR_DISK_ERR) {
    Serial.println("[SD] Card responds but reads FAIL (disk error) -> marginal card or");
    Serial.println("     slot/wiring, NOT a format problem. Reseat, clean the contacts,");
    Serial.println("     try a shorter/known-good cable, or another card.");
  } else {  // FR_NO_FILESYSTEM and anything else
    Serial.println("[SD] Card read OK but no valid filesystem -> WRONG FORMAT.");
    Serial.println("     -> The ESP32 needs FAT32 on an MBR (Master Boot");
    Serial.println("        Record) partition table.");
    Serial.println("     -> macOS Disk Utility defaults to GUID Partition Map, which the");
    Serial.println("        ESP32 cannot read. Reformat using MacOS Disk Utility: View >");
    Serial.println("        Show All Devices, select the DEVICE (not the volume), Erase >");
    Serial.println("        MS-DOS (FAT), Scheme = Master Boot Record. DO NOT select");
    Serial.println("        \"MS-DOS (FAT32)\" because it will not use MBR. If the Master");
    Serial.println("        Boot Record option is not displayed, the View (to the right of");
    Serial.println("        the green Maximize button) may not be on \"Show All Devices\".");
    Serial.println("        You can check that MBR is listed as the Partition Map in the");
    Serial.println("        Physical Disk table (it's not listed in the Physical Volume");
    Serial.println("        table).");
    Serial.println("");
    Serial.println("*** BEFORE REMOVING THE SDCARD");
    Serial.println("*** UNPLUG THE BOARD from the computer to avoid damaging the card ***");
  }

  f_mount(NULL, drv, 0);  // release the probe mount
  sdcard_uninit(pdrv);
}

// Returns true once the filesystem is mounted. On failure, prints a specific
// reason (no card vs. wrong format) and returns false. Never auto-erases.
//
// Tries progressively slower SPI clocks: a card can initialize (init runs at
// 400 kHz) yet fail sector reads at a high clock if the wiring/connection is
// marginal. If a slower clock mounts, the filesystem was fine all along -- the
// problem was signal integrity, not the format.
bool initSDCard() {
  const uint32_t kSpeeds[] = { 4000000, 1000000, 400000 };
  for (uint8_t i = 0; i < sizeof(kSpeeds) / sizeof(kSpeeds[0]); i++) {
    if (SD.begin(SD_CS, SD_SPI, kSpeeds[i])) {  // format_if_empty defaults to false
      uint8_t t = SD.cardType();
      const char *typeStr = (t == CARD_MMC) ? "MMC" : (t == CARD_SD)   ? "SDSC"
                                                    : (t == CARD_SDHC) ? "SDHC"
                                                                       : "UNKNOWN";
      Serial.printf("[SD] Mounted OK at %lu Hz. Type %s, size %llu MB, used %llu / %llu MB\n",
                    (unsigned long)kSpeeds[i], typeStr,
                    SD.cardSize() / (1024ULL * 1024ULL),
                    SD.usedBytes() / (1024ULL * 1024ULL),
                    SD.totalBytes() / (1024ULL * 1024ULL));
      if (i > 0) Serial.println("     (needed a slower clock -> check wiring/cable/card)");
      return true;
    }
  }

  diagnoseSDFailure();
  return false;
}

// ---- setup / loop --------------------------------------------------------

bool g_mounted = false;  // set once in setup()

// The read/write portion of the test -- run repeatedly; reuses the mount.
void runFileTest() {
  Serial.println("\n=== HT-HC33 SD card test ===");
  writeFile(SD, TEST_PATH, "Hello from HT-HC33!\n");
  readFile(SD, TEST_PATH);
  appendFile(SD, TEST_PATH, "Appended line OK.\n");
  readFile(SD, TEST_PATH);
  Serial.println("=== Test complete ===");
}

void setup() {
  Serial.begin(115200);
  delay(1500);  // let the UART settle after reset
  Serial.println("\n=== HT-HC33 SD card test ===");

  // Bring up SPI and mount the card EXACTLY ONCE, here. Re-mounting from
  // loop() is unreliable on ESP32-S3 HSPI (arduino-esp32 #7565): the card can
  // init but fail reads, which looks like a bad filesystem. So mount once and
  // reuse the handle.
  SD_SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  g_mounted = initSDCard();
}

void loop() {
  if (g_mounted) {
    runFileTest();  // re-run the read/write test (no re-mount)
  } else {
    Serial.println("[SD] Not mounted -- see the reason above. Fix the card, then");
    Serial.println("     power-cycle the board (unplug/replug) to retry.");
  }
  delay(5000);
}
