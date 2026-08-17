#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mac-developer-bridge-installer.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

MOCK_BIN="$TMP/mock-bin"
HOME_DIR="$TMP/home"
INSTALL_DIR="$HOME_DIR/custom & install/mac-developer-bridge"
BIN_DIR="$HOME_DIR/bin"
PLIST_DIR="$HOME_DIR/LaunchAgents"
DATA_DIR="$HOME_DIR/Application & Support/MacDeveloperBridge"
LOG_DIR="$HOME_DIR/Logs & Audit/MacDeveloperBridge"
STATE_DIR="$TMP/state"
mkdir -p "$MOCK_BIN" "$HOME_DIR" "$STATE_DIR"

cat > "$MOCK_BIN/uname" <<'SH'
#!/bin/bash
if [[ "${1:-}" == "-s" ]]; then printf 'Darwin\n'; else /usr/bin/uname "$@"; fi
SH

cat > "$MOCK_BIN/security" <<'SH'
#!/bin/bash
set -euo pipefail
state="${MOCK_SECURITY_STATE:?}"
command="$1"; shift
case "$command" in
  add-generic-password)
    key=""
    while (($#)); do
      case "$1" in
        -w) key="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s' "$key" > "$state"
    ;;
  find-generic-password)
    cat "$state"
    ;;
  delete-generic-password)
    rm -f "$state"
    ;;
  *) printf 'unexpected security command: %s\n' "$command" >&2; exit 2 ;;
esac
SH

cat > "$MOCK_BIN/launchctl" <<'SH'
#!/bin/bash
set -euo pipefail
printf '%q ' "$@" >> "${MOCK_LAUNCHCTL_LOG:?}"
printf '\n' >> "${MOCK_LAUNCHCTL_LOG:?}"
if [[ "${1:-}" == "print" ]]; then
  printf 'mock launch agent: running\n'
fi
exit 0
SH

cat > "$MOCK_BIN/plutil" <<'SH'
#!/bin/bash
set -euo pipefail
[[ "${1:-}" == "-lint" ]] || { printf 'expected -lint\n' >&2; exit 2; }
python3 - "$2" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as handle:
    plistlib.load(handle)
print(f"{sys.argv[1]}: OK")
PY
SH

cat > "$MOCK_BIN/tunnel-client" <<'SH'
#!/bin/bash
set -euo pipefail
printf '%q ' "$@" >> "${MOCK_TUNNEL_LOG:?}"
printf '\n' >> "${MOCK_TUNNEL_LOG:?}"
case "${1:-}" in
  init)
    profile=""; command_path=""; tunnel=""
    shift
    while (($#)); do
      case "$1" in
        --profile) profile="$2"; shift 2 ;;
        --mcp-command) command_path="$2"; shift 2 ;;
        --tunnel-id) tunnel="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$profile" && -x "$command_path" && "$tunnel" =~ ^tunnel_[0-9a-f]{32}$ ]]
    printf '%s\n' "$command_path" > "${MOCK_PROFILE_STATE:?}"
    ;;
  doctor)
    [[ -s "${MOCK_PROFILE_STATE:?}" ]]
    printf 'mock tunnel doctor: ready\n'
    ;;
  run)
    printf 'mock tunnel run\n'
    ;;
  *) printf 'unexpected tunnel-client command: %s\n' "${1:-}" >&2; exit 2 ;;
esac
SH

cat > "$MOCK_BIN/codex" <<'SH'
#!/bin/bash
exit 0
SH

