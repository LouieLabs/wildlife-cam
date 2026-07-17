#pragma once
#include <stdbool.h>
#include <stdint.h>

// Per-device identity + network, loaded from NVS at boot -- the P4 port of the
// HT-HC33 device_config. One firmware image -> many cameras: the dashboard's
// "Set up a camera" USB tool (see provisioning.h) writes these keys; the
// same NVS namespace/keys as the S3 build so tooling stays identical.
//
// HaLow creds are stored-but-unused in Phase 1 (radio lands in Phase 2), same
// stance the S3 build took: provision once, no re-provision when HaLow lights up.

#define DC_STR_MAX 65

typedef struct {
  char halow_ssid[DC_STR_MAX];
  char halow_psk[DC_STR_MAX];
  char wifi_ssid[DC_STR_MAX];
  char wifi_pass[DC_STR_MAX];
  char net_mode[8];            // "wifi" | "halow" | "both"
  char device_id[48];
  char device_secret[DC_STR_MAX];
  bool provisioned;            // identity + a usable network present
} device_config_t;

extern device_config_t g_cfg;

// Load g_cfg from NVS, apply compile-time dev fallbacks, set .provisioned.
bool device_config_load(void);

// Write the NON-EMPTY fields of c to NVS (empty string = leave key as-is).
// Read-back verified: a full/corrupt NVS partition fails loudly, not silently.
bool device_config_save(const device_config_t *c);

// --- Dashboard-pushed config changes (set_wifi / set_id) ---------------------

// Apply a new 2.4 GHz network: stash current creds as backup, arm a trial of
// `trials` wakes. If the new network never connects, wifi_trial_resolve()
// restores the backup (auto-revert). Returns false on NVS failure.
bool apply_wifi_change(const char *ssid, const char *pass, const char *net_mode,
                       uint8_t trials);

// True while a set_wifi trial is armed (backup still held).
bool wifi_trial_active(void);

// Call once per wake AFTER the connect attempt. First success commits (drops
// backup); on the last failed trial restores the backup and returns true --
// caller should reboot onto the restored network.
bool wifi_trial_resolve(bool connected_ok);

// Cancel an armed trial WITHOUT reverting (explicit local save wins).
void wifi_trial_clear(void);

// Rename: device id changes, secret + networks untouched.
bool apply_id_change(const char *new_id);
