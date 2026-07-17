#pragma once
#include <stdbool.h>
#include <stdint.h>

// PIR + USER-button deep-sleep wake sources -- P4 port of pir_wake/user_button.
// Both use the EXT1 wake unit (the P4 has no EXT0); PIR wakes on HIGH, the
// button on LOW, distinguished at boot by reading which pin changed.

typedef enum {
  WAKE_COLD,     // power-on / reset / brownout
  WAKE_TIMER,    // periodic check-in
  WAKE_PIR,      // motion
  WAKE_BUTTON,   // USER button tap
} wake_reason_t;

// Classify this boot's wake cause. Call once, early in app_main.
wake_reason_t wake_classify(void);

// Short uppercase tag for cloud filenames ("PIR"/"BUTTON"/"TIMER"/"COLDBOOT").
const char *wake_tag(wake_reason_t r);

// Configure PIR/button pins as inputs (also needed before re-arming).
void wake_pins_init(void);

// Read the PIR line right now (spurious-wake filter + burst quiet window).
bool pir_line_high(void);

// Arm timer + PIR + button wakes, then enter deep sleep. Never returns.
void go_to_deep_sleep(uint32_t seconds);
