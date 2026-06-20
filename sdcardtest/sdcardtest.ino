// =============================================================================
// Minimal microSD test for the Heltec HT-HC33.
//
// Purpose: isolate the SD card from the camera/WiFi/web-server firmware. If this
// sketch mounts the card, the hardware + pins are fine and the issue is the main
// firmware (most likely camera-framebuffer memory pressure). If this ALSO fails,
// it's the card / seating / format, not the code.
//
// How to use:
//   1. Open this in the Arduino IDE with the HT-HC33 board selected.
//   2. Upload, open Serial Monitor @ 115200, tap the board's reset button.
//   3. Read the line that starts with "RESULT:".
//
// Pins are Heltec's own (wifi-halow/As_VideoWebServer/sd_read_write.h).
// =============================================================================
#include "FS.h"
#include "halow_SD.h"
#include "SPI.h"

#define SD_CLK   15
#define SD_MISO  16
#define SD_MOSI  11
#define SD_CS    10

SPIClass SD_SPI(HSPI);   // the card has its own dedicated SPI bus

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n=== HT-HC33 minimal SD test ===");
  Serial.printf("pins: CLK=%d  MISO=%d  MOSI=%d  CS=%d\n", SD_CLK, SD_MISO, SD_MOSI, SD_CS);

  SD_SPI.begin(SD_CLK, SD_MISO, SD_MOSI, SD_CS);

  bool ok = false;
  for (int i = 1; i <= 3 && !ok; i++) {
    if (SD.begin(SD_CS, SD_SPI)) {
      ok = true;
    } else {
      Serial.printf("attempt %d: SD.begin() failed\n", i);
      delay(400);
    }
  }

  if (!ok) {
    Serial.println("RESULT: MOUNT FAILED  ->  card/seating/format issue (not the sketch)");
    Serial.println("  try: re-seat the card firmly; use a <=32GB card formatted FAT32; try another card.");
    return;
  }

  uint8_t type = SD.cardType();
  if (type == CARD_NONE) {
    Serial.println("RESULT: begin() ok but CARD_NONE (no card seen)");
    return;
  }

  Serial.printf("RESULT: SD OK   type=%d   size=%llu MB\n",
                (int)type, SD.cardSize() / (1024ULL * 1024ULL));

  // prove we can actually write + read
  File f = SD.open("/sdtest.txt", FILE_WRITE);
  if (f) { f.println("hello from HT-HC33"); f.close(); Serial.println("wrote /sdtest.txt"); }
  else   { Serial.println("open /sdtest.txt for write FAILED"); }

  File r = SD.open("/sdtest.txt");
  if (r) { Serial.print("read back: "); while (r.available()) Serial.write(r.read()); r.close(); }
}

void loop() {}
