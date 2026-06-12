#!/usr/bin/env bash
# Install the macOS LaunchAgent that auto-runs critterwatch. On any change to
# Downloads or the camera folders, it:
#   1. moves ONLY camera-interface files (named wildcam_*) from Downloads into
#      "Louie Labs/Wildlife Camera Images" or "Wildlife Camera Videos", then
#   2. annotates new files in those folders -> "Louie Labs/Annotated".
# It never moves or reads any non-wildcam_ file, and writes only inside Louie Labs.
#
# Usage:  ./install_agent.sh        (run once)
# Stop:   ./uninstall_agent.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/python"
LABEL="com.louielabs.critterwatch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

BASE="$HOME/Downloads/Louie Labs"
IMAGES="$BASE/Wildlife Camera Images"
VIDEOS="$BASE/Wildlife Camera Videos"

if [ ! -x "$PY" ]; then
  echo "error: venv python not found at $PY (create the venv + pip install first)" >&2
  exit 1
fi
if [ ! -d "$IMAGES" ] || [ ! -d "$VIDEOS" ]; then
  echo "error: expected folders not found:" >&2
  echo "  $IMAGES" >&2
  echo "  $VIDEOS" >&2
  echo "create them (inside '$BASE') and re-run." >&2
  exit 1
fi
mkdir -p "$BASE/Annotated"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>critterwatch</string>
    <string>ingest</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WatchPaths</key>
  <array>
    <string>$HOME/Downloads</string>
    <string>$IMAGES</string>
    <string>$VIDEOS</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HERE/agent.out.log</string>
  <key>StandardErrorPath</key><string>$HERE/agent.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "installed + loaded: $LABEL"
echo "watching:"
echo "  $HOME/Downloads        (routes wildcam_* camera files only)"
echo "  $IMAGES"
echo "  $VIDEOS"
echo "annotated results -> $BASE/Annotated"
echo "logs: $HERE/agent.out.log  /  $HERE/agent.err.log"
