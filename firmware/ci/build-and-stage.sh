#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# firmware/ci/build-and-stage.sh
#
# Compile the Heltec HT-HC33 firmware in Cloud Build and drop the resulting
# .bin under web/public/firmware/builds/<boardType>/<sha>/ so the docker image
# baked from web/ picks it up. This is called from web/cloudbuild.yaml BEFORE
# the docker build step so the .bin lands inside the Cloud Run image and the
# /api/firmware/publish route (Slice B) can stat it and hash it.
#
# What it does, in plain words:
#   1. Downloads the Heltec ESP_HaLow Arduino core (~500 MB toolchain + libs)
#      and pins it to a known-good commit so a vendor breaking change doesn't
#      silently ship a different firmware
#   2. Copies our repo's core overrides (16 MB flash size + OTA partition
#      table + git-SHA prebuild hook) into the core -- same overrides a
#      student uses locally per firmware/heltec-core-overrides/README.md
#   3. Compiles cloud_telemetry_node with arduino-cli
#   4. Copies the compiled .bin to
#      web/public/firmware/builds/<boardType>/<sha>/firmware.bin -- content-
#      addressed by git SHA so the URL never changes for the same build
#
# Environment variables (all optional):
#   OTA_BUILD_SHA     git short SHA to tag the build (default: rev-parse HEAD)
#   OTA_BOARD_TYPE    board type slug (default: heltec-ht-hc33)
#   FQBN              arduino-cli FQBN (default: heltec:esp_halow:HT-HC33)
#   SKETCHBOOK        arduino sketchbook path (default: $HOME/Arduino)
#   HELTEC_CORE_REPO  upstream repo (default: HelTecAutomation/ESP_HaLow.git)
#   HELTEC_CORE_REF   pinned ref (default: cc33014, matches local dev @ 2026-07-02)
#
# Usage (CI):
#   firmware/ci/build-and-stage.sh
#
# Usage (local iteration, skip the core clone + toolchain download):
#   SKETCHBOOK="$HOME/Documents/Arduino" firmware/ci/build-and-stage.sh
#   (assumes you already have the Heltec core installed at
#   $SKETCHBOOK/hardware/heltec/esp_halow with tools/get.py already run)
#
# The script is idempotent: re-running it with the same SHA overwrites the
# same output path.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Config -- defaults are what CI uses. Locals can override any of them.
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKETCH_DIR="${REPO_ROOT}/cloud_telemetry_node"
OVERRIDES_DIR="${REPO_ROOT}/firmware/heltec-core-overrides"

OTA_BUILD_SHA="${OTA_BUILD_SHA:-$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo dev)}"
OTA_BOARD_TYPE="${OTA_BOARD_TYPE:-heltec-ht-hc33}"
FQBN="${FQBN:-heltec:esp_halow:HT-HC33}"
SKETCHBOOK="${SKETCHBOOK:-$HOME/Arduino}"
HELTEC_CORE_REPO="${HELTEC_CORE_REPO:-https://github.com/HelTecAutomation/ESP_HaLow.git}"
# Pinned to the exact commit that produced a green local compile on 2026-07-02.
# Bump this deliberately after re-running the compile locally and verifying the
# resulting .bin still runs on a bench board.
HELTEC_CORE_REF="${HELTEC_CORE_REF:-cc33014}"

CORE_DIR="${SKETCHBOOK}/hardware/heltec/esp_halow"
BUILD_TMP="$(mktemp -d -t fw-build-XXXX)"
trap 'rm -rf "$BUILD_TMP"' EXIT

STAGING_DIR="${REPO_ROOT}/web/public/firmware/builds/${OTA_BOARD_TYPE}/${OTA_BUILD_SHA}"
OUTPUT_BIN="${STAGING_DIR}/firmware.bin"

echo "======================================================================"
echo "Firmware CI build"
echo "  SHA          : ${OTA_BUILD_SHA}"
echo "  Board type   : ${OTA_BOARD_TYPE}"
echo "  FQBN         : ${FQBN}"
echo "  Sketchbook   : ${SKETCHBOOK}"
echo "  Core repo    : ${HELTEC_CORE_REPO} @ ${HELTEC_CORE_REF}"
echo "  Output       : ${OUTPUT_BIN}"
echo "======================================================================"

