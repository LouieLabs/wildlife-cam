#!/usr/bin/env bash
# Build the distributable HT-HC33 firmware image for browser flashing (ESP Web
# Tools) and copy the parts into web/public/firmware/.
#
# The image is built with BLANK network + identity + camera key, so the PUBLIC
# binary carries NO secrets. A flashed board gets its Wi-Fi/HaLow creds, identity,
# and the shared camera key written to NVS by the dashboard's "Set up a camera"
# tool. Your local dev secrets.h is restored automatically afterward.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKETCH="$ROOT/cloud_telemetry_node"
FQBN="heltec:esp_halow:HT-HC33"
OUT="$ROOT/web/public/firmware"

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
echo "Wrote firmware image -> $OUT"
