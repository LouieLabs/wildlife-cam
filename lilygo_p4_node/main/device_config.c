#include "device_config.h"
#include "node_config.h"

#include <string.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"

static const char *TAG = "devcfg";

// Same namespace + keys as the HT-HC33 build so the dashboard's provisioning
// tool and docs stay board-agnostic.
#define NVS_NS       "wildcam"
#define K_TRIALS     "wifi_trials"
#define K_BAK_SSID   "wifi_bak_ssid"
#define K_BAK_PASS   "wifi_bak_pass"

device_config_t g_cfg;

static void get_str(nvs_handle_t h, const char *key, char *out, size_t cap) {
  size_t len = cap;
  if (nvs_get_str(h, key, out, &len) != ESP_OK) out[0] = '\0';
}

// copy with guaranteed NUL termination
static void scpy(char *dst, size_t cap, const char *src) {
  if (!src) { dst[0] = '\0'; return; }
  snprintf(dst, cap, "%s", src);
}

bool device_config_load(void) {
  memset(&g_cfg, 0, sizeof(g_cfg));

  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) {
    get_str(h, "halow_ssid",    g_cfg.halow_ssid,    sizeof(g_cfg.halow_ssid));
    get_str(h, "halow_psk",     g_cfg.halow_psk,     sizeof(g_cfg.halow_psk));
    get_str(h, "wifi_ssid",     g_cfg.wifi_ssid,     sizeof(g_cfg.wifi_ssid));
    get_str(h, "wifi_pass",     g_cfg.wifi_pass,     sizeof(g_cfg.wifi_pass));
    get_str(h, "net_mode",      g_cfg.net_mode,      sizeof(g_cfg.net_mode));
    get_str(h, "device_id",     g_cfg.device_id,     sizeof(g_cfg.device_id));
    get_str(h, "device_secret", g_cfg.device_secret, sizeof(g_cfg.device_secret));
    nvs_close(h);
  }

  // Dev/bench fallbacks -- production images compile these blank, so a field
  // board MUST be provisioned.
  if (!g_cfg.wifi_ssid[0])     scpy(g_cfg.wifi_ssid,     sizeof(g_cfg.wifi_ssid),     WIFI_SSID_FALLBACK);
  if (!g_cfg.wifi_pass[0])     scpy(g_cfg.wifi_pass,     sizeof(g_cfg.wifi_pass),     WIFI_PASS_FALLBACK);
  if (!g_cfg.device_id[0])     scpy(g_cfg.device_id,     sizeof(g_cfg.device_id),     DEVICE_ID_FALLBACK);
  if (!g_cfg.device_secret[0]) scpy(g_cfg.device_secret, sizeof(g_cfg.device_secret), DEVICE_SECRET_FALLBACK);

  if (!g_cfg.net_mode[0]) {
    if (g_cfg.wifi_ssid[0])       scpy(g_cfg.net_mode, sizeof(g_cfg.net_mode), "wifi");
    else if (g_cfg.halow_ssid[0]) scpy(g_cfg.net_mode, sizeof(g_cfg.net_mode), "halow");
  }

  bool has_net = g_cfg.wifi_ssid[0] || g_cfg.halow_ssid[0];
  g_cfg.provisioned = g_cfg.device_id[0] && g_cfg.device_secret[0] && has_net;
  return g_cfg.provisioned;
}

// Write one key and read it back -- the only reliable detector for a silently
// full/corrupt NVS partition (learned the hard way on the S3 build).
static bool put_verified(nvs_handle_t h, const char *key, const char *want) {
  if (!want || !want[0]) return true;   // blank = leave key as-is
  if (nvs_set_str(h, key, want) != ESP_OK) {
    ESP_LOGE(TAG, "%s write FAILED", key);
    return false;
  }
  char back[DC_STR_MAX] = {0};
  size_t len = sizeof(back);
  bool ok = nvs_get_str(h, key, back, &len) == ESP_OK && strcmp(back, want) == 0;
  ESP_LOGI(TAG, "%-14s %s", key, ok ? "OK" : "READBACK MISMATCH");
  return ok;
}

bool device_config_save(const device_config_t *c) {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
    ESP_LOGE(TAG, "nvs_open(rw) failed");
    return false;
  }
  bool ok = true;
  ok &= put_verified(h, "halow_ssid",    c->halow_ssid);
  ok &= put_verified(h, "halow_psk",     c->halow_psk);
  ok &= put_verified(h, "wifi_ssid",     c->wifi_ssid);
  ok &= put_verified(h, "wifi_pass",     c->wifi_pass);
  ok &= put_verified(h, "net_mode",      c->net_mode);
  ok &= put_verified(h, "device_id",     c->device_id);
  ok &= put_verified(h, "device_secret", c->device_secret);
  if (ok) ok = nvs_commit(h) == ESP_OK;
  nvs_close(h);
  if (!ok) ESP_LOGE(TAG, "save FAILED -- erase flash and re-provision");
  return ok;
}

