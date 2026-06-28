# PIR Capture & Upload Pipeline — Implementation Plan (Heltec HT-HC33)

**Target:** Heltec HT-HC33 (ESP32-S3), **Arduino core + FreeRTOS** (no ESP-IDF
migration — see the framework note below). **Power model:** battery/solar first.

> **In plain words.** The camera should sleep to save battery, wake up when the
> motion sensor (PIR) sees something, take a picture (or a short clip), and save
> it to the SD card. It only sends pictures over the long-range radio (HaLow)
> during quiet spells. If motion happens again *while* it's still sending an old
> picture, it stops sending so it doesn't miss the new animal — the half-sent
> picture stays safely on the SD card to send later. Before sending, it does a
> quick check to skip "false alarm" photos with no animal in them.

## Why we stay on Arduino (not ESP-IDF)
FreeRTOS (tasks, queues, semaphores, interrupts) is **already available** inside
the Heltec Arduino core — the live-stream sketch already uses a FreeRTOS mutex.
HaLow on this board is **only** shipped as an Arduino library (`wifi-halow`) with
a sealed driver blob, so moving to pure ESP-IDF would *lose* HaLow for no real
gain. Everything below is achievable in the Arduino core.

---

## Architecture: a 3-state machine + 2 background tasks

```
        PIR interrupt
ARMED ───────────────►  MOTION  ──(quiet for LULL_SECONDS)──►  LULL
(deep sleep,            (capture + save                       (upload SD
 PIR = wake source)     to SD, fast)                           backlog)
   ▲                                                             │
   └──────────────(backlog empty / battery saver)───────────────┘
            (PIR during LULL → abort upload, jump back to MOTION)
```

**FreeRTOS pieces (all in the Arduino sketch):**

| Piece | Priority | Job |
|---|---|---|
| **PIR ISR** | (interrupt) | Sets a "motion" flag / gives a semaphore; also the deep-sleep wake source (`ext0`) |
| **Capture task** | high | On motion: grab frame(s), run quick animal check, write JPEG to SD with metadata |
| **Uploader task** | low | During LULL: send SD backlog over HaLow, checking the motion flag between chunks and bailing if it's set |
| **SD backlog** | — | A queue (or just "scan `/wildcam` for unsent files") the uploader drains |

**Power:** deep-sleep while ARMED, woken by PIR (`ext0`) — same low-power core as
today's `cloud_telemetry_node`. Stay awake only during MOTION and LULL windows.

---

## Phases (build order)

### Phase 1 — Motion → SD, single-threaded (no concurrency yet)
Goal: prove the capture path before adding tasks.
- PIR on a GPIO: `attachInterrupt` **and** configure it as the `ext0` deep-sleep
  wake source. (Reuse the PIR re-arm/GPIO work from the
  `add-camera-sd-pir-sketchtest` branch.)
- On wake/motion: init camera, capture a JPEG, write to SD `/wildcam` with a
  filename + small metadata (timestamp, device id). (Reuse the SD code from
  `videowithinterfacesketch`.)
- Keep the existing status report + command poll.
- **Deliverable:** motion → photo saved to SD, then back to deep sleep.

### Phase 2 — FreeRTOS tasks: upload in lulls, abort on motion  ⟵ *the refactor*
Goal: capturing and uploading make progress independently.
- Add the **Capture task** + **Uploader task** + a **motion semaphore/flag**.
- **LULL detection:** track `lastMotionMs`; when `now - lastMotionMs >
  LULL_SECONDS` (start ~90 s) and the backlog is non-empty, enter LULL and run
  the uploader.
- **Abort-on-motion policy** (replaces the raw "abort if > 1 s" idea — see note):
  the uploader checks the motion flag between network chunks. If motion fires,
  it **decides**: if the current file is nearly done, finish it; otherwise close
  the connection, **leave the file on SD**, and hand control back to MOTION.
- **Deliverable:** motion bursts get saved while older photos upload in the
  background and politely step aside for new motion.

### Phase 3 — Smarts: animal pre-check, clips, tuning
- **Animal pre-check** (skip false PIR triggers before spending HaLow airtime):
  start cheap — frame-to-frame difference / motion energy / JPEG-size heuristic;
  graduate to **TensorFlow Lite Micro** (runs under arduino-esp32) if needed.
- **"Movies":** on the S3 (OV3660, no hardware H.264) a clip = a short **burst of
  JPEGs (MJPEG)** saved to SD. True H.264 video is a P4-class feature, not S3 —
  documented as a limitation.
- **Tuning:** `LULL_SECONDS`, abort threshold, deep-sleep current, NTP-per-wake
  cost, upload retry/backoff.

---

## Key risks & decisions (flag early)

1. **Slow HaLow + atomic uploads.** A Cloud Storage signed `PUT` is a *single
   atomic upload* — you can't resume half of it. So "abort" = drop the
   connection and **re-queue the whole file from SD** next lull (the photo is
   never lost, but the bytes sent so far are wasted). If wasted airtime becomes a
   problem, switch to GCS **resumable uploads** (more complex) — future option.
2. **"Abort if > 1 second" is likely too aggressive** — a single HaLow photo may
   take several seconds, so a 1 s cap would abort *everything*. The real control
   is "PIR fires *during* an upload → checkpoint between chunks and decide
   finish-vs-abort," with a tunable threshold.
3. **MJPEG ≠ real video** on the S3. If true H.264 movies matter, that's the
   argument for the Lilygo T-Halow-P4 (hardware H.264) — a separate, ESP-IDF
   codebase.
4. **Camera + deep sleep + tasks power budget** needs measuring on real hardware
   (sleep current, wake duration, upload airtime).

## Open questions for the team
- `LULL_SECONDS`: 90 s? 120 s?
- Per motion event: single photo, a short burst, or an MJPEG clip?
- Animal pre-check: start with the cheap heuristic, or go straight to TFLite-Micro?
- Battery/solar target runtime (drives how aggressive the sleep budget must be)?
