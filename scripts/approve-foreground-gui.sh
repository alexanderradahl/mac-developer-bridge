#!/bin/bash
set -euo pipefail

DATA_DIR="${MAC_DEV_BRIDGE_DATA_DIR:-$HOME/Library/Application Support/MacDeveloperBridge}"
APPROVAL_FILE="${MAC_DEV_BRIDGE_FOREGROUND_GUI_APPROVAL_FILE:-$DATA_DIR/FOREGROUND_GUI_APPROVED}"
MAX_TTL_SECONDS=300
TTL=60
APPS=()

usage() {
  cat <<'TXT'
Usage: approve-foreground-gui.sh --app NAME [--app NAME ...] [--ttl SECONDS]

Creates a single-use foreground-GUI approval for Mac Developer Bridge.

  --app NAME      Desktop application/process allowed to take foreground for ONE shell call.
                  Repeat for commands that intentionally coordinate multiple apps.
  --ttl SECONDS   15..300 seconds. Default 60.

Examples:
  ./scripts/approve-foreground-gui.sh --app Slack --ttl 60
  ./scripts/approve-foreground-gui.sh --app "Google Chrome" --ttl 60

There is deliberately no wildcard/all-apps option. Background-first remains the default.
TXT
}

while (( $# )); do
  case "$1" in
    --app) APPS+=("${2:-}"); shift 2 ;;
    --ttl) TTL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

(( ${#APPS[@]} )) || { printf 'At least one --app is required.\n' >&2; exit 2; }
[[ "$TTL" =~ ^[0-9]+$ ]] || { printf 'Invalid --ttl.\n' >&2; exit 2; }
(( TTL >= 15 && TTL <= MAX_TTL_SECONDS )) || { printf -- '--ttl must be between 15 and %s seconds.\n' "$MAX_TTL_SECONDS" >&2; exit 2; }

for app in "${APPS[@]}"; do
  [[ -n "$app" ]] || { printf 'Empty --app.\n' >&2; exit 2; }
  [[ "$app" != "*" && "$app" != "all" && "$app" != "ALL" ]] || { printf 'Wildcard/all-app foreground approval is intentionally unsupported.\n' >&2; exit 2; }
  case "$app" in
    *'"'*) printf 'Invalid --app value: %s\n' "$app" >&2; exit 2 ;;
  esac
done

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true
OPENSSL_BIN="$(command -v openssl || true)"
[[ -n "$OPENSSL_BIN" && -x "$OPENSSL_BIN" ]] || { printf 'openssl is required.\n' >&2; exit 1; }
NONCE="$("$OPENSSL_BIN" rand -hex 16)"
[[ "$NONCE" =~ ^[0-9a-fA-F]{32}$ ]] || { printf 'Failed to generate approval nonce.\n' >&2; exit 1; }
EXPIRES_AT="$(date -u -v "+${TTL}S" '+%Y-%m-%dT%H:%M:%SZ')"

apps_json=""
for app in "${APPS[@]}"; do
  [[ -z "$apps_json" ]] || apps_json="$apps_json, "
  apps_json="$apps_json\"$app\""
done

umask 077
cat > "$APPROVAL_FILE" <<JSON
{
  "nonce": "$NONCE",
  "expiresAt": "$EXPIRES_AT",
  "allowedApps": [$apps_json]
}
JSON
chmod 600 "$APPROVAL_FILE"

printf 'Approved ONE foreground GUI shell call.\n'
printf '  apps       : %s\n' "${APPS[*]}"
printf '  expires    : %s\n' "$EXPIRES_AT"
printf '  grant file : %s\n' "$APPROVAL_FILE"
printf '  nonce      : %s\n' "$NONCE"
printf '\nThe bridge consumes this grant before the focus-changing shell call runs.\n'
printf 'Revoke before use with: rm -f "%s"\n' "$APPROVAL_FILE"
