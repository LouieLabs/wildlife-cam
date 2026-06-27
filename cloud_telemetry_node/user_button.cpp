#include "user_button.h"
#include "esp_sleep.h"

void buttonInit() {
  pinMode(USER_BUTTON_PIN, INPUT_PULLUP);   // idles HIGH; LOW = pressed
}

bool buttonWokeUs() {
  return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT1;
}

void buttonArmForWake() {
  // Wake when GPIO0 goes LOW (button pressed). ext1 is a different wake channel
  // from the PIR's ext0, so the two coexist (motion = HIGH, button = LOW).
  esp_sleep_enable_ext1_wakeup(1ULL << USER_BUTTON_PIN, ESP_EXT1_WAKEUP_ANY_LOW);
}
