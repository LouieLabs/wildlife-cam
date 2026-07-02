# HT-HC33 OTA Unit Test

**Bench sketch that exercises the pure-logic parts of the fleet firmware's
OTA path (`cloud_telemetry_node/ota_update.cpp` + JSON helpers in
`cloud_telemetry_node/cloud_backend.cpp`).**

## In plain words

The OTA code has two kinds of pieces:

1. **Pure logic** — checks like "is the battery high enough?", "is this .bin
   for my kind of board?", and "what does the cloud response actually say?".
   These don't need Wi-Fi or a real firmware image to run.
2. **Radio + flash** — download the .bin, verify its fingerprint, write it into
   the spare app slot, reboot. This *needs* a real cloud + a real board.

This sketch tests the **pure logic** on a bench board in ~30 seconds. It prints
`ALL PASS` if the safety gate and the JSON helpers behave the way the plan doc
says they should. When it fails, it prints which check failed and the source
line, so you can jump straight to the bug.

**The full download+flash path is NOT tested here.** For that, do a live bench
cycle: publish a build via `/api/firmware/publish`, wake a bench camera, watch
the serial log.

## How to run

1. Open `HT-HC33_OTA_Unit.ino` in the Arduino IDE.
2. Board: **Heltec ESP32 HaLow -> HT-HC33** (FQBN `heltec:esp_halow:HT-HC33`).
3. USB CDC On Boot: **Disabled** (default). Upload speed: **460 800**.
4. Upload. Open the Serial Monitor at 115 200 baud.
5. Press the RESET button on the board. You should see something like:

   ```
   === HT-HC33 OTA unit test ===
   BOARD_TYPE (local copy) = heltec-ht-hc33

   [test] otaShouldAttempt
     PASS  BoardTypeMismatch when target board != BOARD_TYPE
     PASS  BadWakeReason when wake == PIR
     ...

   === ALL PASS (30 checks) ===
   ```

## Sync rule — read before changing anything

This sketch **intentionally duplicates** the functions it tests from
`cloud_telemetry_node/`. Arduino IDE has no clean way to pull source files
from a sibling directory (the fleet firmware's `.cpp` includes `secrets.h`,
which is git-ignored and would break the bench compile).

If you change any of these in `cloud_telemetry_node/`, **copy the change into
this sketch** and re-run on a bench board:

| Production file & symbol | Local copy in sketch |
|---|---|
| `node_config.h` `BOARD_TYPE` | `BOARD_TYPE_LOCAL` #define |
| `ota_update.h` `OtaResult` enum | `OtaResult` enum block |
| `ota_update.h` `WakeReason` enum | `WakeReason` enum block |
| `ota_update.h` `OtaTarget` struct | `OtaTarget` struct block |
| `ota_update.cpp` `BATTERY_FLOOR_PCT` | `BATTERY_FLOOR_PCT` |
| `ota_update.cpp` `RSSI_FLOOR_DBM` | `RSSI_FLOOR_DBM` |
| `ota_update.cpp` `otaShouldAttempt()` | `otaShouldAttempt()` |
| `ota_update.cpp` `otaResultString()` | `otaResultString()` |
| `cloud_backend.cpp` `jsonStringField()` | `jsonStringField()` |
| `cloud_backend.cpp` `jsonIntField()` | `jsonIntField()` |
| `cloud_backend.cpp` `jsonSubObject()` | `jsonSubObject()` |

If the copies drift, this sketch is testing yesterday's code. The plan doc
(`docs/FLASH_STORAGE_OTA_PLAN.md`, Step 3) documents this as a known limitation
of Arduino-only firmware testing. Firmware devs bench-test manually anyway;
this test is a fast pre-check, not a regression gate.

## What isn't covered (and where it lives)

| Behavior | Where to test |
|---|---|
| Actual HTTPS download of a .bin | Live bench: publish + wake, watch serial |
| `Update.begin` / `writeStream` / `end` | Live bench (needs real flash write) |
| SHA256 mismatch abort | Live bench (poison a manifest deliberately) |
| `esp_ota_mark_app_valid_cancel_rollback` | Live bench (force PENDING_VERIFY, wake, check logs) |
| `[ota] mark_valid ok` log line | Live bench serial grep |
| RTDB `state.lastOta` write | `web/test/api/command-poll.test.ts` (server-side) |
| `/api/firmware/publish` route | `web/test/api/firmware-publish.test.ts` (server-side) |

## Related

- **Design doc:** `docs/FLASH_STORAGE_OTA_PLAN.md` — Step 3 has the full flow,
  the 21 locked design decisions, and the failure-mode table this test is
  asserting against.
- **Sibling bench tests:** `hardware-tests/HT-HC33_SDTest/` (SD probing pattern
  this sketch's harness style mirrors), `hardware-tests/HT-HC33_FlashTest/`
  (LittleFS bench cycle).
