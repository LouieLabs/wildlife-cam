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
  if (!p.begin(NVS_NS, /*readOnly=*/false)) return false;
  if (c.halowSsid.length())    p.putString("halow_ssid", c.halowSsid);
  if (c.halowPsk.length())     p.putString("halow_psk", c.halowPsk);
  if (c.wifiSsid.length())     p.putString("wifi_ssid", c.wifiSsid);
  if (c.wifiPass.length())     p.putString("wifi_pass", c.wifiPass);
  if (c.netMode.length())      p.putString("net_mode", c.netMode);
  if (c.deviceId.length())     p.putString("device_id", c.deviceId);
  if (c.deviceSecret.length()) p.putString("device_secret", c.deviceSecret);
  p.end();
  return true;
}
