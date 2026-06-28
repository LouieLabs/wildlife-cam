#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Over-the-air firmware updates, in plain words:
//
// The dashboard sets the device's command to "update". On its next wake the
// camera (this code) fetches a tiny JSON file from the backend that says what
// the latest version is. If that's newer than what's running -- and we haven't
// already failed this exact version -- we download the new firmware into the
// OTHER on-chip program slot, then restart into it.
//
// The new image's FIRST job is to take a photo labelled "First image of vX.Y"
// and upload it. Only after that upload succeeds do we tell the chip "this new
// image is good"; otherwise the bootloader will revert to the previous version
// on the next boot. As a backup, if the validated-new image then crashes more
// than a few times in a row, we manually flip back to the previous slot.
//
// Three layers of safety:
//   1) Bootloader auto-rollback. We don't mark the new image valid until the
//      labelled photo is uploaded. If the first wake fails, the chip resets to
//      the previous image on its own.
//   2) First-photo acceptance. Forces the new image to actually take + upload a
//      visible-in-the-dashboard photo before being committed.
//   3) NVS 3-strike health counter. After mark-valid, if 3 consecutive cold
//      boots fail to finish their cycle, manually swap back.
//
// Loop guard: when a rollback happens we remember which version it was, and
// refuse to re-attempt the same version on our own. The admin must publish a
// fixed version (e.g. 1.1.1) -- or click "Idle" to clear the update command.
// ---------------------------------------------------------------------------

// Snapshot of the OTA state for the current boot, populated by otaBootSync.
// Read by cloud_backend.cpp's reportStatus() to include in the device's status
// report, and by the sketch to decide whether to take a labelled first-boot
// photo on this wake.
struct OtaStateView {
  bool        firstBootPending;        // first-boot capture+upload not yet confirmed
  uint8_t     strikes;                 // post-mark-valid cycles without a healthy milestone
  const char *stateLabel;              // "running" | "pending_verify" | "rolled_back"
  String      rollbackFromVersion;     // set when stateLabel == "rolled_back"
  String      rollbackReason;          // "first-boot upload failed" or "3-strike health counter"
  bool        rollbackThisBoot;        // true ONLY on the very first wake after a rollback
};

extern OtaStateView g_ota;

// Call at the top of setup() (after Serial.begin), passing whether this wake
// is a cold boot (power-on / reset, as opposed to a deep-sleep timer / ext0 /
// ext1 wake). Reads/updates NVS, classifies this boot, and -- if 3 strikes are
// up -- manually reverts + restarts (which never returns).
void otaBootSync(bool coldBoot);

// Call after a successful capture+upload+capture-complete cycle. On the first
// such call after a new image, clears firstBootPending and calls
// esp_ota_mark_app_valid_cancel_rollback() so the bootloader stops watching.
// Always resets the strike counter to 0.
void otaMarkHealthy();

// Call when the dashboard's command is "update". Returns true if it queued a
// restart (caller should stop, the function won't actually return in that
// case). Returns false on every skip path: battery too low, network failure
// fetching the manifest, server version is the loop-broken version, or server
// version isn't newer than what's running.
bool otaTryUpdate(int batteryPct);

// Call right before any intentional exit (goToDeepSleep, or an ESP.restart()
// for provisioning / OTA). Marks the current cycle as "completed cleanly" so
// the strike counter doesn't count it as a hang.
void otaMarkCycleClean();
