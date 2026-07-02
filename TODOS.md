# TODOS

Deferred work with enough context to pick up cold. Add new items with a date and
enough backstory that "why" survives when the person who filed it has moved on.

## Format

Each entry has: **What**, **Why**, **Pros / Cons**, **Context**, **Depends on**.
Filed date is a header line. Keep entries factual — this file is not for venting
about code smells you didn't fix (put those in a Decision Record).

---

## 2026-07-01 (filed from `/plan-eng-review` of FLASH_STORAGE_OTA_PLAN.md Step 3)

### 1. Rollout stagger for fleet-wide OTA

**What.** When a dashboard admin publishes a new firmware to many cameras, add a
per-camera delay so they don't all download at once.

**Why.** Thundering-herd on HaLow mesh bandwidth (each hop roughly halves
goodput; N cameras contending for the same relay can starve each other). Also
guards against surprise GCS bandwidth spikes at fleet scale.

**Pros.** Prevents an entire subnet from saturating during rollout. One-time
wire-format investment.

**Cons.** Adds a scheduling concept the plan currently doesn't have. Two ways
to build (server-driven `startAfterMs` vs client-random backoff) — whichever is
picked becomes a wire-format commitment.

**Context.** Deferred in the 2026-07-01 plan review (see Issue 21A). V1 of Step
3 targets 1–5 cameras. Revisit when Lilygo T-Halow-P4 lights up mesh **or**
fleet exceeds ~10 cameras — whichever is first.

Simplest shape when we build it: `otaTarget.startAfterMs` computed by the
`/api/firmware/publish` route, one field added to the payload. Device delays
that long **after** `otaShouldAttempt()` returns true (so battery/RSSI gates
still fire first). Randomize per camera or bucket into waves — TBD.

**Depends on.** Fleet growth or HaLow mesh, whichever first.

### 2. HaLow throughput vendor-verify (Heltec + Lilygo)

**What.** Empirically measure HaLow goodput for the Heltec HT-HC01 and Lilygo
TX-AH modules at 0 hops, 1 hop, and 2 hops. Record numbers in the
FLASH_STORAGE_OTA_PLAN.md Decision Record.

**Why.** The OTA stall detector (Issue 19A of the 2026-07-01 review) uses
`otaTarget.expectedSeconds`, `minBytesPerSec`, and `maxSeconds`, computed by the
backend from mesh topology. V1 ships with 2.4 GHz numbers as placeholders. When
HaLow lights up, the placeholders will time out too early or waste budget unless
we know the real numbers.

**Pros.** Concrete throughput data unblocks proper stall-detection tuning.
Vendor peak claims (~40 Mbps) diverge wildly from realistic goodput —
measurement is the only honest answer.

**Cons.** Requires two or three HaLow-wired boards on a bench. Time-on-bench,
not just code.

**Context.** Vendor docs to consult: `https://github.com/HelTecAutomation/ESP_HaLow`
and `https://github.com/Xinyuan-LilyGO/T-Halow` (per `.agents/rules/EXTERNAL_CONTEXT.md`).
Suggested test protocol:

- Two devices, 8 MHz channel, close range (<5 m), measure sustained 1 MB
  transfer goodput → record N Mbps / KB/s.
- Add a relay device 10–20 m away — measure 1-hop goodput.
- Repeat with a second relay — measure 2-hop goodput.
- Log MCS and retry rate if the vendor stack exposes them.

Data lives in the plan doc's Decision Record when it exists. Feeds directly
into the backend's `otaTarget` computation in `/api/firmware/publish`.

**Depends on.** A HaLow-wired firmware build (today, the code notes the HaLow
radio isn't wired in — see comment in `cloud_backend.cpp`).

### 3. OTA history log (audit trail)

**What.** New Firestore collection recording every OTA event:
`{deviceId, from, to, ts, result, durationS, minBytesPerSec}`. Dashboard page
shows per-camera history and fleet-wide roll-up.

**Why.** `state.lastOta` is a one-shot field (last event only). "Which builds
has camera X been on for the past month?" is unanswerable without a log.
Compliance-friendly and a debug tool for future OTA regressions.

**Pros.** Enables trend visibility ("camera 5 has failed 3 OTAs in a row").
Cheap to write during OTA — one extra Firestore doc per event.

**Cons.** New collection to schema + rule + test. Only valuable once fleet is
large enough for trends to matter.

**Context.** Deferred in the 2026-07-01 plan review (Issue TODO 4). Extend the
existing `state.lastOta` write in `reportStatus()` to also append a doc to
`otaEvents/<deviceId>_<ts>` or similar. Dashboard page uses the same admin
auth gate as `/api/firmware/publish`.

**Depends on.** Fleet growth OR first "why does camera N always fail" question.

### 4. Lilygo firmware compile in Cloud Build

**What.** Extend the Cloud Build config that compiles Heltec firmware into
staging to also compile the Lilygo T-Halow-P4 sketch and publish under
`web/public/firmware/builds/lilygo-t-halow-p4/<sha>/`.

**Why.** The board-type gate (Issue 9A of the plan review) is architected for
two boards. Until Lilygo has a compilable sketch and a Cloud Build pipeline,
the whole board-type story is one-sided and only Heltec cameras can OTA.

**Pros.** Unlocks OTA for the Lilygo boards planned for eventual deployment.

**Cons.** Blocked on Lilygo firmware source landing. That's its own project:
ESP-IDF v5.3+ (not Arduino), MIPI-CSI drivers, RISC-V/ESP32-P4 architecture
per `.agents/rules/HARDWARE.md`. Cloud Build needs a second compile step with a
different toolchain — likely a Docker image with ESP-IDF pre-installed. Recent
JDK21 CI pain (PRs #24–#26) is prior evidence that Cloud Build extensions are
not cheap.

**Context.** Deferred in the 2026-07-01 plan review (Issue TODO 5). When the
Lilygo firmware source lands, extend `cloudbuild.yaml` with a second step
using an ESP-IDF Docker image; publish to `builds/lilygo-t-halow-p4/<sha>/`.
The publish route already handles boardType filtering.

**Depends on.** Lilygo P4 firmware source existing in the repo.
