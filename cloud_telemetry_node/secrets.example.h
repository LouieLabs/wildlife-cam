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
// The secret shown when you registered THIS device on the dashboard. The
// database only accepts status writes that carry the matching secret.
#define DEVICE_SECRET  "ABC-123-4567"

// --- Camera key (dev fallback only) -----------------------------------------
// Shared key for photo uploads + command poll. It is now PROVISIONED into NVS by
// the dashboard's "Set up a camera" tool, so the distributable/public firmware
// image is built with this BLANK (no secrets in the public binary). Set it here
// only for a bench board you compile + flash yourself.
#define CAMERA_API_KEY "change-me-to-match-web-env-local"
