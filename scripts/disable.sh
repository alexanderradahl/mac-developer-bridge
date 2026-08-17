#!/bin/bash
set -uo pipefail

# Kill switch. Reports only what it actually verified.
#
# bridge.mjs re-reads the unlock file before every tool call, so removing it is
# already fail-closed: the next call is refused and the bridge exits 78. This
# script exists to reclaim what that cannot reach:
#   1. An in-flight command, and the serving processes themselves.
#   2. shell_start jobs, which spawn detached and unref'd so their process groups
#      outlive bridge.mjs. Their pgids are recorded in $DATA_DIR/jobs/*.json,
#      the only way to find them afterwards.
#   3. Interactive pty sessions, recorded in the same jobs directory with
#      kind:"pty" and processGroupId set to the setsid'd session leader.
#   4. Child MCP servers started by the federation gateway, recorded with
#      kind:"mcp-child" and their own pgid (they are spawned detached so the
#      group is reclaimable from here).
#   5. The background-Chrome native messaging host, which Chrome owns rather
#      than bridge.mjs and can otherwise survive the MCP processes.
#   6. The LaunchAgent, on the Tunnel transport (the HTTP transport has none).

LABEL="com.openai.mac-developer-bridge-tunnel"
DOMAIN="gui/$(id -u)"
DATA_DIR="${MAC_DEV_BRIDGE_DATA_DIR:-$HOME/Library/Application Support/MacDeveloperBridge}"
UNLOCK_FILE="${MAC_DEV_BRIDGE_UNLOCK_FILE:-$DATA_DIR/FULL_ACCESS_ENABLED}"
PERSONAL_BROWSER_APPROVAL_FILE="${MAC_DEV_BRIDGE_PERSONAL_APPROVAL_FILE:-$DATA_DIR/PERSONAL_BROWSER_APPROVED}"
FOREGROUND_GUI_APPROVAL_FILE="${MAC_DEV_BRIDGE_FOREGROUND_GUI_APPROVAL_FILE:-$DATA_DIR/FOREGROUND_GUI_APPROVED}"
# Not configurable: bridge.mjs hardcodes this location, so an override here
# would silently search a directory the bridge never writes to.
JOB_DIR="$DATA_DIR/jobs"
PID_FILE="$DATA_DIR/mcp-http.pid"
CHROME_NATIVE_PID_FILE="$DATA_DIR/chrome-native-host.pid"
CHROME_BACKGROUND_SOCKET="$DATA_DIR/chrome-background.sock"
BACKGROUND_CHROME_GRANT_DIR="$DATA_DIR/chrome-background-grants"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-$(command -v launchctl 2>/dev/null || true)}"
HTTP_PORT="${MAC_DEV_BRIDGE_HTTP_PORT:-8787}"
INSTALL_DIR="${MAC_DEV_BRIDGE_INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd -P)}"

did_something=0
still_running=0

# Identify our processes. A pidfile is authoritative; the scan is a fallback.
#
# Pattern scanning alone was wrong three ways: it matched command lines merely
# mentioning the filename, it missed node binaries named node22/node24 (which
# scripts/run-bridge.sh supports via NODE_BIN), and it matched other checkouts
# plus `node --check mcp-http.mjs`.
#
# True when $2 (a command line) is an interpreter RUNNING a script at $1.
# $1 may be a full path or a `*/basename` pattern. The script must sit directly
# after the executable with only dash-flags between; merely appearing in argv is
# not enough, or `node tests/http.mjs <path>` and `node -e '...' <path>` match.
# Shared by both identity checks. $1 is a LITERAL path; quoting it inside [[ =~ ]]
# is load-bearing — unquoted, an install path containing regex metacharacters
# stops matching, and `mac-developer-bridge (1)` from a second download is exactly
# that. A serving bridge there would be invisible and reported as contained.
_runs_script_impl() { # literal-or-pattern, cmdline, quote?(1=literal)
  local target="$1" cmd="$2" literal="$3" prefix
  # Only the tokens BEFORE the script path are interpreter flags. Scanning the
  # whole line would let `node bridge.mjs -p` exempt itself from the kill switch.
  prefix="${cmd%%"$target"*}"
  [[ "$prefix" == "$cmd" && "$literal" == 1 ]] && return 1   # target not present
  case " $prefix " in
    *" --check "*|*" -c "*|*" --eval "*|*" -e "*|*" --print "*|*" -p "*) return 1 ;;
  esac
  if [[ "$literal" == 1 ]]; then
    [[ "$cmd" =~ ^[^[:space:]]+([[:space:]]+-[^[:space:]]*)*[[:space:]]+"$target"([[:space:]]|$) ]]
  else
    [[ "$cmd" =~ ^[^[:space:]]+([[:space:]]+-[^[:space:]]*)*[[:space:]]+$target([[:space:]]|$) ]]
  fi
}

