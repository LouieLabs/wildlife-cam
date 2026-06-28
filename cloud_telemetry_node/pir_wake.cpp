#include "pir_wake.h"
#include "esp_sleep.h"
#include "driver/rtc_io.h"

void pirInit() {
  // Pull-down so a disconnected or idle sensor reads LOW. A real PIR drives the
  // line HIGH on motion, overriding the weak pull. Without this a floating
  // GPIO15 false-triggers the ext0 motion wake (seen on the bench with no PIR).
  pinMode(PIR_PIN, INPUT_PULLDOWN);
}

bool pirWokeUs() {
  return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0;
}

void pirArmForWake(uint32_t settleMs) {
  // If we slept while the PIR was still HIGH, it would fire immediately. Wait
  // for it to settle back to LOW (bounded by settleMs so a stuck-high sensor
  // can't keep us awake forever).
  uint32_t start = millis();
  while (digitalRead(PIR_PIN) == HIGH && millis() - start < settleMs) {
    delay(200);
  }
  // Hold the pull-down through deep sleep so a floating/idle line can't
  // false-wake us (the awake-mode pinMode pull does NOT persist in deep sleep).
  rtc_gpio_pulldown_en((gpio_num_t)PIR_PIN);
  rtc_gpio_pullup_dis((gpio_num_t)PIR_PIN);
  // Wake when GPIO15 goes HIGH (motion). GPIO15 is RTC-capable, so ext0 works.
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIR_PIN, 1);
}
