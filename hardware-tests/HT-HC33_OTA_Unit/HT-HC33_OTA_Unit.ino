/*
 * HT-HC33 OTA unit test (pure logic, no network required)
 * -------------------------------------------------------
 * Board:  Heltec ESP32-S3 Wi-Fi HaLow Camera (HT-HC33)
 * FQBN:   heltec:esp_halow:HT-HC33   (the "ESP32 HaLow" core)
 *
 * What this sketch covers, in plain words: the parts of the OTA update code
 * that don't touch the radio or the flash writer -- the safety gate that
 * decides "is it safe to attempt an OTA right now?" and the hand-rolled JSON
 * helpers that pull the update instructions out of a cloud response. If the
 * board prints "ALL PASS", those two pieces still work after a change.
 *
 * What this sketch does NOT cover: the actual download + verify + flash path.
 * That needs a real .bin served over HTTPS and real hardware to flash into;
 * it belongs in a full bench cycle, not a unit test.
 *
 * ---------------------------------------------------------------------------
 * SYNC RULE -- read this before changing anything!
 * ---------------------------------------------------------------------------
 * This sketch INTENTIONALLY duplicates the pure functions it tests from the
 * fleet firmware (cloud_telemetry_node/ota_update.cpp and cloud_backend.cpp).
 * Arduino sketches are self-contained -- there's no clean way to pull in
 * source files from a sibling directory (secrets.h is git-ignored, and the
 * IDE won't follow .cpp include chains across directories).
 *
 * If you change either of these in cloud_telemetry_node/:
 *   * OtaResult enum          (in ota_update.h)
 *   * otaShouldAttempt()      (in ota_update.cpp)
 *   * otaResultString()       (in ota_update.cpp)
 *   * jsonStringField()       (in cloud_backend.cpp)
 *   * jsonIntField()          (in cloud_backend.cpp)
 *   * jsonSubObject()         (in cloud_backend.cpp)
 *   * BATTERY_FLOOR_PCT       (in ota_update.cpp)
 *   * RSSI_FLOOR_DBM          (in ota_update.cpp)
 *   * BOARD_TYPE              (in node_config.h)
 * then UPDATE THE COPIES BELOW and re-run the sketch on a bench board.
 *
 * When the copies drift, the sketch is testing yesterday's code. The plan
 * doc (docs/FLASH_STORAGE_OTA_PLAN.md, Step 3) calls this out as a real
 * limitation of Arduino-only firmware testing.
 * ---------------------------------------------------------------------------
 *
 * Arduino IDE settings: Board "HT-HC33", USB CDC On Boot: DISABLED (default).
 * No PSRAM / SD / camera libs needed.
 */

#include <Arduino.h>
#include <WiFi.h>

// ===========================================================================
// COPIES from cloud_telemetry_node/ota_update.h -- keep in sync (see SYNC RULE).
// ===========================================================================
#define BOARD_TYPE_LOCAL "heltec-ht-hc33"   // COPY of node_config.h BOARD_TYPE

enum class OtaResult {
  Ok,
  DownloadFailed,
  NoSpace,
  WriteFailed,
  ShaMismatch,
  Stalled,
  Timeout,
  BoardTypeMismatch,
  LowBattery,
  LowRssi,
  BadWakeReason,
};

enum class WakeReason { Cold, Timer, Pir, Button };

struct OtaTarget {
  String url;
  String sha256;
  size_t sizeBytes;
  String version;
  String boardType;
  uint32_t expectedSeconds;
  uint32_t minBytesPerSec;
  uint32_t maxSeconds;
};

// ===========================================================================
// COPIES from cloud_telemetry_node/ota_update.cpp -- keep in sync (SYNC RULE).
// Only the pure-logic pieces we can test without hardware/network.
// ===========================================================================
static const int BATTERY_FLOOR_PCT = 40;
static const int RSSI_FLOOR_DBM    = -75;

static const char *otaResultString(OtaResult r) {
  switch (r) {
    case OtaResult::Ok:                 return "Ok";
    case OtaResult::DownloadFailed:     return "DownloadFailed";
    case OtaResult::NoSpace:            return "NoSpace";
    case OtaResult::WriteFailed:        return "WriteFailed";
    case OtaResult::ShaMismatch:        return "ShaMismatch";
    case OtaResult::Stalled:            return "Stalled";
    case OtaResult::Timeout:            return "Timeout";
    case OtaResult::BoardTypeMismatch:  return "BoardTypeMismatch";
    case OtaResult::LowBattery:         return "LowBattery";
    case OtaResult::LowRssi:            return "LowRssi";
    case OtaResult::BadWakeReason:      return "BadWakeReason";
  }
  return "Unknown";
}