# Literal path match, for the fallback scan.
runs_script() { _runs_script_impl "$1" "$2" 1; }

# Pattern match on the basename, for the pidfile branch: the serving process may
# have been launched from a different copy than this script lives in.
#
# The directory prefix is OPTIONAL. DEPLOY.md's documented command is a bare
# `node mcp-http.mjs` from the package directory, so requiring a leading path
# made the pidfile check reject the real front end.
runs_script_basename() { _runs_script_impl "([^[:space:]]*/)?$1" "$2" 0; }

pids_for_script() {
  local script="$1" pid cmd resolved="$INSTALL_DIR/$1" script_pid_file=""
  case "$script" in
    mcp-http.mjs) script_pid_file="$PID_FILE" ;;
    chrome-native-host.mjs) script_pid_file="$CHROME_NATIVE_PID_FILE" ;;
  esac
  if [[ -n "$script_pid_file" && -f "$script_pid_file" ]]; then
    # First line only: concatenating digits across lines would fabricate a pid.
    pid="$(head -1 "$script_pid_file" | tr -dc '0-9')"
    # The pidfile is NOT self-cleaning — process.on("exit") does not run on
    # SIGKILL, and neither reboot nor uninstall.sh removes it. So confirm the pid
    # is really running this script before signalling it; a stale pidfile plus
    # pid reuse would otherwise kill an arbitrary process of the same user.
    if valid_target "$pid" && kill -0 "$pid" 2>/dev/null; then
      cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      # Positional check, same rule as the fallback. A loose substring test would
      # accept a recycled pid running `node tests/http.mjs <path>/mcp-http.mjs`.
      # The directory is left open here because the serving process may have been
      # launched from a different copy than this script lives in.
      if runs_script_basename "$script" "$cmd"; then
        printf '%s\n' "$pid"
        return 0
      fi
      printf 'Ignoring stale pidfile: pid %s is not running %s\n' "$pid" "$script" >&2
    fi
  fi
  for pid in $(pgrep -f "$script" 2>/dev/null || true); do
    [[ "$pid" == "$$" ]] && continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    # The path must be the script the interpreter is RUNNING: directly after the
    # executable, with only dash-flags between. Merely appearing somewhere in
    # argv is not enough -- that also matches `node tests/http.mjs <path>` and
    # `node -e '...' <path>`, neither of which is a serving process, and both of
    # which a kill switch must leave alone.
    runs_script "$resolved" "$cmd" || continue
    printf '%s\n' "$pid"
  done
}

# Refuse to signal anything but a real, specific pid/pgid.
#
# This exists because of the blast radius of the alternatives: `kill -TERM -1`
# signals EVERY process the user owns, and `kill -TERM -0` signals this script's
# own process group. A malformed or missing field in a job metadata file must
# never be able to produce either, so require a plain integer >= 2.
valid_target() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] || return 1
  (( $1 >= 2 )) || return 1
}

