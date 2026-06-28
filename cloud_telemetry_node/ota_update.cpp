#include "ota_update.h"
#include "node_config.h"

#include <Preferences.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include "esp_ota_ops.h"

OtaStateView g_ota = { false, 0, "running", "", "", false };

// NVS namespace + keys. Separate from "wildcam" so OTA bookkeeping can't
// collide with the provisioning config the browser-flash tool writes.
static const char *NS              = "wildcam_ota";
static const char *K_LAST_BOOTED   = "lb_ver";    // last version that reached "healthy"
static const char *K_LAST_ATTEMPT  = "la_ver";    // version we're trying right now (or got reverted from)
static const char *K_LAST_FAILED   = "lf_ver";    // loop-breaker: don't auto-retry this one
static const char *K_LAST_REASON   = "lr_rsn";    // rollback reason (set by manual revert; empty => bootloader)
static const char *K_FIRSTBOOT     = "fb_pend";   // first-boot capture/upload still owed
static const char *K_STRIKES       = "strikes";   // post-mark-valid strike counter
static const char *K_CYCLE_CLEAN   = "cyc_ok";    // set true at goToDeepSleep, false on entry

// ---------------------------------------------------------------------------
// Tiny helpers (kept local so this module is self-contained).
// ---------------------------------------------------------------------------

// Pull a string field out of a flat JSON response, like `{"version":"1.1.0"}`.
// Good enough for the manifest; avoids adding a JSON library.
static String jsonStringField(const String &json, const char *key) {
  String needle = String("\"") + key + "\":\"";
  int i = json.indexOf(needle);
  if (i < 0) return "";
  i += needle.length();
  int j = json.indexOf('"', i);
  if (j < 0) return "";
  return json.substring(i, j);
}

// Compare "1.10.0" > "1.9.0" the right way (numeric, per part). Returns
// negative if a<b, zero if equal, positive if a>b. Missing parts read as 0.
static int semverCompare(const String &a, const String &b) {
  int ai = 0, bi = 0;
  for (int part = 0; part < 3; part++) {
    int av = 0, bv = 0;
    while (ai < (int)a.length() && isDigit(a[ai])) { av = av * 10 + (a[ai] - '0'); ai++; }
    if (ai < (int)a.length() && a[ai] == '.') ai++;
    while (bi < (int)b.length() && isDigit(b[bi])) { bv = bv * 10 + (b[bi] - '0'); bi++; }
    if (bi < (int)b.length() && b[bi] == '.') bi++;
    if (av != bv) return av - bv;
  }
  return 0;
}

// Resolve the "app" field in the manifest (e.g. "app.bin" or "/firmware/app.bin"
// or a full URL) against the manifest's own URL.
static String resolveAppUrl(const String &appPath) {
  if (appPath.startsWith("http")) return appPath;
  if (appPath.startsWith("/"))    return String(BACKEND_BASE_URL) + appPath;
  // Relative -> relative to the manifest's directory.
  String dir = OTA_VERSION_PATH;
  int slash = dir.lastIndexOf('/');
  if (slash >= 0) dir = dir.substring(0, slash + 1);
  return String(BACKEND_BASE_URL) + dir + appPath;
}

// ---------------------------------------------------------------------------
// Boot classification.
// ---------------------------------------------------------------------------

