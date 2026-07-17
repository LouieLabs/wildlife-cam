#include "cloud_backend.h"
#include "node_config.h"
#include "device_config.h"
#include "version.h"

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_netif_sntp.h"
#include "cJSON.h"

static const char *TAG = "cloud";

// Shared response buffer for the small JSON replies we exchange (signed URLs
// are the longest at ~1.5 KB; 4 KB gives headroom).
#define RESP_MAX 4096

typedef struct {
  char buf[RESP_MAX];
  int len;
} resp_buf_t;

static esp_err_t http_event_cb(esp_http_client_event_t *evt) {
  if (evt->event_id == HTTP_EVENT_ON_DATA && evt->user_data) {
    resp_buf_t *r = (resp_buf_t *)evt->user_data;
    int space = RESP_MAX - 1 - r->len;
    int n = evt->data_len < space ? evt->data_len : space;
    if (n > 0) {
      memcpy(r->buf + r->len, evt->data, n);
      r->len += n;
      r->buf[r->len] = '\0';
    }
  }
  return ESP_OK;
}

// One POST/PUT with a JSON body + optional device-secret header. Returns the
// HTTP status (or <0 on transport error); response body lands in resp.
static int http_json(const char *url, esp_http_client_method_t method,
                     const char *body, bool device_auth, resp_buf_t *resp) {
  resp->len = 0;
  resp->buf[0] = '\0';
  esp_http_client_config_t cfg = {
    .url = url,
    .method = method,
    .event_handler = http_event_cb,
    .user_data = resp,
    .crt_bundle_attach = esp_crt_bundle_attach,   // proper TLS (no setInsecure)
    .timeout_ms = 15000,
  };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (!c) return -1;
  esp_http_client_set_header(c, "Content-Type", "application/json");
  if (device_auth) esp_http_client_set_header(c, "x-device-secret", g_cfg.device_secret);
  if (body) esp_http_client_set_post_field(c, body, strlen(body));

  esp_err_t err = esp_http_client_perform(c);
  int status = err == ESP_OK ? esp_http_client_get_status_code(c) : -1;
  esp_http_client_cleanup(c);
  if (err != ESP_OK) ESP_LOGW(TAG, "%s -> %s", url, esp_err_to_name(err));
  return status;
}

// --- Status -------------------------------------------------------------------

bool cloud_report_status(const status_report_t *r) {
  char url[256];
  snprintf(url, sizeof(url), "https://" RTDB_HOST "/devices/%s/state.json", g_cfg.device_id);

  char body[512];
  snprintf(body, sizeof(body),
           "{\"status\":\"%s\",\"battery\":%d,\"secret\":\"%s\","
           "\"firmwareVersion\":\"%s\",\"boardType\":\"" BOARD_TYPE "\","
           "\"updatedAt\":%lld}",
           r->status, r->battery_pct, g_cfg.device_secret,
           fw_version_str(), (long long)r->updated_at_ms);

  resp_buf_t resp;
  int code = http_json(url, HTTP_METHOD_PUT, body, false, &resp);
  if (code != 200) ESP_LOGW(TAG, "report HTTP %d: %.120s", code, resp.buf);
  return code == 200;
}

// --- Commands -------------------------------------------------------------------

static void copy_json_str(const cJSON *obj, const char *key, char *dst, size_t cap) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (cJSON_IsString(v) && v->valuestring) snprintf(dst, cap, "%s", v->valuestring);
  else dst[0] = '\0';
}

bool cloud_get_command(command_t *out) {
  memset(out, 0, sizeof(*out));
  snprintf(out->verb, sizeof(out->verb), "idle");

  char body[128];
  snprintf(body, sizeof(body), "{\"deviceId\":\"%s\"}", g_cfg.device_id);
  resp_buf_t resp;
  int code = http_json(BACKEND_BASE_URL "/api/command-poll", HTTP_METHOD_POST, body, true, &resp);
  if (code != 200) {
    ESP_LOGW(TAG, "command-poll HTTP %d", code);
    return false;
  }

  cJSON *root = cJSON_Parse(resp.buf);
  if (!root) return false;

  copy_json_str(root, "command", out->verb, sizeof(out->verb));
  if (!out->verb[0]) snprintf(out->verb, sizeof(out->verb), "idle");

  const cJSON *wifi = cJSON_GetObjectItemCaseSensitive(root, "wifi");
  if (cJSON_IsObject(wifi)) {
    copy_json_str(wifi, "ssid",    out->wifi_ssid,     sizeof(out->wifi_ssid));
    copy_json_str(wifi, "pass",    out->wifi_pass,     sizeof(out->wifi_pass));
    copy_json_str(wifi, "netMode", out->wifi_net_mode, sizeof(out->wifi_net_mode));
    out->has_wifi = out->wifi_ssid[0] != '\0';   // pass may be "" (open network)
  }
  const cJSON *rename = cJSON_GetObjectItemCaseSensitive(root, "rename");
  if (cJSON_IsObject(rename)) {
    copy_json_str(rename, "newId", out->rename_new_id, sizeof(out->rename_new_id));
    out->has_rename = out->rename_new_id[0] != '\0';
  }
  const cJSON *settings = cJSON_GetObjectItemCaseSensitive(root, "settings");
  if (cJSON_IsObject(settings)) {
    const cJSON *v;
    v = cJSON_GetObjectItemCaseSensitive(settings, "burstMs");
    if (cJSON_IsNumber(v)) out->burst_ms = (uint32_t)v->valuedouble;
    v = cJSON_GetObjectItemCaseSensitive(settings, "burstMaxShots");
    if (cJSON_IsNumber(v)) out->burst_max_shots = (uint32_t)v->valuedouble;
  }
  out->has_ota = cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(root, "ota"));

  cJSON_Delete(root);
  return true;
}

