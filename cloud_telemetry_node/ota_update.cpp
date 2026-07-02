#include "ota_update.h"
#include "node_config.h"    // BOARD_TYPE

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include "esp_ota_ops.h"

// ---------------------------------------------------------------------------
// Thresholds -- deliberately named as constants (not raw literals) so a
// reviewer skimming otaShouldAttempt() can see them at a glance and the
// bench test asserts on the same numbers.
// ---------------------------------------------------------------------------
static const int BATTERY_FLOOR_PCT = 40;   // 1.1 MB flash = several seconds of RF -- don't attempt on a dying cell
static const int RSSI_FLOOR_DBM    = -75;  // below this, Wi-Fi drops mid-flash are common
static const uint32_t STALL_GRACE_MS = 15000;  // let the first 15s buffer up before rate-checking

// Fallback budgets when the server payload omits them. Conservative for a
// worst-case 2.4 GHz link (slow AP, distant camera). HaLow multi-hop numbers
// arrive via the server payload (see TODOS.md item 2).
static const uint32_t DEFAULT_MIN_BPS   = 20000;   // 20 KB/s floor
static const uint32_t DEFAULT_MAX_SEC   = 120;     // 2 min ceiling

const char *otaResultString(OtaResult r) {
  switch (r) {
    case OtaResult::Ok:                 return "Ok";
    case OtaResult::DownloadFailed:     return "DownloadFailed";
    case OtaResult::NoSpace:            return "NoSpace";
    case OtaResult::WriteFailed:        return "WriteFailed";
    case OtaResult::ShaMismatch:        return "ShaMismatch";
    case OtaResult::Stalled:            return "Stalled";
    case OtaResult::Timeout:            return "Timeout";
    case OtaResult::BoardTypeMismatch:  return "BoardTypeMismatch";
    case OtaResult::LowBattery:         return "LowBattery";
    case OtaResult::LowRssi:            return "LowRssi";
    case OtaResult::BadWakeReason:      return "BadWakeReason";
  }
  return "Unknown";
}

// ---------------------------------------------------------------------------
// Safety gate. Every check here is a real failure mode we've seen or reasoned
// through in the plan review. Ordered by cost: cheapest / most-catastrophic
// first (BoardTypeMismatch = guaranteed brick, so refuse before anything else).
// ---------------------------------------------------------------------------
OtaResult otaShouldAttempt(const OtaTarget &t, WakeReason wr, int batteryPct) {
  // (1) Board type: an ESP32-S3 image on ESP32-P4 (or vice versa) is a brick.
  //     UI and backend also gate on this -- this is the last line of defense.
  if (t.boardType != BOARD_TYPE) {
    Serial.printf("[ota] refused: boardType '%s' != mine '%s'\n",
                  t.boardType.c_str(), BOARD_TYPE);
    return OtaResult::BoardTypeMismatch;
  }

  // (2) Wake reason: never race the motion path. The motion moment is already
  //     gone by the time we're online; if OTA takes the wake, the shot is
  //     lost and the next PIR event during OTA is missed. Timer/button/cold
  //     have nothing to lose.
  if (wr == WakeReason::Pir) {
    Serial.println("[ota] skipped: PIR wake (motion path has priority)");
    return OtaResult::BadWakeReason;
  }

  // (3) Battery: mid-flash power loss corrupts the inactive slot.
  if (batteryPct < BATTERY_FLOOR_PCT) {
    Serial.printf("[ota] skipped: battery %d%% < floor %d%%\n",
                  batteryPct, BATTERY_FLOOR_PCT);
    return OtaResult::LowBattery;
  }

  // (4) RSSI: a marginal link drops mid-flash and we lose the .bin. WiFi.RSSI()
  //     returns 0 when not connected -- treat that as "unknown, allow" since
  //     the download will fail fast anyway if the link is really down.
  int rssi = WiFi.RSSI();
  if (rssi != 0 && rssi < RSSI_FLOOR_DBM) {
    Serial.printf("[ota] skipped: RSSI %d dBm < floor %d dBm\n",
                  rssi, RSSI_FLOOR_DBM);
    return OtaResult::LowRssi;
  }

  return OtaResult::Ok;
}