# True when the live process/group plausibly IS the recorded job, by start time.
#
# Job metadata is never pruned and macOS recycles pids, so an old entry can name
# a pgid now owned by something unrelated — which would then be SIGKILLed and
# reported as "Stopping background job". A process that started BEFORE the job
# was recorded cannot be part of it.
job_owns_target() { # metadata-path, target ("-pgid" or "pid")
  local meta="$1" target="$2" started started_epoch pid earliest lstart proc_epoch
  started="$(sed -n 's/.*"startedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$meta" | head -1)"
  # No recorded time: cannot verify, so do not signal.
  [[ -n "$started" ]] || return 1
  started_epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${started%%.*}" +%s 2>/dev/null || true)"
  [[ -n "$started_epoch" ]] || return 1

  if [[ "$target" == -* ]]; then
    earliest="$(pgrep -g "${target#-}" 2>/dev/null | head -1 || true)"
    pid="$earliest"
  else
    pid="$target"
  fi
  [[ -n "${pid:-}" ]] || return 1

  lstart="$(ps -o lstart= -p "$pid" 2>/dev/null || true)"
  [[ -n "$lstart" ]] || return 1
  proc_epoch="$(date -j -f '%a %b %e %H:%M:%S %Y' "$lstart" +%s 2>/dev/null || true)"
  # Unparseable start time: fail closed on the signal, not on the report.
  [[ -n "$proc_epoch" ]] || return 1
  # 5s slack for clock granularity between the two sources.
  (( proc_epoch + 5 >= started_epoch ))
}

# Read a numeric field from a job metadata file, validated.
job_field() { # metadata-path, field
  local v
  v="$(sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$1" | head -1)"
  valid_target "$v" || return 1
  printf '%s\n' "$v"
}

stop_pids() { # label, pids...
  local label="$1" pid; shift
  for pid in "$@"; do
    printf 'Stopping %s (pid %s)\n' "$label" "$pid"
    kill "$pid" 2>/dev/null || true
  done
}

# --- unlock file ------------------------------------------------------------
if [[ -e "$UNLOCK_FILE" || -L "$UNLOCK_FILE" ]] && [[ ! -f "$UNLOCK_FILE" ]]; then
  # A directory or dangling symlink here is not "absent" — it is an unlock path
  # that cannot be read. `rm -f` will not remove a directory, so report it rather
  # than printing the reassuring "already absent" line.
  printf 'UNLOCK PATH EXISTS BUT IS NOT A REGULAR FILE: %s\n' "$UNLOCK_FILE"
  printf '  Remove it by hand (rmdir/unlink). Until then this path cannot be a latch.\n'
  still_running=1
elif [[ -f "$UNLOCK_FILE" ]]; then
  if rm -f "$UNLOCK_FILE" 2>/dev/null && [[ ! -f "$UNLOCK_FILE" ]]; then
    printf 'Removed unlock file: %s\n' "$UNLOCK_FILE"
    did_something=1
  else
    # Anything with shell access could chmod the directory or chflags uchg the
    # file to defeat this. Never report success for it.
    printf 'FAILED to remove unlock file: %s\n' "$UNLOCK_FILE"
    printf '  Check directory permissions and `ls -lO` for a uchg flag.\n'
    still_running=1
  fi
else
  printf 'Unlock file already absent: %s\n' "$UNLOCK_FILE"
fi
printf '  (a running bridge re-checks this before each tool call and then exits)\n'

# Revoke pending one-shot authority too. Leaving either file behind after the
# kill switch would let the next bridge process consume an approval that the
# operator reasonably expected "disable" to have cancelled.
for approval_file in "$PERSONAL_BROWSER_APPROVAL_FILE" "$FOREGROUND_GUI_APPROVAL_FILE"; do
  if [[ -e "$approval_file" || -L "$approval_file" ]]; then
    if rm -f "$approval_file" 2>/dev/null && [[ ! -e "$approval_file" && ! -L "$approval_file" ]]; then
      printf 'Revoked pending approval: %s\n' "$approval_file"
      did_something=1
    else
      printf 'WARNING: failed to revoke pending approval: %s\n' "$approval_file"
      still_running=1
    fi
  fi
done

if [[ -d "$BACKGROUND_CHROME_GRANT_DIR" ]]; then
  if rm -rf "$BACKGROUND_CHROME_GRANT_DIR" 2>/dev/null && [[ ! -e "$BACKGROUND_CHROME_GRANT_DIR" ]]; then
    printf 'Revoked shared background-Chrome grants: %s\n' "$BACKGROUND_CHROME_GRANT_DIR"
    did_something=1
  else
    printf 'WARNING: failed to revoke shared background-Chrome grants: %s\n' "$BACKGROUND_CHROME_GRANT_DIR"
    still_running=1
  fi
fi

