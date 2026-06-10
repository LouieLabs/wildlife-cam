#include "esp_camera.h"

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

void setup() {
  Serial.begin(921600);
  delay(1000);

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_SVGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return;
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Capture failed");
    return;
  }

  Serial.println("START");
  Serial.write(fb->buf, fb->len);
  Serial.println("END");
  esp_camera_fb_return(fb);
}

void loop() {}