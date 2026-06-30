// ===========================================================================
// Cloud Telemetry Node  --  Heltec HT-HC33 (ESP32-S3)
// ---------------------------------------------------------------------------
// What it does, in plain words: every time it wakes up it connects to Wi-Fi,
// tells the cloud "I'm online + my battery level", checks if the dashboard
// asked it to do anything, then goes into the deepest sleep it can for a set
// number of seconds. Then it wakes and does it again. This keeps power use low.
//
// IMPORTANT: This is a *separate operating mode* from the live-stream camera
// sketch (videowithinterfacesketch). A board that deep-sleeps cannot also run
// an always-on video stream -- run ONE of them, not both.
//
// Flash with the Arduino IDE:  Board "Heltec ESP32 HaLow" -> HT-HC33
//                              (FQBN heltec:esp_halow:HT-HC33)
// First: copy secrets.example.h -> secrets.h and fill it in.
// ===========================================================================
#include <WiFi.h>
#include "esp_sleep.h"
#include "esp_wifi.h"

#include "node_config.h"
#include "secrets.h"
#include "cloud_backend.h"
#include "camera_capture.h"
#include "flash_store.h"
#include "pir_wake.h"
#include "user_button.h"
#include "dev_mode.h"
#include "device_config.h"
#include "provisioning.h"
#include "version.h"

// Survives deep sleep (kept in RTC memory) so we can count wake-ups in the log.
RTC_DATA_ATTR uint32_t bootCount = 0;
// Fallback photo filename counter when the clock isn't NTP-synced yet.
RTC_DATA_ATTR uint32_t captureSeq = 0;

static void goToDeepSleep(uint32_t seconds) {
  Serial.printf("[sleep] deep sleep for %u s (the chip resets on wake)\n", seconds);
  Serial.flush();

  // Turn the radio fully off before sleeping (lowest current draw).
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  // Deep sleep with TWO wake sources: the timer (periodic check-in) and the PIR
  // motion sensor (ext0). Whichever fires first wakes us. We deliberately do NOT
  // call esp_sleep_pd_config() here: on this Heltec/ESP-IDF build it asserts and
  // crashes, and it isn't needed -- timer deep sleep already powers down the
  // unused domains for us, leaving only the RTC timer running to wake us.
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  pirArmForWake();          // also wake on motion (ext0, settles the PIR first)
  buttonArmForWake();       // also wake on a USER button press (ext1)
  esp_deep_sleep_start();   // <-- never returns; board reboots into setup() on wake
}

// Power up the camera, grab one JPEG, upload it via a signed link, then tell
// the backend (which clears the command and records the capture).
// reason: "PIR"/"BUTTON"/"TIMER"/"COLDBOOT" -- feeds the descriptive object name.
static void doTakePicture(const char *reason) {
  Serial.println("[command] take_picture -> capturing");
  if (!cameraInit()) return;

  camera_fb_t *fb = cameraCapture();
  if (fb) {
    Serial.printf("[cam] captured %u bytes\n", (unsigned)fb->len);
    long epoch = getEpochSeconds();
    long long tsMs = epoch ? (long long)epoch * 1000LL : 0LL;
    String objectName;
    String signedUrl = requestUploadUrl(objectName, reason, tsMs);
    if (signedUrl.length() && uploadJpeg(signedUrl, fb->buf, fb->len)) {
      Serial.println("[upload] photo uploaded ✓");
      if (captureComplete(objectName)) Serial.println("[command] cleared by backend ✓");
    }
    cameraReturn(fb);
  } else {
    Serial.println("[cam] capture failed");
  }
  cameraDeinit();   // power the camera back down before we sleep
}

