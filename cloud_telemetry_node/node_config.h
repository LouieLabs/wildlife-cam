#pragma once
// ---------------------------------------------------------------------------
// Non-secret configuration for the cloud telemetry node.
// (Secrets -- Wi-Fi password, the device secret, the camera API key -- live in
//  secrets.h, which is gitignored. Copy secrets.example.h to secrets.h.)
// ---------------------------------------------------------------------------

// Identity: must EXACTLY match what you typed when you registered this board on
// the dashboard (Register a camera).
#define DEVICE_ID        "pond_cam_01"

// Realtime Database host -- no "https://", no trailing slash.
#define RTDB_HOST        "louielabs-animal-cams-default-rtdb.firebaseio.com"

// Base URL of the web app (for photo upload + capture-complete). The firmware
// auto-uses TLS for an https:// URL and plain HTTP otherwise, so either works:
//   * FIELD / PRODUCTION -> the deployed Cloud Run backend (HTTPS). Uploads land
//     in the bucket tagged under prod/.
//   * DEV -> your computer's LAN address while running `npm run dev`
//     (e.g. http://192.168.1.97:3000, NOT localhost). Uploads tag under dev/.
#define BACKEND_BASE_URL "https://wildlife-dashboard-ee47ntxftq-uw.a.run.app"

// Basic telemetry test: on every wake, capture a photo, save it to internal
// flash (LittleFS), wait 5 s, then upload it to the cloud (and any photos left
// over from a previous failed upload). Set to 0 to go back to status-only.
#define DO_CAPTURE_CYCLE   1
#define CAPTURE_WAIT_MS    5000

// --- Duty cycle -------------------------------------------------------------
// The board wakes, reports ONCE, then deep-sleeps this many seconds. Because
// deep sleep resets the chip, this number IS the reporting interval.
//   * 10  -> fast testing (report every ~10 s)
//   * 30  -> your normal setting
#define SLEEP_SECONDS    30

// --- Battery sense (real HT-HC33 circuit, from the datasheet) ----------------
// Drive ADC_Ctrl HIGH to switch VBAT through a 100K/100K divider into ADC_IN,
// so the pin reads VBAT/2. (Datasheet section 4.1.)
#define BAT_ADC_CTRL_PIN   20      // ADC_Ctrl enable (also USB_P; unused since we use the CP2102)
#define BAT_ADC_PIN        1       // ADC_IN = VBAT / 2
#define VBAT_EMPTY_MV      3400    // ~0%  (Li-ion empty)
#define VBAT_FULL_MV       4200    // ~100% (Li-ion full)

// --- Dev vs Field mode (auto, single codebase) ------------------------------
// On a COLD boot, the node listens this long on the serial port. If a developer
// (a computer is connected) presses any key, it enters DEV MODE: a self-contained
// 2.4 GHz Wi-Fi hotspot + camera website, and stays awake. No key -> FIELD MODE
// (the normal low-power deep-sleep behavior). Timer wakes skip the listen.
#define DEV_MODE_LISTEN_MS   10000
// Cold-boot window (ms) to listen for serial provisioning commands (the
// dashboard's "Set up a camera" tool, or the Serial Monitor) before the
// dev-mode prompt. Kept short -- the browser tool sends a command immediately.
#define PROV_LISTEN_MS       4000
// Dev hotspot password (WPA2 needs >= 8 chars). SSID is "wildcam-<DEVICE_ID>".
#define DEV_AP_PASSWORD      "wildcam1234"
