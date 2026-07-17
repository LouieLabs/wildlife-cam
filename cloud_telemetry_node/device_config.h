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
// The HaLow radio is wired in via net_link.cpp (netConnect()), so both sets of
// credentials are live: boards provisioned before the HaLow path landed pick it
// up with no re-provisioning -- their stored HaLow creds just start working.
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
  String deviceSecret;  // per-device, used both for RTDB writes AND backend HTTP auth
  bool   provisioned;   // identity + network present
};

// Filled by loadDeviceConfig(); read by the networking code (cloud_backend.cpp).
extern DeviceConfig g_cfg;

// Load g_cfg from NVS, then apply the dev fallback. Returns g_cfg.provisioned.
bool loadDeviceConfig();

// Write the non-empty fields of `c` to NVS (empty = leave that key as-is). Used
// by serial / browser provisioning. Returns true on success.
bool saveDeviceConfig(const DeviceConfig &c);

// ---------------------------------------------------------------------------
// Dashboard-pushed config changes (OTA "set_wifi" / "set_id" commands)
// ---------------------------------------------------------------------------
// These let the dashboard re-point a camera's 2.4 GHz Wi-Fi, or rename its id,
// without a USB cable -- the board applies the change to NVS and reboots. See
// cloud_telemetry_node.ino (command handling) and docs/pir-capture-pipeline-plan.md.

// Apply a new 2.4 GHz Wi-Fi network from a set_wifi command. Before overwriting,
// it STASHES the current creds as a backup and starts a "trial" of `trials`
// wakes. If the new network never connects, wifiTrialResolve() restores the
// backup so a wrong password can't strand the camera off-grid. Returns false if
// the NVS write failed (creds left unchanged).
bool applyWifiChange(const String &newSsid, const String &newPass,
                     const String &newNetMode, uint8_t trials);

// True while a set_wifi trial is in progress (new creds live, backup still held).
bool wifiTrialActive();

// Call once per wake AFTER the Wi-Fi connect attempt, passing whether we got
// online. On the first success it COMMITS (drops the backup); on repeated
// failure it counts down and, when the trials run out, RESTORES the backup and
// returns true -- the caller should then reboot to reconnect on the old network.
bool wifiTrialResolve(bool connectedOk);

// Apply a new device identity from a set_id command (rename). The per-device
// secret is left unchanged: the cloud keeps the same pre_shared_key under the
// new id, so the board stays authenticated across the switch. Returns false on
// NVS write failure (id left unchanged).
bool applyIdChange(const String &newId);