# --- LaunchAgent ------------------------------------------------------------
if [[ -n "$LAUNCHCTL_BIN" && -x "$LAUNCHCTL_BIN" ]]; then
  launchctl_out="$("$LAUNCHCTL_BIN" print "$DOMAIN/$LABEL" 2>&1)"
  launchctl_rc=$?
  if (( launchctl_rc == 0 )); then
    if "$LAUNCHCTL_BIN" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      printf 'Stopped LaunchAgent: %s\n' "$LABEL"
    else
      printf 'FAILED to boot out LaunchAgent %s\n' "$LABEL"
      still_running=1
    fi
    did_something=1
    # KeepAlive + ThrottleInterval means launchd can relaunch the chain up to
    # 10s later, after the checks below would otherwise have printed a verdict.
    if "$LAUNCHCTL_BIN" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      printf 'WARNING: LaunchAgent is STILL loaded; launchd may relaunch it (KeepAlive).\n'
      still_running=1
    fi
  elif [[ "$launchctl_out" == *"Could not find service"* || "$launchctl_out" == *"not find"* ]]; then
    printf 'No LaunchAgent loaded (expected on the Cloudflare/HTTP transport).\n'
  else
    # Commonly a non-GUI session: the gui/<uid> domain is unreachable over SSH,
    # so we cannot conclude the agent is absent.
    printf 'Could not query the LaunchAgent domain (%s). Cannot confirm it is stopped:\n' "$DOMAIN"
    printf '  %s\n' "$launchctl_out"
    still_running=1
  fi
fi

# --- serving processes ------------------------------------------------------
for script in mcp-http.mjs bridge.mjs chrome-native-host.mjs; do
  # shellcheck disable=SC2046
  pids=$(pids_for_script "$script")
  [[ -n "$pids" ]] || continue
  # shellcheck disable=SC2086
  stop_pids "$script" $pids
  did_something=1
done

# --- detached shell_start jobs ---------------------------------------------
# These survive bridge.mjs by design, so they are killed by process group.
#
# Build ONE target list and drive signal, escalation, and verification from it.
# Previously the kill used the process group but the verification used the leader
# pid, so a job running `sleep 300 &` — leader exits, group member survives —
# passed verification while still running. Killing and verifying by different
# predicates is what produced every false "Disabled" verdict in this script.
targets=()   # each entry is either "-<pgid>" (group) or "<pid>" (single process)
target_kinds=()   # parallel to targets, for the operator-facing wording only

# Reads the optional "kind" field and turns it into words. Presentation only:
# every kind is discovered, signalled, escalated and verified by the same
# field-driven path below, so a kind this script has never heard of is still
# reclaimed.
job_kind_label() { # metadata-path
  local kind
  kind="$(sed -n 's/.*"kind"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1)"
  case "$kind" in
    pty) printf 'pty session\n' ;;
    mcp-child) printf 'child MCP server\n' ;;
    *) printf 'background job\n' ;;
  esac
}

