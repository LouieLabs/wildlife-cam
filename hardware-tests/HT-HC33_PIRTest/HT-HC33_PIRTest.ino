/*
 * HT-HC33 PIR sensor — DEBUG / wiring test
 * ----------------------------------------
 * In plain words: this sketch does ONE thing — it watches the motion sensor
 * and prints to the Serial Monitor whether it sees motion or not. No camera,
 * no WiFi, no sleep. Use it to prove your sensor is wired correctly before
 * wiring it into the real (camera) firmware.
 *
 * WIRING (Heltec HT-HC33):
 *   PIR  OUT  -> GPIO1     (the signal wire; this is the "pin 1" you mentioned)
 *   PIR  GND  -> GND
 *   PIR  VCC  -> 5V if it's an HC-SR501 (the big white-dome one),
 *               or 3V3 if it's a tiny AM312. The OUT signal is 3.3V either way,
 *               which is safe for GPIO1.
 *
 * HOW TO RUN:
 *   1. Arduino IDE board: "HT-HC33"  (core: heltec:esp_halow)
 *      Leave "USB CDC On Boot" DISABLED (serial goes through the CP2102 chip).
 *   2. Upload, then open Serial Monitor at 115200 baud.
 *   3. A classic HC-SR501 needs ~30-60s to "warm up" after power-on and may
 *      report false motion at first. That's normal — wait a minute.
 *   4. Wave your hand. You should see "MOTION DETECTED". Stay still and it
 *      should settle back to "no motion".
 *
 *   arduino-cli compile --fqbn heltec:esp_halow:HT-HC33 .
 */

#define PIR_PIN 1            // GPIO1 — PIR signal (OUT) wire
#define HEARTBEAT_MS 2000    // how often to print the level even when nothing changes

int  lastState   = -1;       // -1 = unknown, so the very first reading always prints
unsigned long lastHeartbeat = 0;

void setup() {
  Serial.begin(115200);
  delay(300);                // give the USB-serial bridge a moment

  pinMode(PIR_PIN, INPUT);   // the PIR drives the line high/low itself

  Serial.println();
  Serial.println(F("=== HT-HC33 PIR debug test ==="));
  Serial.print  (F("Watching GPIO"));
  Serial.println(PIR_PIN);
  Serial.println(F("HIGH = motion seen, LOW = no motion."));
  Serial.println(F("(HC-SR501 needs ~30-60s to warm up after power-on.)"));
  Serial.println();
}

void loop() {
  int state = digitalRead(PIR_PIN);

  // Print immediately whenever the sensor changes (motion starts / stops).
  if (state != lastState) {
    if (state == HIGH) {
      Serial.println(F(">>> MOTION DETECTED  (GPIO1 went HIGH)"));
    } else {
      Serial.println(F("... no motion       (GPIO1 went LOW)"));
    }
    lastState = state;
  }

  // Also print a steady heartbeat so you can tell the sketch is alive and see
  // the resting level even when nothing is moving.
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    Serial.print(F("[heartbeat] GPIO1 = "));
    Serial.println(state == HIGH ? F("HIGH (motion)") : F("LOW (still)"));
    lastHeartbeat = millis();
  }

  delay(20);   // light debounce; PIR signals are slow, no need to poll faster
}
