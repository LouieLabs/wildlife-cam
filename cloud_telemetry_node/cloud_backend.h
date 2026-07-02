#pragma once
#include <Arduino.h>
#include "ota_update.h"   // OtaResult + OtaTarget travel through the status/command shapes

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

// Result of a prior OTA attempt, echoed back to the dashboard as state.lastOta
// so the operator can see exactly why an update didn't take. Populated when
// the caller has one to report; leave the StatusReport::lastOta pointer NULL
// when there's nothing to say this wake.
struct LastOtaResult {
  OtaResult result;
  String from;         // FW_VERSION_STR at the time of the attempt
  String to;           // otaTarget.version
  uint32_t durationS;  // wall-clock seconds spent on the attempt
  long long ts;        // epoch ms of when the attempt finished (0 if clock not synced)
};

// What we tell RTDB /devices/<id>/state on every wake. Grew into a struct to
// accommodate boardType + fwVersion + lastOta without a 7-arg reportStatus().
struct StatusReport {
  const char *status;         // "online", "ota_flashing", etc.
  int batteryPct;
  long long updatedAt;        // epoch ms, or 0 when NTP hasn't synced
  const LastOtaResult *lastOta;   // NULL when no OTA event to report this wake
};

// Write this device's status to /devices/<id>/state in the Realtime Database.
// The payload includes the device secret so the database rule accepts it.
// firmwareVersion + boardType come from the compile-time FW_VERSION_STR +
// BOARD_TYPE constants so the dashboard always sees the truth of what's
// running. Returns true on HTTP 200.
bool reportStatus(const StatusReport &r);

// The dashboard's instructions for this wake. verb is one of:
//   "idle"             -- do nothing extra
//   "take_picture"     -- capture + upload one photo now
//   "update_firmware"  -- ota is populated; consider running otaShouldAttempt +
//                         otaDownloadAndFlash
struct Command {
  String verb;
  bool hasOta;         // true iff verb == "update_firmware" and ota parsed OK
  OtaTarget ota;       // meaningful only when hasOta is true
};

// Ask the backend for this device's pending command (via /api/command-poll,
// authenticated with the per-device secret).
Command getCommand();

// ---- Hand-rolled JSON helpers (exposed so ota_update + the bench test can
// parse the nested "ota" object in the command-poll response). These only
// handle the flat / one-level-nested shapes WE write on the server side; they
// are not a general JSON parser and will silently return "" / 0 on anything
// they don't recognize. That's the point -- narrow surface, no dep.

// Extract a "key":"value" string field from a flat JSON object. Returns "" if
// the key isn't present or the value isn't a string.
String jsonStringField(const String &json, const char *key);

// Extract a "key":<number> integer field. Returns defaultValue if the key isn't
// present or the value isn't a bare (unquoted) integer. Handles negative and
// up to 64-bit values.
long long jsonIntField(const String &json, const char *key, long long defaultValue = 0);

// Extract a "key":{...} nested object as its own JSON substring (including the
// braces). Returns "" if the key isn't present or the value isn't an object.
// Nested braces balance correctly; strings-inside-values are respected.
String jsonSubObject(const String &json, const char *key);

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