void otaBootSync(bool coldBoot) {
  g_ota.stateLabel        = "running";
  g_ota.firstBootPending  = false;
  g_ota.strikes           = 0;
  g_ota.rollbackThisBoot  = false;

  // Non-cold wakes (timer/PIR/button) are mid-image: rollback bookkeeping
  // already happened on the cold boot we sleep-cycle off of. Just surface the
  // current pending/strike state for the cycle's reporting.
  if (!coldBoot) {
    Preferences p; p.begin(NS, true);
    g_ota.firstBootPending = p.getBool(K_FIRSTBOOT, false);
    g_ota.strikes          = p.getUChar(K_STRIKES, 0);
    p.end();
    if (g_ota.firstBootPending) g_ota.stateLabel = "pending_verify";
    return;
  }

  Preferences p; p.begin(NS, false);
  String  lastBooted  = p.getString(K_LAST_BOOTED, "");
  String  lastAttempt = p.getString(K_LAST_ATTEMPT, "");
  String  lastReason  = p.getString(K_LAST_REASON, "");
  uint8_t strikes     = p.getUChar(K_STRIKES, 0);
  bool    firstBoot   = p.getBool(K_FIRSTBOOT, false);
  bool    cycleClean  = p.getBool(K_CYCLE_CLEAN, true);

  const String running = String(FW_VERSION);

  // ---- Case A: rolled back. We attempted version X, but X isn't running --
  // either the bootloader reverted (PENDING_VERIFY → ABORTED) on the second
  // boot, or our 3-strike code manually swapped slots.
  if (lastAttempt.length() && lastAttempt != running) {
    g_ota.stateLabel          = "rolled_back";
    g_ota.rollbackFromVersion = lastAttempt;
    g_ota.rollbackReason      = lastReason.length() ? lastReason : "first-boot upload failed";
    g_ota.rollbackThisBoot    = true;
    p.putString(K_LAST_FAILED, lastAttempt);   // loop guard for next "update"
    p.remove(K_LAST_ATTEMPT);
    p.remove(K_LAST_REASON);
    p.remove(K_FIRSTBOOT);
    p.putString(K_LAST_BOOTED, running);
    p.putUChar(K_STRIKES, 0);
    p.putBool(K_CYCLE_CLEAN, false);
    p.end();
    Serial.printf("[ota] ROLLED BACK from v%s (reason: %s)\n",
                  g_ota.rollbackFromVersion.c_str(),
                  g_ota.rollbackReason.c_str());
    return;
  }

  // ---- Case B: new image we explicitly attempted just booted for the first
  // time. Mark "first-boot pending" so the sketch takes the labelled photo.
  if (lastAttempt.length() && lastAttempt == running) {
    g_ota.stateLabel       = "pending_verify";
    g_ota.firstBootPending = true;
    g_ota.strikes          = 0;
    p.putBool(K_FIRSTBOOT, true);
    p.putUChar(K_STRIKES, 0);
    p.putBool(K_CYCLE_CLEAN, false);
    p.end();
    Serial.printf("[ota] first boot of v%s -- pending verify\n", running.c_str());
    return;
  }

  // ---- Case C: continuation of the currently-good image.
  if (running == lastBooted) {
    g_ota.stateLabel       = "running";
    g_ota.firstBootPending = firstBoot;
    // A non-clean previous cycle on a validated image looks like a crash. Bump
    // the strike count; revert manually when we hit the limit.
    if (!cycleClean && !firstBoot) {
      strikes++;
      Serial.printf("[ota] previous cycle didn't finish cleanly -- strike %u/%u\n",
                    (unsigned)strikes, (unsigned)OTA_MAX_STRIKES);
      if (strikes >= OTA_MAX_STRIKES) {
        // Tell the OLD image (which is what's about to boot) what happened.
        p.putString(K_LAST_ATTEMPT, running);
        p.putString(K_LAST_REASON,  "3-strike health counter");
        p.putBool(K_CYCLE_CLEAN, true);
        p.end();
        Serial.println("[ota] strike limit reached -- reverting to previous slot");
        const esp_partition_t *other = esp_ota_get_next_update_partition(NULL);
        if (other) esp_ota_set_boot_partition(other);
        Serial.flush();
        delay(200);
        ESP.restart();
        return;
      }
      p.putUChar(K_STRIKES, strikes);
    }
    g_ota.strikes = strikes;
    p.putBool(K_CYCLE_CLEAN, false);
    p.end();
    return;
  }

  // ---- Case D: first-ever boot, or a USB re-flash with a different version.
  // Reset all OTA tracking and accept the running image as the baseline.
  Serial.printf("[ota] cold start on v%s (no prior boot record)\n", running.c_str());
  p.putString(K_LAST_BOOTED, running);
  p.remove(K_LAST_ATTEMPT);
  p.remove(K_LAST_REASON);
  p.remove(K_FIRSTBOOT);
  p.putUChar(K_STRIKES, 0);
  p.putBool(K_CYCLE_CLEAN, false);
  p.end();
}

// ---------------------------------------------------------------------------
// Healthy-milestone callbacks (mark-valid + strike reset).
// ---------------------------------------------------------------------------

void otaMarkHealthy() {
  Preferences p; p.begin(NS, false);
  bool wasFirstBoot = p.getBool(K_FIRSTBOOT, false);
  if (wasFirstBoot) {
    p.remove(K_FIRSTBOOT);
    p.remove(K_LAST_ATTEMPT);
    p.remove(K_LAST_REASON);
    p.putString(K_LAST_BOOTED, FW_VERSION);
    g_ota.firstBootPending = false;
    g_ota.stateLabel       = "running";
    // Tell the bootloader the new image is good (state -> VALID). Returns
    // ESP_OK on first call, harmlessly returns an error on subsequent calls.
    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    Serial.printf("[ota] image v%s VALID (mark_valid: %d)\n", FW_VERSION, (int)err);
  }
  if (p.getUChar(K_STRIKES, 0) != 0) p.putUChar(K_STRIKES, 0);
  g_ota.strikes = 0;
  p.end();
}

void otaMarkCycleClean() {
  Preferences p; p.begin(NS, false);
  p.putBool(K_CYCLE_CLEAN, true);
  p.end();
}

// ---------------------------------------------------------------------------
// "update" command: fetch manifest, decide, download, restart.
// ---------------------------------------------------------------------------

