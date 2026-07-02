# Flash Storage + OTA Plan (Heltec HT-HC33)

> **Status (updated 2026-07-01):** Steps 1 & 2 **SHIPPED** on `main`; Step 3
> (OTA update code) design locked by plan review — see the 2026-07-01 entry
> in the Decision Record for the 21 resolved questions. Supersedes the
> microSD storage approach.
> **Audience:** LouieLabs students + whoever (human or Claude) implements
> Step 3 next.

## In plain words

We stopped using microSD cards on the Heltec camera board — only 1 of our 4 cards
worked reliably, and the failures were the *cards*, not the format or the board.
Instead we'll store photos in the board's **own built-in flash memory** (the chip
that already holds the program), and we'll reserve room for **wireless firmware
updates (OTA)** from the very beginning. Photos survive sleep and power-loss, just
like the SD card promised — without the flaky cards.

There's **one rule that drives everything**: the flash has to be divided up (the
"partition table") *once*, correctly, before we store anything. Re-dividing it
later erases everything in flash — including photos already sitting on a camera out
in the field. That's why we reserve the OTA space up front even though we'll write
the OTA code last.

## Key facts (verified 2026-06-27)

| Thing | Value | Note |
|---|---|---|
| Flash chip size | **16 MB** | Confirmed by reading the chip (`esptool flash_id` → Device 4018). |
| Core's configured flash | **8 MB** (`default_8MB`) | The Heltec core under-uses the chip by half today. Step 1 fixes this. |
| Firmware size | **~1.11 MB** | `cloud_telemetry_node`, 31% of the current 3.5 MB app slot. |
| Board / build | FQBN `heltec:esp_halow:HT-HC33`, upload **460800** baud | 921600 corrupts. USB CDC On Boot = Disabled. |
| Core location | `/Users/alan/Documents/Arduino/hardware/heltec/esp_halow` | Manual install, **not** in `~/Library/Arduino15`. esptool at `<core>/tools/esptool/esptool`. |
| Monitoring | `hardware-tests/HT-HC33_SDTest/serial_monitor_noreset.py` | Avoids DTR/RTS resets that wedge the board. |

## The three steps (order matters)

### Step 1 — 16 MB OTA-ready partition table  *(✅ SHIPPED — see [`firmware/heltec-core-overrides/`](../firmware/heltec-core-overrides/))*
Switch the board to 16 MB and apply a layout with **two app slots** (for OTA) plus a
large LittleFS data area:

```
# name,    type, subtype,  offset,    size       # notes
nvs,       data, nvs,      0x9000,    0x5000      # 20 KB  settings
otadata,   data, ota,      0xe000,    0x2000      # 8 KB   which slot to boot
app0,      app,  ota_0,    0x10000,   0x200000    # 2 MB   firmware (fits 1.11 MB + growth)
app1,      app,  ota_1,    0x210000,  0x200000    # 2 MB   OTA spare slot
spiffs,    data, spiffs,   0x410000,  0xBE0000    # ~11.9 MB LittleFS photo store
coredump,  data, coredump, 0xFF0000,  0x10000     # 64 KB  crash logs
```
- **Result:** ~11.5 MB usable LittleFS ≈ **~46 full-3 MP to ~287 VGA photos**, persistent.
- **Keep the data partition labeled `spiffs`** so the default `LittleFS.begin()` finds it.
- **Resolved (2026-06-29):** the `boards.local.txt` + custom partition CSV
  approach worked. Files live in [`firmware/heltec-core-overrides/`](../firmware/heltec-core-overrides/);
  see that directory's README for install steps. Gotcha discovered along the
  way: the **variant**'s `partitions.csv` outranks `build.partitions`, so
  the override has to land in the right variant directory.
- **Verify:** compile shows app `Maximum is 2097152 bytes`; at runtime
  `LittleFS.totalBytes()` ≈ 11.5 MB.

