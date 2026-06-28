#pragma once
#include <Arduino.h>

// Dev-vs-field auto-detection, single codebase. The idea: a board being
// developed is plugged into a COMPUTER (USB serial), while a deployed board is
// not. So we use "is someone typing on the serial port" as the trigger -- it
// can't be faked by a solar/USB charger, and needs no hardware mod (the HT-HC33
// has no usable USB/VBUS detect pin).

// Listen on the serial port for up to windowMs. Returns true if any key was
// pressed (-> a developer is connected -> enter dev mode).
bool devModeRequested(uint32_t windowMs);

// Bring up a self-contained 2.4 GHz Wi-Fi hotspot + a simple camera website and
// serve it forever (never returns). Used for offsite dev with no network/gateway.
void runDevMode();
