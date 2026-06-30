#include "cloud_backend.h"
#include "node_config.h"
#include "secrets.h"
#include "device_config.h"
#include "version.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "time.h"

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

// Associate to a 2.4 GHz AP (the native ESP32 radio). Returns true on connect.
static bool wifiStaConnect(const String &ssid, const String &pass, uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.printf("[wifi] connecting to %s", ssid.c_str());
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  return false;
}

// Get online per the provisioned net mode. HaLow and 2.4 GHz are separate
// radios/networks; "both" tries HaLow first (production long-range) then falls
// back to 2.4 GHz. NOTE: the HaLow radio is not wired into this build yet, so we
// log and skip it rather than pretend -- 2.4 GHz works today.
bool wifiConnect(uint32_t timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;

  bool wantHalow = (g_cfg.netMode == "halow" || g_cfg.netMode == "both");
  bool wantWifi  = (g_cfg.netMode == "wifi"  || g_cfg.netMode == "both");

  if (wantHalow) {
    Serial.printf("[net] HaLow '%s' configured, but the HaLow radio is not enabled "
                  "in this build -- skipping\n", g_cfg.halowSsid.c_str());
  }
  if (wantWifi && g_cfg.wifiSsid.length()) {
    return wifiStaConnect(g_cfg.wifiSsid, g_cfg.wifiPass, timeoutMs);
  }
  if (wantHalow && !wantWifi) {
    Serial.println("[net] HaLow-only and HaLow not yet supported in firmware -> cannot connect");
  } else {
    Serial.println("[net] no usable 2.4 GHz SSID configured -> cannot connect");
  }
  return false;
}

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
// ---------------------------------------------------------------------------
bool reportStatus(const char *status, int batteryPct, long long updatedAt) {
  String url = String("https://") + RTDB_HOST + "/devices/" + g_cfg.deviceId + "/state.json";

  // updatedAt is 64-bit (epoch ms), so format it with %lld to avoid overflow.
  char ts[24];
  snprintf(ts, sizeof(ts), "%lld", updatedAt);

  // Build the JSON body. The secret is what the database rule checks.
  // firmwareVersion is auto-stamped at build time (see version.h) so the
  // dashboard can show which build is on each device without any per-release
  // bookkeeping.
  String body = "{";
  body += "\"status\":\"" + String(status) + "\",";
  body += "\"battery\":" + String(batteryPct) + ",";
  body += "\"secret\":\"" + g_cfg.deviceSecret + "\",";
  body += "\"firmwareVersion\":\"" + String(FW_VERSION_STR) + "\",";
  body += "\"updatedAt\":" + String(ts);
  body += "}";

  WiFiClientSecure client;
  client.setInsecure();   // skip TLS cert check -- fine for testing; see README
  HTTPClient https;
  if (!https.begin(client, url)) {
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

// Defined below in the photo-upload section; declared here so getCommand() can
// reuse it to pull the "command" field out of the JSON response.
static String jsonStringField(const String &json, const char *key);

// ---------------------------------------------------------------------------
// Command poll: HTTP POST /api/command-poll (authenticated via the backend)
// The database's command path is no longer public, so we ask the web app for
// the pending command instead of reading the database directly. Auth = the
// per-device secret (NOT a fleet-wide key), sent in x-device-secret. The server
// looks the expected value up by deviceId, so a leak of one board's secret
// blasts only that one board.
// ---------------------------------------------------------------------------
String getCommand() {
  String url = String(BACKEND_BASE_URL) + "/api/command-poll";
  // Match the transport to the URL scheme (deployed backend is https://, a
  // local dev server is http://) -- same approach as requestUploadUrl().
  bool secure = url.startsWith("https:");
  WiFiClient plain;
  WiFiClientSecure tls;
  if (secure) tls.setInsecure();   // skip cert check (testing); see README
  HTTPClient http;
  if (!http.begin(secure ? (WiFiClient &)tls : (WiFiClient &)plain, url)) return "idle";
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", g_cfg.deviceSecret);

  String reqBody = String("{\"deviceId\":\"") + g_cfg.deviceId + "\"}";
  int code = http.POST(reqBody);
  String resp = (code == 200) ? http.getString() : "";
  http.end();
  if (code != 200) {
    Serial.printf("[command] command-poll HTTP %d\n", code);
    return "idle";
  }

  // Response is JSON like {"deviceId":"...","command":"take_picture"}.
  String cmd = jsonStringField(resp, "command");
  return cmd.length() ? cmd : "idle";
}

// ---------------------------------------------------------------------------
// Photo upload flow
// ---------------------------------------------------------------------------

// Tiny extractor for a "key":"value" string field in a flat JSON response.
// (Good enough for our known, simple responses -- avoids pulling in a JSON lib.)
static String jsonStringField(const String &json, const char *key) {
  String needle = String("\"") + key + "\":\"";
  int i = json.indexOf(needle);
  if (i < 0) return "";
  i += needle.length();
  int j = json.indexOf('"', i);
  if (j < 0) return "";
  return json.substring(i, j);
}

String requestUploadUrl(String &objectNameOut, const char *wakeReason, long long capturedAtMs) {
  String url = String(BACKEND_BASE_URL) + "/api/get-upload-url";
  // Pick the transport from the URL scheme: the deployed Cloud Run backend is
  // https://, a local `npm run dev` server is http://. (WiFiClientSecure is a
  // WiFiClient, so the same HTTPClient.begin overload takes either.)
  bool secure = url.startsWith("https:");
  WiFiClient plain;
  WiFiClientSecure tls;
  if (secure) tls.setInsecure();   // skip cert check (testing); see README
  HTTPClient http;
  if (!http.begin(secure ? (WiFiClient &)tls : (WiFiClient &)plain, url)) return "";
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
  WiFiClientSecure client;
  client.setInsecure();   // skip cert check (testing); see README
  HTTPClient https;
  if (!https.begin(client, signedUrl)) return false;
  // Content-Type MUST match what the URL was signed with (image/jpeg).
  https.addHeader("Content-Type", "image/jpeg");
  int code = https.sendRequest("PUT", (uint8_t *)data, len);
  https.end();
  if (code != 200) Serial.printf("[upload] PUT HTTP %d\n", code);
  return code == 200;
}

bool uploadStream(const String &signedUrl, Stream &stream, size_t len) {
  WiFiClientSecure client;
  client.setInsecure();   // skip cert check (testing); see README
  HTTPClient https;
  if (!https.begin(client, signedUrl)) return false;
  https.addHeader("Content-Type", "image/jpeg");
  int code = https.sendRequest("PUT", &stream, len);
  https.end();
  if (code != 200) Serial.printf("[upload] PUT(stream) HTTP %d\n", code);
  return code == 200;
}

bool captureComplete(const String &objectName) {
  String url = String(BACKEND_BASE_URL) + "/api/capture-complete";
  bool secure = url.startsWith("https:");
  WiFiClient plain;
  WiFiClientSecure tls;
  if (secure) tls.setInsecure();   // skip cert check (testing); see README
  HTTPClient http;
  if (!http.begin(secure ? (WiFiClient &)tls : (WiFiClient &)plain, url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", g_cfg.deviceSecret);

  String body = String("{\"deviceId\":\"") + g_cfg.deviceId +
                "\",\"objectPath\":\"" + objectName + "\"}";
  int code = http.POST(body);
  http.end();
  if (code != 200) Serial.printf("[complete] capture-complete HTTP %d\n", code);
  return code == 200;
}
