#include "cloud_backend.h"
#include "node_config.h"
#include "secrets.h"
#include "device_config.h"
#include "version.h"

#include "net_http.h"
#include "time.h"

// ---------------------------------------------------------------------------
// Networking: getting online lives in net_link.cpp (netConnect() handles the
// HaLow / 2.4 GHz / both logic). Every HTTP call below goes through NetHttp
// (net_http.h), which routes to whichever radio is active.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Battery (stubbed until a real sense pin + divider ratio are provided)
// ---------------------------------------------------------------------------
int readBatteryPercent() {
  // Enable the divider, let it settle, average a few calibrated reads, disable.
  pinMode(BAT_ADC_CTRL_PIN, OUTPUT);
  digitalWrite(BAT_ADC_CTRL_PIN, HIGH);
  delay(10);
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogReadMilliVolts(BAT_ADC_PIN); delay(2); }
  digitalWrite(BAT_ADC_CTRL_PIN, LOW);   // turn the divider back off (saves power)

  int vbat_mv = (sum / 8) * 2;           // pin reads VBAT/2 (100K/100K divider)
  long pct = (long)(vbat_mv - VBAT_EMPTY_MV) * 100 / (VBAT_FULL_MV - VBAT_EMPTY_MV);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (int)pct;
}

// ---------------------------------------------------------------------------
// Time (one short NTP sync)
// ---------------------------------------------------------------------------
long getEpochSeconds(uint32_t timeoutMs) {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  // getLocalTime() blocks until the clock holds a real date (year >= 2016) or
  // the timeout elapses -- more reliable than polling time() ourselves.
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, timeoutMs)) {
    Serial.println("[ntp] sync failed (will report without a real timestamp)");
    return 0;
  }
  return (long)time(nullptr);   // epoch seconds (fits in 32 bits until 2038)
}

// ---------------------------------------------------------------------------
// Status report: HTTPS PUT to /devices/<id>/state.json
//
// Fields on the wire (in order):
//   status, battery, secret, firmwareVersion, boardType, updatedAt,
//   lastOta {result, from, to, durationS, ts}   (optional)
// ---------------------------------------------------------------------------
bool reportStatus(const StatusReport &r) {
  String url = String("https://") + RTDB_HOST + "/devices/" + g_cfg.deviceId + "/state.json";

  // updatedAt is 64-bit (epoch ms), format with %lld to avoid overflow.
  char ts[24];
  snprintf(ts, sizeof(ts), "%lld", r.updatedAt);

  // firmwareVersion is auto-stamped at build time (see version.h). boardType is
  // the compile-time BOARD_TYPE from node_config.h -- one image per board type.
  // The dashboard uses both to filter available OTA builds.
  String body = "{";
  body += "\"status\":\"" + String(r.status) + "\",";
  body += "\"battery\":" + String(r.batteryPct) + ",";
  body += "\"secret\":\"" + g_cfg.deviceSecret + "\",";
  body += "\"firmwareVersion\":\"" + String(FW_VERSION_STR) + "\",";
  body += "\"boardType\":\"" + String(BOARD_TYPE) + "\",";
  body += "\"updatedAt\":" + String(ts);

  if (r.lastOta) {
    char durBuf[16];
    snprintf(durBuf, sizeof(durBuf), "%u", (unsigned)r.lastOta->durationS);
    char lastOtaTs[24];
    snprintf(lastOtaTs, sizeof(lastOtaTs), "%lld", r.lastOta->ts);
    body += ",\"lastOta\":{";
    body += "\"result\":\"" + String(otaResultString(r.lastOta->result)) + "\",";
    body += "\"from\":\""   + r.lastOta->from + "\",";
    body += "\"to\":\""     + r.lastOta->to   + "\",";
    body += "\"durationS\":" + String(durBuf) + ",";
    body += "\"ts\":" + String(lastOtaTs);
    body += "}";
  }
  body += "}";

  NetHttp https;
  if (!https.begin(url)) {
    Serial.println("[report] https.begin failed");
    return false;
  }
  https.addHeader("Content-Type", "application/json");
  int code = https.PUT(body);
  if (code != 200) {
    Serial.printf("[report] HTTP %d: %s\n", code, https.getString().c_str());
  }
  https.end();
  return code == 200;
}

