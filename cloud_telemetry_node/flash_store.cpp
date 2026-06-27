#include "flash_store.h"

// Folder for captures (LittleFS supports directories).
static const char *WILDCAM_DIR = "/wildcam";

// Conservative guess for an average JPEG until we've actually saved one. Real
// captures replace this with a running average, so picsRemaining() gets more
// accurate after the first photo. 250 KB ~ a high-quality full-res frame.
static const uint32_t DEFAULT_AVG_JPEG = 250000;

static bool g_fs_ok = false;
static uint32_t g_avg_jpeg = 0;   // running average of saved JPEG sizes (bytes)

bool flashInit() {
  if (g_fs_ok) return true;

  // begin(true) = format the partition if it can't be mounted. That only
  // happens on the very first boot after flashing the new partition table;
  // afterwards the stored photos persist across sleep / reset / OTA.
  if (!LittleFS.begin(true)) {
    Serial.println("[flash] LittleFS mount/format failed");
    return false;
  }
  if (!LittleFS.exists(WILDCAM_DIR)) LittleFS.mkdir(WILDCAM_DIR);
  g_fs_ok = true;

  size_t total = LittleFS.totalBytes();
  size_t freeB = total - LittleFS.usedBytes();
  Serial.printf("[flash] LittleFS OK: %u KB free of %u KB (room for ~%d photos)\n",
                (unsigned)(freeB / 1024), (unsigned)(total / 1024), picsRemaining());
  return true;
}

String flashSaveJpeg(const uint8_t *data, size_t len, long long tsMs, uint32_t seq) {
  if (!g_fs_ok) return "";

  char path[64];
  if (tsMs > 0) snprintf(path, sizeof(path), "%s/wildcam_%lld.jpg", WILDCAM_DIR, tsMs);
  else          snprintf(path, sizeof(path), "%s/wildcam_%lu.jpg", WILDCAM_DIR, (unsigned long)seq);

  File f = LittleFS.open(path, FILE_WRITE);
  if (!f) {
    Serial.printf("[flash] open %s for write failed\n", path);
    return "";
  }
  size_t written = f.write(data, len);
  f.close();
  if (written != len) {
    Serial.printf("[flash] short write %u/%u (disk full?) -> discarding\n",
                  (unsigned)written, (unsigned)len);
    LittleFS.remove(path);   // don't leave a truncated file behind
    return "";
  }

  // Update the running average photo size (simple exponential smoothing).
  g_avg_jpeg = g_avg_jpeg ? (g_avg_jpeg * 3 + (uint32_t)len) / 4 : (uint32_t)len;
  Serial.printf("[flash] saved %s (%u bytes)\n", path, (unsigned)len);
  return String(path);
}

File flashOpen(const String &path) {
  return LittleFS.open(path, FILE_READ);
}

bool flashDelete(const String &path) {
  bool ok = LittleFS.remove(path);
  Serial.printf("[flash] %s %s\n", ok ? "deleted" : "delete FAILED:", path.c_str());
  return ok;
}

int flashListPending(String out[], int maxN) {
  if (!g_fs_ok || maxN <= 0) return 0;

  File dir = LittleFS.open(WILDCAM_DIR);
  if (!dir || !dir.isDirectory()) return 0;

  int n = 0;
  for (File e = dir.openNextFile(); e && n < maxN; e = dir.openNextFile()) {
    if (!e.isDirectory()) {
      String name = e.name();   // some cores return the full path, some the basename
      out[n++] = name.startsWith("/") ? name : String(WILDCAM_DIR) + "/" + name;
    }
    e.close();
  }
  dir.close();

  // Oldest first. The names embed an epoch-ms or sequence number, so a plain
  // ascending string sort puts the earliest capture first (simple insertion
  // sort -- the list is tiny).
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++)
      if (out[j] < out[i]) { String t = out[i]; out[i] = out[j]; out[j] = t; }

  return n;
}

int picsRemaining() {
  if (!g_fs_ok) return 0;
  uint32_t avg = g_avg_jpeg ? g_avg_jpeg : DEFAULT_AVG_JPEG;
  size_t freeB = LittleFS.totalBytes() - LittleFS.usedBytes();
  return (int)(freeB / avg);
}
