#pragma once
#include <stdbool.h>
#include <stdint.h>

// Connectivity for the T-Halow-P4. The P4 has NO radio of its own:
//   Phase 1: 2.4 GHz WiFi through the onboard ESP32-C6 companion
//            (esp-hosted transport + esp_wifi_remote -- standard esp_wifi API
//            afterward, so the rest of the firmware is radio-agnostic).
//   Phase 2: HaLow via the TX-AH module (UART AT commands, gateway design).
//
// net_connect() picks per g_cfg.net_mode ("wifi" today; "halow" logs + skips,
// same honest stance the S3 build took before its HaLow path existed).

// Bring the stack up and associate. Returns true when an IP is obtained
// within timeout_ms.
bool net_connect(uint32_t timeout_ms);

// True while associated with an IP.
bool net_is_connected(void);

// Radio off before deep sleep (lowest current).
void net_shutdown(void);
