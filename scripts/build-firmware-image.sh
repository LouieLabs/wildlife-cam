#!/usr/bin/env bash
# Build the distributable HT-HC33 firmware image.
#
# Two consumers share the same .bin:
#   1) Browser flashing (ESP Web Tools): writes the full image (bootloader +
#      partitions + boot_app0 + firmware.bin) to a brand-new board.
#   2) Over-the-air updates: the already-deployed firmware downloads the
#      app-only "app.bin" from /firmware/app.bin and rolls itself into the
#      inactive OTA slot. The OTA client gates on /firmware/ota-version.json.
#
# Usage:
#   scripts/build-firmware-image.sh             # reuse current FW_VERSION
#   scripts/build-firmware-image.sh 1.1.0       # bump FW_VERSION first
#   scripts/build-firmware-image.sh --version 1.1.0
#
# The image is built with BLANK network + identity + camera key, so the PUBLIC
# binary carries NO secrets. A flashed board gets its Wi-Fi/HaLow creds,
# identity, and the shared camera key written to NVS by the dashboard's "Set up
# a camera" tool. Your local dev secrets.h is restored automatically afterward.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKETCH="$ROOT/cloud_telemetry_node"
FQBN="heltec:esp_halow:HT-HC33"
OUT="$ROOT/web/public/firmware"
CFG="$SKETCH/node_config.h"

# ---- Parse the optional --version / positional argument --------------------
NEW_VERSION=""
case "${1:-}" in
  -v|--version) NEW_VERSION="${2:-}" ;;
  "")            ;;
  *)             NEW_VERSION="$1" ;;
esac
if [ -n "$NEW_VERSION" ] && ! printf '%s' "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: version must look like 1.2.3, got: $NEW_VERSION" >&2
  exit 1
fi

# ---- Bump FW_VERSION in node_config.h (optional) ---------------------------
if [ -n "$NEW_VERSION" ]; then
  # Portable in-place edit: write to a tmp file then mv. Avoids BSD-vs-GNU
  # sed -i incompatibilities.
  TMP="$(mktemp)"
  awk -v v="$NEW_VERSION" '
    /^#define[[:space:]]+FW_VERSION[[:space:]]+/ {
      print "#define FW_VERSION                \"" v "\""
      next
    }
    { print }
  ' "$CFG" > "$TMP"
  if ! grep -q "FW_VERSION                \"$NEW_VERSION\"" "$TMP"; then
    rm -f "$TMP"
    echo "error: didn't find an FW_VERSION line to bump in $CFG" >&2
    exit 1
  fi
  mv "$TMP" "$CFG"
  echo "node_config.h: FW_VERSION -> $NEW_VERSION"
fi

# Read whatever FW_VERSION currently sits in node_config.h -- this is the
# version we will publish in manifest.json + ota-version.json.
CURRENT_VERSION="$(awk '/^#define[[:space:]]+FW_VERSION[[:space:]]+/ {
  match($0, /"[^"]+"/);
  print substr($0, RSTART+1, RLENGTH-2);
  exit
}' "$CFG")"
if [ -z "$CURRENT_VERSION" ]; then
  echo "error: FW_VERSION not found in $CFG" >&2
  exit 1
fi
echo "Building firmware v$CURRENT_VERSION"

# ---- Compile with blank secrets, with a restore trap -----------------------
restore() { [ -f "$SKETCH/secrets.h.imgbak" ] && mv -f "$SKETCH/secrets.h.imgbak" "$SKETCH/secrets.h"; }
trap restore EXIT

[ -f "$SKETCH/secrets.h" ] && cp "$SKETCH/secrets.h" "$SKETCH/secrets.h.imgbak"
cat > "$SKETCH/secrets.h" <<'EOF'
#pragma once
// Temporary blank secrets for the PUBLIC firmware image (no secrets compiled in).
#define WIFI_SSID      ""
#define WIFI_PASSWORD  ""
#define DEVICE_SECRET  ""
#define CAMERA_API_KEY ""
EOF

arduino-cli compile -e --fqbn "$FQBN" "$SKETCH"

B="$SKETCH/build/heltec.esp_halow.HT-HC33"
CORE="$(find "$HOME/Library/Arduino15/packages" -name boot_app0.bin -path '*Heltec-esp32*' | head -1)"
mkdir -p "$OUT"
cp "$B/cloud_telemetry_node.ino.bootloader.bin" "$OUT/bootloader.bin"
cp "$B/cloud_telemetry_node.ino.partitions.bin" "$OUT/partitions.bin"
cp "$CORE"                                       "$OUT/boot_app0.bin"
cp "$B/cloud_telemetry_node.ino.bin"             "$OUT/firmware.bin"
# Same bytes, two names: ESP Web Tools loads firmware.bin at the ota_0 offset;
# the on-device OTA client downloads app.bin into whichever slot is inactive.
cp "$B/cloud_telemetry_node.ino.bin"             "$OUT/app.bin"

# ---- Publish the OTA manifest (the device polls THIS to decide whether to
#      update) and bump the ESP Web Tools manifest's version so it matches.
cat > "$OUT/ota-version.json" <<EOF
{
  "version": "$CURRENT_VERSION",
  "app": "app.bin"
}
EOF

# Bump the ESP Web Tools manifest's "version" field, leaving the rest alone.
MAN="$OUT/manifest.json"
if [ -f "$MAN" ]; then
  TMP="$(mktemp)"
  awk -v v="$CURRENT_VERSION" '
    /"version":/ {
      sub(/"version":[[:space:]]*"[^"]*"/, "\"version\": \"" v "\"")
    }
    { print }
  ' "$MAN" > "$TMP"
  mv "$TMP" "$MAN"
fi

APP_SIZE="$(wc -c < "$OUT/app.bin" | tr -d ' ')"
echo "Wrote firmware image -> $OUT (v$CURRENT_VERSION, app.bin = $APP_SIZE bytes)"
