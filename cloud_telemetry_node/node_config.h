#pragma once
// ---------------------------------------------------------------------------
// Non-secret configuration for the cloud telemetry node.
// (Secrets -- Wi-Fi password, the device secret, the camera API key -- live in
//  secrets.h, which is gitignored. Copy secrets.example.h to secrets.h.)
// ---------------------------------------------------------------------------

// Identity: must EXACTLY match what you typed when you registered this board on
// the dashboard (Register a camera).
#define DEVICE_ID        "pond_cam_01"

// What kind of board this firmware image targets. The dashboard filters OTA
// builds by this so a Heltec .bin can never be pushed to a Lilygo (or vice
// versa -- different CPU architecture, guaranteed brick). One firmware image =
// one BOARD_TYPE. Match the value in web/public/firmware/builds/<boardType>/.
#define BOARD_TYPE       "heltec-ht-hc33"

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

// --- Motion linger: stay awake after motion (don't sleep between triggers) ---
// A MOTION wake normally captures once and deep-sleeps immediately. But deep
// sleep drops Wi-Fi, so the NEXT motion event pays the full Wi-Fi reconnect
// (several seconds) before it can shoot -- long enough to miss the animal. So
// after a motion capture we stay awake with Wi-Fi still up and watch the PIR
// directly: fresh motion shoots right away with no reconnect, and each motion
// resets the timer so we keep watching as long as something is around. We only
// deep-sleep after the PIR has been quiet this many ms.
//   * This is the single-threaded version of the MOTION/LULL states in
//     docs/pir-capture-pipeline-plan.md.
//   * Trade-off: Wi-Fi stays on during the window, so bigger = fewer missed
//     shots but more battery. 30 s is a reasonable field start; tune per site.
#define MOTION_LINGER_MS     30000
// Minimum gap between captures while lingering, so an animal parked in front of
// the sensor doesn't machine-gun the camera (wasting battery + storage).
#define MOTION_MIN_GAP_MS     8000
// How often to poll the PIR pin while lingering.
#define MOTION_POLL_MS         200
// Absolute ceiling on one linger window, regardless of motion. A PIR that sticks
// HIGH (a known failure mode -- see pir_wake.cpp) would otherwise refresh the
// quiet timer forever and hold the board awake, draining the battery. After this
// we deep-sleep no matter what; the timer wake brings us back.
#define MOTION_LINGER_MAX_MS 300000

// --- OTA Wi-Fi change: trial before commit ----------------------------------
// When the dashboard pushes a new Wi-Fi network (set_wifi), the board keeps the
// OLD creds as a backup and gives the NEW network this many wakes to connect. If
// it never does (wrong password, out of range), the firmware reverts to the old
// network so a typo on the dashboard can't strand the camera off-grid. Each wake
// is up to SLEEP_SECONDS apart, so 3 wakes ~= a minute-plus of retrying.
#define WIFI_TRIAL_WAKES   3

// --- Battery sense (real HT-HC33 circuit, from the datasheet) ----------------
// Drive ADC_Ctrl HIGH to switch VBAT through a 100K/100K divider into ADC_IN,
// so the pin reads VBAT/2. (Datasheet section 4.1.)
#define BAT_ADC_CTRL_PIN   20      // ADC_Ctrl enable (also USB_P; unused since we use the CP2102)
#define BAT_ADC_PIN        1       // ADC_IN = VBAT / 2
#define VBAT_EMPTY_MV      3400    // ~0%  (Li-ion empty)
#define VBAT_FULL_MV       4200    // ~100% (Li-ion full)

// --- USB-power sense (no extra hardware; from the schematic) -----------------
// The CP2102 USB-UART bridge is powered from VDD_5V, and VDD_5V comes ONLY from
// the USB VBUS (Type-C -> F1 fuse -> VDD_5V; no battery boost). So when USB is
// unplugged the CP2102 is fully unpowered and its TXD line (-> the ESP32's
// U0RXD = GPIO44) stops being driven. We detect "on USB power" by enabling the
// pin's internal pulldown and reading it: a powered CP2102 idles the line HIGH
// (push-pull, overrides the ~45k pulldown) => USB present; unpowered => LOW.
// Verified against HT-HC33_Schematic_V1.0.0 (USB-UART + POWER blocks) 2026-07-09.
// NOTE: reads USB *power*, not "terminal open" -- a wall charger also reads HIGH.
// Solar charging does NOT false-trigger (it feeds the battery, not VDD_5V).
#define USB_SENSE_PIN      44      // U0RXD, wired to CP2102 TXD (pin 50 on the S3)

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
