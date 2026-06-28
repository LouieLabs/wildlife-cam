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
  g_cfg.wifiSsid     = p.getString("wifi_ssid", "");
  g_cfg.wifiPass     = p.getString("wifi_pass", "");
  g_cfg.deviceId     = p.getString("device_id", "");
  g_cfg.deviceSecret = p.getString("device_secret", "");
  p.end();

  // Dev / bench fallback: fill any blank field from the compiled-in values.
  if (g_cfg.wifiSsid     == "") g_cfg.wifiSsid     = WIFI_SSID;
  if (g_cfg.wifiPass     == "") g_cfg.wifiPass     = WIFI_PASSWORD;
  if (g_cfg.deviceId     == "") g_cfg.deviceId     = DEVICE_ID;
  if (g_cfg.deviceSecret == "") g_cfg.deviceSecret = DEVICE_SECRET;

  g_cfg.provisioned = g_cfg.wifiSsid.length() && g_cfg.deviceId.length()
                      && g_cfg.deviceSecret.length();
  return g_cfg.provisioned;
}

bool saveDeviceConfig(const String &ssid, const String &pass,
                      const String &id, const String &secret) {
  Preferences p;
  if (!p.begin(NVS_NS, /*readOnly=*/false)) return false;
  if (ssid.length())   p.putString("wifi_ssid", ssid);
  if (pass.length())   p.putString("wifi_pass", pass);
  if (id.length())     p.putString("device_id", id);
  if (secret.length()) p.putString("device_secret", secret);
  p.end();
  return true;
}
