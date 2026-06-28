# LouieLabs — Wildlife Cam (Claude Code / Cowork guide)

This file is auto-loaded by Claude Code (and Cowork, which runs on Claude Code)
at the start of every session in this repo. It pulls in the same guardrails the
Antigravity agent uses, so all tools behave consistently.

> The users are **high school students**, not CS/ME/EE majors. Always lead with a
> plain-English "In plain words" recap before code or jargon (see the
> Explain-Back Rule below). Beginner-friendly explanations live in
> [`docs/for-students/`](docs/for-students/) — point students there.

## Shared guardrails (single source of truth)

@.agents/rules/PROJECT.md
@.agents/rules/HARDWARE.md
@.agents/rules/EXTERNAL_CONTEXT.md

## Build toolchain

- Build with the **Arduino IDE + Heltec "ESP32 HaLow" core** (`heltec:esp_halow`),
  FQBN `heltec:esp_halow:HT-HC33`. PlatformIO is **parked** — see the header in
  `platformio.ini` for why.
- Standalone hardware checks live in `hardware-tests/` (built with `arduino-cli`).

## Notes for the assistant

- Honor the **Grill-Me Loop** and its escape hatch from `PROJECT.md`.
- For other surfaces: **Claude.ai Chat** can't read this file — paste these rules
  into a Project's custom instructions there. To apply across all of a student's
  repos, also add `~/.claude/CLAUDE.md`.
- **Cloud artifacts are environment-tagged** (`APP_ENV` in `web/`): dev images
  live under `dev/` in GCS and dev detections carry `env:"dev"` in Firestore (see
  `web/README.md`). When wrapping up dev work that produced cloud artifacts,
  **offer to run `npm run clean:dev`** (in `web/`) so dev test data doesn't pile
  up. It can never touch production data.

## Team Workflow Rules
- Always create a new feature branch for tasks using standard naming: `feature/your-name-feature-title`
- Do not make changes directly to the `main` branch.
- Write modular Arduino code (separate `.ino` or `.cpp/.h` files for distinct hardware components like sensors, displays, etc.) to minimize merge conflicts.

## Documenting the "why"
Put each reason where it will survive. The test: **would the "why" still matter if you
deleted the code it describes?**
- **No — it dies with the line** (magic numbers, workarounds, a non-obvious choice about
  *this* code) → **inline comment**, right next to the code. e.g.
  `// 460800 baud — 921600 corrupts the upload`.
- **Yes — it outlives the code** (why this approach over alternatives, what we *rejected*,
  decisions that span multiple files, how things evolved) → a **Decision Record** in the
  relevant `docs/` design doc: append-only, dated, never rewritten; mark superseded sections
  `SUPERSEDED` instead of deleting. Rejected paths have no code to attach to, so they can
  *only* live here.
- **Some decisions want both:** a one-line inline guardrail at the point of danger + the full
  story in the Decision Record (e.g. the reserved OTA partition slot — see
  [`docs/FLASH_STORAGE_OTA_PLAN.md`](docs/FLASH_STORAGE_OTA_PLAN.md)).

Code captures *what*; comments capture *local why*; the Decision Record captures
*approach-level why and history*. An agent can regenerate the *what* from code on demand, but
only if the *why* was written down at decision time.