kind_for_target() { # target
  local i=0
  while (( i < ${#targets[@]} )); do
    if [[ "${targets[$i]}" == "$1" ]]; then
      printf '%s\n' "${target_kinds[$i]}"
      return 0
    fi
    i=$(( i + 1 ))
  done
  printf 'background job\n'
}

if [[ -d "$JOB_DIR" ]]; then
  for meta in "$JOB_DIR"/*.json; do
    [[ -f "$meta" ]] || continue
    pgid="$(job_field "$meta" processGroupId || true)"
    jpid="$(job_field "$meta" pid || true)"
    kind_label="$(job_kind_label "$meta")"
    # Ownership-check before adding, so a recycled pgid from stale metadata is
    # never signalled — the same protection the pidfile branch already applies.
    if valid_target "$pgid" && kill -0 "-$pgid" 2>/dev/null; then
      if job_owns_target "$meta" "-$pgid"; then
        targets+=("-$pgid")
        target_kinds+=("$kind_label")
      else
        printf 'Skipping stale job metadata %s: pgid %s predates the recorded job\n' \
          "$(basename "$meta")" "$pgid" >&2
      fi
    elif valid_target "$jpid" && kill -0 "$jpid" 2>/dev/null; then
      if job_owns_target "$meta" "$jpid"; then
        targets+=("$jpid")
        target_kinds+=("$kind_label")
      else
        printf 'Skipping stale job metadata %s: pid %s predates the recorded job\n' \
          "$(basename "$meta")" "$jpid" >&2
      fi
    fi
  done
fi

live_targets() { # echoes the subset of "$@" that still exists
  local t
  for t in "$@"; do
    [[ -n "$t" ]] || continue
    kill -0 "$t" 2>/dev/null && printf '%s\n' "$t"
  done
}

if (( ${#targets[@]} )); then
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    printf 'Stopping %s target %s\n' "$(kind_for_target "$t")" "$t"
    kill -TERM "$t" 2>/dev/null || true
    did_something=1
  done < <(live_targets "${targets[@]}")
fi

sleep 1

# --- escalate ---------------------------------------------------------------
for script in mcp-http.mjs bridge.mjs chrome-native-host.mjs; do
  pids=$(pids_for_script "$script")
  for pid in $pids; do
    printf '  pid %s ignored SIGTERM, sending SIGKILL\n' "$pid"
    kill -9 "$pid" 2>/dev/null || true
  done
done

if (( ${#targets[@]} )); then
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    printf '  %s target %s ignored SIGTERM, sending SIGKILL\n' "$(kind_for_target "$t")" "$t"
    kill -9 "$t" 2>/dev/null || true
  done < <(live_targets "${targets[@]}")
fi

sleep 1

# --- verify, using exactly the targets that were signalled ------------------
for script in mcp-http.mjs bridge.mjs chrome-native-host.mjs; do
  survivors=$(pids_for_script "$script")
  if [[ -n "$survivors" ]]; then
    printf '\nWARNING: %s is STILL RUNNING after SIGKILL: %s\n' "$script" "$(echo "$survivors" | tr '\n' ' ')"
    still_running=1
  fi
done

# A SIGKILL cannot run the native host's cleanup handlers. Once the process
# verification above proves it is gone, stale control-plane artifacts are safe
# to remove so a later extension connection cannot mistake them for a live host.
if [[ -z "$(pids_for_script chrome-native-host.mjs)" ]]; then
  rm -f "$CHROME_NATIVE_PID_FILE" "$CHROME_BACKGROUND_SOCKET" 2>/dev/null || true
fi

if (( ${#targets[@]} )); then
  job_survivors="$(live_targets "${targets[@]}" | tr '\n' ' ')"
  if [[ -n "${job_survivors// /}" ]]; then
    printf '\nWARNING: background job target(s) STILL RUNNING after SIGKILL: %s\n' "$job_survivors"
    still_running=1
  fi
fi

# A job process that left its group (setsid, a double-forking daemon) is in
# neither list and cannot be found from the recorded metadata at all.
printf '\nNote: processes that left their job process group cannot be detected here.\n'
# A federated child MCP server that launched a browser is exactly this case:
# Chrome re-parents itself out of the group, so killing the provider can leave a
# browser running — and in personal mode that browser is attached to the live
# profile. No group-kill containment is claimed for federated browsers.
printf 'Note: a browser launched by a child MCP server re-parents itself out of that\n'
printf '      group, so it may survive. Check for stray browser processes separately.\n'

# The port probe only covers $HTTP_PORT; if the front end was started with a
# different MAC_DEV_BRIDGE_HTTP_PORT than this shell has, the process re-check
# above is what establishes containment, not this.
if curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null 2>&1; then
  printf '\nWARNING: something is STILL LISTENING on 127.0.0.1:%s.\n' "$HTTP_PORT"
  printf '  lsof -nP -a -iTCP:%s -sTCP:LISTEN\n' "$HTTP_PORT"
  still_running=1
fi

# Match the executable, not any command line mentioning the word.
if pgrep -x cloudflared >/dev/null 2>&1; then
  printf '\nNOTE: cloudflared is still running, so the public hostname may still resolve.\n'
  printf 'Stop it with:  pkill -f "cloudflared tunnel"\n'
  still_running=1
fi

printf '\n'
if (( still_running )); then
  printf 'PARTIALLY disabled. Read the warnings above: this host is NOT contained.\n'
  printf 'The most reliable remote cutoff is deleting the plugin in ChatGPT.\n'
  exit 1
fi
if (( did_something )); then
  printf 'Disabled. Re-checked after SIGKILL: no front end, no bridge, no background\n'
  printf 'Chrome native host, no recorded background jobs running, and nothing answers\n'
  printf 'on 127.0.0.1:%s.\n' "$HTTP_PORT"
else
  printf 'Nothing was running and no unlock file was present.\n'
fi
