// ===========================================================================
// Wildlife camera node -- Lilygo T-Halow-P4 (ESP32-P4, ESP-IDF)
// ---------------------------------------------------------------------------
// The P4 port of camera_code_v3_1 / cloud_telemetry_node. Same plain-words
// behavior: wake -> connect -> report -> (photograph on motion) -> check for
// a dashboard command -> deep sleep. One wake per PIR event or SLEEP_SECONDS.
// ===========================================================================
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "node_config.h"
#include "version.h"
#include "device_config.h"
#include "provisioning.h"
#include "wake_sources.h"
#include "net.h"
#include "camera_capture.h"
#include "photo_store.h"
#include "cloud_backend.h"

static const char *TAG = "node";

// Survive deep sleep in RTC memory (cleared only by full power loss).
RTC_DATA_ATTR static uint32_t s_boot_count = 0;
RTC_DATA_ATTR static uint32_t s_capture_seq = 0;
// Dashboard-tunable burst settings, cached across sleeps (0 = use defaults).
RTC_DATA_ATTR static uint32_t s_burst_ms = 0;
RTC_DATA_ATTR static uint32_t s_burst_max_shots = 0;

static uint32_t clamp_u32(uint32_t v, uint32_t lo, uint32_t hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
static uint32_t effective_burst_ms(void) {
  return clamp_u32(s_burst_ms ? s_burst_ms : CAPTURE_BURST_MS, BURST_MS_MIN, BURST_MS_MAX);
}
static uint32_t effective_burst_shots(void) {
  return clamp_u32(s_burst_max_shots ? s_burst_max_shots : CAPTURE_BURST_MAX_SHOTS,
                   BURST_SHOTS_MIN, BURST_SHOTS_MAX);
}

// Upload everything pending in flash, oldest first; delete only after the
// backend confirms. Stops on the first network failure (retries next wake).
static void upload_pending_photos(void) {
  int total_uploaded = 0;
  for (;;) {
    char paths[16][PHOTO_PATH_MAX];
    int n = photo_store_list(paths, 16);
    if (n == 0) {
      if (total_uploaded == 0) ESP_LOGI(TAG, "nothing to upload");
      break;
    }
    int uploaded = 0;
    bool stop = false;
    for (int i = 0; i < n; i++) {
      char reason[16];
      int64_t cap_ts = 0;
      photo_store_parse(paths[i], reason, sizeof(reason), &cap_ts);

      char url[2048], object[256];
      if (!cloud_request_upload_url(reason, cap_ts, url, sizeof(url), object, sizeof(object))) {
        ESP_LOGW(TAG, "no signed URL -> stopping, retry next wake");
        stop = true;
        break;
      }
      if (cloud_upload_file(url, paths[i])) {
        cloud_capture_complete(object);
        photo_store_delete(paths[i]);   // confirmed -> safe to remove
        uploaded++;
        total_uploaded++;
      } else {
        ESP_LOGW(TAG, "upload FAILED -> keeping for retry next wake");
        stop = true;
        break;
      }
    }
    if (stop || uploaded == 0) break;   // no progress -> don't spin
  }
  ESP_LOGI(TAG, "flash room for ~%d more photos", photo_store_remaining());
}

// Single shot (BUTTON / COLDBOOT test shot): capture -> flash -> upload.
static void capture_save_upload(const char *reason) {
  if (!camera_init()) { ESP_LOGE(TAG, "camera init failed"); return; }
  camera_frame_t fb = camera_capture();
  if (!fb.buf) { ESP_LOGE(TAG, "capture failed"); camera_deinit(); return; }
  ESP_LOGI(TAG, "captured %u bytes", (unsigned)fb.len);

  int64_t epoch = cloud_epoch_seconds(0);   // non-blocking: 0 if not yet synced
  char path[PHOTO_PATH_MAX];
  bool saved = photo_store_save(fb.buf, fb.len, epoch ? epoch * 1000 : 0,
                                ++s_capture_seq, reason, path, sizeof(path));
  camera_return(&fb);
  camera_deinit();
  if (saved) upload_pending_photos();
}

// Continuous-motion burst: photo every burst_ms while the PIR stays active,
// with the quiet-window rule (a pulsing short-hold PIR must not end a real
// event) and the same safety rails as the S3 build.
static void capture_burst_upload(const char *reason) {
  if (!camera_init()) { ESP_LOGE(TAG, "camera init failed"); return; }
  const uint32_t burst_ms = effective_burst_ms();
  const uint32_t max_shots = effective_burst_shots();
  ESP_LOGI(TAG, "PIR burst: photo every %lu ms, max %lu shots",
           (unsigned long)burst_ms, (unsigned long)max_shots);

  uint32_t shots = 0;
  int64_t last_motion_ms = esp_log_timestamp();
  for (;;) {
    camera_frame_t fb = camera_capture();
    if (!fb.buf) { ESP_LOGW(TAG, "capture failed -> ending burst"); break; }
    int64_t epoch = cloud_epoch_seconds(0);
    char path[PHOTO_PATH_MAX];
    bool saved = photo_store_save(fb.buf, fb.len, epoch ? epoch * 1000 : 0,
                                  ++s_capture_seq, reason, path, sizeof(path));
    camera_return(&fb);
    if (!saved) { ESP_LOGW(TAG, "save failed -> ending burst"); break; }
    shots++;

    if (photo_store_remaining() <= CAPTURE_BURST_MIN_FREE) {
      ESP_LOGW(TAG, "flash nearly full -> ending burst");
      break;
    }
    if (shots >= max_shots) {
      ESP_LOGW(TAG, "burst hit %lu-shot cap -> ending (resumes next wake if still moving)",
               (unsigned long)max_shots);
      break;
    }

    vTaskDelay(pdMS_TO_TICKS(burst_ms));
    if (pir_line_high()) {
      last_motion_ms = esp_log_timestamp();
    } else if (esp_log_timestamp() - last_motion_ms >= CAPTURE_QUIET_MS) {
      ESP_LOGI(TAG, "no motion for %d ms -> ending burst", CAPTURE_QUIET_MS);
      break;
    }
    // line LOW inside the quiet window: PIR is between pulses -- keep going.
  }

  camera_deinit();
  ESP_LOGI(TAG, "burst captured %lu photo(s) -> upload", (unsigned long)shots);
  upload_pending_photos();
}

void app_main(void) {
  s_boot_count++;

  esp_err_t nvs = nvs_flash_init();
  if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }

  wake_pins_init();
  wake_reason_t wake = wake_classify();

  // Spurious-motion filter: a genuine PIR trigger holds its line HIGH for
  // seconds; boot-to-here is far shorter. LOW now = electrical noise (or no
  // sensor): downgrade to a plain check-in so noise can't chain-shoot.
  if (wake == WAKE_PIR) {
    vTaskDelay(pdMS_TO_TICKS(50));
    if (!pir_line_high()) {
      ESP_LOGW(TAG, "motion wake but PIR line LOW -> spurious; treating as timer wake");
      wake = WAKE_TIMER;
    }
  }
  const char *tag = wake_tag(wake);
  ESP_LOGI(TAG, "=== wake #%lu (%s) ===", (unsigned long)s_boot_count, tag);
  ESP_LOGI(TAG, "fw %s  board " BOARD_TYPE, fw_version_str());

  device_config_load();
  ESP_LOGI(TAG, "device_id=%s mode=%s (%s)", g_cfg.device_id, g_cfg.net_mode,
           g_cfg.provisioned ? "provisioned" : "NOT provisioned");

  // Cold boot only: give the dashboard's USB tool a provisioning window.
  if (wake == WAKE_COLD && provisioning_listen(PROV_LISTEN_MS)) {
    ESP_LOGI(TAG, "provisioned -> rebooting to apply");
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
  }

  if (!g_cfg.provisioned) {
    ESP_LOGW(TAG, "not provisioned -> sleeping (use the dashboard's Set up a camera tool)");
    go_to_deep_sleep(SLEEP_SECONDS);
  }

  // 1) Get online. Resolve any armed set_wifi trial on BOTH outcomes -- failed
  //    wakes must count toward the auto-revert or a bad push never reverts.
  bool online = net_connect(WIFI_CONNECT_TIMEOUT_MS);
  if (wifi_trial_active() && wifi_trial_resolve(online)) {
    ESP_LOGW(TAG, "wifi trial reverted -> rebooting onto restored network");
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
  }
  if (!online) {
    ESP_LOGW(TAG, "connect failed -> sleeping");
    go_to_deep_sleep(SLEEP_SECONDS);
  }

  // 2) Report status.
  int64_t epoch = cloud_epoch_seconds(NTP_TIMEOUT_MS);
  int battery = cloud_battery_percent();
  status_report_t rpt = { "online", battery, epoch ? epoch * 1000 : 0 };
  bool sent = cloud_report_status(&rpt);
  ESP_LOGI(TAG, "report %s (battery %d%%)", sent ? "SENT" : "FAILED", battery);

  // 2.5) Capture cycle: burst on motion, single shot on button/cold boot,
  //      upload-retry only on a plain timer check-in.
  if (photo_store_init()) {
    if (wake == WAKE_PIR)                          capture_burst_upload(tag);
    else if (wake == WAKE_BUTTON || wake == WAKE_COLD) capture_save_upload(tag);
    else                                           upload_pending_photos();
  }

  // 3) Dashboard command.
  command_t cmd;
  if (cloud_get_command(&cmd)) {
    ESP_LOGI(TAG, "command pending = %s", cmd.verb);

    if (cmd.burst_ms) s_burst_ms = cmd.burst_ms;
    if (cmd.burst_max_shots) s_burst_max_shots = cmd.burst_max_shots;

    if (!strcmp(cmd.verb, "take_picture")) {
      capture_save_upload(tag);   // capture-complete clears the command
    } else if (!strcmp(cmd.verb, "set_wifi") && cmd.has_wifi) {
      ESP_LOGI(TAG, "set_wifi -> '%s' (trial %d wakes)", cmd.wifi_ssid, WIFI_TRIAL_WAKES);
      if (apply_wifi_change(cmd.wifi_ssid, cmd.wifi_pass, cmd.wifi_net_mode, WIFI_TRIAL_WAKES)) {
        cloud_ack_command();      // ack on the OLD (working) connection
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
      }
    } else if (!strcmp(cmd.verb, "set_id") && cmd.has_rename) {
      ESP_LOGI(TAG, "set_id -> '%s'", cmd.rename_new_id);
      if (apply_id_change(cmd.rename_new_id)) {
        cloud_ack_command();
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
      }
    } else if (!strcmp(cmd.verb, "update_firmware")) {
      // Phase 2 on this board: report loudly instead of silently ignoring, so
      // a dashboard publish against a P4 is visible in the field logs.
      ESP_LOGW(TAG, "update_firmware received but OTA is Phase 2 on the P4 -> skipping");
    }
  }

  // 4) Sleep.
  net_shutdown();
  go_to_deep_sleep(SLEEP_SECONDS);
}
