#include "sd_store.h"
#include <SPI.h>

// microSD wiring on the HT-HC33 (Heltec's dedicated HSPI bus) -- copied from the
// working live-stream sketch. Do not change without a reason.
#define SD_CLK_PIN   15
#define SD_MISO_PIN  16
#define SD_MOSI_PIN  11
#define SD_CS_PIN    10

static SPIClass SD_SPI(HSPI);   // the card has its own SPI bus
static bool g_sd_ok = false;

bool sdInit() {
  if (g_sd_ok) return true;
  SD_SPI.begin(SD_CLK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

  // Try progressively slower SPI clocks. A card initializes at low speed even on
  // a marginal slot/link, where the default 4 MHz can fail -- matches the robust
  // HT-HC33_SDTest approach. (A truly dead card or a too-picky slot still fails,
  // but this rescues the borderline cases.)
  const uint32_t kSpeeds[] = { 4000000, 1000000, 400000 };
  for (int i = 0; i < 3; i++) {
    if (SD.begin(SD_CS_PIN, SD_SPI, kSpeeds[i])) {
      g_sd_ok = true;
      if (!SD.exists("/wildcam")) SD.mkdir("/wildcam");
      Serial.printf("[sd] card OK at %lu Hz (%llu MB)\n",
                    (unsigned long)kSpeeds[i], SD.cardSize() / (1024ULL * 1024ULL));
      return true;
    }
    Serial.printf("[sd] mount failed at %lu Hz\n", (unsigned long)kSpeeds[i]);
    delay(300);
  }
  Serial.println("[sd] no card mounted (tried 4 MHz / 1 MHz / 400 kHz)");
  return false;
}

String sdSaveJpeg(const uint8_t *data, size_t len, long long tsMs, uint32_t seq) {
  if (!g_sd_ok) return "";
  char path[48];
  if (tsMs > 0) snprintf(path, sizeof(path), "/wildcam/wildcam_%lld.jpg", tsMs);
  else          snprintf(path, sizeof(path), "/wildcam/wildcam_%lu.jpg", (unsigned long)seq);

  File f = SD.open(path, FILE_WRITE);
  if (!f) {
    Serial.printf("[sd] open %s for write failed\n", path);
    return "";
  }
  size_t written = f.write(data, len);
  f.close();
  if (written != len) {
    Serial.printf("[sd] short write %u/%u\n", (unsigned)written, (unsigned)len);
    return "";
  }
  Serial.printf("[sd] saved %s (%u bytes)\n", path, (unsigned)len);
  return String(path);
}

File sdOpen(const String &path) {
  return SD.open(path, FILE_READ);
}