### Step 2 — flash storage layer  *(✅ SHIPPED — see [`cloud_telemetry_node/flash_store.{h,cpp}`](../cloud_telemetry_node/))*
In `cloud_telemetry_node`, retire the SD logic in `sd_store.{h,cpp}` and add a modular
`flash_store.{h,cpp}` (separate files, per the team rule):
- **Flow:** capture → write `/img_<seq>.jpg` to LittleFS → upload via the existing
  signed-URL path (`cloud_backend`) → delete on success, keep on failure for retry.
- Add `picsRemaining()` = `(LittleFS.totalBytes() - LittleFS.usedBytes()) / runningAvgJpegBytes`.
- `#include <LittleFS.h>`, `LittleFS.begin(true)`. Wear is a non-issue at capture-and-clear volumes.

### Step 3 — OTA update code  *(⏳ OPEN — design locked 2026-07-01)*

**In plain words.** Today a bug fix means uncabling every camera and reflashing
it over USB. This step lets the dashboard push a new firmware build to a chosen
set of cameras. The dashboard picks *which build* and *which cameras*; each
camera downloads the new firmware into a spare partition, checks a fingerprint
so it knows the download wasn't corrupted, then reboots into the new build. If
something goes wrong the camera automatically falls back to the version it was
running before. Cameras that use a different chip (e.g. Lilygo P4) can never
accidentally get a Heltec build (or vice versa) — it would brick them.

#### Flow at a glance

```
  Dashboard (admin)                   Cloud                       Camera (on wake)
  ─────────────────                   ─────                       ────────────────
  pick build (SHA)                                                (asleep)
  pick target cameras   ─── POST ──▶  /api/firmware/publish
      (filtered by                    verifies board-type match
       state.boardType)                writes otaTarget + command   (asleep)
                                       to /devices/<id> in RTDB
                                                                    wake (timer)
                                                                    │
                                                                    ├─ reportStatus
                                                                    │  (writes fwVersion,
                                                                    │   boardType, lastOta)
                                                                    │
                                                                    ├─ otaMarkValidIfPending
                                                                    │  (only after a good
                                                                    │   reportStatus)
                                                                    │
                                                                    ├─ uploadPendingPhotos
                                                                    │
                                                                    └─ getCommand
                                                                         │
                                                                         "update_firmware"
                                                                         + ota{url, sha256,
                                                                              sizeBytes,
                                                                              version,
                                                                              boardType,
                                                                              expectedSeconds,
                                                                              minBytesPerSec,
                                                                              maxSeconds}
                                                                         │
                                                                         otaShouldAttempt?
                                                                         (battery ≥40%,
                                                                          RSSI ≥ -75dBm,
                                                                          board matches)
                                                                         │
                                                                         cameraDeinit
                                                                         │
                                                                    ┌────┴────────────┐
                                                                    ▼                 ▼
                                                             download+stream    (any failure:
                                                             SHA256 + Update.       Update.abort,
                                                             writeStream +          reportStatus
                                                             Update.setMD5)         lastOta=…,
                                                                    │               continue → sleep)
                                                                    ▼
                                                             SHA256 match?
                                                             ├─ no  → abort  ─────┐
                                                             └─ yes → Update.end  │
                                                                       │          │
                                                                       ▼          │
                                                             esp_ota_set_boot_    │
                                                             partition(inactive)  │
                                                                       │          │
                                                                       ▼          │
                                                                 ESP.restart      │
                                                                       │          │
                                                                       ▼          │
                                                             new firmware boots   │
                                                             (state: PENDING_     │
                                                              VERIFY)             │
                                                                       │          │
                                                                       ▼          │
                                                                 wifiConnect      │
                                                                 reportStatus ────┤
                                                                       │          │
                                                                       ▼          │
                                                                 otaMarkValid…    │
                                                                 (cancels the     │
                                                                  auto-rollback)  │
                                                                                  ▼
                                                                     bootloader auto-reverts
                                                                     to previous slot if the
                                                                     new firmware never marks
                                                                     itself valid
```

#### Files touched

