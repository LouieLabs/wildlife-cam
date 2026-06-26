#include "cloud_backend.h"
#include "node_config.h"
#include "secrets.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "time.h"

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------
bool wifiConnect(uint32_t timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
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

// ---------------------------------------------------------------------------
// Battery (stubbed until a real sense pin + divider ratio are provided)
// ---------------------------------------------------------------------------
int readBatteryPercent() {
#if BATTERY_ADC_PIN < 0
  return BATTERY_TEST_VALUE;
#else
  // Rough placeholder: assumes a divider mapping 0-3.3V at the pin to 0-100%.
  // Replace the math once you tell me the divider ratio / battery range.
  int raw = analogRead(BATTERY_ADC_PIN);          // 0..4095 on ESP32-S3
  int pct = (int)((raw / 4095.0f) * 100.0f);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
#endif
}

// ---------------------------------------------------------------------------
// Time (one short NTP sync)
// ---------------------------------------------------------------------------
long getEpochSeconds(uint32_t timeoutMs) {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  uint32_t start = millis();
  time_t now = 0;
  while (millis() - start < timeoutMs) {
    now = time(nullptr);
    if (now > 1700000000) return (long)now;   // looks like a real 2023+ epoch
    delay(150);
  }
  return 0;   // couldn't sync in time
}

// ---------------------------------------------------------------------------
// Status report: HTTPS PUT to /devices/<id>/state.json
// ---------------------------------------------------------------------------
bool reportStatus(const char *status, int batteryPct, long updatedAt) {
  String url = String("https://") + RTDB_HOST + "/devices/" + DEVICE_ID + "/state.json";

  // Build the JSON body. The secret is what the database rule checks.
  String body = "{";
  body += "\"status\":\"" + String(status) + "\",";
  body += "\"battery\":" + String(batteryPct) + ",";
  body += "\"secret\":\"" + String(DEVICE_SECRET) + "\",";
  body += "\"updatedAt\":" + String(updatedAt);
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

// ---------------------------------------------------------------------------
// Command poll: HTTPS GET /devices/<id>/command.json
// ---------------------------------------------------------------------------
String getCommand() {
  String url = String("https://") + RTDB_HOST + "/devices/" + DEVICE_ID + "/command.json";

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  if (!https.begin(client, url)) return "";
  int code = https.GET();
  String raw = (code == 200) ? https.getString() : "";
  https.end();

  // RTDB returns a JSON string like "take_picture" (with quotes) or "null".
  raw.trim();
  if (raw == "null" || raw.length() == 0) return "idle";
  if (raw.startsWith("\"") && raw.endsWith("\"") && raw.length() >= 2) {
    raw = raw.substring(1, raw.length() - 1);
  }
  return raw;
}
