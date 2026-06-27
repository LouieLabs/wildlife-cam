// ===========================================================================
// HT-HC33 internal-flash (LittleFS) test  --  verifies the OTA-ready partition
// ---------------------------------------------------------------------------
// Network-free check of the 16 MB partition layout from
// firmware/heltec-core-overrides/. It mounts LittleFS, prints the partition
// size (should be ~11.5 MB usable), writes + reads back + verifies a 256 KB
// file, then deletes it. No Wi-Fi, camera, or cloud needed.
//
// Board "Heltec ESP32 HaLow" -> HT-HC33  (FQBN heltec:esp_halow:HT-HC33)
// Serial Monitor @ 115200.
// ===========================================================================
#include <FS.h>
#include <LittleFS.h>

static void report(const char *tag) {
  size_t total = LittleFS.totalBytes();
  size_t used  = LittleFS.usedBytes();
  Serial.printf("[flash %-6s] total=%.2f MB  used=%u B  free=%.2f MB\n",
                tag, total / 1048576.0, (unsigned)used,
                (total - used) / 1048576.0);
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=== HT-HC33 LittleFS / partition test ===");

  if (!LittleFS.begin(true)) {        // format on first boot after new table
    Serial.println("[flash] MOUNT FAILED");
    return;
  }
  Serial.println("[flash] mounted OK");
  report("mount");

  // Write a 256 KB file in 1 KB chunks (a known byte pattern).
  const size_t N = 256 * 1024;
  Serial.printf("[test] writing %u bytes to /flashtest.bin ...\n", (unsigned)N);
  File f = LittleFS.open("/flashtest.bin", FILE_WRITE);
  if (!f) { Serial.println("[test] open-for-write FAILED"); return; }
  uint8_t buf[1024];
  for (int i = 0; i < 1024; i++) buf[i] = (uint8_t)i;
  size_t wrote = 0;
  for (size_t k = 0; k < N; k += 1024) wrote += f.write(buf, 1024);
  f.close();
  Serial.printf("[test] wrote %u bytes\n", (unsigned)wrote);
  report("wrote");

  // Read it back and verify every byte matches the pattern.
  f = LittleFS.open("/flashtest.bin", FILE_READ);
  Serial.printf("[test] file size on disk = %u bytes\n", (unsigned)f.size());
  bool ok = true;
  size_t readTotal = 0;
  uint8_t rb[1024];
  while (f.available() && ok) {
    size_t got = f.read(rb, 1024);
    readTotal += got;
    for (size_t i = 0; i < got; i++) if (rb[i] != (uint8_t)i) { ok = false; break; }
  }
  f.close();
  Serial.printf("[test] read %u bytes, integrity %s\n",
                (unsigned)readTotal, ok ? "PASS ✓" : "FAIL ✗");

  LittleFS.remove("/flashtest.bin");
  Serial.println("[test] deleted test file");
  report("after");
  Serial.println("=== done. size report repeats every 3 s ===");
}

void loop() {
  delay(3000);
  report("idle");
}