static OtaResult otaShouldAttempt(const OtaTarget &t, WakeReason wr, int batteryPct) {
  if (t.boardType != BOARD_TYPE_LOCAL) return OtaResult::BoardTypeMismatch;
  if (wr == WakeReason::Pir)            return OtaResult::BadWakeReason;
  if (batteryPct < BATTERY_FLOOR_PCT)   return OtaResult::LowBattery;
  int rssi = WiFi.RSSI();
  if (rssi != 0 && rssi < RSSI_FLOOR_DBM) return OtaResult::LowRssi;
  return OtaResult::Ok;
}

// ===========================================================================
// COPIES from cloud_telemetry_node/cloud_backend.cpp -- keep in sync (SYNC RULE).
// ===========================================================================
static String jsonStringField(const String &json, const char *key) {
  String needle = String("\"") + key + "\":\"";
  int i = json.indexOf(needle);
  if (i < 0) return "";
  i += needle.length();
  int j = json.indexOf('"', i);
  if (j < 0) return "";
  return json.substring(i, j);
}

static long long jsonIntField(const String &json, const char *key, long long defaultValue = 0) {
  String needle = String("\"") + key + "\":";
  int i = json.indexOf(needle);
  if (i < 0) return defaultValue;
  i += needle.length();
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;
  if (i >= (int)json.length()) return defaultValue;
  if (json[i] == '"') return defaultValue;
  int j = i;
  if (json[j] == '-' || json[j] == '+') j++;
  while (j < (int)json.length() && json[j] >= '0' && json[j] <= '9') j++;
  if (j == i || (json[i] == '-' && j == i + 1)) return defaultValue;
  String num = json.substring(i, j);
  return strtoll(num.c_str(), nullptr, 10);
}

static String jsonSubObject(const String &json, const char *key) {
  String needle = String("\"") + key + "\":";
  int i = json.indexOf(needle);
  if (i < 0) return "";
  i += needle.length();
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;
  if (i >= (int)json.length() || json[i] != '{') return "";
  int start = i;
  int depth = 0;
  bool inString = false;
  bool escape = false;
  for (int j = i; j < (int)json.length(); j++) {
    char c = json[j];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c == '\\') { escape = true; continue; }
      if (c == '"') { inString = false; }
      continue;
    }
    if (c == '"') { inString = true; continue; }
    if (c == '{') depth++;
    else if (c == '}') {
      depth--;
      if (depth == 0) return json.substring(start, j + 1);
    }
  }
  return "";
}

// ===========================================================================
// Assertion harness (kept simple -- no external test lib)
// ===========================================================================
static int g_pass = 0;
static int g_fail = 0;

#define CHECK(name, cond) do { \
  bool _c = (cond);                                                            \
  if (_c) { g_pass++; Serial.printf("  PASS  %s\n", name); }                   \
  else    { g_fail++; Serial.printf("  FAIL  %s  (at line %d)\n", name, __LINE__); } \
} while (0)

// ===========================================================================
// Tests
// ===========================================================================
static void testShouldAttempt() {
  Serial.println("\n[test] otaShouldAttempt");
  OtaTarget t;
  t.boardType = BOARD_TYPE_LOCAL;
  t.url = "https://example/f.bin"; t.sha256 = "abc"; t.sizeBytes = 1024;
  t.version = "abc"; t.expectedSeconds = 10; t.minBytesPerSec = 20000; t.maxSeconds = 60;

  OtaTarget mismatched = t;
  mismatched.boardType = "lilygo-t-halow-p4";
  CHECK("BoardTypeMismatch when target board != BOARD_TYPE",
        otaShouldAttempt(mismatched, WakeReason::Timer, 90) == OtaResult::BoardTypeMismatch);

  CHECK("BadWakeReason when wake == PIR",
        otaShouldAttempt(t, WakeReason::Pir, 90) == OtaResult::BadWakeReason);

  CHECK("LowBattery when battery == 30%",
        otaShouldAttempt(t, WakeReason::Timer, 30) == OtaResult::LowBattery);
  CHECK("LowBattery boundary just under (39% refused)",
        otaShouldAttempt(t, WakeReason::Timer, 39) == OtaResult::LowBattery);
  CHECK("Battery at floor (40%) allowed",
        otaShouldAttempt(t, WakeReason::Timer, 40) == OtaResult::Ok);

  CHECK("Ok when battery OK, wake=Timer, RSSI unknown (Wi-Fi off)",
        otaShouldAttempt(t, WakeReason::Timer, 90) == OtaResult::Ok);
  CHECK("Ok on Button wake",
        otaShouldAttempt(t, WakeReason::Button, 90) == OtaResult::Ok);
  CHECK("Ok on Cold wake",
        otaShouldAttempt(t, WakeReason::Cold, 90) == OtaResult::Ok);
}