// ---------------------------------------------------------------------------
// Download + verify + apply.
//
// Failure decision tree (matches Issue 11 in the plan doc):
//
//   HTTP GET builds/<board>/<sha>/firmware.bin
//    ├── ✗ 4xx/5xx / TLS error / DNS   → DownloadFailed
//    ├── ✗ Content-Length != sizeBytes → DownloadFailed
//    ├── ✓ Update.begin(sizeBytes)
//    │    ├── ✗ false → NoSpace
//    │    └── ✓ read + Update.write + sha256_update loop
//    │          ├── ✗ short write / stream broken → Update.abort → WriteFailed
//    │          ├── ✗ elapsed > maxSeconds       → Update.abort → Timeout
//    │          ├── ✗ throughput < minBytesPerSec → Update.abort → Stalled
//    │          └── ✓ all bytes written; final SHA256 == expected?
//    │                ├── ✗ no  → Update.abort → ShaMismatch
//    │                └── ✓ Update.end(true) → set_boot_partition → restart
//    │
// ---------------------------------------------------------------------------
OtaResult otaDownloadAndFlash(const OtaTarget &t) {
  Serial.printf("[ota] downloading %s (%u bytes, sha256 %s...)\n",
                t.url.c_str(), (unsigned)t.sizeBytes,
                t.sha256.substring(0, 12).c_str());

  const uint32_t maxSec = t.maxSeconds ? t.maxSeconds : DEFAULT_MAX_SEC;
  const uint32_t minBps = t.minBytesPerSec ? t.minBytesPerSec : DEFAULT_MIN_BPS;

  WiFiClientSecure client;
  client.setInsecure();   // no cert pinning for v1 -- SHA256 gates the flash
  HTTPClient http;
  http.setTimeout(maxSec * 1000UL);   // socket-level ceiling, matches our budget

  if (!http.begin(client, t.url)) {
    Serial.println("[ota] http.begin failed");
    return OtaResult::DownloadFailed;
  }

  int code = http.GET();
  if (code != 200) {
    Serial.printf("[ota] GET HTTP %d\n", code);
    http.end();
    return OtaResult::DownloadFailed;
  }

  int contentLen = http.getSize();
  if (contentLen < 0 || (size_t)contentLen != t.sizeBytes) {
    Serial.printf("[ota] size mismatch: Content-Length=%d otaTarget=%u\n",
                  contentLen, (unsigned)t.sizeBytes);
    http.end();
    return OtaResult::DownloadFailed;
  }

  if (!Update.begin(t.sizeBytes)) {
    Serial.printf("[ota] Update.begin(%u) refused (partition full?)\n",
                  (unsigned)t.sizeBytes);
    http.end();
    return OtaResult::NoSpace;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0 /* isSha224 = false */);

  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t written = 0;
  const uint32_t startMs = millis();

  while (written < t.sizeBytes) {
    uint32_t elapsedMs = millis() - startMs;

    if (elapsedMs > maxSec * 1000UL) {
      Serial.printf("[ota] timeout: elapsed %us > max %us (wrote %u of %u)\n",
                    (unsigned)(elapsedMs / 1000), (unsigned)maxSec,
                    (unsigned)written, (unsigned)t.sizeBytes);
      Update.abort();
      mbedtls_sha256_free(&sha);
      http.end();
      return OtaResult::Timeout;
    }

    if (elapsedMs > STALL_GRACE_MS && written > 0) {
      uint32_t bytesPerSec = (uint32_t)((uint64_t)written * 1000UL / elapsedMs);
      if (bytesPerSec < minBps) {
        Serial.printf("[ota] stalled: %u B/s < floor %u B/s (wrote %u of %u)\n",
                      (unsigned)bytesPerSec, (unsigned)minBps,
                      (unsigned)written, (unsigned)t.sizeBytes);
        Update.abort();
        mbedtls_sha256_free(&sha);
        http.end();
        return OtaResult::Stalled;
      }
    }

    // Give the TCP stack a moment when nothing is ready. We don't tight-loop
    // on read -- the wall-clock ceiling handles the "never arrives" case.
    if (!stream->available()) {
      if (!http.connected()) {
        Serial.printf("[ota] stream disconnected at %u bytes\n", (unsigned)written);
        Update.abort();
        mbedtls_sha256_free(&sha);
        http.end();
        return OtaResult::WriteFailed;
      }
      delay(10);
      continue;
    }

    size_t toRead = sizeof(buf);
    if (t.sizeBytes - written < toRead) toRead = t.sizeBytes - written;
    int n = stream->readBytes(buf, toRead);
    if (n <= 0) { delay(10); continue; }

    size_t w = Update.write(buf, n);
    if (w != (size_t)n) {
      Serial.printf("[ota] Update.write short: %u of %d\n", (unsigned)w, n);
      Update.abort();
      mbedtls_sha256_free(&sha);
      http.end();
      return OtaResult::WriteFailed;
    }
    mbedtls_sha256_update(&sha, buf, n);
    written += n;
  }

  http.end();

  // SHA256 verify. Comparing lowercase hex against the payload's expected value.
  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);

  char digestHex[65];
  for (int i = 0; i < 32; i++) sprintf(digestHex + i * 2, "%02x", digest[i]);
  digestHex[64] = '\0';

  if (t.sha256.length() != 64 ||
      strncasecmp(digestHex, t.sha256.c_str(), 64) != 0) {
    Serial.printf("[ota] SHA256 mismatch\n"
                  "         got %s\n"
                  "    expected %s\n",
                  digestHex, t.sha256.c_str());
    Update.abort();
    return OtaResult::ShaMismatch;
  }

  if (!Update.end(true /* evenIfRemaining */)) {
    Serial.printf("[ota] Update.end failed: err=%u\n", Update.getError());
    return OtaResult::WriteFailed;
  }

  Serial.printf("[ota] flash + verify OK -> rebooting into new slot (%u bytes)\n",
                (unsigned)written);
  Serial.flush();
  delay(200);       // let the log line make it through the CP2102
  ESP.restart();    // <-- never returns; new firmware runs setup() from scratch
  return OtaResult::Ok;  // unreachable
}

// ---------------------------------------------------------------------------
// Called after every successful reportStatus() to clear the rollback trigger
// on a freshly-flashed image. Silent no-op on a normal boot.
// ---------------------------------------------------------------------------
void otaMarkValidIfPending(bool reportStatusOk) {
  const esp_partition_t *running = esp_ota_get_running_partition();
  if (!running) return;

  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;

  if (state != ESP_OTA_IMG_PENDING_VERIFY) return;   // normal boot, nothing to do

  Serial.println("[ota] pending verify -- checking reportStatus");

  if (!reportStatusOk) {
    Serial.println("[ota] reportStatus not ok -- letting bootloader auto-revert on next reset");
    return;
  }

  esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
  if (err == ESP_OK) {
    Serial.println("[ota] mark_valid ok");
  } else {
    Serial.printf("[ota] mark_valid FAILED (err=%d)\n", (int)err);
  }
}
