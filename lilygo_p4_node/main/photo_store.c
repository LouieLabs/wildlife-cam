#include "photo_store.h"
#include "node_config.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#include "esp_log.h"
#include "esp_littlefs.h"

static const char *TAG = "photos";
#define MOUNT_POINT "/lfs"
#define WILDCAM_DIR MOUNT_POINT "/wildcam"

// Conservative until the first real save updates the running average.
#define DEFAULT_AVG_JPEG 250000

static bool s_ok = false;
static uint32_t s_avg_jpeg = 0;

bool photo_store_init(void) {
  if (s_ok) return true;
  esp_vfs_littlefs_conf_t conf = {
    .base_path = MOUNT_POINT,
    .partition_label = "storage",
    .format_if_mount_failed = true,   // first boot after flashing formats
    .dont_mount = false,
  };
  if (esp_vfs_littlefs_register(&conf) != ESP_OK) {
    ESP_LOGE(TAG, "LittleFS mount/format failed");
    return false;
  }
  mkdir(WILDCAM_DIR, 0775);   // EEXIST is fine
  s_ok = true;

  size_t total = 0, used = 0;
  esp_littlefs_info("storage", &total, &used);
  ESP_LOGI(TAG, "LittleFS OK: %u KB free of %u KB (~%d photos)",
           (unsigned)((total - used) / 1024), (unsigned)(total / 1024),
           photo_store_remaining());
  return true;
}

bool photo_store_save(const uint8_t *data, size_t len, int64_t ts_ms,
                      uint32_t seq, const char *reason,
                      char *out, size_t cap) {
  if (!s_ok) return false;
  const char *r = (reason && reason[0]) ? reason : "UNKNOWN";

  char path[PHOTO_PATH_MAX];
  if (ts_ms > 0) snprintf(path, sizeof(path), WILDCAM_DIR "/%s_%lld.jpg", r, (long long)ts_ms);
  else           snprintf(path, sizeof(path), WILDCAM_DIR "/%s_seq%lu.jpg", r, (unsigned long)seq);

  FILE *f = fopen(path, "wb");
  if (!f) { ESP_LOGE(TAG, "open %s failed", path); return false; }
  size_t written = fwrite(data, 1, len, f);
  fclose(f);
  if (written != len) {
    ESP_LOGE(TAG, "short write %u/%u (disk full?) -> discarding", (unsigned)written, (unsigned)len);
    unlink(path);   // never leave a truncated JPEG behind
    return false;
  }

  s_avg_jpeg = s_avg_jpeg ? (s_avg_jpeg * 3 + (uint32_t)len) / 4 : (uint32_t)len;
  ESP_LOGI(TAG, "saved %s (%u bytes)", path, (unsigned)len);
  if (out && cap) snprintf(out, cap, "%s", path);
  return true;
}

static int cmp_paths(const void *a, const void *b) {
  return strcmp((const char *)a, (const char *)b);
}

int photo_store_list(char paths[][PHOTO_PATH_MAX], int max_n) {
  if (!s_ok || max_n <= 0) return 0;
  DIR *dir = opendir(WILDCAM_DIR);
  if (!dir) return 0;

  int n = 0;
  struct dirent *e;
  while ((e = readdir(dir)) != NULL && n < max_n) {
    if (e->d_type == DT_DIR) continue;
    // A dirent name can be up to 255 bytes; PHOTO_PATH_MAX can't hold
    // dir+name in the worst case. Our own names are short, so a name that
    // WOULD truncate is foreign junk -- skip it rather than build a path
    // that silently points at the wrong (or no) file and desyncs
    // upload/delete. snprintf returns the length it WANTED to write.
    int want = snprintf(paths[n], PHOTO_PATH_MAX, "%s/%s", WILDCAM_DIR, e->d_name);
    if (want < 0 || want >= PHOTO_PATH_MAX) {
      ESP_LOGW(TAG, "skipping over-long filename: %.40s...", e->d_name);
      continue;
    }
    n++;
  }
  closedir(dir);
  // Names embed epoch-ms / sequence numbers, so a plain sort = oldest first.
  qsort(paths, n, PHOTO_PATH_MAX, cmp_paths);
  return n;
}

void photo_store_parse(const char *path, char *reason_out, size_t reason_cap,
                       int64_t *ts_ms_out) {
  snprintf(reason_out, reason_cap, "UNKNOWN");
  *ts_ms_out = 0;

  const char *base = strrchr(path, '/');
  base = base ? base + 1 : path;

  const char *us = strchr(base, '_');
  if (!us) return;
  size_t rlen = (size_t)(us - base);
  if (rlen >= reason_cap) rlen = reason_cap - 1;
  memcpy(reason_out, base, rlen);
  reason_out[rlen] = '\0';

  const char *rest = us + 1;   // "<epochMs>.jpg" or "seq<N>.jpg"
  if (strncmp(rest, "seq", 3) != 0) *ts_ms_out = atoll(rest);
}

bool photo_store_delete(const char *path) {
  bool ok = unlink(path) == 0;
  ESP_LOGI(TAG, "%s %s", ok ? "deleted" : "delete FAILED:", path);
  return ok;
}

int photo_store_remaining(void) {
  if (!s_ok) return 0;
  size_t total = 0, used = 0;
  if (esp_littlefs_info("storage", &total, &used) != ESP_OK) return 0;
  uint32_t avg = s_avg_jpeg ? s_avg_jpeg : DEFAULT_AVG_JPEG;
  return (int)((total - used) / avg);
}