// Upload every photo still sitting in flash (this cycle's plus any leftovers
// from earlier cycles whose upload failed), oldest first. A file is deleted
// ONLY after the backend confirms the upload, so nothing is lost on a flaky
// link -- it just gets retried on the next wake. We stop on the first failure
// (usually the network is down) and try again next time.
static void uploadPendingPhotos() {
  String pending[16];
  int n = flashListPending(pending, 16);
  if (n == 0) { Serial.println("[cycle] nothing to upload"); return; }
  Serial.printf("[cycle] %d photo(s) pending upload\n", n);

  for (int i = 0; i < n; i++) {
    // Recover the ORIGINAL capture's reason + time from the LittleFS filename so
    // a photo uploaded one wake later still gets a descriptive cloud name (not
    // the upload-time clock).
    String reason; long long capTs = 0;
    flashParsePath(pending[i], reason, capTs);

    String objectName;
    String signedUrl = requestUploadUrl(objectName, reason.c_str(), capTs);
    if (!signedUrl.length()) {
      Serial.println("[upload] no signed URL -> stopping, retry next wake");
      break;
    }
    File f = flashOpen(pending[i]);
    if (!f) { Serial.printf("[flash] reopen %s failed -> skip\n", pending[i].c_str()); continue; }
    bool ok = uploadStream(signedUrl, f, f.size());
    f.close();
    if (ok) {
      captureComplete(objectName);
      flashDelete(pending[i]);   // safe to remove now: the upload is confirmed
      Serial.println("[upload] uploaded from flash ✓");
    } else {
      Serial.println("[upload] FAILED -> keeping file for retry next wake");
      break;
    }
  }
  Serial.printf("[flash] room for ~%d more photos\n", picsRemaining());
}

