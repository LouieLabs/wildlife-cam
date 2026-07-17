#include "net.h"
#include "node_config.h"
#include "device_config.h"

#include <string.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

static const char *TAG = "net";

// ---------------------------------------------------------------------------
// Connectivity for the T-Halow-P4.
//
// The P4 has NO radio of its own. WiFi comes from the onboard ESP32-C6
// companion over 4-bit SDIO, bridged by esp_hosted + esp_wifi_remote (see
// idf_component.yml). Those components hook the STANDARD esp_wifi_* API, so
// everything below is ordinary IDF WiFi code -- the SDIO transport to the C6
// is transparent. Lilygo wires the C6 with the SAME pin map as Espressif's
// ESP32-P4-Function-EV-Board (CLK18 / CMD19 / D0-D3 = 14-17, slave reset 54),
// which is why the stock CONFIG_ESP_HOSTED_P4_DEV_BOARD_FUNC_BOARD defaults
// apply unmodified. Facts + citations: docs/PLAN-lilygo-p4-port.md.
//
// HARDWARE PREREQUISITE: Lilygo ships the C6 BLANK. Until esp-hosted SLAVE
// firmware is flashed onto it (external USB-serial adapter; C6 TX/RX are on
// header JP1), every connect fails at the TRANSPORT layer -- the log shows
// "Attempt connection with slave" retries rather than a WiFi association
// error. That is a missing-firmware symptom, not a bug in this file.
// ---------------------------------------------------------------------------

#define NET_CONNECTED_BIT BIT0
#define NET_FAILED_BIT    BIT1
// Association attempts per wake before giving up (deep sleep resets the chip,
// so this counter is naturally per-wake).
#define MAX_RETRY 3

static EventGroupHandle_t s_events;
static esp_netif_t *s_netif;
static int s_retries;
static bool s_started;
static bool s_connected;

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_event_sta_disconnected_t *d = (wifi_event_sta_disconnected_t *)data;
    s_connected = false;
    if (s_retries < MAX_RETRY) {
      s_retries++;
      ESP_LOGW(TAG, "disconnected (reason %d) -> retry %d/%d", d->reason, s_retries, MAX_RETRY);
      esp_wifi_connect();
    } else {
      // Reason 201 (NO_AP_FOUND) earns a plain-English line: on the Heltec
      // fleet this exact case cost real time ("why is it looking for that?").
      if (d->reason == WIFI_REASON_NO_AP_FOUND) {
        ESP_LOGE(TAG, "network '%s' NOT FOUND -- wrong SSID, a 5 GHz-only network, or out of range",
                 g_cfg.wifi_ssid);
      } else {
        ESP_LOGE(TAG, "connect failed after %d tries (last reason %d)", MAX_RETRY, d->reason);
      }
      xEventGroupSetBits(s_events, NET_FAILED_BIT);
    }
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
    ESP_LOGI(TAG, "connected, IP " IPSTR, IP2STR(&e->ip_info.ip));
    s_connected = true;
    s_retries = 0;
    xEventGroupSetBits(s_events, NET_CONNECTED_BIT);
  }
}

bool net_connect(uint32_t timeout_ms) {
  if (s_connected) return true;

  // Radio selection mirrors the Heltec build's honest stance: HaLow creds may
  // be provisioned, but the TX-AH radio is Phase 2 -- say so, don't pretend.
  bool want_halow = !strcmp(g_cfg.net_mode, "halow") || !strcmp(g_cfg.net_mode, "both");
  bool want_wifi  = !strcmp(g_cfg.net_mode, "wifi")  || !strcmp(g_cfg.net_mode, "both");
  if (want_halow) {
    ESP_LOGW(TAG, "HaLow '%s' provisioned, but the TX-AH radio is not enabled in this build -> skipping",
             g_cfg.halow_ssid);
  }
  if (!want_wifi || !g_cfg.wifi_ssid[0]) {
    ESP_LOGE(TAG, "no usable 2.4 GHz SSID configured -> cannot connect");
    return false;
  }

  if (!s_events) s_events = xEventGroupCreate();
  xEventGroupClearBits(s_events, NET_CONNECTED_BIT | NET_FAILED_BIT);
  s_retries = 0;

  if (!s_started) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_netif = esp_netif_create_default_wifi_sta();

    // esp_wifi_init() is serviced by esp_wifi_remote -> esp_hosted -> SDIO ->
    // the C6. A blank C6 stalls here (see the note at the top of this file).
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &on_wifi_event, NULL, NULL));
    s_started = true;
  }

  wifi_config_t wc = {0};

  // 802.11 limits: SSID <= 32 bytes, PSK <= 63 chars. Our NVS fields are wider
  // than that, so a too-long stored value is INVALID config -- refuse loudly
  // rather than let it truncate and silently hunt a DIFFERENT network (a real
  // SSID prefix would be worse than an obvious failure). wc is zero-initialised,
  // so memcpy leaves correct padding/termination.
  size_t ssid_len = strlen(g_cfg.wifi_ssid);
  size_t pass_len = strlen(g_cfg.wifi_pass);
  if (ssid_len > sizeof(wc.sta.ssid) || pass_len >= sizeof(wc.sta.password)) {
    ESP_LOGE(TAG, "stored WiFi creds too long (ssid %u B max %u; pass %u B max %u) -> refusing to connect",
             (unsigned)ssid_len, (unsigned)sizeof(wc.sta.ssid),
             (unsigned)pass_len, (unsigned)sizeof(wc.sta.password) - 1);
    return false;
  }
  memcpy(wc.sta.ssid, g_cfg.wifi_ssid, ssid_len);
  memcpy(wc.sta.password, g_cfg.wifi_pass, pass_len);
  // An open network has an empty password; a WPA2 threshold would make such a
  // network unjoinable.
  wc.sta.threshold.authmode = g_cfg.wifi_pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
  ESP_ERROR_CHECK(esp_wifi_start());   // STA_START event kicks off the connect

  ESP_LOGI(TAG, "connecting to '%s'...", g_cfg.wifi_ssid);
  EventBits_t bits = xEventGroupWaitBits(s_events, NET_CONNECTED_BIT | NET_FAILED_BIT,
                                         pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
  if (bits & NET_CONNECTED_BIT) return true;
  if (!(bits & NET_FAILED_BIT)) {
    ESP_LOGE(TAG, "connect timed out after %lu ms (C6 slave firmware missing?)",
             (unsigned long)timeout_ms);
  }
  return false;
}

bool net_is_connected(void) { return s_connected; }

void net_shutdown(void) {
  if (!s_started) return;
  // Drop the link before deep sleep. NOTE: the C6 is a separate chip on its
  // own power domain -- the P4 sleeping does NOT power it down. Cutting the
  // companion's draw (slave reset is on GPIO54) is a Phase-2 power-budget task.
  esp_wifi_disconnect();
  esp_wifi_stop();
  s_connected = false;
}
