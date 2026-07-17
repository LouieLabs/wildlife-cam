#include "wake_sources.h"
#include "node_config.h"

#include "esp_log.h"
#include "esp_sleep.h"
#include "driver/gpio.h"
#include "driver/rtc_io.h"

static const char *TAG = "wake";

wake_reason_t wake_classify(void) {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER: return WAKE_TIMER;
    case ESP_SLEEP_WAKEUP_EXT1: {
      uint64_t pins = esp_sleep_get_ext1_wakeup_status();
      if (pins & (1ULL << PIR_GPIO)) return WAKE_PIR;
      if (pins & (1ULL << USER_BUTTON_GPIO)) return WAKE_BUTTON;
      return WAKE_PIR;   // EXT1 with no attributed pin: treat as motion
    }
    default: return WAKE_COLD;
  }
}

const char *wake_tag(wake_reason_t r) {
  switch (r) {
    case WAKE_PIR:    return "PIR";
    case WAKE_BUTTON: return "BUTTON";
    case WAKE_TIMER:  return "TIMER";
    default:          return "COLDBOOT";
  }
}

void wake_pins_init(void) {
  gpio_config_t pir = {
    .pin_bit_mask = 1ULL << PIR_GPIO,
    .mode = GPIO_MODE_INPUT,
    // Pull-down so a floating/unwired PIR line reads LOW instead of noise.
    .pull_down_en = GPIO_PULLDOWN_ENABLE,
    .pull_up_en = GPIO_PULLUP_DISABLE,
  };
  gpio_config(&pir);
  gpio_config_t btn = {
    .pin_bit_mask = 1ULL << USER_BUTTON_GPIO,
    .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE,   // button idles HIGH, pressed = LOW
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
  };
  gpio_config(&btn);
}

bool pir_line_high(void) {
  return gpio_get_level(PIR_GPIO) == 1;
}

void go_to_deep_sleep(uint32_t seconds) {
  ESP_LOGI(TAG, "deep sleep %lus (chip resets on wake)", (unsigned long)seconds);

  // Hold the PIR pull-down through deep sleep so a floating line can't
  // false-wake us (awake-mode pulls don't persist in deep sleep).
  rtc_gpio_pulldown_en(PIR_GPIO);
  rtc_gpio_pullup_dis(PIR_GPIO);
  rtc_gpio_pullup_en(USER_BUTTON_GPIO);
  rtc_gpio_pulldown_dis(USER_BUTTON_GPIO);

  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  // PIR: wake when HIGH. Button: wake when LOW. EXT1 on the P4 supports
  // per-pin level selection via the _io variant.
  esp_sleep_enable_ext1_wakeup_io(1ULL << PIR_GPIO, ESP_EXT1_WAKEUP_ANY_HIGH);
  esp_sleep_enable_ext1_wakeup_io(1ULL << USER_BUTTON_GPIO, ESP_EXT1_WAKEUP_ANY_LOW);

  esp_deep_sleep_start();   // never returns
}
