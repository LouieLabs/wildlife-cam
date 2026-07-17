#include "provisioning.h"
#include "device_config.h"
#include "node_config.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "prov";

// Read one newline-terminated line from the USB console, or "" on timeout.
// Trims a trailing \r so CRLF terminals behave.
static bool read_line(char *out, size_t cap, uint32_t timeout_ms) {
  size_t n = 0;
  int64_t start = esp_timer_get_time();
  out[0] = '\0';
  while ((esp_timer_get_time() - start) / 1000 < timeout_ms) {
    uint8_t ch;
    int got = usb_serial_jtag_read_bytes(&ch, 1, pdMS_TO_TICKS(20));
    if (got <= 0) continue;
    if (ch == '\n') break;
    if (n + 1 < cap) out[n++] = (char)ch;
    start = esp_timer_get_time();   // keep reading while bytes flow
  }
  out[n] = '\0';
  // trim trailing \r / spaces
  while (n > 0 && (out[n - 1] == '\r' || out[n - 1] == ' ')) out[--n] = '\0';
  return n > 0;
}

static void print_mac(void) {
  uint8_t m[6];
  esp_read_mac(m, ESP_MAC_WIFI_STA);
  printf("MAC %02x:%02x:%02x:%02x:%02x:%02x\n", m[0], m[1], m[2], m[3], m[4], m[5]);
}

static void stash_set(device_config_t *in, const char *key, const char *val) {
  if      (!strcmp(key, "halow_ssid")) snprintf(in->halow_ssid, sizeof(in->halow_ssid), "%s", val);
  else if (!strcmp(key, "halow_psk"))  snprintf(in->halow_psk,  sizeof(in->halow_psk),  "%s", val);
  else if (!strcmp(key, "wifi_ssid"))  snprintf(in->wifi_ssid,  sizeof(in->wifi_ssid),  "%s", val);
  else if (!strcmp(key, "wifi_pass"))  snprintf(in->wifi_pass,  sizeof(in->wifi_pass),  "%s", val);
  else if (!strcmp(key, "mode"))       snprintf(in->net_mode,   sizeof(in->net_mode),   "%s", val);
  else if (!strcmp(key, "id"))         snprintf(in->device_id,  sizeof(in->device_id),  "%s", val);
  else if (!strcmp(key, "secret"))     snprintf(in->device_secret, sizeof(in->device_secret), "%s", val);
  else { printf("ERR key\n"); return; }
  printf("OK %s\n", key);
}

bool provisioning_listen(uint32_t detect_ms) {
  usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
  usb_serial_jtag_driver_install(&cfg);   // idempotent-ish; ignore if already up

  ESP_LOGI(TAG, "ready %lus (send 'MAC?' / 'SET ...' / 'SAVE')",
           (unsigned long)(detect_ms / 1000));
  print_mac();

  char line[160];
  if (!read_line(line, sizeof(line), detect_ms)) return false;   // no tool attached

  device_config_t in = {0};   // stashed fields; written to NVS on SAVE
  for (;;) {
    if (line[0]) {
      if (!strcmp(line, "MAC?")) {
        print_mac();
      } else if (!strcmp(line, "SAVE")) {
        bool ok = device_config_save(&in);
        // Explicit local provisioning cancels any armed set_wifi trial so the
        // auto-revert can't stomp what a human just chose.
        if (ok) wifi_trial_clear();
        printf(ok ? "SAVED\n" : "ERR save\n");
        return ok;
      } else if (!strcmp(line, "EXIT")) {
        printf("OK exit\n");
        return false;
      } else if (!strncmp(line, "SET ", 4)) {
        char *key = line + 4;
        char *sp = strchr(key, ' ');
        if (sp) {
          *sp = '\0';
          stash_set(&in, key, sp + 1);   // value = remainder (may contain spaces)
        } else {
          printf("ERR key\n");
        }
      } else {
        printf("ERR cmd\n");
      }
    }
    if (!read_line(line, sizeof(line), PROV_IDLE_MS)) {
      ESP_LOGI(TAG, "idle timeout -> continuing boot");
      return false;
    }
  }
}
