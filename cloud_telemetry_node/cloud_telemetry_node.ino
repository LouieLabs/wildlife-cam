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

// Survives deep sleep (kept in RTC memory) so we can count wake-ups in the log.
RTC_DATA_ATTR uint32_t bootCount = 0;

static void goToDeepSleep(uint32_t seconds) {
  Serial.printf("[sleep] deep sleep for %u s (the chip resets on wake)\n", seconds);
  Serial.flush();

  // Turn the radio fully off before sleeping.
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_wifi_stop();

  // Deepest mode that can still wake ITSELF: power down the RTC peripherals and
  // leave only the RTC timer running to wake us. (RTC memory stays on so
  // bootCount survives.)
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_OFF);
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

void setup() {
  Serial.begin(115200);
  delay(300);
  bootCount++;
  Serial.printf("\n=== wake #%u (wake reason: %d) ===\n",
                bootCount, (int)esp_sleep_get_wakeup_cause());

  // 1) Get online. If Wi-Fi won't connect, don't waste battery -- just sleep.
  if (!wifiConnect()) {
    Serial.println("[wifi] connect failed -> sleeping");
    goToDeepSleep(SLEEP_SECONDS);
  }

  // 2) Report status to the Realtime Database.
  long epoch = getEpochSeconds();                 // 0 if NTP didn't sync in time
  long updatedAt = epoch ? epoch * 1000L          // epoch milliseconds when known
                         : (long)bootCount;        // otherwise a simple counter
  int battery = readBatteryPercent();
  bool ok = reportStatus("online", battery, updatedAt);
  Serial.printf("[report] %s  (battery %d%%)\n", ok ? "SENT ✓" : "FAILED", battery);

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
