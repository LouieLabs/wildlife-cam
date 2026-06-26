#pragma once
#include <Arduino.h>

// Small, self-contained helpers for talking to the Louie Labs cloud backend.
// Kept separate from the main sketch so the networking code stays tidy and
// easy to reuse.

// Connect to Wi-Fi. Returns true once connected (or false on timeout).
bool wifiConnect(uint32_t timeoutMs = 15000);

// Battery percentage (0-100). Stubbed to a test value until BATTERY_ADC_PIN
// is set in node_config.h.
int readBatteryPercent();

// One quick NTP time sync. Returns epoch seconds, or 0 if it couldn't sync in
// time (we still report; the timestamp just won't be wall-clock accurate).
long getEpochSeconds(uint32_t timeoutMs = 3000);

// Write this device's status to /devices/<id>/state in the Realtime Database.
// The payload includes the device secret so the database rule accepts it.
// Returns true on HTTP 200.
bool reportStatus(const char *status, int batteryPct, long updatedAt);

// Read this device's pending command from /devices/<id>/command (public read).
// Returns e.g. "take_picture" / "idle", or "" on error.
String getCommand();
