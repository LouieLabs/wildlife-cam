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

// One NTP time sync. Returns epoch seconds, or 0 if it couldn't sync in time
// (we still report; the timestamp just won't be wall-clock accurate).
long getEpochSeconds(uint32_t timeoutMs = 8000);

// Write this device's status to /devices/<id>/state in the Realtime Database.
// The payload includes the device secret so the database rule accepts it.
// updatedAt is epoch MILLISECONDS (64-bit -- it overflows a 32-bit int).
// Returns true on HTTP 200.
bool reportStatus(const char *status, int batteryPct, long long updatedAt);

// Read this device's pending command from /devices/<id>/command (public read).
// Returns e.g. "take_picture" / "idle", or "" on error.
String getCommand();

// --- Photo upload flow (used when the command is "take_picture") ------------

// Ask the web app for a short-lived signed upload link. On success returns the
// upload URL and fills objectNameOut with the storage path; "" on failure.
String requestUploadUrl(String &objectNameOut);

// PUT the JPEG bytes to the signed upload URL. Returns true on HTTP 200.
bool uploadJpeg(const String &signedUrl, const uint8_t *data, size_t len);

// PUT a JPEG straight from a stream (e.g. an open SD File) -- avoids loading the
// whole photo into RAM. len must be the exact byte count. Returns true on 200.
bool uploadStream(const String &signedUrl, Stream &stream, size_t len);

// Tell the backend the photo is uploaded: it clears the command and records the
// capture. Returns true on HTTP 200.
bool captureComplete(const String &objectName);
