#pragma once
// ---------------------------------------------------------------------------
// Template for secrets.h -- COPY this file to "secrets.h" in this same folder
// and fill in your real values. secrets.h is gitignored; this template is
// committed so teammates know what to fill in.
//
// These are ONLY a developer/bench fallback. In the field, a board's network +
// identity are written to on-chip storage (NVS) by the dashboard's "Set up a
// camera" tool, which OVERRIDES anything here. A production firmware image is
// built with these left blank so it MUST be provisioned. See device_config.h.
// ---------------------------------------------------------------------------

// --- 2.4 GHz Wi-Fi (testing/dev only) --------------------------------------
// The deployed cameras use HaLow, not 2.4 GHz; this is just for bench testing
// against a normal hotspot/router.
#define WIFI_SSID      "your-wifi-name"
#define WIFI_PASSWORD  "your-wifi-password"

// --- HaLow network (optional dev fallback) ---------------------------------
// Uncomment to bench-test a HaLow network without provisioning. The SSID/PSK are
// the gateway's HaLow network (different from your 2.4 GHz one).
// #define HALOW_SSID  "critterwatch-halow"
// #define HALOW_PSK   "your-64-hex-char-psk"

// --- Identity --------------------------------------------------------------
// The 10-char secret shown when you registered THIS device on the dashboard
// (format XXX-XXX-XXXX). It authenticates the board to the cloud for BOTH the
// status writes to Realtime Database AND the photo/command HTTP calls to the
// web backend; the server looks up the expected value per-device, so a leak
// only burns the one board.
#define DEVICE_SECRET  "ABC-123-4567"
