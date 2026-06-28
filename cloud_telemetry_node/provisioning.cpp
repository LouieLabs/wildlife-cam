#include "provisioning.h"
#include "device_config.h"
#include <WiFi.h>

// Idle timeout once provisioning has started: if no command arrives for this
// long, give up and continue normal boot (so a half-finished setup can't strand
// the node awake forever).
static const uint32_t PROV_IDLE_MS = 30000;

// Read one newline-terminated line from Serial, or "" if nothing arrives within
// timeoutMs. Trims a trailing '\r' so CRLF from a terminal is fine.
static String readSerialLine(uint32_t timeoutMs) {
  String line;
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\n') { line.trim(); return line; }
      line += c;
      start = millis();   // keep reading while bytes are flowing
    }
    delay(5);
  }
  line.trim();
  return line;
}

static String macString() {
  uint8_t m[6];
  WiFi.macAddress(m);
  char buf[18];
  snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
           m[0], m[1], m[2], m[3], m[4], m[5]);
  return String(buf);
}

bool provisioningListen(uint32_t detectMs) {
  Serial.printf("[prov] ready %lus -- MAC %s (send 'MAC?' / 'SET ...' / 'SAVE')\n",
                (unsigned long)(detectMs / 1000), macString().c_str());

  // Wait for the first command; bail to normal boot if none shows up.
  String line = readSerialLine(detectMs);
  if (line.length() == 0) return false;

  String ssid, pass, id, secret;   // stashed until SAVE
  while (true) {
    if (line.length()) {
      if (line == "MAC?") {
        Serial.printf("MAC %s\n", macString().c_str());
      } else if (line == "SAVE") {
        bool ok = saveDeviceConfig(ssid, pass, id, secret);
        Serial.println(ok ? "SAVED" : "ERR save");
        return ok;
      } else if (line == "EXIT") {
        Serial.println("OK exit");
        return false;
      } else if (line.startsWith("SET ")) {
        // "SET <key> <value...>" -- value is the remainder after the 2nd space.
        int k0 = 4;
        int k1 = line.indexOf(' ', k0);
        String key = (k1 < 0) ? line.substring(k0) : line.substring(k0, k1);
        String val = (k1 < 0) ? ""                 : line.substring(k1 + 1);
        if      (key == "ssid")   { ssid = val;   Serial.println("OK ssid"); }
        else if (key == "pass")   { pass = val;   Serial.println("OK pass"); }
        else if (key == "id")     { id = val;     Serial.println("OK id"); }
        else if (key == "secret") { secret = val; Serial.println("OK secret"); }
        else                      { Serial.println("ERR key"); }
      } else {
        Serial.println("ERR cmd");
      }
    }
    line = readSerialLine(PROV_IDLE_MS);
    if (line.length() == 0) {     // idle timeout -> abandon, continue boot
      Serial.println("[prov] idle timeout -> continuing boot");
      return false;
    }
  }
}