// ---------------------------------------------------------------------------
// Command poll: HTTP POST /api/command-poll (authenticated via the backend)
// The database's command path is no longer public, so we ask the web app for
// the pending command instead of reading the database directly. Auth = the
// per-device secret (NOT a fleet-wide key), sent in x-device-secret. The server
// looks the expected value up by deviceId, so a leak of one board's secret
// blasts only that one board.
//
// Response shape:
//   { "deviceId":"...", "command":"idle" | "take_picture" | "update_firmware",
//     "ota": { url, sha256, sizeBytes, version, boardType,
//              expectedSeconds, minBytesPerSec, maxSeconds }   // when command == "update_firmware"
//   }
// ---------------------------------------------------------------------------
Command getCommand() {
  Command out;
  out.verb = "idle";
  out.hasOta = false;
  out.hasWifi = false;
  out.hasRename = false;

  String url = String(BACKEND_BASE_URL) + "/api/command-poll";
  // NetHttp matches the transport to the URL scheme (deployed backend is
  // https://, a local dev server is http://) and picks the active radio.
  NetHttp http;
  if (!http.begin(url)) return out;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", g_cfg.deviceSecret);

  String reqBody = String("{\"deviceId\":\"") + g_cfg.deviceId + "\"}";
  int code = http.POST(reqBody);
  String resp = (code == 200) ? http.getString() : "";
  http.end();
  if (code != 200) {
    Serial.printf("[command] command-poll HTTP %d\n", code);
    return out;
  }

  String verb = jsonStringField(resp, "command");
  if (verb.length()) out.verb = verb;

  if (out.verb == "update_firmware") {
    String otaObj = jsonSubObject(resp, "ota");
    if (otaObj.length()) {
      out.ota.url             = jsonStringField(otaObj, "url");
      out.ota.sha256          = jsonStringField(otaObj, "sha256");
      out.ota.sizeBytes       = (size_t)jsonIntField(otaObj, "sizeBytes", 0);
      out.ota.version         = jsonStringField(otaObj, "version");
      out.ota.boardType       = jsonStringField(otaObj, "boardType");
      out.ota.expectedSeconds = (uint32_t)jsonIntField(otaObj, "expectedSeconds", 0);
      out.ota.minBytesPerSec  = (uint32_t)jsonIntField(otaObj, "minBytesPerSec", 0);
      out.ota.maxSeconds      = (uint32_t)jsonIntField(otaObj, "maxSeconds", 0);
      // Consider the payload valid only if the required fields are present;
      // otherwise fall back to plain "update_firmware" without ota -- caller
      // treats that as a malformed command and skips.
      out.hasOta = out.ota.url.length() && out.ota.sha256.length() &&
                   out.ota.sizeBytes > 0 && out.ota.boardType.length();
      if (!out.hasOta) {
        Serial.println("[command] update_firmware payload missing required fields -> ignoring");
      }
    } else {
      Serial.println("[command] update_firmware without ota object -> ignoring");
    }
  } else if (out.verb == "set_wifi") {
    // { "command":"set_wifi", "wifi":{ "ssid","pass","netMode" } }
    String wifiObj = jsonSubObject(resp, "wifi");
    if (wifiObj.length()) {
      out.wifiSsid    = jsonStringField(wifiObj, "ssid");
      out.wifiPass    = jsonStringField(wifiObj, "pass");
      out.wifiNetMode = jsonStringField(wifiObj, "netMode");
      out.hasWifi = out.wifiSsid.length() > 0;   // pass may be "" (open network)
      if (!out.hasWifi) Serial.println("[command] set_wifi payload missing ssid -> ignoring");
    } else {
      Serial.println("[command] set_wifi without wifi object -> ignoring");
    }
  } else if (out.verb == "set_id") {
    // { "command":"set_id", "rename":{ "newId" } }
    String renameObj = jsonSubObject(resp, "rename");
    if (renameObj.length()) {
      out.renameNewId = jsonStringField(renameObj, "newId");
      out.hasRename = out.renameNewId.length() > 0;
      if (!out.hasRename) Serial.println("[command] set_id payload missing newId -> ignoring");
    } else {
      Serial.println("[command] set_id without rename object -> ignoring");
    }
  }
  return out;
}

// POST /api/command-ack -- tell the backend we applied a one-shot command.
bool ackCommand() {
  String url = String(BACKEND_BASE_URL) + "/api/command-ack";
  NetHttp http;
  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", g_cfg.deviceSecret);
  String reqBody = String("{\"deviceId\":\"") + g_cfg.deviceId + "\"}";
  int code = http.POST(reqBody);
  http.end();
  Serial.printf("[command] ack HTTP %d\n", code);
  return code == 200;
}

