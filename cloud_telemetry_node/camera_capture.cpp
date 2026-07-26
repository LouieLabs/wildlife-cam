#include "camera_capture.h"
#include <Arduino.h>

// --- Factory pin mapping for the Heltec HT-HC33 (OV3660) ---
// Copied verbatim from the working videowithinterfacesketch so this node uses
// the same wiring Heltec ships. Do not change these without a reason.
#define PWDN_GPIO_NUM   20
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM   47
#define SIOD_GPIO_NUM   45
#define SIOC_GPIO_NUM   42
#define Y9_GPIO_NUM     38
#define Y8_GPIO_NUM     48
#define Y7_GPIO_NUM     46
#define Y6_GPIO_NUM     18
#define Y5_GPIO_NUM     14
#define Y4_GPIO_NUM     12
#define Y3_GPIO_NUM     13
#define Y2_GPIO_NUM     17
#define VSYNC_GPIO_NUM  40
#define HREF_GPIO_NUM   39
#define PCLK_GPIO_NUM   21

// Throwaway frames after init so exposure/white-balance settles before the
// real shot (the first frame after power-up is often dark/green).
#define CAMERA_WARMUP_FRAMES  3

// --- Photo size -------------------------------------------------------------
// The OV3660 can shoot up to 2048x1536, but this node ran at 640x480 because
// the frame buffer lived in the small on-chip RAM, which can't hold more. With
// PSRAM switched on (Arduino IDE: Tools > PSRAM) the buffer moves to the
// board's 8MB of external RAM and a much bigger photo fits.
//
// Why it matters: an animal far from the lens is only a few pixels across at
// VGA -- too few for the detector to identify. A rat at a few metres is roughly
// 22 px wide at VGA but ~44 px at SXGA, which is over the threshold where
// detection starts working at all.
//
// Cost: a bigger JPEG takes longer to upload and uses more battery. Check the
// "first frame" size in the serial log before raising this further.
//   FRAMESIZE_SXGA  1280x1024  (4x VGA)   <- current
//   FRAMESIZE_UXGA  1600x1200  (6x VGA)
//   FRAMESIZE_QXGA  2048x1536  (10x VGA, sensor maximum)
#define CAMERA_FRAMESIZE_HIRES     FRAMESIZE_SXGA
#define CAMERA_JPEG_QUALITY_HIRES  10   // 0-63; LOWER means better quality

bool cameraInit() {
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
  // How big a photo we can take depends on where the frame buffer can live.
  // PSRAM is a BUILD option (Tools > PSRAM) and this board's factory default is
  // "Disabled", so ask at runtime instead of assuming: with PSRAM off we stay
  // on the old VGA settings rather than failing to start the camera at all.
  const bool havePsram = psramFound();
  if (havePsram) {
    config.frame_size   = CAMERA_FRAMESIZE_HIRES;
    config.jpeg_quality = CAMERA_JPEG_QUALITY_HIRES;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size   = FRAMESIZE_VGA;   // 640x480 -- fits in on-chip RAM
    config.jpeg_quality = 12;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }
  config.fb_count     = 1;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;

  if (havePsram) {
    Serial.println("[cam] PSRAM found -> high-resolution mode");
  } else {
    Serial.println("[cam] PSRAM NOT enabled -> stuck at VGA. Fix: Arduino IDE "
                   "Tools > PSRAM > \"QSPI PSRAM\" (try \"OPI PSRAM\" if that "
                   "still reports NOT enabled), then reflash.");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK && havePsram) {
    // The bigger frame buffer may not fit (ESP_ERR_NO_MEM). Fall back to the
    // known-good VGA settings rather than leaving the node with no camera --
    // a smaller photo beats no photo.
    Serial.printf("[cam] init failed at high resolution: 0x%x -> retrying at VGA\n", err);
    config.frame_size   = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    err = esp_camera_init(&config);
  }
  if (err != ESP_OK) {
    Serial.printf("[cam] init failed: 0x%x\n", err);
    return false;
  }

  // Throw away a few frames so auto-exposure / white-balance can settle -- the
  // first frames after power-up are often dark or green. (Adopted from Ethan's
  // motion-capture sketch.)
  for (int i = 0; i < CAMERA_WARMUP_FRAMES; i++) {
    camera_fb_t *warm = esp_camera_fb_get();
    if (warm) esp_camera_fb_return(warm);
    delay(60);
  }
  return true;
}

camera_fb_t *cameraCapture() {
  camera_fb_t *fb = esp_camera_fb_get();
  // Report the first photo of each boot so the upload cost of a resolution
  // change is visible -- once only, so a 60-shot burst doesn't flood the log.
  static bool reported = false;
  if (fb && !reported) {
    reported = true;
    Serial.printf("[cam] first frame: %ux%u, %u bytes\n",
                  (unsigned)fb->width, (unsigned)fb->height, (unsigned)fb->len);
  }
  return fb;
}

void cameraReturn(camera_fb_t *fb) {
  if (fb) esp_camera_fb_return(fb);
}

void cameraDeinit() {
  esp_camera_deinit();
}