// HTTPS-or-HTTP GET helper, returns the body. Sets codeOut to the HTTP code,
// or -1 if the request itself couldn't be set up.
static String httpGet(const String &url, int &codeOut) {
  bool secure = url.startsWith("https:");
  WiFiClientSecure tls;
  WiFiClient plain;
  if (secure) tls.setInsecure();                 // skip cert check (testing); see README
  HTTPClient http;
  if (!http.begin(secure ? (WiFiClient &)tls : (WiFiClient &)plain, url)) {
    codeOut = -1;
    return "";
  }
  codeOut = http.GET();
  String body = (codeOut == 200) ? http.getString() : "";
  http.end();
  return body;
}

// Download the new app image into the inactive OTA slot. Returns true if the
// image is fully written and the boot partition has been switched (so the next
// reboot will boot it).
static bool downloadAppImage(const String &url) {
  bool secure = url.startsWith("https:");
  WiFiClientSecure tls;
  WiFiClient plain;
  if (secure) tls.setInsecure();
  HTTPClient http;
  if (!http.begin(secure ? (WiFiClient &)tls : (WiFiClient &)plain, url)) {
    Serial.println("[ota] http.begin failed for app.bin");
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[ota] app.bin HTTP %d\n", code);
    http.end();
    return false;
  }
  int total = http.getSize();
  if (total <= 0) {
    Serial.println("[ota] app.bin missing Content-Length -- aborting");
    http.end();
    return false;
  }
  if (!Update.begin(total)) {
    Serial.printf("[ota] Update.begin failed (need %d B, slot has %u B)\n",
                  total, (unsigned)ESP.getFreeSketchSpace());
    http.end();
    return false;
  }
  Serial.printf("[ota] writing %d bytes to inactive slot...\n", total);
  size_t written = Update.writeStream(http.getStream());
  if ((int)written != total) {
    Serial.printf("[ota] short write %u / %d -- aborting\n", (unsigned)written, total);
    Update.abort();
    http.end();
    return false;
  }
  if (!Update.end(true)) {
    Serial.printf("[ota] Update.end failed: %d\n", Update.getError());
    http.end();
    return false;
  }
  http.end();
  Serial.println("[ota] image written, boot slot switched");
  return true;
}

bool otaTryUpdate(int batteryPct) {
  if (batteryPct < OTA_BATTERY_MIN_PCT) {
    Serial.printf("[ota] battery %d%% < %d%% -- skipping update\n",
                  batteryPct, OTA_BATTERY_MIN_PCT);
    return false;
  }

  String versionUrl = String(BACKEND_BASE_URL) + OTA_VERSION_PATH;
  int code = 0;
  String body = httpGet(versionUrl, code);
  if (code != 200) {
    Serial.printf("[ota] manifest fetch HTTP %d\n", code);
    return false;
  }
  String serverVersion = jsonStringField(body, "version");
  String appPath       = jsonStringField(body, "app");
  if (!appPath.length()) appPath = OTA_APP_PATH_DEFAULT;
  if (!serverVersion.length()) {
    Serial.println("[ota] manifest has no version field");
    return false;
  }
  Serial.printf("[ota] server offers v%s (running v%s)\n",
                serverVersion.c_str(), FW_VERSION);

  if (semverCompare(serverVersion, FW_VERSION) <= 0) {
    Serial.println("[ota] running version is already current");
    return false;
  }

  // Loop guard: refuse to re-attempt a version we already rolled back from.
  // The admin must publish a fix (e.g. 1.1.1) or click Idle to clear the cmd.
  Preferences pRead; pRead.begin(NS, true);
  String lastFailed = pRead.getString(K_LAST_FAILED, "");
  pRead.end();
  if (lastFailed.length() && serverVersion == lastFailed) {
    Serial.printf("[ota] server v%s == lastFailed v%s -- skipping (publish a fix to retry)\n",
                  serverVersion.c_str(), lastFailed.c_str());
    return false;
  }

  String binUrl = resolveAppUrl(appPath);
  Serial.printf("[ota] downloading %s\n", binUrl.c_str());
  if (!downloadAppImage(binUrl)) return false;

  // Image is committed to the inactive slot. Record what we tried so the next
  // boot (whether it's the new image or a bootloader-rollback to the old one)
  // can classify itself correctly, then restart.
  Preferences p; p.begin(NS, false);
  p.putString(K_LAST_ATTEMPT, serverVersion);
  p.remove(K_LAST_REASON);            // only set on manual revert; bootloader path uses default text
  p.remove(K_FIRSTBOOT);              // re-set on the new boot
  p.putBool(K_CYCLE_CLEAN, true);     // this cycle is exiting intentionally
  p.end();
  Serial.printf("[ota] reboot into v%s in 1 s...\n", serverVersion.c_str());
  Serial.flush();
  delay(1000);
  ESP.restart();
  return true;  // never reached
}
