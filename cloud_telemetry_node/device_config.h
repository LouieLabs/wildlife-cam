#pragma once
#include <Arduino.h>

// Per-device identity + Wi-Fi, loaded from on-chip storage (NVS) at boot.
//
// Why: so ONE pre-built firmware image works for every camera. The browser
// "Set up a camera" tool (and, later, OTA) writes each board's Wi-Fi + identity
// into NVS; the firmware reads it here. Nothing per-device is compiled in.
//
// Dev fallback: when NVS is empty (a developer's bench board), any blank field
// falls back to the compile-time values in secrets.h / node_config.h, so the
// existing "edit secrets.h and flash" workflow keeps working unchanged. A
// production image is built with BLANK placeholders, so it requires NVS.
struct DeviceConfig {
  String wifiSsid;
  String wifiPass;
  String deviceId;
  String deviceSecret;
  bool   provisioned;   // true once Wi-Fi + id + secret are all present
};

// Filled by loadDeviceConfig(); read by the networking code (cloud_backend.cpp).
extern DeviceConfig g_cfg;

// Load g_cfg from NVS, then apply the dev fallback. Returns g_cfg.provisioned.
bool loadDeviceConfig();

// Write per-device config to NVS (used by serial / browser provisioning). An
// empty arg leaves that field untouched. Returns true on success.
bool saveDeviceConfig(const String &ssid, const String &pass,
                      const String &id, const String &secret);
