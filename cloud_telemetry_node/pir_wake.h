#pragma once
#include <Arduino.h>

// PIR (motion sensor) wake support for the low-power node. Lets the board sleep
// and wake the instant something moves, instead of only on the timer.
//
// PIN CHOICE: GPIO15. Ethan's original motion sketch used GPIO1, but in this
// firmware GPIO1 is the battery-voltage ADC (see node_config.h), so the PIR
// moves to GPIO15 -- which is freed up by dropping the microSD card and is
// RTC-capable, so it can wake the chip from deep sleep (ext0).
//
// WIRING:  PIR OUT -> GPIO15,  PIR GND -> GND,  PIR VCC -> 5V (HC-SR501) or 3V3 (AM312).
#define PIR_PIN  15

// Configure the PIR signal pin as an input. Call once in setup().
void pirInit();

// True if THIS wake-up was caused by PIR motion (deep-sleep ext0 wake).
bool pirWokeUs();

// Right before deep sleep: wait (up to settleMs) for motion to stop so we don't
// instantly re-trigger, then arm an ext0 wake on the next motion. Combine with
// esp_sleep_enable_timer_wakeup() to wake on EITHER motion or the timer.
void pirArmForWake(uint32_t settleMs = 8000);
