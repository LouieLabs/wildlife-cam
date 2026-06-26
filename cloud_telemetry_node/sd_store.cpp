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
  for (int attempt = 1; attempt <= 3; attempt++) {
    if (SD.begin(SD_CS_PIN, SD_SPI)) {
      g_sd_ok = true;
      if (!SD.exists("/wildcam")) SD.mkdir("/wildcam");
      Serial.printf("[sd] card OK (%llu MB)\n", SD.cardSize() / (1024ULL * 1024ULL));
      return true;
    }
    Serial.printf("[sd] mount failed (attempt %d/3)\n", attempt);
    delay(300);
  }
  Serial.println("[sd] no card detected");
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
