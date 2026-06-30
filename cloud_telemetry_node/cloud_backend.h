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

// Ask the backend for this device's pending command (via /api/command-poll,
// authenticated with the camera key). Returns e.g. "take_picture" / "idle".
String getCommand();

// --- Photo upload flow (used when the command is "take_picture") ------------

// Ask the web app for a short-lived signed upload link. On success returns the
// upload URL and fills objectNameOut with the storage path; "" on failure.
//
// wakeReason ("PIR"/"BUTTON"/"TIMER"/"COLDBOOT"/"UNKNOWN") and capturedAt (epoch
// ms, 0 if NTP wasn't synced when the photo was taken) get used server-side to
// build a descriptive object name like `LL-cam1_260630-021026_BUTTON.jpg`.
// Pass the ORIGINAL capture's reason + time even when uploading a pending photo
// from a later wake; flashParsePath() recovers them from the LittleFS filename.
String requestUploadUrl(String &objectNameOut, const char *wakeReason, long long capturedAtMs);

// PUT the JPEG bytes to the signed upload URL. Returns true on HTTP 200.
bool uploadJpeg(const String &signedUrl, const uint8_t *data, size_t len);

// PUT a JPEG straight from a stream (e.g. an open SD File) -- avoids loading the
// whole photo into RAM. len must be the exact byte count. Returns true on 200.
bool uploadStream(const String &signedUrl, Stream &stream, size_t len);

// Tell the backend the photo is uploaded: it clears the command and records the
// capture. Returns true on HTTP 200.
bool captureComplete(const String &objectName);
