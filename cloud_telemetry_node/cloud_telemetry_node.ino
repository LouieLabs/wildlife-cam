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
#include "sd_store.h"
#include "dev_mode.h"

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

  // Deep sleep with a timer wake. We deliberately do NOT call
  // esp_sleep_pd_config() here: on this Heltec/ESP-IDF build it asserts and
  // crashes, and it isn't needed -- timer deep sleep already powers down the
  // unused domains for us, leaving only the RTC timer running to wake us.
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  esp_deep_sleep_start();   // <-- never returns; board reboots into setup() on wake
}

// Power up the camera, grab one JPEG, upload it via a signed link, then tell
// the backend (which clears the command and records the capture).
static void doTakePicture() {
  Serial.println("[command] take_picture -> capturing");
  if (!cameraInit()) return;

  camera_fb_t *fb = cameraCapture();
  if (fb) {
    Serial.printf("[cam] captured %u bytes\n", (unsigned)fb->len);
    String objectName;
    String signedUrl = requestUploadUrl(objectName);
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

// Basic telemetry test (no PIR yet): capture a photo, SAVE IT TO SD, wait 5 s,
// then upload that saved file to the cloud. The 5 s stands in for the future
// "wait for a lull" step. The photo stays on SD so it's never lost.
static void captureSaveWaitUpload() {
  Serial.println("[cycle] capture -> SD -> wait -> upload");
  if (!cameraInit()) { Serial.println("[cam] init failed"); return; }

  camera_fb_t *fb = cameraCapture();
  if (!fb) { Serial.println("[cam] capture failed"); cameraDeinit(); return; }
  Serial.printf("[cam] captured %u bytes\n", (unsigned)fb->len);

  long epoch = getEpochSeconds();
  long long tsMs = epoch ? (long long)epoch * 1000LL : 0LL;
  String path = sdSaveJpeg(fb->buf, fb->len, tsMs, ++captureSeq);
  cameraReturn(fb);
  cameraDeinit();   // done with the camera; save power during the wait + upload
  if (!path.length()) { Serial.println("[sd] save failed -> skip upload"); return; }

  Serial.printf("[cycle] waiting %d ms before upload...\n", CAPTURE_WAIT_MS);
  delay(CAPTURE_WAIT_MS);

  String objectName;
  String signedUrl = requestUploadUrl(objectName);
  if (!signedUrl.length()) { Serial.println("[upload] no signed URL"); return; }

  File f = sdOpen(path);
  if (!f) { Serial.println("[sd] reopen for upload failed"); return; }
  bool ok = uploadStream(signedUrl, f, f.size());
  f.close();
  Serial.printf("[upload] %s\n", ok ? "uploaded from SD ✓" : "FAILED");
  if (ok) captureComplete(objectName);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  bootCount++;
  bool coldBoot = (esp_sleep_get_wakeup_cause() != ESP_SLEEP_WAKEUP_TIMER);
  Serial.printf("\n=== wake #%u (wake reason: %d, %s) ===\n",
                bootCount, (int)esp_sleep_get_wakeup_cause(),
                coldBoot ? "cold boot" : "timer wake");

  // 0) On a cold boot only, offer DEV MODE. A developer (computer on the USB
  //    serial) presses a key -> Wi-Fi hotspot + website, stay awake. Otherwise
  //    fall through to the normal low-power FIELD behavior. Timer wakes skip this
  //    so deep-sleep cycles never pay the listen cost.
  if (coldBoot && devModeRequested(DEV_MODE_LISTEN_MS)) {
    runDevMode();   // never returns
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
  // 2.5) Basic telemetry test: capture -> save to SD -> wait 5 s -> upload.
  if (sdInit()) captureSaveWaitUpload();
  else Serial.println("[sd] init failed -> skipping capture cycle");
#endif

  // 3) Check for a pending command from the dashboard.
  String cmd = getCommand();
  Serial.printf("[command] pending = %s\n", cmd.c_str());
  if (cmd == "take_picture") {
    doTakePicture();
  }

  // 4) Back to sleep.
  goToDeepSleep(SLEEP_SECONDS);
}

void loop() {
  // Never runs: setup() always ends in deep sleep, which resets the chip so we
  // start over from setup() each wake.
}
