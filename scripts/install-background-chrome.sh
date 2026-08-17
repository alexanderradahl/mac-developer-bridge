#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Background Chrome integration currently supports macOS only.\n' >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_DIR="$ROOT/chrome-extension"
EXTENSION_ID="pcebfblnmcappinbenkmddjdapaoajgm"
HOST_NAME="io.github.alexanderradahl.mac_developer_bridge"
DATA_DIR="${MAC_DEV_BRIDGE_DATA_DIR:-$HOME/Library/Application Support/MacDeveloperBridge}"
NATIVE_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
WRAPPER="$DATA_DIR/chrome-native-host"
MANIFEST="$NATIVE_DIR/$HOST_NAME.json"
PROFILE_BINDING="$DATA_DIR/chrome-background-profile.json"
CHROME_LOCAL_STATE="$HOME/Library/Application Support/Google/Chrome/Local State"
NODE_BIN="$(command -v node || true)"
OPEN_CHROME=0

if [[ "${1:-}" == "--open" ]]; then OPEN_CHROME=1; shift; fi
if (( $# )); then
  printf 'Usage: %s [--open]\n' "$0" >&2
  exit 2
fi

[[ -x "$NODE_BIN" ]] || { printf 'node was not found in PATH. Install Node.js first.\n' >&2; exit 1; }
[[ -f "$EXTENSION_DIR/manifest.json" ]] || { printf 'Missing extension at %s\n' "$EXTENSION_DIR" >&2; exit 1; }
[[ -f "$CHROME_LOCAL_STATE" ]] || { printf 'Chrome Local State was not found at %s\n' "$CHROME_LOCAL_STATE" >&2; exit 1; }

mkdir -p "$DATA_DIR" "$NATIVE_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

python3 - "$CHROME_LOCAL_STATE" "$PROFILE_BINDING" <<'PYPROFILE'
import json, os, sys
local_state, out = sys.argv[1:]
data = json.load(open(local_state, encoding="utf-8"))
profile = data.get("profile") or {}
profile_dir = profile.get("last_used") or "Default"
entry = (profile.get("info_cache") or {}).get(profile_dir) or {}
email = str(entry.get("user_name") or "").strip()
gaia = str(entry.get("gaia_id") or "").strip()
if not email or "@" not in email or not gaia.isdigit():
    raise SystemExit(f"Chrome profile {profile_dir!r} is not signed in with a primary Google account")
binding = {"profileDirectory": profile_dir, "expectedEmail": email, "expectedGaiaId": gaia}
tmp = out + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(binding, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, out)
print(f"Bound background Chrome to profile {profile_dir}: {email}")
PYPROFILE
chmod 600 "$PROFILE_BINDING"

umask 077
cat > "$WRAPPER" <<EOF2
#!/bin/sh
exec "$NODE_BIN" "$ROOT/scripts/chrome-native-host.mjs"
EOF2
chmod 700 "$WRAPPER"

python3 - "$MANIFEST" "$HOST_NAME" "$WRAPPER" "$EXTENSION_ID" <<'PY'
import json, os, sys
out, name, path, extension_id = sys.argv[1:]
data = {
    "name": name,
    "description": "Mac Developer Bridge background Chrome native host",
    "path": path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
tmp = out + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, out)
PY
chmod 600 "$MANIFEST"

cat <<EOF2
Background Chrome native host installed.

One-time Chrome step:
  1. Open chrome://extensions
  2. Enable Developer mode
  3. Click "Load unpacked"
  4. Choose: $EXTENSION_DIR

Expected extension id: $EXTENSION_ID
Native host manifest: $MANIFEST
Signed-in profile binding: $PROFILE_BINDING

Relaxed browser access is the default: once the extension is loaded and the
signed-in profile binding matches, MDB can use normal HTTP/HTTPS sites without
per-site terminal approvals. If you want scoped URL/app approval gates, turn on
"Strict approvals" in the Mac Developer Bridge menu-bar app. Strict mode then uses
scripts/approve-personal-browser.sh and scripts/approve-foreground-gui.sh.

Routine chrome_* tools then use background tabs (active:false) and do not activate
Chrome. Native dialogs, CAPTCHAs, file pickers, and trusted-user-gesture flows still
require foreground/manual interaction.
EOF2

if (( OPEN_CHROME )); then
  open -g -a "Google Chrome" "chrome://extensions" || true
fi
