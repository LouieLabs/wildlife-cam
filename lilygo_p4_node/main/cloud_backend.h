#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Cloud protocol to the LouieLabs backend -- P4 port of the HT-HC33
// cloud_backend. Same wire contract; parsing via cJSON (IDF built-in) instead
// of the S3 build's hand-rolled string scanning.

// --- Status ------------------------------------------------------------------
typedef struct {
  const char *status;      // "online", ...
  int battery_pct;
  int64_t updated_at_ms;   // epoch ms, 0 when NTP hasn't synced
} status_report_t;

// HTTPS PUT devices/<id>/state.json (payload carries the device secret; the
// RTDB rule accepts the write only when it matches the registry).
bool cloud_report_status(const status_report_t *r);

// --- Commands ------------------------------------------------------------------
typedef struct {
  char verb[24];           // idle | take_picture | set_wifi | set_id | update_firmware
  // set_wifi payload
  bool has_wifi;
  char wifi_ssid[65];
  char wifi_pass[65];
  char wifi_net_mode[8];
  // set_id payload
  bool has_rename;
  char rename_new_id[48];
  // dashboard capture settings (0 = not provided -> keep current)
  uint32_t burst_ms;
  uint32_t burst_max_shots;
  // update_firmware arrives with an ota payload; Phase 2 on this board. We
  // surface only the flag so the cycle can log-and-skip it explicitly.
  bool has_ota;
} command_t;

// POST /api/command-poll (x-device-secret auth).
bool cloud_get_command(command_t *out);

// POST /api/command-ack -- clear a one-shot command (set_wifi/set_id) after
// applying it, while still on the OLD working connection.
bool cloud_ack_command(void);

// --- Photo upload flow ---------------------------------------------------------
// POST /api/get-upload-url -> signed PUT URL + object name.
bool cloud_request_upload_url(const char *wake_reason, int64_t captured_at_ms,
                              char *url_out, size_t url_cap,
                              char *object_out, size_t object_cap);

// PUT a stored JPEG file to the signed URL (streamed; photos never need to
// fit in RAM twice). Returns true on HTTP 200.
bool cloud_upload_file(const char *signed_url, const char *path);

// POST /api/capture-complete -- backend clears the command + records the
// capture (analysis then kicks off server-side immediately).
bool cloud_capture_complete(const char *object_name);

// --- Time ------------------------------------------------------------------------
// One SNTP sync attempt (bounded). Returns epoch seconds, or 0 on timeout.
int64_t cloud_epoch_seconds(uint32_t timeout_ms);

// Battery percent. TODO(bring-up): wire the T-Halow-P4 battery sense circuit
// once identified; stubbed to 100 until then (same stance as early S3 builds).
int cloud_battery_percent(void);
