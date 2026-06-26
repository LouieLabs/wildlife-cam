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

// Base URL of the web app (for photo upload links). While testing against
// `npm run dev`, this is your computer's LAN address (NOT localhost). Update if
// your computer's IP changes -- Next prints a "Network:" URL on startup.
#define BACKEND_BASE_URL "http://192.168.1.26:3000"

// Basic telemetry test: on every wake, capture a photo, save it to the SD card,
// wait 5 s, then upload it to the cloud. Set to 0 to go back to status-only.
#define DO_CAPTURE_CYCLE   1
#define CAPTURE_WAIT_MS    5000

// --- Duty cycle -------------------------------------------------------------
// The board wakes, reports ONCE, then deep-sleeps this many seconds. Because
// deep sleep resets the chip, this number IS the reporting interval.
//   * 10  -> fast testing (report every ~10 s)
//   * 30  -> your normal setting
#define SLEEP_SECONDS    30

// --- Battery sense ----------------------------------------------------------
// Set BATTERY_ADC_PIN to the ADC-capable GPIO wired to your battery divider.
// Leave it at -1 to report a fixed test value until you tell me the real pin.
#define BATTERY_ADC_PIN     -1
#define BATTERY_TEST_VALUE  100