| File | Change |
|---|---|
| `cloud_telemetry_node/node_config.h` | Add `BOARD_TYPE` compile-time constant (e.g. `"heltec-ht-hc33"`) |
| `cloud_telemetry_node/cloud_backend.{h,cpp}` | Add `StatusReport` struct, `Command` struct; extend `reportStatus()` and `getCommand()`; add `jsonIntField` + `jsonSubObject` helpers next to existing `jsonStringField` |
| `cloud_telemetry_node/ota_update.{h,cpp}` | **NEW** — `OtaResult` enum, `otaShouldAttempt()`, `otaDownloadAndFlash()`, `otaMarkValidIfPending()`, plus first-boot self-check log lines |
| `cloud_telemetry_node/cloud_telemetry_node.ino` | Wire `otaMarkValidIfPending` right after successful `reportStatus`; wire OTA dispatch after `uploadPendingPhotos` |
| `hardware-tests/HT-HC33_OTA_Unit/` | **NEW** — bench sketch exercising `otaShouldAttempt` + JSON helpers with PASS/FAIL prints |
| `web/app/api/command-poll/route.ts` | Include `ota` object in response when `/devices/<id>/otaTarget` present |
| `web/app/api/firmware/publish/route.ts` | **NEW** admin-only route: board-type match, build-exists HEAD check, server-computed SHA256, per-device atomic RTDB write |
| `web/app/dashboard/firmware/page.tsx` (or similar) | **NEW** page: build picker (filtered by boardType), camera picker (filtered by state.boardType), confirm-and-publish |
| Cloud Build config | New step: `arduino-cli compile` → drop `firmware.bin` under `web/public/firmware/builds/<boardType>/<sha>/` (staging) |
| RTDB rules | Explicit deny on `/devices/<id>/otaTarget` public write; state.{fwVersion,boardType,lastOta} device-secret-only |
| `web/test/api/firmware-publish.test.ts` | **NEW** — all 6 safety assertions |
| `web/test/api/command-poll.test.ts` | Extend for `ota` present/absent cases |
| `web/test/rules/` | Extend for new RTDB paths |

#### Locked design decisions (from 2026-07-01 plan review)

1. **Command-driven, not auto-poll.** Dashboard picks the build via the existing `getCommand()` bus. No on-device version-comparison logic.
2. **Rollback is real.** Partition table must have rollback enabled; firmware calls `esp_ota_mark_app_valid_cancel_rollback()` **only** after the first successful `reportStatus()` post-flash. Never at boot.
3. **On-device safety gate `otaShouldAttempt()`** — battery ≥ 40%, wake reason ∈ {timer, button}, RSSI ≥ -75 dBm, and `otaTarget.boardType == BOARD_TYPE`.
4. **Fires in step-3 dispatch, after `uploadPendingPhotos()`** — photos never lost.
5. **Content-addressed hosting** at `web/public/firmware/builds/<boardType>/<sha>/firmware.bin`. Browser-flasher's `firmware.bin` stays under `latest-stable/`. No collision.
6. **Integrity:** SHA256 in the `otaTarget` payload (server-computed at publish time), verified in-flight by device; `Update.setMD5()` for the library's post-write check; `WiFiClientSecure.setInsecure()` (no cert pinning for v1).
7. **Payload shape:** sibling `/devices/<id>/otaTarget: {url, sha256, sizeBytes, version, boardType, expectedSeconds, minBytesPerSec, maxSeconds}`. `command` stays a scalar string. Device writes back `state.fwVersion`, `state.boardType`, `state.lastOta = {result, ts, from, to, durationS}`.
8. **Publish pipeline:** Cloud Build compiles into a staging area; the dashboard admin picks a build **and** the subset of cameras to roll out to. V1 target: 1 test camera at a time.
9. **Board-type gate at three layers:** device refuses mismatched `boardType`; publish route refuses mismatched write; dashboard UI filters builds by camera's `state.boardType`.
10. **JSON parsing:** extend the hand-rolled helper with `jsonIntField` + `jsonSubObject`. No new dep.
11. **Error path is explicit** — every failure returns an `OtaResult` variant (`DownloadFailed`, `NoSpace`, `WriteFailed`, `ShaMismatch`, `Stalled`, `Ok`), all of which run `Update.abort()` and continue the wake cycle rather than reboot.
12. **Single new module** — `ota_update.{h,cpp}` owns everything OTA-scoped.
13. **`reportStatus()` grows via a `StatusReport` struct**, not a longer arg list.
14. **`otaMarkValidIfPending()` lives in `.ino`, called right after `reportStatus` returns true.**
15. **`getCommand()` returns a `Command` struct** with an optional embedded `OtaTarget`.
16. **Firmware-side tests:** bench sketch at `hardware-tests/HT-HC33_OTA_Unit/` exercises `otaShouldAttempt` and the JSON helpers with print-assertions. Matches the `HT-HC33_SDTest` pattern.
17. **`/api/firmware/publish` gets full test coverage** — auth, board-type match, build-exists (HEAD), server-computed SHA256, rate-limit, per-device atomic write.
18. **RTDB rules for the new paths are explicit and tested.**
19. **Server-driven stall detector.** Backend puts `expectedSeconds`/`minBytesPerSec`/`maxSeconds` in the `otaTarget` payload; device enforces. Two-part detector: wall-clock ceiling + rate-floor. V1 hardcodes reasonable numbers for 2.4 GHz — HaLow numbers land when the radio wires up (see TODOS.md).
20. **Streaming SHA256** computed in the same loop as `Update.write()`. No LittleFS involvement.
21. **Rollout stagger is deferred** to TODOS.md; v1 targets 1–5 cameras.