static void testResultStrings() {
  Serial.println("\n[test] otaResultString");
  CHECK("Ok label",                strcmp(otaResultString(OtaResult::Ok), "Ok") == 0);
  CHECK("DownloadFailed label",    strcmp(otaResultString(OtaResult::DownloadFailed), "DownloadFailed") == 0);
  CHECK("NoSpace label",           strcmp(otaResultString(OtaResult::NoSpace), "NoSpace") == 0);
  CHECK("WriteFailed label",       strcmp(otaResultString(OtaResult::WriteFailed), "WriteFailed") == 0);
  CHECK("ShaMismatch label",       strcmp(otaResultString(OtaResult::ShaMismatch), "ShaMismatch") == 0);
  CHECK("Stalled label",           strcmp(otaResultString(OtaResult::Stalled), "Stalled") == 0);
  CHECK("Timeout label",           strcmp(otaResultString(OtaResult::Timeout), "Timeout") == 0);
  CHECK("BoardTypeMismatch label", strcmp(otaResultString(OtaResult::BoardTypeMismatch), "BoardTypeMismatch") == 0);
  CHECK("LowBattery label",        strcmp(otaResultString(OtaResult::LowBattery), "LowBattery") == 0);
  CHECK("LowRssi label",           strcmp(otaResultString(OtaResult::LowRssi), "LowRssi") == 0);
  CHECK("BadWakeReason label",     strcmp(otaResultString(OtaResult::BadWakeReason), "BadWakeReason") == 0);
}

static void testJsonHelpers() {
  Serial.println("\n[test] JSON helpers");
  // Shape matches web/app/api/command-poll/route.ts response (design doc §7).
  String resp =
    "{\"deviceId\":\"pond_cam_01\","
     "\"command\":\"update_firmware\","
     "\"ota\":{"
       "\"url\":\"https://ex.com/builds/heltec-ht-hc33/a1b2c3d/firmware.bin\","
       "\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\","
       "\"sizeBytes\":1174480,"
       "\"version\":\"a1b2c3d\","
       "\"boardType\":\"heltec-ht-hc33\","
       "\"expectedSeconds\":30,"
       "\"minBytesPerSec\":30000,"
       "\"maxSeconds\":90"
     "}}";

  CHECK("jsonStringField pulls top-level 'command'",
        jsonStringField(resp, "command") == "update_firmware");
  CHECK("jsonStringField pulls top-level 'deviceId'",
        jsonStringField(resp, "deviceId") == "pond_cam_01");
  CHECK("jsonStringField returns \"\" on missing key",
        jsonStringField(resp, "not-a-key") == "");

  String otaObj = jsonSubObject(resp, "ota");
  CHECK("jsonSubObject returns balanced object substring",
        otaObj.length() > 0 && otaObj[0] == '{' && otaObj[otaObj.length() - 1] == '}');
  CHECK("jsonSubObject nested fields land in the returned substring",
        jsonStringField(otaObj, "url") ==
          "https://ex.com/builds/heltec-ht-hc33/a1b2c3d/firmware.bin");
  CHECK("jsonSubObject sha256 (long string) round-trips intact",
        jsonStringField(otaObj, "sha256").length() == 64);
  CHECK("jsonSubObject boardType matches",
        jsonStringField(otaObj, "boardType") == "heltec-ht-hc33");

  CHECK("jsonIntField pulls sizeBytes",       jsonIntField(otaObj, "sizeBytes") == 1174480);
  CHECK("jsonIntField pulls expectedSeconds", jsonIntField(otaObj, "expectedSeconds") == 30);
  CHECK("jsonIntField pulls minBytesPerSec",  jsonIntField(otaObj, "minBytesPerSec") == 30000);
  CHECK("jsonIntField pulls maxSeconds",      jsonIntField(otaObj, "maxSeconds") == 90);
  CHECK("jsonIntField returns default on missing key",
        jsonIntField(otaObj, "not-a-key", -1) == -1);
  CHECK("jsonIntField rejects quoted number (would be wrong shape)",
        jsonIntField(String("{\"n\":\"42\"}"), "n", -1) == -1);

  // Malformed / adversarial inputs -- fail-closed.
  CHECK("jsonSubObject returns \"\" when key isn't an object",
        jsonSubObject(String("{\"a\":\"str\"}"), "a") == "");
  CHECK("jsonSubObject handles a brace-inside-string safely",
        jsonSubObject(String("{\"x\":{\"s\":\"has}brace\",\"n\":5}}"), "x").indexOf("has}brace") > 0);
  CHECK("jsonStringField returns \"\" on unterminated string",
        jsonStringField(String("{\"a\":\"unterm"), "a") == "");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n=== HT-HC33 OTA unit test ===");
  Serial.printf("BOARD_TYPE (local copy) = %s\n", BOARD_TYPE_LOCAL);

  testShouldAttempt();
  testResultStrings();
  testJsonHelpers();

  Serial.println();
  if (g_fail == 0) {
    Serial.printf("=== ALL PASS (%d checks) ===\n", g_pass);
  } else {
    Serial.printf("=== %d FAIL / %d PASS ===\n", g_fail, g_pass);
  }
}

void loop() {
  // Idle. Reset the board to re-run the tests.
  delay(60000);
}