chmod +x "$MOCK_BIN"/*

export HOME="$HOME_DIR"
export PATH="$MOCK_BIN:$PATH"
export MOCK_SECURITY_STATE="$STATE_DIR/keychain"
export MOCK_LAUNCHCTL_LOG="$STATE_DIR/launchctl.log"
export MOCK_TUNNEL_LOG="$STATE_DIR/tunnel.log"
export MOCK_PROFILE_STATE="$STATE_DIR/profile"
export MAC_DEV_BRIDGE_INSTALL_DIR="$INSTALL_DIR"
export MAC_DEV_BRIDGE_BIN_DIR="$BIN_DIR"
export MAC_DEV_BRIDGE_PLIST_DIR="$PLIST_DIR"
export MAC_DEV_BRIDGE_DATA_DIR="$DATA_DIR"
# The test process can inherit the real menu-bar bridge unlock path. Override it
# explicitly so mock uninstall.sh can never revoke the running developer bridge.
export MAC_DEV_BRIDGE_UNLOCK_FILE="$DATA_DIR/FULL_ACCESS_ENABLED"
export MAC_DEV_BRIDGE_LOG_DIR="$LOG_DIR"
export MAC_DEV_BRIDGE_AUDIT_MODE="metadata"
export MAC_DEV_BRIDGE_SHELL="/bin/bash"
export MAC_DEV_BRIDGE_PROFILE="mock-profile"
export MAC_DEV_BRIDGE_FULL_ACCESS_ACK="I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS"
export CONTROL_PLANE_TUNNEL_ID="tunnel_0123456789abcdef0123456789abcdef"
RUNTIME_KEY="sk-test-runtime-key-${RANDOM}-${RANDOM}-not-real"
export CONTROL_PLANE_API_KEY="$RUNTIME_KEY"
export TUNNEL_CLIENT_BIN="$MOCK_BIN/tunnel-client"
export CODEX_BIN="$MOCK_BIN/codex"
export SECURITY_BIN="$MOCK_BIN/security"
export LAUNCHCTL_BIN="$MOCK_BIN/launchctl"
export PLUTIL_BIN="$MOCK_BIN/plutil"
export UNAME_BIN="$MOCK_BIN/uname"

"$ROOT/install.sh" > "$STATE_DIR/install.out"

[[ -x "$INSTALL_DIR/bridge.mjs" ]]
[[ -L "$BIN_DIR/mac-developer-bridge" ]]
[[ "$(readlink "$BIN_DIR/mac-developer-bridge")" == "$INSTALL_DIR/bridge.mjs" ]]
[[ "$(cat "$DATA_DIR/FULL_ACCESS_ENABLED")" == "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS" ]]
[[ "$(cat "$DATA_DIR/tunnel-profile")" == "mock-profile" ]]
[[ "$(cat "$STATE_DIR/keychain")" == "$RUNTIME_KEY" ]]
[[ -s "$PLIST_DIR/com.openai.mac-developer-bridge-tunnel.plist" ]]
python3 - "$PLIST_DIR/com.openai.mac-developer-bridge-tunnel.plist" "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR" <<'PY'
import plistlib, sys
plist_path, install_dir, data_dir, log_dir = sys.argv[1:]
with open(plist_path, 'rb') as handle:
    data = plistlib.load(handle)
assert data['ProgramArguments'] == [f'{install_dir}/scripts/run-tunnel.sh']
assert data['EnvironmentVariables']['MAC_DEV_BRIDGE_INSTALL_DIR'] == install_dir
assert data['EnvironmentVariables']['MAC_DEV_BRIDGE_DATA_DIR'] == data_dir
assert data['EnvironmentVariables']['MAC_DEV_BRIDGE_LOG_DIR'] == log_dir
assert data['StandardOutPath'] == f'{log_dir}/tunnel.stdout.log'
assert data['StandardErrorPath'] == f'{log_dir}/tunnel.stderr.log'
PY
grep -Fq "bootstrap" "$STATE_DIR/launchctl.log"
grep -Fq "doctor" "$STATE_DIR/tunnel.log"

if grep -R -F "$RUNTIME_KEY" "$INSTALL_DIR" "$PLIST_DIR" "$DATA_DIR" "$LOG_DIR" >/dev/null 2>&1; then
  printf 'runtime key leaked into installed files\n' >&2
  exit 1
fi

"$ROOT/uninstall.sh" > "$STATE_DIR/uninstall.out"
[[ ! -e "$INSTALL_DIR" ]]
[[ ! -e "$BIN_DIR/mac-developer-bridge" ]]
[[ ! -e "$PLIST_DIR/com.openai.mac-developer-bridge-tunnel.plist" ]]
[[ ! -e "$DATA_DIR/FULL_ACCESS_ENABLED" ]]
[[ ! -e "$STATE_DIR/keychain" ]]

printf 'mock macOS installer test passed\n'
