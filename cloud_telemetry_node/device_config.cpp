#include "device_config.h"
#include "node_config.h"
#include "secrets.h"
#include <Preferences.h>

DeviceConfig g_cfg;

// NVS namespace that holds this board's provisioning. The browser flash tool
// writes the same keys.
static const char *NVS_NS = "wildcam";

bool loadDeviceConfig() {
  Preferences p;
  p.begin(NVS_NS, /*readOnly=*/true);
  g_cfg.halowSsid    = p.getString("halow_ssid", "");
  g_cfg.halowPsk     = p.getString("halow_psk", "");
  g_cfg.wifiSsid     = p.getString("wifi_ssid", "");
  g_cfg.wifiPass     = p.getString("wifi_pass", "");
  g_cfg.netMode      = p.getString("net_mode", "");
  g_cfg.deviceId     = p.getString("device_id", "");
  g_cfg.deviceSecret = p.getString("device_secret", "");
  p.end();

  // Dev / bench fallback: fill any blank field from the compiled-in values. A
  // production image is built with blanks, so it requires NVS provisioning.
  if (g_cfg.wifiSsid     == "") g_cfg.wifiSsid     = WIFI_SSID;
  if (g_cfg.wifiPass     == "") g_cfg.wifiPass     = WIFI_PASSWORD;
  if (g_cfg.deviceId     == "") g_cfg.deviceId     = DEVICE_ID;
  if (g_cfg.deviceSecret == "") g_cfg.deviceSecret = DEVICE_SECRET;
#ifdef HALOW_SSID
  if (g_cfg.halowSsid    == "") g_cfg.halowSsid    = HALOW_SSID;
#endif
#ifdef HALOW_PSK
  if (g_cfg.halowPsk     == "") g_cfg.halowPsk     = HALOW_PSK;
#endif

  // Default the mode from whatever creds exist (2.4 GHz works today, so prefer
  // it when present; otherwise HaLow if that's all we have).
  if (g_cfg.netMode == "") {
    if      (g_cfg.wifiSsid.length())  g_cfg.netMode = "wifi";
    else if (g_cfg.halowSsid.length()) g_cfg.netMode = "halow";
  }

  bool hasNet = g_cfg.wifiSsid.length() || g_cfg.halowSsid.length();
  g_cfg.provisioned = g_cfg.deviceId.length() && g_cfg.deviceSecret.length() && hasNet;
  return g_cfg.provisioned;
}

bool saveDeviceConfig(const DeviceConfig &c) {
  Preferences p;
  if (!p.begin(NVS_NS, /*readOnly=*/false)) {
    Serial.println("[nvs] begin(readWrite) failed");
    return false;
  }

  // putString() returns 0 on failure but the old code ignored that, so a full
  // NVS partition silently swallowed writes while still reporting "SAVED" to
  // the provisioning page. After every write, READ BACK the same key and
  // compare to what we just wrote -- the only reliable detector for the
  // silent-failure case. Any mismatch fails the whole save so SAVE responds
  // ERR save instead of lying.
  bool allOk = true;
  auto checkPut = [&](const char *key, const String &want) {
    if (want.length() == 0) return;          // blank == caller wants to leave key as-is
    size_t wrote = p.putString(key, want);
    String got = p.getString(key, "");
    bool match = (got == want);
    bool ok = (wrote > 0) && match;
    Serial.printf("[nvs] %-14s %s  wrote=%u readback=%s\n", key,
                  ok ? "OK  " : "FAIL",
                  (unsigned)wrote,
                  match ? "match" : "MISMATCH");
    if (!ok) allOk = false;
  };

  checkPut("halow_ssid",    c.halowSsid);
  checkPut("halow_psk",     c.halowPsk);
  checkPut("wifi_ssid",     c.wifiSsid);
  checkPut("wifi_pass",     c.wifiPass);
  checkPut("net_mode",      c.netMode);
  checkPut("device_id",     c.deviceId);
  checkPut("device_secret", c.deviceSecret);

  p.end();
  if (!allOk) {
    Serial.println("[nvs] save FAILED -- partition likely full of junk from prior provisions.");
    Serial.println("[nvs] Fix: Arduino IDE -> Tools -> Erase All Flash Before Sketch Upload -> Enabled, then reflash.");
  }
  return allOk;
}
