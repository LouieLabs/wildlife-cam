#!/usr/bin/env bash
# Stop and remove the critterwatch LaunchAgent.
set -euo pipefail
LABEL="com.louielabs.critterwatch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "removed: $LABEL (auto-annotation stopped)"
