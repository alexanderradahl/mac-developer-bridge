#!/bin/bash
set -euo pipefail

# Creates an expiring personal-profile browser grant. Federated providers use
# one single-use file; chrome-background uses additive shared grant files.
#
# Why this is a script the human runs and not a setting:
#
# Personal mode is a LARGER grant than shell access. evaluate_script against the
# live profile is arbitrary JavaScript in the origin of every authenticated
# session on this machine — mail, banking, cloud consoles. list_network_requests
# returns Authorization and Cookie headers unless --redactNetworkHeaders is set,
# and upload_file can read a local file into a web page as an exfiltration path.
# A config flag for that would be set-and-forget. Federated grants remain per-use;
# chrome-background grants are expiring, additive scopes shared across sessions.
#
# For federated providers bridge.mjs never creates the fixed approval file and
# consumes it once. For chrome-background, this script writes a unique grant file
# that remains active only until its original expiry and may be merged with others.
#
# Honest limit, also stated in SECURITY.md: shell_exec can forge this file. The
# gate stops an unattended model from drifting into personal mode and creates an
# audit record naming the nonce; it does not contain a model that has already
# decided to escalate.

DATA_DIR="${MAC_DEV_BRIDGE_DATA_DIR:-$HOME/Library/Application Support/MacDeveloperBridge}"
APPROVAL_FILE="${MAC_DEV_BRIDGE_PERSONAL_APPROVAL_FILE:-$DATA_DIR/PERSONAL_BROWSER_APPROVED}"
BACKGROUND_GRANT_DIR="${MAC_DEV_BRIDGE_BACKGROUND_CHROME_GRANT_DIR:-$DATA_DIR/chrome-background-grants}"
# 15 minutes is the ceiling bridge.mjs enforces at read time; anything longer is
# refused there, so there is no point offering it here.
MAX_TTL_SECONDS=900

usage() {
  cat <<'EOF'
Usage: approve-personal-browser.sh --provider KEY --url-pattern PATTERN [--url-pattern PATTERN ...] [--ttl SECONDS]

  --provider KEY      Federated provider key (e.g. "chrome") or the built-in
                      background browser key "chrome-background".
  --url-pattern P     A URLPattern the browser is restricted to. Required, repeatable.
                      Enforcement happens inside the browser: a federated Chrome
                      provider uses --allowedUrlPattern; chrome-background uses the
                      extension's URLPattern checks. The gateway does not string-match URLs.
  --ttl SECONDS       Grant lifetime, 30..900 seconds. Default 300.

For federated providers, the grant remains single-use. For provider
chrome-background, each approval is additive and shared across every ChatGPT
session connected to this bridge until that grant expires; active grants survive
bridge restarts until their original expiry.
EOF
}

PROVIDER=""
TTL=300
PATTERNS=()

while (( $# )); do
  case "$1" in
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --url-pattern) PATTERNS+=("${2:-}"); shift 2 ;;
    --ttl) TTL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$PROVIDER" ]] || { printf '--provider is required\n' >&2; exit 2; }
[[ "$PROVIDER" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { printf 'Invalid --provider (expected [A-Za-z0-9_-]{1,32})\n' >&2; exit 2; }
(( ${#PATTERNS[@]} )) || { printf 'At least one --url-pattern is required. An unrestricted personal browser is not an option this script offers.\n' >&2; exit 2; }
[[ "$TTL" =~ ^[0-9]+$ ]] || { printf 'Invalid --ttl\n' >&2; exit 2; }
(( TTL >= 30 )) || { printf -- '--ttl must be at least 30 seconds\n' >&2; exit 2; }
(( TTL <= MAX_TTL_SECONDS )) || { printf -- '--ttl must be at most %s seconds (bridge.mjs refuses anything longer at read time)\n' "$MAX_TTL_SECONDS" >&2; exit 2; }

for pattern in "${PATTERNS[@]}"; do
  [[ -n "$pattern" ]] || { printf 'Empty --url-pattern\n' >&2; exit 2; }
  case "$pattern" in
    *'"'*) printf 'A --url-pattern may not contain a double quote\n' >&2; exit 2 ;;
  esac
done

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

# Do not use `tr </dev/urandom | head -c 32` here while `pipefail` is enabled:
# `head` deliberately closes the pipe after 32 bytes, `tr` receives SIGPIPE, and
# `set -e` exits the script before it prints anything. `openssl rand -hex 16`
# produces the same 128 bits directly with no pipeline/SIGPIPE failure mode.
OPENSSL_BIN="$(command -v openssl || true)"
[[ -n "$OPENSSL_BIN" && -x "$OPENSSL_BIN" ]] || { printf 'openssl is required to generate the approval nonce\n' >&2; exit 1; }
NONCE="$("$OPENSSL_BIN" rand -hex 16)"
[[ "$NONCE" =~ ^[0-9a-fA-F]{32}$ ]] || { printf 'Failed to generate a valid 32-hex-character nonce\n' >&2; exit 1; }
EXPIRES_AT="$(date -u -v "+${TTL}S" '+%Y-%m-%dT%H:%M:%SZ')"

patterns_json=""
for pattern in "${PATTERNS[@]}"; do
  [[ -z "$patterns_json" ]] || patterns_json="$patterns_json, "
  patterns_json="$patterns_json\"$pattern\""
done

umask 077
if [[ "$PROVIDER" == "chrome-background" ]]; then
  mkdir -p "$BACKGROUND_GRANT_DIR"
  chmod 700 "$BACKGROUND_GRANT_DIR" 2>/dev/null || true
  TARGET_FILE="$BACKGROUND_GRANT_DIR/$NONCE.json"
else
  TARGET_FILE="$APPROVAL_FILE"
fi

cat >"$TARGET_FILE" <<EOF
{
  "nonce": "$NONCE",
  "expiresAt": "$EXPIRES_AT",
  "provider": "$PROVIDER",
  "allowedUrlPatterns": [$patterns_json]
}
EOF
chmod 600 "$TARGET_FILE"

printf 'Approved personal-profile browser mode for provider "%s".\n' "$PROVIDER"
printf '  grant file : %s\n' "$TARGET_FILE"
printf '  nonce      : %s   (recorded in the audit log for every call it authorises)\n' "$NONCE"
printf '  expires    : %s   (in %s seconds)\n' "$EXPIRES_AT" "$TTL"
printf '  url pattern: %s\n' "${PATTERNS[@]}"
if [[ "$PROVIDER" == "chrome-background" ]]; then
  printf '\nShared/additive: this URL scope is available to every ChatGPT session on this bridge until expiry.\n'
  printf 'Other chrome-background approvals are merged; they do not replace this one.\n'
  printf 'The grant survives bridge restarts until its original expiry.\n'
  printf 'Revoke this grant with: rm -f "%s"\n' "$TARGET_FILE"
else
  printf '\nSingle use: the bridge unlinks this file when it starts the provider.\n'
  printf 'Revoke before use with: rm -f "%s"\n' "$TARGET_FILE"
fi
