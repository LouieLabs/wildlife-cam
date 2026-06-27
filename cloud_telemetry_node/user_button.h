#pragma once
#include <Arduino.h>

// The HT-HC33's onboard USER button is GPIO0 -- the same button Heltec tells you
// to hold while uploading. It has an onboard pull-up, so it idles HIGH and reads
// LOW when pressed. We use it as a manual "capture now" trigger that wakes the
// board from deep sleep (ext1) and takes a photo, exactly like a PIR motion event.
//
// CAVEAT: GPIO0 is also the boot/download strapping pin. A quick TAP wakes +
// captures fine; HOLDING it down across the wake can instead drop the chip into
// firmware-download mode. So tap, don't hold.
//
// It uses ext1 (wake-on-LOW) so it coexists with the PIR's ext0 (wake-on-HIGH).
#define USER_BUTTON_PIN  0

// Configure the button pin as an input. Call once in setup().
void buttonInit();

// True if THIS wake-up was caused by the USER button (deep-sleep ext1 wake).
bool buttonWokeUs();

// Arm an ext1 wake on a button press (GPIO0 going LOW). Call before deep sleep,
// alongside the PIR's pirArmForWake() and the timer.
void buttonArmForWake();
