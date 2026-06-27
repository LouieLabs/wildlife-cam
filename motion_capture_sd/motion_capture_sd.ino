/*
 * Wildlife Cam — motion-triggered photo capture to SD (HT-HC33)
 * ------------------------------------------------------------
 * In plain words: the board sleeps to save battery. When the motion sensor
 * (PIR) sees something, it wakes the board up, the board takes a photo and
 * saves it to the SD card, then it goes back to sleep and waits for the next
 * movement. No WiFi, no website — photos pile up on the card for now. (Sending
 * them to a website is a clean next step we'll add later.)
 *
 * Board:  Heltec HT-HC33  (FQBN heltec:esp_halow:HT-HC33, the "ESP32 HaLow" core)
 * IDE settings: USB CDC On Boot DISABLED, PSRAM: OPI PSRAM, Flash Size: 16MB.
 *
 * WIRING:
 *   PIR OUT -> GPIO1   (the signal wire)
 *   PIR GND -> GND
 *   PIR VCC -> 5V (big HC-SR501)  or  3V3 (tiny AM312)
 *   microSD card inserted (FAT32 / MBR — see hardware-tests/HT-HC33_SDTest).
 *
 * GPIO1 is used because it is (a) free on this board and (b) able to wake the
 * chip from deep sleep. Photos are written to /wildcam/img_00001.jpg, etc.
 *
 *   arduino-cli compile --fqbn heltec:esp_halow:HT-HC33 .
 *
 * --- DEBUG MODE ---------------------------------------------------------
 * Set DEBUG_STAY_AWAKE to 1 to bench-test WITHOUT sleeping: the board stays on,
 * prints the PIR state continuously, and snaps a photo on each new motion. Great
 * for watching it work over the Serial Monitor. Set back to 0 for real
 * battery/deep-sleep behavior. (For a camera-free sensor check, use the separate
 * hardware-tests/HT-HC33_PIRTest sketch.)
 */

#include "esp_camera.h"
#include "esp_sleep.h"
#include <SPI.h>
#include <halow_SD.h>     // HaLow core's SD library (provides fs::SDFS SD)

// ====== knobs you might tweak =========================================
#define DEBUG_STAY_AWAKE    0        // 1 = don't sleep; watch PIR + capture live
#define PIR_PIN             1        // GPIO1 — PIR signal (OUT), wakes from sleep
#define PIR_SETTLE_TIMEOUT  8000     // ms to wait for motion to stop before sleeping
#define WARMUP_FRAMES       3        // throwaway frames so exposure settles first
// ======================================================================

// --- HT-HC33 onboard camera (OV3660). Pin map taken verbatim from the working
//     videowithinterfacesketch.ino — do not change these. ---
#define PWDN_GPIO_NUM     20
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     47
#define SIOD_GPIO_NUM     45
#define SIOC_GPIO_NUM     42
#define Y9_GPIO_NUM       38
#define Y8_GPIO_NUM       48
#define Y7_GPIO_NUM       46
#define Y6_GPIO_NUM       18
#define Y5_GPIO_NUM       14
#define Y4_GPIO_NUM       12
#define Y3_GPIO_NUM       13
#define Y2_GPIO_NUM       17
#define VSYNC_GPIO_NUM    40
#define HREF_GPIO_NUM     39
#define PCLK_GPIO_NUM     21

// --- microSD on the HT-HC33's dedicated HSPI bus (same pins as the SD test) ---
#define SD_CLK_PIN   15
#define SD_MISO_PIN  16
#define SD_MOSI_PIN  11
#define SD_CS_PIN    10
SPIClass SD_SPI(HSPI);

// Survives deep sleep, so photo numbers keep climbing across wake-ups.
RTC_DATA_ATTR uint32_t g_bootCount = 0;

bool g_camOK = false;
bool g_sdOK  = false;

// ----------------------------------------------------------------------
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  // With PSRAM we can grab a big, high-quality still; without it, fall back to
  // the small VGA buffer that the streaming firmware uses (known-good).
  if (psramFound()) {
    config.frame_size  = FRAMESIZE_UXGA;   // 1600x1200 — nice wildlife stills
    config.jpeg_quality = 10;              // lower number = better quality
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size  = FRAMESIZE_VGA;    // 640x480 fallback (proven config)
    config.jpeg_quality = 12;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }
  config.fb_count   = 1;
  config.grab_mode  = CAMERA_GRAB_WHEN_EMPTY;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init FAILED: 0x%x\n", err);
    return false;
  }
  Serial.printf("[CAM] init OK (%s)\n", psramFound() ? "UXGA/PSRAM" : "VGA/DRAM");
  return true;
}