// Capture a photo, SAVE IT TO FLASH, optionally wait, then upload. The wait
// only fires on a PIR wake -- the 5 s is a placeholder for the future "wait
// for a lull" step that lets motion settle before the upload + sleep. A
// button press, timer wake, or cold boot has nothing to settle, so we skip
// the delay and save 5 s of awake time (= battery).
//
// reason: "PIR"/"BUTTON"/"TIMER"/"COLDBOOT" -- baked into the LittleFS filename
// so a delayed upload still tells the cloud what triggered the capture, and
// printed at the front of the cycle log so it's easy to scan multi-wake logs.
static void captureSaveUpload(const char *reason) {
  // Title case the reason for the log line; PIR stays uppercase since it's an
  // acronym. Filenames + cloud names keep the canonical uppercase form.
  const char *reasonDisplay =
      strcmp(reason, "COLDBOOT") == 0 ? "Coldboot" :
      strcmp(reason, "BUTTON")   == 0 ? "Button"   :
      strcmp(reason, "TIMER")    == 0 ? "Timer"    :
      strcmp(reason, "PIR")      == 0 ? "PIR"      : reason;
  bool needWait = (strcmp(reason, "PIR") == 0);
  Serial.printf("[cycle] %s capture -> flash%s -> upload\n",
                reasonDisplay, needWait ? " -> wait" : "");

  if (!cameraInit()) { Serial.println("[cam] init failed"); return; }

  camera_fb_t *fb = cameraCapture();
  if (!fb) { Serial.println("[cam] capture failed"); cameraDeinit(); return; }
  Serial.printf("[cam] captured %u bytes\n", (unsigned)fb->len);

  long epoch = getEpochSeconds();
  long long tsMs = epoch ? (long long)epoch * 1000LL : 0LL;
  String path = flashSaveJpeg(fb->buf, fb->len, tsMs, ++captureSeq, reason);
  cameraReturn(fb);
  cameraDeinit();   // done with the camera; save power during the wait + upload
  if (!path.length()) { Serial.println("[flash] save failed -> skip upload"); return; }

  if (needWait) {
    Serial.printf("[cycle] waiting %d ms before upload...\n", CAPTURE_WAIT_MS);
    delay(CAPTURE_WAIT_MS);
  }

  uploadPendingPhotos();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  bootCount++;
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  bool motionWake = (cause == ESP_SLEEP_WAKEUP_EXT0);    // PIR saw movement
  bool buttonWake = (cause == ESP_SLEEP_WAKEUP_EXT1);    // USER button pressed
  bool timerWake  = (cause == ESP_SLEEP_WAKEUP_TIMER);   // periodic check-in
  bool coldBoot   = (!motionWake && !buttonWake && !timerWake);  // power-on / reset
  const char *why = motionWake ? "MOTION wake" : buttonWake ? "BUTTON wake"
                  : timerWake  ? "timer wake"  : "cold boot";
  // Short tag for the cloud filename (see version.h + get-upload-url).
  const char *wakeReason = motionWake ? "PIR" : buttonWake ? "BUTTON"
                         : timerWake  ? "TIMER" : "COLDBOOT";
  Serial.printf("\n=== wake #%u (wake reason: %d, %s) ===\n", bootCount, (int)cause, why);
  Serial.printf("[fw] version %s\n", FW_VERSION_STR);

  pirInit();      // PIR signal pin   -> input (also needed before re-arming for sleep)
  buttonInit();   // USER button pin  -> input

  // Load this board's identity + Wi-Fi from on-chip storage (NVS). Falls back to
  // the compiled-in dev values (secrets.h / node_config.h) when NVS is empty, so
  // bench boards keep working. One firmware image -> many cameras.
  loadDeviceConfig();
  Serial.printf("[config] device_id = %s | mode = %s (%s)\n", g_cfg.deviceId.c_str(),
                g_cfg.netMode.c_str(), g_cfg.provisioned ? "provisioned" : "NOT provisioned");

  // Cold boot only: offer serial provisioning (the dashboard's "Set up a camera"
  // tool, or the Serial Monitor) so a blank board can get its Wi-Fi + identity
  // written to NVS. On a successful SAVE we reboot so the new config takes effect.
  if (coldBoot && provisioningListen(PROV_LISTEN_MS)) {
    Serial.println("[prov] saved -> rebooting to apply");
    Serial.flush();   // let "SAVED" + this line finish transmitting before reset
    delay(200);
    ESP.restart();
  }

  // 0) On a cold boot only, offer DEV MODE. A developer (computer on the USB
  //    serial) presses a key -> Wi-Fi hotspot + website, stay awake. Otherwise
  //    fall through to the normal low-power FIELD behavior. Timer wakes skip this
  //    so deep-sleep cycles never pay the listen cost.
  if (coldBoot && devModeRequested(DEV_MODE_LISTEN_MS)) {
    runDevMode();   // never returns
  }

  // If this board was never provisioned (no Wi-Fi / id / secret from NVS or
  // secrets.h), there's nothing useful to do in the field -- say how to fix it
  // and sleep. Set it up with the dashboard's "Set up a camera" tool, or fill in
  // secrets.h / node_config.h for bench testing.
  if (!g_cfg.provisioned) {
    Serial.println("[config] not provisioned -> sleeping (flash via dashboard, or set secrets.h)");
    goToDeepSleep(SLEEP_SECONDS);
  }

  // 1) Get online. If Wi-Fi won't connect, don't waste battery -- just sleep.
  if (!wifiConnect()) {
    Serial.println("[wifi] connect failed -> sleeping");
    goToDeepSleep(SLEEP_SECONDS);
  }

  // 2) Report status to the Realtime Database.
  long epoch = getEpochSeconds();                 // 0 if NTP didn't sync in time
  // epoch ms needs 64 bits -- (long)epoch*1000 overflows 32-bit and gave a
  // garbage timestamp. Use 0 when the clock isn't real yet.
  long long updatedAt = epoch ? (long long)epoch * 1000LL : 0LL;
  int battery = readBatteryPercent();
  bool ok = reportStatus("online", battery, updatedAt);
  Serial.printf("[report] %s  (battery %d%%)\n", ok ? "SENT ✓" : "FAILED", battery);

#if DO_CAPTURE_CYCLE
  // 2.5) Capture on MOTION (and on a cold boot, for a first test shot). On a
  //      plain timer check-in we skip the new photo but still flush anything
  //      left from a previous failed upload. Either way nothing is lost.
  if (flashInit()) {
    if (motionWake || buttonWake || coldBoot) captureSaveUpload(wakeReason);  // new photo + flush
    else                                      uploadPendingPhotos();// timer: retry only
  } else {
    Serial.println("[flash] init failed -> skipping capture cycle");
  }
#endif

  // 3) Check for a pending command from the dashboard.
  String cmd = getCommand();
  Serial.printf("[command] pending = %s\n", cmd.c_str());
  if (cmd == "take_picture") {
    doTakePicture(wakeReason);
  }

  // 4) Back to sleep.
  goToDeepSleep(SLEEP_SECONDS);
}

void loop() {
  // Never runs: setup() always ends in deep sleep, which resets the chip so we
  // start over from setup() each wake.
}
