#pragma once
// ---------------------------------------------------------------------------
// Template for secrets.h -- COPY this file to "secrets.h" in this same folder
// and fill in your real values. secrets.h is gitignored; this template is
// committed so teammates know what to fill in.
// ---------------------------------------------------------------------------

// Your Wi-Fi (2.4 GHz) the board uses to reach the internet.
#define WIFI_SSID      "your-wifi-name"
#define WIFI_PASSWORD  "your-wifi-password"

// The 6-character secret shown when you registered THIS device on the
// dashboard (e.g. "A7K2Q4"). The database only accepts status writes that
// carry the matching secret.
#define DEVICE_SECRET  "ABC123"

// Shared key for photo uploads -- must match CAMERA_API_KEY in web/.env.local.
// (Not used yet by the status-only node; here for the upcoming photo step.)
#define CAMERA_API_KEY "change-me-to-match-web-env-local"