// Mount the SD card on its dedicated HSPI bus, trying progressively slower
// clocks (a marginal connection can init but fail reads at full speed).
bool initSD() {
  SD_SPI.begin(SD_CLK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
  const uint32_t speeds[] = { 4000000, 1000000, 400000 };
  for (uint8_t i = 0; i < 3; i++) {
    if (SD.begin(SD_CS_PIN, SD_SPI, speeds[i])) {
      Serial.printf("[SD] mounted (%llu MB free of %llu MB)\n",
                    (SD.totalBytes() - SD.usedBytes()) / (1024ULL * 1024ULL),
                    SD.totalBytes() / (1024ULL * 1024ULL));
      if (!SD.exists("/wildcam")) SD.mkdir("/wildcam");
      return true;
    }
  }
  Serial.println("[SD] mount FAILED — see hardware-tests/HT-HC33_SDTest for why.");
  return false;
}

// Capture one JPEG and write it to the next free /wildcam/img_NNNNN.jpg.
bool captureToSD() {
  if (!g_camOK || !g_sdOK) return false;

  // Throw away a few frames so auto-exposure/white-balance settles (the first
  // frame after wake is often dark or green).
  for (int i = 0; i < WARMUP_FRAMES; i++) {
    camera_fb_t *warm = esp_camera_fb_get();
    if (warm) esp_camera_fb_return(warm);
    delay(60);
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { Serial.println("[CAM] capture FAILED (no frame)"); return false; }

  // Pick a filename that doesn't already exist (so a power-cycle won't clobber).
  char path[32];
  uint32_t idx = g_bootCount;
  do {
    snprintf(path, sizeof(path), "/wildcam/img_%05u.jpg", idx);
    idx++;
  } while (SD.exists(path));

  File f = SD.open(path, FILE_WRITE);
  bool ok = false;
  if (f) {
    size_t written = f.write(fb->buf, fb->len);
    f.close();
    ok = (written == fb->len);
    Serial.printf("[CAM] %s  %s (%u bytes)\n", path, ok ? "saved" : "SHORT WRITE", (unsigned)fb->len);
  } else {
    Serial.printf("[CAM] could not open %s for writing\n", path);
  }

  esp_camera_fb_return(fb);
  return ok;
}

// Wait for the PIR to go quiet, then deep-sleep until the next motion.
void armAndSleep() {
  Serial.print("[SLEEP] waiting for motion to stop");
  unsigned long start = millis();
  while (digitalRead(PIR_PIN) == HIGH && millis() - start < PIR_SETTLE_TIMEOUT) {
    Serial.print(".");
    delay(200);
  }
  Serial.println();

  // Wake again when GPIO1 goes HIGH (motion). GPIO1 is RTC-capable, so ext0 works.
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIR_PIN, 1);
  Serial.println("[SLEEP] going to deep sleep — wave to wake.\n");
  Serial.flush();
  esp_deep_sleep_start();   // execution stops here; wake restarts at setup()
}

// ----------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  g_bootCount++;

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  Serial.printf("\n=== boot #%u (%s) ===\n", g_bootCount,
                cause == ESP_SLEEP_WAKEUP_EXT0 ? "woken by MOTION" : "fresh power-on");

  pinMode(PIR_PIN, INPUT);
  g_camOK = initCamera();
  g_sdOK  = initSD();

  // Take the shot for this wake-up.
  captureToSD();

#if DEBUG_STAY_AWAKE
  Serial.println("[DEBUG] staying awake — watching PIR, will snap on each motion.");
#else
  armAndSleep();
#endif
}

void loop() {
  // Only runs in DEBUG_STAY_AWAKE mode (the deep-sleep path never returns here).
#if DEBUG_STAY_AWAKE
  static int last = LOW;
  int now = digitalRead(PIR_PIN);
  if (now == HIGH && last == LOW) {
    Serial.println(">>> MOTION — capturing");
    captureToSD();
  }
  if (now != last) {
    Serial.println(now == HIGH ? "[PIR] HIGH (motion)" : "[PIR] LOW (still)");
  }
  last = now;
  delay(50);
#endif
}
