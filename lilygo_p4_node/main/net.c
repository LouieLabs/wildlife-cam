#include "net.h"
#include "node_config.h"
#include "device_config.h"
#include "esp_log.h"

static const char *TAG = "net";

// ===========================================================================
// BRING-UP PLACEHOLDER -- Phase 1 WIP.
// Real implementation: WiFi via the onboard ESP32-C6 companion using
// esp-hosted + esp_wifi_remote (then the standard esp_wifi_* API works).
// Pending verified component names/init order from the research pass.
// ===========================================================================
bool net_connect(uint32_t timeout_ms) {
  (void)timeout_ms;
  ESP_LOGE(TAG, "net_connect: companion-WiFi transport not wired yet (bring-up stub)");
  return false;
}
bool net_is_connected(void) { return false; }
void net_shutdown(void) {}