bool cloud_ack_command(void) {
  char body[128];
  snprintf(body, sizeof(body), "{\"deviceId\":\"%s\"}", g_cfg.device_id);
  resp_buf_t resp;
  int code = http_json(BACKEND_BASE_URL "/api/command-ack", HTTP_METHOD_POST, body, true, &resp);
  if (code != 200) ESP_LOGW(TAG, "command-ack HTTP %d", code);
  return code == 200;
}

// --- Photo upload ----------------------------------------------------------------

bool cloud_request_upload_url(const char *wake_reason, int64_t captured_at_ms,
                              char *url_out, size_t url_cap,
                              char *object_out, size_t object_cap) {
  url_out[0] = object_out[0] = '\0';
  char body[256];
  snprintf(body, sizeof(body),
           "{\"deviceId\":\"%s\",\"wakeReason\":\"%s\",\"capturedAt\":%lld}",
           g_cfg.device_id, (wake_reason && wake_reason[0]) ? wake_reason : "UNKNOWN",
           (long long)captured_at_ms);

  resp_buf_t resp;
  int code = http_json(BACKEND_BASE_URL "/api/get-upload-url", HTTP_METHOD_POST, body, true, &resp);
  if (code != 200) {
    ESP_LOGW(TAG, "get-upload-url HTTP %d", code);
    return false;
  }
  cJSON *root = cJSON_Parse(resp.buf);
  if (!root) return false;
  copy_json_str(root, "uploadUrl", url_out, url_cap);
  copy_json_str(root, "objectName", object_out, object_cap);
  cJSON_Delete(root);
  return url_out[0] != '\0';
}

bool cloud_upload_file(const char *signed_url, const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return false;
  FILE *f = fopen(path, "rb");
  if (!f) return false;

  esp_http_client_config_t cfg = {
    .url = signed_url,
    .method = HTTP_METHOD_PUT,
    .crt_bundle_attach = esp_crt_bundle_attach,
    .timeout_ms = 30000,
  };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (!c) { fclose(f); return false; }
  // Content-Type MUST match what the URL was signed with.
  esp_http_client_set_header(c, "Content-Type", "image/jpeg");

  bool ok = false;
  if (esp_http_client_open(c, st.st_size) == ESP_OK) {
    char chunk[2048];
    size_t n;
    while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) {
      if (esp_http_client_write(c, chunk, n) < 0) break;
    }
    esp_http_client_fetch_headers(c);
    int code = esp_http_client_get_status_code(c);
    ok = code == 200;
    if (!ok) ESP_LOGW(TAG, "upload PUT HTTP %d", code);
  }
  esp_http_client_close(c);
  esp_http_client_cleanup(c);
  fclose(f);
  return ok;
}

bool cloud_capture_complete(const char *object_name) {
  char body[256];
  snprintf(body, sizeof(body), "{\"deviceId\":\"%s\",\"objectPath\":\"%s\"}",
           g_cfg.device_id, object_name);
  resp_buf_t resp;
  int code = http_json(BACKEND_BASE_URL "/api/capture-complete", HTTP_METHOD_POST, body, true, &resp);
  if (code != 200) ESP_LOGW(TAG, "capture-complete HTTP %d", code);
  return code == 200;
}

// --- Time / battery ------------------------------------------------------------------

int64_t cloud_epoch_seconds(uint32_t timeout_ms) {
  esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  cfg.start = true;
  esp_netif_sntp_init(&cfg);
  int64_t epoch = 0;
  if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(timeout_ms)) == ESP_OK) {
    epoch = (int64_t)time(NULL);
  } else {
    ESP_LOGW(TAG, "SNTP sync timed out (reporting without wall-clock)");
  }
  esp_netif_sntp_deinit();
  return epoch;
}

int cloud_battery_percent(void) {
  // TODO(bring-up): T-Halow-P4 battery sense circuit unknown -- stubbed.
  return 100;
}