// ---------------------------------------------------------------------------
// set_wifi trial (backup + countdown + auto-revert) -- port of the S3 logic.
// ---------------------------------------------------------------------------

bool apply_wifi_change(const char *ssid, const char *pass, const char *net_mode,
                       uint8_t trials) {
  if (!ssid || !ssid[0]) return false;   // never blank out WiFi over the air

  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
  char cur_ssid[DC_STR_MAX] = {0}, cur_pass[DC_STR_MAX] = {0};
  get_str(h, "wifi_ssid", cur_ssid, sizeof(cur_ssid));
  get_str(h, "wifi_pass", cur_pass, sizeof(cur_pass));
  // Direct writes (not device_config_save): the backup password may be ""
  // for an open network and must still be recorded.
  bool ok = nvs_set_str(h, K_BAK_SSID, cur_ssid) == ESP_OK &&
            nvs_set_str(h, K_BAK_PASS, cur_pass) == ESP_OK &&
            nvs_set_u8(h, K_TRIALS, trials) == ESP_OK &&
            nvs_commit(h) == ESP_OK;
  nvs_close(h);
  if (!ok) return false;
  ESP_LOGI(TAG, "[wifi-trial] backup '%s' held, trying '%s' for %u wake(s)",
           cur_ssid, ssid, (unsigned)trials);

  device_config_t c = {0};
  scpy(c.wifi_ssid, sizeof(c.wifi_ssid), ssid);
  scpy(c.wifi_pass, sizeof(c.wifi_pass), pass ? pass : "");
  scpy(c.net_mode,  sizeof(c.net_mode),  net_mode ? net_mode : "");
  return device_config_save(&c);
}

bool wifi_trial_active(void) {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
  uint8_t t = 0;
  nvs_get_u8(h, K_TRIALS, &t);
  nvs_close(h);
  return t > 0;
}

bool wifi_trial_resolve(bool connected_ok) {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
  uint8_t t = 0;
  nvs_get_u8(h, K_TRIALS, &t);
  if (t == 0) { nvs_close(h); return false; }   // no trial armed

  if (connected_ok) {
    nvs_erase_key(h, K_TRIALS);
    nvs_erase_key(h, K_BAK_SSID);
    nvs_erase_key(h, K_BAK_PASS);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "[wifi-trial] new network confirmed -> committed");
    return false;
  }

  if (t > 1) {
    nvs_set_u8(h, K_TRIALS, (uint8_t)(t - 1));
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGW(TAG, "[wifi-trial] no connect, %u wake(s) left before revert", (unsigned)(t - 1));
    return false;
  }

  // Trials exhausted -> restore the previous network.
  char bak_ssid[DC_STR_MAX] = {0}, bak_pass[DC_STR_MAX] = {0};
  get_str(h, K_BAK_SSID, bak_ssid, sizeof(bak_ssid));
  get_str(h, K_BAK_PASS, bak_pass, sizeof(bak_pass));
  nvs_erase_key(h, K_TRIALS);
  nvs_erase_key(h, K_BAK_SSID);
  nvs_erase_key(h, K_BAK_PASS);
  if (bak_ssid[0]) nvs_set_str(h, "wifi_ssid", bak_ssid);
  nvs_set_str(h, "wifi_pass", bak_pass);   // may be "" (open network)
  nvs_commit(h);
  nvs_close(h);
  ESP_LOGW(TAG, "[wifi-trial] new network unreachable -> reverted to '%s'", bak_ssid);
  return true;   // caller should reboot onto the restored creds
}

void wifi_trial_clear(void) {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
  uint8_t t = 0;
  nvs_get_u8(h, K_TRIALS, &t);
  if (t != 0) {
    nvs_erase_key(h, K_TRIALS);
    nvs_erase_key(h, K_BAK_SSID);
    nvs_erase_key(h, K_BAK_PASS);
    nvs_commit(h);
    ESP_LOGI(TAG, "[wifi-trial] cleared by explicit local save (no revert)");
  }
  nvs_close(h);
}

bool apply_id_change(const char *new_id) {
  if (!new_id || !new_id[0]) return false;
  device_config_t c = {0};
  scpy(c.device_id, sizeof(c.device_id), new_id);
  return device_config_save(&c);
}