#### First-boot self-check (safety-critical)

When new firmware boots, `esp_ota_get_state_partition()` returns `ESP_OTA_IMG_PENDING_VERIFY`. Firmware **must** log:
- `[ota] pending verify — waiting on reportStatus` at boot
- `[ota] mark_valid ok` when `otaMarkValidIfPending()` clears the rollback trigger

The bench test in `HT-HC33_OTA_Unit/` greps for both markers. Without this, a bug in `mark_valid` is silent — the fleet reverts every OTA and no one notices except by watching `state.fwVersion` never advance.

#### Known failure modes and how the plan covers them

| Failure | Guard | User sees |
|---|---|---|
| Cloud outage / bad URL | HTTPS fails, `OtaResult::DownloadFailed` | `state.lastOta.result="DownloadFailed"` |
| Wi-Fi drops mid-flash | short write → `Update.abort()`, `WriteFailed` | `state.lastOta.result="WriteFailed"` |
| Manifest tampered / wrong .bin | SHA256 mismatch → `Update.abort()`, `ShaMismatch` | `state.lastOta.result="ShaMismatch"` |
| Wrong-arch binary (Heltec .bin on Lilygo) | Device refuses at `otaShouldAttempt` + backend refuses at publish + UI filters at pick time | `state.lastOta.result="BoardTypeMismatch"` |
| Low battery | `otaShouldAttempt` returns false; no attempt | (silent, correctly) |
| Motion event during OTA window | Gate excludes PIR wakes — motion never blocked | (silent, correctly) |
| Storage exhaustion | `Update.begin()` returns false → `NoSpace` | `state.lastOta.result="NoSpace"` |
| Stalled download | Server-driven `minBytesPerSec` + 15 s grace → abort | `state.lastOta.result="Stalled"` |
| Timeout exceeds `maxSeconds` | Wall-clock ceiling → abort | `state.lastOta.result="Timeout"` |
| New firmware boots but never mark_valid | Bootloader auto-reverts on next reset | ⚠️ silent — dashboard sees fwVersion unchanged; document as a real "reverted" case |
| `mark_valid` code is itself buggy | First-boot self-check log lines make it grep-able in bench test | Explicit log; bench test asserts on it |

## Decision Record

This section is **append-only** — add a dated entry whenever a decision changes; don't
rewrite history. (See the maintenance note below for why.)

