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
 * Arduino IDE settings: Board "HT-HC33", USB CDC On Boot: Enabled,
 * PSRAM: OPI PSRAM, Flash Size: 16MB. Uses the core's bundled SD + SPI libs.
 */

#include <SPI.h>
#include <halow_SD.h>     // HaLow core's SD library (provides fs::SDFS SD)
#include <sd_diskio.h>    // low-level sdcard_init/type/num_sectors for diagnostics

// --- HT-HC33 SD pins (SPI mode, HSPI bus) ---
static const int SD_SCK  = 15;
static const int SD_MISO = 16;
static const int SD_MOSI = 11;
static const int SD_CS   = 10;

// Heltec drives the SD slot on the HSPI peripheral with its own SPIClass.
SPIClass SD_SPI(HSPI);

static const char *TEST_PATH = "/predupe_sdtest.txt";

// ---- file helpers --------------------------------------------------------

void writeFile(fs::FS &fs, const char *path, const char *message) {
  Serial.printf("Writing file: %s\n", path);
  File file = fs.open(path, FILE_WRITE);
  if (!file) { Serial.println("  -> open for write FAILED"); return; }
  file.print(message) ? Serial.println("  -> write OK")
                      : Serial.println("  -> write FAILED");
  file.close();
}

void appendFile(fs::FS &fs, const char *path, const char *message) {
  Serial.printf("Appending to file: %s\n", path);
  File file = fs.open(path, FILE_APPEND);
  if (!file) { Serial.println("  -> open for append FAILED"); return; }
  file.print(message) ? Serial.println("  -> append OK")
                      : Serial.println("  -> append FAILED");
  file.close();
}

void readFile(fs::FS &fs, const char *path) {
  Serial.printf("Reading file: %s\n", path);
  File file = fs.open(path);
  if (!file) { Serial.println("  -> open for read FAILED"); return; }
  Serial.print("  -> contents: \"");
  while (file.available()) Serial.write(file.read());
  Serial.println("\"");
  file.close();
}

// Print the specific reason a mount failed, without erasing anything.
//
// sdcard_init() only reserves a FATFS slot + sets up the CS pin -- the card is
// not actually contacted until the mount (f_mount -> ff_sd_initialize), which
// sets card->type. So we re-init and re-mount at the low level purely to read
// card->type, then classify by whether the card hardware initialized:
//   type is SD / SDHC / MMC  -> card answered but FS bad -> WRONG FORMAT
//   type is NONE / UNKNOWN   -> card never initialized   -> not inserted /
//                               bad wiring / dead card (init jumps to
//                               "unknown_card" -> CARD_UNKNOWN on any comms fail)
void diagnoseSDFailure() {
  uint8_t pdrv = sdcard_init(SD_CS, &SD_SPI, 400000);   // slow, robust init
  if (pdrv == 0xFF) {
    Serial.println("[SD] Internal: no free SD slot (unexpected).");
    return;
  }

  bool mounted = sdcard_mount(pdrv, "/sddiag", 5, false);   // expected to fail
  sdcard_type_t type = sdcard_type(pdrv);                   // valid even on failure
  bool cardInitialized = (type == CARD_SD || type == CARD_SDHC || type == CARD_MMC);

  if (mounted) {
    sdcard_unmount(pdrv);
    Serial.println("[SD] Mounted on retry -- previous failure was a transient glitch.");
  } else if (!cardInitialized) {
    Serial.println("[SD] No card detected -- the card did not respond.");
    Serial.println("     -> Is a microSD fully inserted (push-push click)?");
    Serial.println("     -> Wiring: CLK=15, MISO=16, MOSI=11, CS=10 on HSPI.");
    Serial.println("     -> Try reseating, or another card (card/slot may be faulty).");
  } else {
    Serial.println("[SD] Card responds but the filesystem could NOT be read -> WRONG FORMAT.");
    Serial.println("     -> The ESP32 needs FAT32 (or exFAT) on an MBR (Master Boot");
    Serial.println("        Record) partition table.");
    Serial.println("     -> macOS Disk Utility defaults to GUID Partition Map, which the");
    Serial.println("        ESP32 cannot read. Reformat: View > Show All Devices, select");
    Serial.println("        the DEVICE (not the volume), Erase > MS-DOS (FAT), Scheme =");
    Serial.println("        Master Boot Record. (FAT32 needs <=32 GB; larger -> exFAT.)");
    Serial.println("     -> Or let the board reformat it (ERASES card) by calling:");
    Serial.println("        SD.begin(SD_CS, SD_SPI, 4000000, \"/sd\", 5, true)");
  }

  sdcard_uninit(pdrv);
}

// Returns true once the filesystem is mounted. On failure, prints a specific
// reason (no card vs. wrong format) and returns false. Never auto-erases.
bool initSDCard() {
  if (SD.begin(SD_CS, SD_SPI)) {           // format_if_empty defaults to false
    uint8_t t = SD.cardType();
    const char *typeStr = (t == CARD_MMC)  ? "MMC"  :
                          (t == CARD_SD)   ? "SDSC" :
                          (t == CARD_SDHC) ? "SDHC" : "UNKNOWN";
    Serial.printf("[SD] Mounted OK. Type %s, size %llu MB, used %llu / %llu MB\n",
                  typeStr, SD.cardSize()  / (1024ULL * 1024ULL),
                  SD.usedBytes()  / (1024ULL * 1024ULL),
                  SD.totalBytes() / (1024ULL * 1024ULL));
    return true;
  }

  diagnoseSDFailure();
  return false;
}

// ---- setup / loop --------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(1500);                 // let USB CDC enumerate
  Serial.println("\n=== HT-HC33 SD card test ===");

  SD_SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);

  if (!initSDCard()) {
    Serial.println("=== Aborted: SD not usable (see reason above) ===");
    return;
  }

  // Exercise the filesystem.
  writeFile(SD, TEST_PATH, "Hello from HT-HC33!\n");
  readFile(SD, TEST_PATH);
  appendFile(SD, TEST_PATH, "Appended line OK.\n");
  readFile(SD, TEST_PATH);

  Serial.println("\n=== Test complete ===");
}

void loop() {
  // test runs once in setup()
}