# ---------------------------------------------------------------------------
# 1. Prerequisites -- fail loud rather than half-finish
# ---------------------------------------------------------------------------
for tool in arduino-cli git python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: '$tool' is required but not found on PATH" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 2. Fetch (or update) the Heltec ESP_HaLow core. Idempotent: keeps the
#    checkout at the pinned SHA whether it exists already or not.
# ---------------------------------------------------------------------------
if [[ ! -d "${CORE_DIR}/.git" ]]; then
  echo "[core] cloning ${HELTEC_CORE_REPO} into ${CORE_DIR}"
  mkdir -p "$(dirname "$CORE_DIR")"
  git clone "$HELTEC_CORE_REPO" "$CORE_DIR"
fi
(
  cd "$CORE_DIR"
  # Only fetch if the pinned ref isn't already present.
  if ! git rev-parse -q --verify "${HELTEC_CORE_REF}^{commit}" >/dev/null; then
    git fetch origin
  fi
  git -c advice.detachedHead=false checkout "$HELTEC_CORE_REF"
)

# ---------------------------------------------------------------------------
# 3. Toolchain: get.py downloads the Xtensa compiler + libs. Skip if the
#    canonical path already exists so local iteration is fast.
# ---------------------------------------------------------------------------
if [[ ! -d "${CORE_DIR}/tools/xtensa-esp32s3-elf" ]]; then
  echo "[toolchain] running tools/get.py (this downloads ~500 MB)"
  (cd "${CORE_DIR}/tools" && python3 get.py)
else
  echo "[toolchain] already present -- skipping get.py"
fi

# ---------------------------------------------------------------------------
# 4. Copy our repo's core overrides into the vendor core. These are the same
#    files firmware/heltec-core-overrides/README.md tells a student to copy
#    manually; automating it here keeps CI + local dev in sync.
# ---------------------------------------------------------------------------
echo "[overrides] applying ${OVERRIDES_DIR} to ${CORE_DIR}"
cp "${OVERRIDES_DIR}/boards.local.txt"                "${CORE_DIR}/boards.local.txt"
cp "${OVERRIDES_DIR}/platform.local.txt"              "${CORE_DIR}/platform.local.txt"
cp "${OVERRIDES_DIR}/variants/HT-HC33/partitions.csv" "${CORE_DIR}/variants/HT-HC33/partitions.csv"

# ---------------------------------------------------------------------------
# 5. secrets.h -- the sketch #include's it but it's gitignored. For CI, we
#    write a stub with dummy values from secrets.example.h. The compiled .bin
#    is generic (NVS-provisioned per device); dev fallbacks in secrets.h are
#    unused in the field.
# ---------------------------------------------------------------------------
if [[ ! -f "${SKETCH_DIR}/secrets.h" ]]; then
  echo "[secrets] writing CI stub secrets.h from secrets.example.h"
  cp "${SKETCH_DIR}/secrets.example.h" "${SKETCH_DIR}/secrets.h"
fi

# ---------------------------------------------------------------------------
# 6. Compile. arduino-cli reads directories.user from its config so we pass
#    --config-file with just the sketchbook path override.
# ---------------------------------------------------------------------------
echo "[compile] arduino-cli compile --fqbn ${FQBN}"
arduino-cli --config-file /dev/null compile \
  --fqbn "$FQBN" \
  --output-dir "$BUILD_TMP" \
  "$SKETCH_DIR"

# ---------------------------------------------------------------------------
# 7. Stage the .bin. Content-addressed by git SHA so the /api/firmware/publish
#    URL is stable for a given build.
# ---------------------------------------------------------------------------
COMPILED_BIN="${BUILD_TMP}/cloud_telemetry_node.ino.bin"
if [[ ! -f "$COMPILED_BIN" ]]; then
  echo "ERROR: expected ${COMPILED_BIN} not produced" >&2
  echo "Build output:" >&2
  ls -la "$BUILD_TMP" >&2
  exit 1
fi

mkdir -p "$STAGING_DIR"
cp "$COMPILED_BIN" "$OUTPUT_BIN"

BIN_SIZE=$(stat -f%z "$OUTPUT_BIN" 2>/dev/null || stat -c%s "$OUTPUT_BIN")
echo "======================================================================"
echo "SUCCESS"
echo "  ${OUTPUT_BIN}"
echo "  ${BIN_SIZE} bytes"
echo "======================================================================"
