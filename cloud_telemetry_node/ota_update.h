#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Over-The-Air firmware updates for the Heltec HT-HC33.
//
// Plain-words summary: the dashboard tells this camera "please update to
// firmware build XYZ." On a safe wake (timer/button, battery healthy, board
// matches) we download the new .bin into the SPARE app slot, check that its
// SHA256 fingerprint matches what the dashboard said to expect, then reboot
// into the new build. If the new build fails to reach the cloud on its first
// wake, the bootloader automatically falls back to the previous slot.
//
// See docs/FLASH_STORAGE_OTA_PLAN.md (Step 3) for the full design, the flow
// diagram, the payload contract, and the 21 locked design decisions.
//
// State-machine diagram (spans multiple reboots):
//
//     ┌───────── (getCommand returns "update_firmware" + OtaTarget) ──────┐
//     │                                                                   │
//     ▼                                                                   │
//   otaShouldAttempt(target, wake, batt)                                   │
//     │                                                                   │
//     ├─ NOT Ok → log reason, continue wake cycle (photos, sleep) ────────┘
//     │
//     └─ Ok → otaDownloadAndFlash
//              │
//              ├─ any failure → Update.abort(), log OtaResult,
//              │                continue wake cycle
//              │
//              └─ ok → esp_ota_set_boot_partition + ESP.restart
//                       │
//                       ▼
//                 chip reboots into new slot
//                 (state: PENDING_VERIFY)
//                       │
//                       ▼
//                 next setup() runs, reportStatus() succeeds
//                       │
//                       ▼
//                 otaMarkValidIfPending(reportStatusOk = true)
//                       │
//                       ▼
//                 esp_ota_mark_app_valid_cancel_rollback → state VALID
//
//   If reportStatus fails after the switch, we do NOT mark valid, and on
//   the next reset the bootloader auto-reverts to the previous slot.
// ---------------------------------------------------------------------------

// Every possible outcome of an OTA attempt this wake cycle. The status report
// echoes this back to the dashboard as state.lastOta.result so the operator
// sees exactly why an update didn't take. Add new variants at the end.
enum class OtaResult {
  Ok,                  // .bin flashed + verified, about to reboot into it
  DownloadFailed,      // HTTPS GET didn't return 200, or begin() failed
  NoSpace,             // Update.begin refused (inactive slot too small)
  WriteFailed,         // short write during download or Update.end failed
  ShaMismatch,         // full download OK, but SHA256 didn't match otaTarget
  Stalled,             // throughput dropped below otaTarget.minBytesPerSec
  Timeout,             // wall-clock exceeded otaTarget.maxSeconds
  BoardTypeMismatch,   // otaTarget.boardType != our BOARD_TYPE (guaranteed brick)
  LowBattery,          // battery below floor -- mid-flash power loss risk
  LowRssi,             // Wi-Fi RSSI below floor -- mid-flash disconnect risk
  BadWakeReason,       // PIR wake -- motion path has priority this cycle
};

// Human-readable name for state.lastOta.result. Also used by the bench test.
const char *otaResultString(OtaResult r);

// The instructions the dashboard sent us via the command bus. All fields except
// the three "*Seconds" and minBytesPerSec are populated from the ota{...} object
// in the /api/command-poll response. Defaults for the three server-driven
// budgets are used when the payload omits them (safe conservative values).
struct OtaTarget {
  String url;               // "https://.../builds/<boardType>/<sha>/firmware.bin"
  String sha256;            // 64 lowercase hex chars, of the .bin bytes
  size_t sizeBytes;         // exact byte count (compared to Content-Length)
  String version;           // "a1b2c3d" (git SHA); echoed as state.lastOta.to
  String boardType;         // "heltec-ht-hc33"; must equal BOARD_TYPE or refuse
  uint32_t expectedSeconds; // server's ETA given current mesh topology (informational)
  uint32_t minBytesPerSec;  // stall floor: abort if throughput drops under this
                            // sustained after a 15 s grace period
  uint32_t maxSeconds;      // hard wall-clock ceiling before abort
};

// Wake reason as classified by setup() from esp_sleep_get_wakeup_cause(). Kept
// as an enum so ota_update.cpp doesn't have to know about esp_sleep_* codes.
enum class WakeReason { Cold, Timer, Pir, Button };

// Decide if it's safe to attempt an OTA on THIS wake, given the target and
// current conditions. Returns Ok when everything looks safe; otherwise returns
// the specific reason (which doubles as state.lastOta.result if the caller
// wants to report the skip).
//
// batteryPct: 0-100, from readBatteryPercent(). Wi-Fi RSSI is read directly
// from WiFi.RSSI() so this must be called AFTER wifiConnect().
OtaResult otaShouldAttempt(const OtaTarget &t, WakeReason wr, int batteryPct);

// Download the .bin, verify SHA256 in-flight, write it into the inactive OTA
// slot, set that slot as the next boot partition, and restart.
//
// On success this function DOES NOT RETURN -- the chip reboots. Any return
// value other than Ok (which can only happen if we fell through without a
// restart, meaning a bug) indicates a failure; Update.abort() has already
// been called and the wake cycle should continue normally to sleep.
//
// Caller MUST have already called cameraDeinit() so the PSRAM camera buffers
// are freed before the download.
OtaResult otaDownloadAndFlash(const OtaTarget &t);

// Called from setup() right after a successful reportStatus. If we're running
// a freshly-flashed image (partition state == PENDING_VERIFY), this marks it
// valid so the bootloader stops threatening to auto-revert. No-op when we're
// on a plain boot.
//
// reportStatusOk MUST be the return of this wake's reportStatus() -- health
// check for "new firmware can reach the cloud." If false, we deliberately
// leave the partition in PENDING_VERIFY so a reset triggers auto-revert.
//
// Also emits log lines the HT-HC33_OTA_Unit bench test greps for:
//   "[ota] pending verify -- checking reportStatus"
//   "[ota] mark_valid ok"          (when reportStatusOk is true)
//   "[ota] reportStatus not ok ..." (when false)
void otaMarkValidIfPending(bool reportStatusOk);
