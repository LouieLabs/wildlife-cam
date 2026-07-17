#pragma once
// ---------------------------------------------------------------------------
// Non-secret configuration for the T-Halow-P4 wildlife node. Mirrors the
// HT-HC33 sketch's node_config.h so behavior stays identical across boards.
// Identity + WiFi come from NVS (dashboard provisioning); nothing per-device
// is compiled in.
// ---------------------------------------------------------------------------

// Dev fallback identity (NVS overrides; blank in production images).
#define DEVICE_ID_FALLBACK      ""
#define DEVICE_SECRET_FALLBACK  ""
#define WIFI_SSID_FALLBACK      ""
#define WIFI_PASS_FALLBACK      ""

// One image per board type: the dashboard filters OTA builds by this so a P4
// .bin can never be pushed to a Heltec S3 (guaranteed brick) or vice versa.
#define BOARD_TYPE       "lilygo-t-halow-p4"

// Realtime Database host -- no "https://", no trailing slash.
#define RTDB_HOST        "louielabs-animal-cams-default-rtdb.firebaseio.com"

// Base URL of the web app (photo upload + command poll + capture-complete).
#define BACKEND_BASE_URL "https://wildlife-dashboard-ee47ntxftq-uw.a.run.app"

// --- Duty cycle --------------------------------------------------------------
// Wake, report once, deep-sleep this many seconds. This IS the reporting
// interval AND the worst-case dashboard-command latency. Motion wakes are
// instant regardless. 30 for bench testing, 600 deployed.
#define SLEEP_SECONDS    600

// --- Motion burst (continuous PIR detection) ---------------------------------
// Same semantics as the HT-HC33 build: on a PIR wake, capture to flash every
// CAPTURE_BURST_MS while motion continues; upload the batch afterward.
#define CAPTURE_BURST_MS        2000
#define CAPTURE_BURST_MIN_FREE  5      // stop before LittleFS fills
#define CAPTURE_BURST_MAX_SHOTS 60     // stuck-PIR battery protection
// End a burst only after this long of PIR quiet -- a short-hold PIR PULSES
// during continuous motion; a single LOW sample must not end the event.
#define CAPTURE_QUIET_MS        10000
// Dashboard overrides (devices/<id>/settings) are clamped to these bounds.
#define BURST_MS_MIN            500
#define BURST_MS_MAX            30000
#define BURST_SHOTS_MIN         1
#define BURST_SHOTS_MAX         500

// --- OTA Wi-Fi change: trial before commit -----------------------------------
// set_wifi keeps the OLD creds as a backup for this many wakes; if the new
// network never connects, auto-revert so a dashboard typo can't strand the
// camera off-grid.
#define WIFI_TRIAL_WAKES   3

// --- Pins (T-Halow-P4) --------------------------------------------------------
// TODO(bring-up): confirm against the Lilygo schematic / research notes before
// first flash. PIR must be on a deep-sleep-wake-capable GPIO.
#define PIR_GPIO           2     // PIR OUT (wake on HIGH)  -- VERIFY on board
#define USER_BUTTON_GPIO   0     // BOOT button (wake on LOW) -- VERIFY

// --- Provisioning / console ---------------------------------------------------
// Cold-boot window to listen for the dashboard's USB provisioning commands.
#define PROV_LISTEN_MS     4000
// Idle timeout once provisioning has started.
#define PROV_IDLE_MS       30000

// --- Networking ---------------------------------------------------------------
#define WIFI_CONNECT_TIMEOUT_MS  15000
#define NTP_TIMEOUT_MS           8000
