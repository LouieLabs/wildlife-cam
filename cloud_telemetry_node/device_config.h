#pragma once
#include <Arduino.h>

// Per-device network + identity, loaded from on-chip storage (NVS) at boot.
//
// Why: so ONE pre-built firmware image works for every camera. The browser
// "Set up a camera" tool (and, later, OTA) writes each board's networks +
// identity into NVS; the firmware reads it here. Nothing per-device is compiled
// in for a production image.
//
// TWO radios, separate credentials: HaLow and 2.4 GHz are different access
// points on different radios, so each has its own SSID/password. `netMode` picks
// which to use ("halow" | "wifi" | "both"; "both" = try HaLow first, fall back
// to 2.4 GHz). Identity (deviceId + deviceSecret) is shared -- it identifies the
// camera to the cloud, not to a radio.
//
// NOTE: the HaLow radio is not wired into this build yet, so HaLow creds are
// stored but not used to connect (2.4 GHz works today). Saving them now means no
// re-provisioning once the HaLow path lands.
//
// Dev fallback: blank fields fall back to compile-time values in secrets.h /
// node_config.h, so a developer's bench board keeps working. A production image
// is built with blank placeholders, so it requires provisioning.
struct DeviceConfig {
  String halowSsid;
  String halowPsk;
  String wifiSsid;
  String wifiPass;
  String netMode;       // "halow" | "wifi" | "both"
  String deviceId;
  String deviceSecret;
  String cameraKey;     // shared upload/command key (was compile-time)
  bool   provisioned;   // identity + network + camera key present
};

// Filled by loadDeviceConfig(); read by the networking code (cloud_backend.cpp).
extern DeviceConfig g_cfg;

// Load g_cfg from NVS, then apply the dev fallback. Returns g_cfg.provisioned.
bool loadDeviceConfig();

// Write the non-empty fields of `c` to NVS (empty = leave that key as-is). Used
// by serial / browser provisioning. Returns true on success.
bool saveDeviceConfig(const DeviceConfig &c);
