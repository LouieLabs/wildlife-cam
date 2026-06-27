#include "pir_wake.h"
#include "esp_sleep.h"

void pirInit() {
  pinMode(PIR_PIN, INPUT);
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
  // Wake when GPIO15 goes HIGH (motion). GPIO15 is RTC-capable, so ext0 works.
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIR_PIN, 1);
}