// ---------------------------------------------------------------------------
// Photo upload flow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tiny hand-rolled JSON helpers. These handle the exact shapes WE emit from
// our own server routes -- flat strings, flat integers, and one level of nested
// object -- and nothing else. They deliberately fail closed (return "" / 0) on
// anything they don't recognize; if you find yourself extending them to cover
// arrays or booleans, that's the moment to bring in ArduinoJson instead.
//
// Skipping-strings-inside-values-of-other-keys is intentional: the "sha256"
// value is a 64-char hex string that will absolutely contain '{' / '}' if we
// treat every brace as structural. So the sub-object parser walks the string
// character-by-character with an in-string flag.
// ---------------------------------------------------------------------------
String jsonStringField(const String &json, const char *key) {
  String needle = String("\"") + key + "\":\"";
  int i = json.indexOf(needle);
  if (i < 0) return "";
  i += needle.length();
  int j = json.indexOf('"', i);
  if (j < 0) return "";
  return json.substring(i, j);
}

long long jsonIntField(const String &json, const char *key, long long defaultValue) {
  String needle = String("\"") + key + "\":";
  int i = json.indexOf(needle);
  if (i < 0) return defaultValue;
  i += needle.length();
  // Skip whitespace (we don't emit any, but Firebase / GCS occasionally do).
  while (i < (int)json.length() && (json[i] == ' ' || json[i] == '\t')) i++;
  if (i >= (int)json.length()) return defaultValue;
  // A quoted value ("1234") is NOT an int for our purposes -- reject it so a
  // shape drift shows up as defaultValue, not a silent wrong number.
  if (json[i] == '"') return defaultValue;
  int j = i;
  if (json[j] == '-' || json[j] == '+') j++;
  while (j < (int)json.length() && json[j] >= '0' && json[j] <= '9') j++;
  if (j == i || (json[i] == '-' && j == i + 1)) return defaultValue;
  // strtoll on the substring
  String num = json.substring(i, j);
  return strtoll(num.c_str(), nullptr, 10);
}

String jsonSubObject(const String &json, const char *key) {
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
  return "";   // unbalanced -- malformed input
}

String requestUploadUrl(String &objectNameOut, const char *wakeReason, long long capturedAtMs) {
  String url = String(BACKEND_BASE_URL) + "/api/get-upload-url";
  // NetHttp picks the transport from the URL scheme: the deployed Cloud Run
  // backend is https://, a local `npm run dev` server is http://.
  NetHttp http;
  if (!http.begin(url)) return "";
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", g_cfg.deviceSecret);

  char tsBuf[24];
  snprintf(tsBuf, sizeof(tsBuf), "%lld", capturedAtMs);
  String safeReason = (wakeReason && *wakeReason) ? String(wakeReason) : String("UNKNOWN");
  String reqBody = String("{\"deviceId\":\"") + g_cfg.deviceId
                 + "\",\"wakeReason\":\"" + safeReason
                 + "\",\"capturedAt\":" + tsBuf + "}";
  int code = http.POST(reqBody);
  String resp = (code == 200) ? http.getString() : "";
  http.end();
  if (code != 200) {
    Serial.printf("[upload] get-upload-url HTTP %d\n", code);
    return "";
  }
  objectNameOut = jsonStringField(resp, "objectName");
  return jsonStringField(resp, "uploadUrl");
}

bool uploadJpeg(const String &signedUrl, const uint8_t *data, size_t len) {
  // The signed URL points at storage.googleapis.com -> HTTPS.
  NetHttp https;
  if (!https.begin(signedUrl)) return false;
  // Content-Type MUST match what the URL was signed with (image/jpeg).
  https.addHeader("Content-Type", "image/jpeg");
  int code = https.sendRequest("PUT", (uint8_t *)data, len);
  https.end();
  if (code != 200) Serial.printf("[upload] PUT HTTP %d\n", code);
  return code == 200;
}

bool uploadStream(const String &signedUrl, Stream &stream, size_t len) {
  NetHttp https;
  if (!https.begin(signedUrl)) return false;
  https.addHeader("Content-Type", "image/jpeg");
  int code = https.sendRequest("PUT", &stream, len);
  https.end();
  if (code != 200) Serial.printf("[upload] PUT(stream) HTTP %d\n", code);
  return code == 200;
}

bool captureComplete(const String &objectName) {
  String url = String(BACKEND_BASE_URL) + "/api/capture-complete";
  NetHttp http;
  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", g_cfg.deviceSecret);

  String body = String("{\"deviceId\":\"") + g_cfg.deviceId +
                "\",\"objectPath\":\"" + objectName + "\"}";
  int code = http.POST(body);
  http.end();
  if (code != 200) Serial.printf("[complete] capture-complete HTTP %d\n", code);
  return code == 200;
}