- **2026-06-27 — Abandon microSD on the Heltec.** Full board×card matrix showed only 1
  of 4 Kingston cards reliable; a failing card was reformatted with the proven
  `diskutil … FAT32 … MBRFormat` and *still* failed `f_mount=13` on a known-good board,
  proving the cards (not the format) fail over the board's SPI link. Cards read fine in a
  PC reader, which is misleading. → Store in internal flash instead. Cards retained for
  non-Heltec boards. *(The Lilygo T-Halow-P4 has no SD slot at all.)*
- **2026-06-27 — Use internal Flash (LittleFS), not PSRAM.** PSRAM (8 MB) is volatile —
  wiped on deep sleep / power loss — so it can only stage a few in-flight images, not store
  them. Flash is non-volatile and far larger after we unlock the full 16 MB.
- **2026-06-27 — Reserve OTA from the start.** User chose dual-app-slot OTA over
  single-app max-storage (~11.5 MB vs ~14 MB LittleFS). Rationale: repartitioning later to
  add OTA would wipe field photos, so the slots must exist up front; the ~2.5 MB of storage
  given up is worth remote updatability.
- **2026-07-01 — Step 3 design locked (plan review).** 21 design questions
  resolved via `/plan-eng-review`. Highlights:
  - **Flow model:** command-driven (extend `getCommand()` on the existing
    `command-poll` bus), not auto-poll + version-compare. Rationale: reuses
    existing device-secret auth and rate limiting; dashboard controls rollout;
    git SHAs don't order anyway.
  - **Scope expanded from the 5-line sketch** to include a Cloud Build compile
    step, a staging area under `web/public/firmware/builds/<boardType>/<sha>/`,
    a dashboard rollout page, and a defense-in-depth board-type gate (device +
    backend + UI). Driver: near-term Lilygo T-Halow-P4 support means Heltec/
    Lilygo binaries must never be misrouted (guaranteed brick — different CPU
    architecture).
  - **Rollback is real:** partition table's `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`
    must be on, and `esp_ota_mark_app_valid_cancel_rollback()` is called only
    after the first successful `reportStatus()` post-flash. First-boot log
    lines make a `mark_valid` regression grep-able in bench tests.
  - **Server-driven stall detector:** `otaTarget` carries `expectedSeconds`,
    `minBytesPerSec`, `maxSeconds` — computed by the backend from mesh topology
    (v1 hardcodes 2.4 GHz numbers; HaLow numbers land later, see TODOS.md).
    Client just enforces. Radio-agnostic wire format.
  - **Not shipped in v1:** ECDSA firmware signing, rollout stagger, OTA history
    log, Lilygo Cloud Build (blocked on Lilygo firmware source landing),
    boot-counter watchdog. See TODOS.md at repo root for the ones we filed.
- **2026-06-29 — Steps 1 & 2 shipped on `main`.** The 16 MB OTA-ready partition
  table landed in [`firmware/heltec-core-overrides/`](../firmware/heltec-core-overrides/)
  (boards.local.txt + custom CSV in the variant directory); the flash storage layer
  landed in [`cloud_telemetry_node/flash_store.{h,cpp}`](../cloud_telemetry_node/),
  retiring the SD code path. The capture → LittleFS → upload → delete-on-success
  flow is live in the fleet firmware. **Step 3 (OTA update code) is the only
  remaining piece of the original plan.**

## How to keep this doc honest

A design doc is a *snapshot of intent*; code is *current reality*. They drift apart. Keep
both useful by separating the two kinds of knowledge:
- **The "why" (this doc + the Decision Record)** can't be recovered from code — capture it
  *at decision time*. Mark sections `SUPERSEDED` rather than deleting them (matches the
  existing `CAMERA_REGISTRATION_ARCHITECTURE.md` convention).
- **The "what" (current structure)** *can* be regenerated from code — periodically have an
  agent reverse-engineer an "as-built" summary, feeding it **both the code and this doc** so
  it can flag where reality diverged from the plan (those diffs are new decisions to record).
