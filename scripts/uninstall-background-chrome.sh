#!/bin/bash
set -euo pipefail
HOST_NAME="io.github.alexanderradahl.mac_developer_bridge"
DATA_DIR="${MAC_DEV_BRIDGE_DATA_DIR:-$HOME/Library/Application Support/MacDeveloperBridge}"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$MANIFEST" "$DATA_DIR/chrome-native-host" "$DATA_DIR/chrome-background.sock" "$DATA_DIR/chrome-native-host.pid"
printf 'Removed the Mac Developer Bridge background Chrome native host.\n'
printf 'Remove the unpacked extension separately from chrome://extensions if desired.\n'
