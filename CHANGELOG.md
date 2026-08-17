# Changelog

## Unreleased

### Background Chrome without focus stealing

- Separated approval strictness from Chrome routing. Direct Chrome AppleScript/JXA, direct Chrome executable launches, and shell `open` calls for web URLs (including `open -g`) are always refused with `CHROME_BACKGROUND_REQUIRED` in both Relaxed and Strict modes, forcing browser work through the signed-in `MDB` tab group. This fixes a regression where Relaxed mode let other sessions bypass the extension, create ungrouped tabs, and steal foreground focus.
- Fixed test isolation so the federation/installer suites cannot target the live checkout or inherit/remove the running menu-bar bridge unlock file. Running `npm test` no longer causes the live MDB endpoint to fall into 502 afterward.
- Changed the product default to **relaxed approvals**: the signed-in MDB Chrome workspace can use normal HTTP/HTTPS sites and native foreground app control can execute without per-site/per-app terminal approval commands. Added a live **Strict approvals** checkbox to the menu-bar app; when enabled it restores the scoped background-Chrome grant pool and one-use foreground-app approvals.
- Added an optional Manifest V3 Chrome extension plus native-messaging host so ChatGPT can operate approved pages in the operator's real signed-in Chrome profile without routine focus theft. New built-in tools are `chrome_workspace_status`, `chrome_workspace_setup`, `chrome_tabs`, `chrome_open`, `chrome_navigate`, `chrome_snapshot`, `chrome_click`, `chrome_fill`, and `chrome_close`.
- Bound the native host to the selected signed-in Chrome profile/account and fail closed on signed-out or mismatched profiles.
- Added a Chrome-native **`MDB`** tab group with a reusable background-tab pool (four tabs by default, up to eight), per-tab leases, idle collapse, restart reconciliation, and group rediscovery. Routine `chrome_open` leases a pre-created tab rather than creating one; `chrome_close` returns it to the pool.
- Made workspace status/setup local and grantless. Reworked authenticated `chrome-background` approval into a shared additive grant pool: concurrent ChatGPT sessions can approve different domains without replacing one another, URL scopes are unioned while each grant remains unexpired, and active grants survive bridge-child restarts until their original expiry. Legacy fixed-file approvals are imported for backward compatibility. Federated personal-browser providers keep their single-use semantics.
- Refuse workspace creation/expansion unless Chrome is already focused. This is deliberate: measured on Chrome 151/macOS, even `tabs.create({active:false})` can bring Chrome to the foreground. Routine work therefore performs no tab creation after the one-time setup.
- Added background-first desktop GUI detection for native apps such as Slack. Relaxed mode still permits non-Chrome foreground UI when genuinely required; Strict mode requires a single-use, app-scoped, maximum-five-minute grant. The old model-controlled env bypass is gone, while Chrome is always forced through the separate `MDB` background routing rule above.
- Added a friendly cat/headphones/laptop extension icon and Chrome action icon at 16/32/48/128px.
- Deliberately did **not** expose arbitrary page JavaScript, network-header capture, or file uploads. Snapshot password values are redacted, and browser/OS security UI that requires trusted foreground interaction is reported rather than silently activated.
- Added `scripts/install-background-chrome.sh`, uninstall support, a mode-0600 local Unix socket, a native-host pidfile, profile binding, and kill-switch coverage so Chrome's native host cannot outlive bridge shutdown unnoticed.
- Added native-protocol/bridge regressions covering stable extension ID, profile matching/mismatch, offline setup behavior, grantless workspace operations, additive cross-session URL scopes, persistence across bridge restart, URL-pattern forwarding, grouped workspace routing, and foreground-GUI self-bypass rejection.

### Poisoned repository adversarial fixture

- Added a deterministic, disposable Git repository fixture covering malicious
  model-visible content in README/AGENTS guidance, source comments, test and
  package output, filenames, Git metadata, and synthetic credential-shaped
  files. The test drives the real stdio bridge, records that armed tools still
  expose their documented authority, then removes the file latch and verifies
  the next call exits 78 with an audit record. It executes no embedded
  instruction, makes no network request, and is not presented as a model safety
  benchmark or prompt-injection mitigation.

### Interactive pty sessions and the federation gateway: verifier findings

Blocking findings from independent verifiers of the new pty layer and child-MCP
gateway. Most fixes below have a regression test confirmed to fail against the unfixed
code — with two exceptions, stated plainly because a blanket claim here would be false:
the two pty terminal-sweep fixes (`teardown('parent_gone')` and the natural-exit sweep)
shipped with no test and were verified only by hand. Both now have one — "a naturally
exited session sweeps a disowned background job" and "a killed bridge lets the helper
sweep the terminal itself" — each confirmed to fail against the unfixed code.

- **The pty session cap was checked and then yielded on, so it did not bound
  anything.** `startPtySession` tested `PTY_MAX_SESSIONS` and then awaited
  `fsp.stat(cwd)` before registering anything, so concurrent `pty_start` calls all
  passed a check none of them had invalidated: measured, 60 concurrent starts
  produced 58 live ptys, 58 helper processes and 15 MB of rings against a cap of 8
  and a stated global retention bound of 2 MB. `kern.tty.ptmx_max` is 511
  *system-wide*, so a large enough batch takes Terminal.app, iTerm and `ssh` away
  from the operator — the operator's own route to `scripts/disable.sh` — and
  `mcp-http.mjs` caps neither connections nor concurrent requests. The slot is now
  reserved synchronously, before the first `await`, and released on every exit
  path. The counter bounds only how many starts may be in flight between the check
  and their entry in the table; it can make the cap stricter, never looser, and
  sequential use never sees it.
- **A killed helper left an orphaned shell that the bridge reported as live.** The
  pty child inherited the helper's fd 3 — the bridge's control pipe — so the pipe
  never reached EOF, `stdio[3]` never closed, and the `close` handler that
  reclaims the leader's group never ran. Measured: after `pkill -f ptyhelper.pl`
  the leader was still alive at t=20 s, reparented to pid 1, with `exited:false`
  in `bridge_status`, holding a session slot until the idle sweeper fired up to 15
  minutes later — and a `kill -9` of the bridge in that window left an
  unrestricted shell with nothing left to reclaim it. `ptyhelper.pl` now closes
  every inherited descriptor above stderr before `exec`, and the reclaim is bound
  to the helper's `exit` as well as its `close`, with a 250 ms grace so the normal
  path still drains the last of the transcript.
- **`pty_write` reported full success for input the terminal discarded.** In
  canonical mode the Darwin line discipline discards an input line of MAX_CANON
  (1024) bytes or more entirely rather than truncating it. Measured: 1023 bytes
  arrived intact; 1024, 2000, 4096, 20000 and 65000 all arrived as *nothing* while
  the tool returned the full `bytesWritten`. `pty_write` now asks the helper for
  the slave's real `ICANON` state — only when the payload would build an over-long
  line, so ordinary typing costs no extra round trip — and refuses with
  `PTY_WRITE_CANON_LIMIT` instead of reporting a delivery that did not happen.
  Bytes carry across calls until a `\r` or `\n`, because the limit is on the line
  the discipline is assembling, so chunking does not evade it. A session in raw
  mode is detected and allowed.
- **`pty_close` reported containment it had not achieved.** Interactive job
  control puts every background job — a plain `cmd &`, no `disown`, no `setsid` —
  in its own process group, which a kill aimed at `-leaderPid` never reaches.
  Measured: `containmentVerified:true` while `ps` showed the job running and
  reparented to pid 1. Reclaim paths now also SIGKILL anything still holding the
  session's controlling terminal, recorded with each process's start time while
  the helper still owns the device and re-verified against it before signalling,
  so a recycled pid is reported and not killed. `leaderGroupGone`,
  `ttyProcessesKilled`, `ttyRecycledSkipped` and `uncontainedPids` are reported
  separately, and `containmentVerified` is true only when nothing survived.
- **Default `pty_read` rendering deleted every CRLF-terminated line.** A tty in
  ONLCR turns the child's `\n` into `\r\n`, so a program that already emits CRLF
  arrives as `\r\r\n`; folding exactly one CR left a trailing CR, and the
  progress-redraw collapse then kept only what followed it — nothing. Measured:
  `printf 'alpha\r\nbeta\r\n'` rendered as two empty lines, with no `lostBytes`
  and no warning. Everything that prints CRLF on a terminal was affected: `ssh`,
  `git`, node's readline, every TUI. A run of CRs before a newline is now folded,
  and the redraw collapse still works.
- **`strip_ansi` was not read-boundary safe.** An escape sequence split by a slice
  boundary was stripped by neither read and reappeared when the client
  concatenated, so paged output differed from a single read. An unterminated
  sequence is now held back like a partial codepoint, bounded so an endless CSI
  parameter run cannot stall reads.
- Helper acknowledgements are correlated by request id instead of matched FIFO by
  kind. Four concurrent `pty_resize` calls each reported their own geometry as
  confirmed when the kernel held only one of them, and a concurrent `pty_signal`
  and the `SIGTERM` inside `pty_close` could consume each other's answer.
- **An automatic restart consumed the operator's next personal-browser grant.**
  `personalRefusal()` marks a refused grant terminal so it is never retried, but
  `scheduleRestart` never read the flag. Measured: with the provider restarting, a
  grant written for a future deliberate session was consumed 3 s later, with no
  tool call and no user action, relaunching the personal-profile browser. A
  personal-mode provider is no longer restarted automatically at all — each start
  spends a single-use approval — and a terminal start failure is no longer retried
  from the restart path either.
- **A personal-profile child outlived its grant indefinitely.** The TTL was
  enforced only inside `call()`, and `armPing()` keeps a child from ever idling
  out. Measured with a 2 s grant and zero tool calls: alive 6 s past expiry, state
  `ready`, and `bridge_status` still reporting the grant as live. A timer armed
  when the grant is consumed now shuts the child down at `expiresAt`, and
  `bridge_status` reports `expired` and `remainingMs` instead of presenting a
  lapsed grant as current.
- **A result above the framing cap SIGKILLed the child, and six such calls failed
  the provider permanently.** The 8 MiB pending-line cap sat *below* the 16 MB
  `maxResultBytes` a provider may be configured for, so the configured ceiling was
  unreachable by construction: a 12 MB reply was a kill rather than a
  `RESULT_TOO_LARGE`, and each kill was charged to the crash-restart budget, so
  six ordinary requests for a full-page screenshot ended in `state=failed` until
  the bridge was restarted. The cap now clears `MAX_MAX_RESULT_BYTES`, is applied
  to a single line rather than to the whole buffer (a chatty child emitting
  megabytes of good newline-terminated lines in one chunk used to trip it), and an
  over-cap line is discarded with a resync on the next newline instead of killing
  the child. Chunks are no longer concatenated per chunk, which at this cap would
  have been gigabytes of copying for one oversized line.
- **A provider that crashed before its first registration came back `ready`
  advertising nothing.** `registerTools({ firstStart: firstStart && !firstRegistrationDone })`
  was always false on a restart because `scheduleRestart` passes `firstStart:false`,
  and the flag was set unconditionally afterwards, so it never protected anything.
  Measured: after recovery, `toolCount 0`, `listTools` empty and every call
  answered "Unknown federated tool", permanently, while `bridge_status` showed
  `ready`. Registration state is now tracked by the branch that actually claims
  the names.
- A dead child's buffered stdout is no longer framed together with its
  replacement's first message, which had been consuming the successor's handshake
  reply and silently downgrading the protocol era.
- `bridge_status` no longer claims `state=failed after 5 restart attempts` when
  there were none.
- README now documents the pty tools, the federation gateway and every
  `bridge.mjs` environment variable, none of which were listed. SECURITY.md gains
  a pty section stating exactly what containment is and is not, and records the
  gaps this change does **not** close: unvalidated `allowedUrlPattern` argv
  injection, a grant consumed before the provider's own preconditions are checked,
  federated results carrying no provenance and an unfiltered `_meta`, child text
  copied verbatim into operator-facing logs, serial and uncapped provider startup,
  and `killNow()` leaving job metadata behind.

Added a second transport, because the OpenAI Secure MCP Tunnel connection type
is unavailable on personal ChatGPT accounts (the Tunnel option is present but
disabled; only Server URL is selectable).

- Added `mcp-http.mjs`, a Streamable-HTTP front end so the bridge can be reached
  as a ChatGPT "Server URL" plugin through Cloudflare Tunnel. It accepts either an
  OAuth 2.1 access token it issues itself or a static bearer token. ChatGPT's plugin
  dialog offers only OAuth / No Auth / Mixed with no API-key field, so OAuth is how
  ChatGPT connects; the bearer serves other Bearer-capable clients and gates consent.
- Requests are re-keyed onto server-side ids. Client JSON-RPC ids cannot be
  trusted to be unique — every MCP client starts its counter at 1 — so keying
  on them crossed responses between concurrent conversations.
- The bearer token is removed from the bridge child's environment, so it cannot
  be read back by `shell_exec`. Mirrors the existing `CONTROL_PLANE_API_KEY`
  scrubbing.
- Added `scripts/tcc-doctor.sh`, which reports whether the binaries in the
  runtime chain actually hold Full Disk Access. FDA cannot be granted by a
  script: the TCC databases are SIP-protected. The report states which session
  it measured, because TCC attributes access to the responsible parent process,
  so a result obtained from a terminal does not describe a launchd-spawned
  process. Print the ancestry chain to make that distinction visible.
- Made `scripts/doctor.sh` transport-aware. It previously reported four
  failures on a healthy Cloudflare setup, probing `tunnel-client`'s port-8080
  endpoints that do not exist on that transport.
- Fixed `startChild` orphaning a live, unkillable `bridge.mjs` when startup
  failed after the child was spawned but before it was published.
- Fixed the write-failure paths rejecting through the raw promise instead of the
  waiter, which left the timeout timer armed for its full duration (600 s for a
  request) after the request had already failed.
- Removed the `initialize` replay, `lastInitialize`, `sawInitialize`, and
  `requestOn`. Replaying `initialize` had no effect: `bridge.mjs` assigned
  `negotiatedProtocol` and read it back one line later purely to echo it, so no
  state survived. Only `notifications/initialized` needs replaying, because it
  sets `legacyInitialized`, which gates every non-ping method. `negotiatedProtocol`
  is now a local in `bridge.mjs`, so it no longer looks like session state a
  transport must restore.
- `MAC_DEV_BRIDGE_HTTP_TOKEN_FILE` read failures now exit 78 with a message
  naming the file, instead of an ENOENT stack with exit 1.
- Fixed a remote denial of service: a malformed request target that Node's HTTP
  parser accepts but `new URL` rejects (`//[/mcp`, an absolute-form target, or a
  malformed `Host` header) threw out of the async request handler and terminated
  the process — unauthenticated, in a single packet, before the bearer check.
  The target is now parsed defensively, the handler cannot throw, and
  `uncaughtException`/`unhandledRejection` guards match `bridge.mjs`.
- Fixed a failed startup returning a dead child, which left the triggering
  request hanging for the full 600-second timeout instead of returning 503.
- Fixed concurrent requests receiving a half-initialized child; `child` is now
  published only after the handshake replay completes.
- Revocation now SIGKILLs in-flight `shell_exec` process groups before exiting.
  Exiting without that cancelled the command's own timeout-kill, so the process
  outlived its declared `timeout_ms` unreported — and `shell_exec` writes no job
  metadata, so `disable.sh` could not find it either.
- Revocation exits once stdout has drained rather than after a fixed 50ms. With a
  large response queued, `process.exit()` truncated the JSON mid-line, so the
  client got an unparseable fragment and a closed pipe instead of the error.
- `bridge_status.fullAccessUnlocked` now reflects the live check instead of
  freezing at the startup value.
- Unlock read errors are classified by allowlist. `EISDIR`/`ELOOP` are permanent,
  so treating every non-`ENOENT` error as transient meant `rm -f <file> && mkdir
  <file>` disarmed the latch for good — and `disable.sh`'s `-f` test is false for
  a directory, so it reported "already absent" and exited 0 claiming containment.
- `disable.sh` restores literal quoting when matching the install path. Extracting
  the test into a function had made the path a regex, so an install under
  `mac-developer-bridge (1)` — what a second download produces — stopped matching
  and a serving bridge there survived a success verdict.
- `disable.sh` scans only the tokens before the script path for interpreter flags.
  Scanning the whole line let `node bridge.mjs -p` exempt itself entirely.
- `disable.sh` ownership-checks job targets by start time before signalling.
  Metadata is never pruned and pids are recycled, so a stale entry could SIGKILL
  an unrelated process group and report it as stopping a background job.
- Fixed the front-end identity check missing any install path containing a space —
  `mac-developer-bridge (1)` from a second download, or anything under "Application
  Support". It tokenized the command line on spaces, so an orphaned front end in such a
  directory was never reclaimed. It now compares against the known absolute path.
- Fixed the login-shell PATH guard accepting profile chatter. `!contains(" ") ||
  contains(":")` short-circuits on the colon, so `warning: /usr/local is out of date`
  passed and would have become the children's PATH. Every colon-separated component
  must now be an absolute path.
- Fixed the menu bar app deleting the tunnel's pidfile before cloudflared was dead.
  Real cloudflared catches SIGTERM and drains for seconds, so a Quit or crash inside
  that window left a live public tunnel whose only record had already been erased —
  reintroducing the very orphan bug the pidfile was added to prevent. The record is now
  removed only after the process is confirmed dead, and Quit sweeps the pidfile after
  the blocking stop, since a prior menu Stop has already cleared the process refs.
- Fixed a `/healthz` response that outlived a Stop reassigning "Starting…", which
  `poll()` then never corrected — the menu claimed it was bringing a public endpoint up
  while the bridge was stopped and disarmed.
- Corrected the exit-code descriptions: 78 from the front end is a token-file failure,
  not a missing unlock (that exit belongs to bridge.mjs, a grandchild it respawns), and
  neither 74 nor 78 is meaningful for cloudflared.
- Identity checks now anchor on the executable rather than a substring of the command
  line, and signal the process group. A substring test would kill a
  `tail -f cloudflared.log`, or an unrelated cloudflared tunnel the user runs for
  another service. The front-end check requires the script to be what the interpreter is
  actually running, matching `disable.sh`.
- The pidfile is no longer deleted when the identity check or `ps` merely fails, which
  had left a live process with no record pointing at it.
- `loginShellResolve`/`loginShellPATH` take the last non-empty line and verify the result
  is executable. A `.zprofile` that prints anything otherwise became part of the "path",
  so startup looked healthy and Start failed with an opaque spawn error.
- Added a `pid > 1` guard on every group signal. Foundation reports
  `processIdentifier == 0` for a process that never launched, and `kill(-0, …)` signals
  the app's own process group — which on a terminal launch includes the user's shell.
- Fixed the menu bar app leaving an unreclaimable public ingress. It recorded no
  pidfile for `cloudflared`, so a force-quit left the tunnel publishing, reparented to
  launchd; the next launch reported a clean baseline it had not reached, and the next
  Start added a second tunnel while the first stayed open forever. Both children are
  now recorded and identity-checked on launch.
- Fixed a dead child leaving its sibling running with the unlock file armed, while the
  UI reported "not running" and still offered the live public URL.
- The app no longer passes `MAC_DEV_BRIDGE_FULL_ACCESS_ACK` to children; inheriting it
  made `bridge.mjs` permanently unlocked and silently voided Stop.
- Fixed an unread stderr pipe in the login-shell probes that could block the shell once
  it filled, hanging the app at launch with no menu bar icon at all.
- Fixed `menubar/build.sh` deleting a running bundle, after which `open` reactivated the
  stale instance — so a rebuild could be tested while the old binary was still running.
  It also pins `-target …-macos13.0` so the binary matches `LSMinimumSystemVersion`.
- Menu bar Stop now signals the process group, so `bridge.mjs`'s `zsh -lc` grandchildren
  (an in-flight `shell_exec`) no longer survive; the poll timer runs in `.common` mode so
  the status line does not freeze while the menu is open; the token file is created 0600
  before content is written rather than chmod'ed after; and its validator matches the
  front end's (bytes and printable ASCII, not Character count).
- Added `menubar/` — a dependency-free AppKit status-bar app (swiftc, no Xcode
  project) that supervises `mcp-http.mjs` and `cloudflared`, shows connection
  status, and copies the URL and token. It owns its children, so Stop/Quit does
  not depend on discovering processes by name, and it arms/disarms the unlock
  file so stopping is fail-closed.
- Revocation is audited from inside the latch, awaited before the exit is
  scheduled. Relying on the caller's catch lost the record: the exit fires via
  `setImmediate` on an empty stdout and could beat the audit write, so the one
  event that must leave a trace was the one losing it.
- Fixed the consent page's `Approve` button doing nothing. The page sent
  `Content-Security-Policy: form-action 'self'`, and Chrome and Safari enforce
  `form-action` against the REDIRECTS a form submission follows — not just the POST
  target. So the POST succeeded, the code was minted, the 302 to ChatGPT came back,
  and the browser silently refused to follow it. No error, no navigation, and the
  server log said "authorization code issued", which made it look like a client-side
  problem. The policy now names the redirect origin, derived from the already
  allowlisted literal so it cannot be widened by client input; a rejected
  `redirect_uri` still gets the tight `'self'`.
- Bounded a remote unauthenticated memory-exhaustion crash. `MAX_BODY` capped one body
  at 8 MiB, but `requestTimeout = 0` — needed so a long `shell_exec` response is not cut
  off — also disables Node's deadline for RECEIVING a body, and `headersTimeout` covers
  only headers. A connection could finish its headers then dribble a body staying just
  under the cap forever, pinning ~8 MiB and never completing; 250 of them reached 1.75 GB
  and OOM-kill a process fronting unrestricted shell. Added a body-read deadline and a
  concurrent-body cap, both safe on every route because request bodies are small
  JSON-RPC and only responses are slow. Verified: 60 slow-body connections now cost 4 MB
  instead of ~500 MB.
- The menu bar app prefers a NAMED Cloudflare tunnel when `~/.cloudflared/config.yml`
  declares one, read from cloudflared's own config rather than a duplicated format. A
  quick tunnel's hostname changes every start, which forces the ChatGPT connector to be
  recreated each run and — because that hostname is the OAuth issuer — makes a restart
  between discovery and callback break the flow silently.
- `build.sh` installs the app to `/Applications`, and the bundle resolves the package
  via `MAC_DEV_BRIDGE_HOME`, then a sibling, then a path baked into `Info.plist`.
  Previously it only worked from inside the package directory, so it could only live in
  `~/Downloads`, where Launchpad and Spotlight never surface it.
- Every OAuth failure now logs through `oauthError`, and `/token` logs both arrival and
  successful issuance. Only some failures were logged and success was silent, so a token
  exchange that never arrived was indistinguishable from one that arrived and was
  refused — which made a real connector failure undiagnosable.
- Fixed OAuth rejecting every connector but the first. ChatGPT mints a NEW callback
  path per connector (`…/oauth/7WkU7U_Y2vFg` on one, `…/oauth/9Jf_WtxFPY80` on the
  next), so the hardcoded exact-match list failed with "Unrecognised redirect_uri" for
  any second connector. The ChatGPT callback shape is now validated by parsing the URL:
  https, host exactly `chatgpt.com`, no userinfo, no port, no query or fragment, and a
  path of `/connector/oauth/<token>`. Deliberately not a string prefix — that would
  accept `https://chatgpt.com.evil.com/…` and `https://chatgpt.com@evil.com/…`, turning
  the authorization endpoint into an open redirect that leaks codes.
- Closed an escape from the revocation latch: `MAC_DEV_BRIDGE_FULL_ACCESS_ACK` was
  copied into every `shell_exec`/`shell_start` child by `mergedEnv`, so any command the
  model ran could re-launch `bridge.mjs` with the acknowledgement already set. A bridge
  started that way never reads the unlock file, so removing the file could not stop it.
  The value is now captured at startup and deleted from the environment;
  `CONTROL_PLANE_API_KEY` was already scrubbed on the adjacent line and this one had
  been missed.
- Fixed the terminal-sweep record being sampled too slowly to catch its own cited
  reproduction. `pty_write` deferred its scan to "the next call" — backwards, since a
  write is the only operation that can create a terminal member — and the interval was
  1 s, so `nohup sleep 995 & disown; exit` escaped outright: measured surviving at gaps
  of 0 ms and 300 ms, reclaimed only at 1100 ms. A write now forces the scan and the
  interval is 150 ms. There was never a cost argument for 1 s: 400 back-to-back
  `pty_read` calls total 76 ms, p50 0.09 ms. Regression test uses the zero-gap case.
- `writeJobMetadata` writes to a temp file and renames. A plain `writeFile` let
  `process.exit` land between open and write, leaving a 0-byte file — `disable.sh`
  extracted no fields and built no target, so a live unrestricted process read as
  "no job".
- Added a revocation latch to federated providers. `Provider.start()` never re-checked
  `stopping` after its awaits (`mkdir`, `consumePersonalApproval`, `verifyFlags`), so a
  revocation landing in one of those windows took `killNow`'s "no child process" branch,
  reported `containmentVerified: true`, and the restart then spawned a fresh detached
  child past the kill switch — reproduced deterministically at a 4560 ms offset. The
  latch is set by `killNow()` only, never by `stop()`: `stop()` is part of the restart
  path, and latching there prevented providers from ever restarting. A provider revoked
  mid-start now reports `containmentVerified: false` rather than claiming success.
- Native tools no longer wait on federated provider startup. `tools/call` awaited
  `federationReady` unconditionally, so one slow provider blocked `bridge_status` — a
  native, read-only tool — for the whole start budget; capping the budget changed the
  number from 20 s to 15 s but not the coupling, and raising the deadline as the docs
  suggested restored 20 s exactly. `tools/list` still waits, because its answer is
  client-cached for 300 s with `listChanged: false`.
- Fixed `teardown('parent_gone')` in `lib/ptyhelper.pl` containing only the leader's
  process group. Interactive job control puts every `cmd &` in its own pgid, so a group
  kill does not contain a pty session — a `nohup sleep 940 &` survived a SIGKILLed
  bridge, reparented to pid 1. The helper now sweeps its own controlling terminal, and
  does so BEFORE the group kill: Darwin `revoke()`s the terminal when the session leader
  exits, so a sweep performed afterwards finds nothing at all.
- Fixed the controlling-terminal sweep being unreachable when a session ended naturally.
  It ran only from `killPtySession`, never from the close handler, so
  `nohup sleep 995 & ; disown ; exit` left a process that no reclaim path could find —
  the stale job metadata named the already-dead leader, so `disable.sh` skipped it too.
- Put a wall-clock deadline on federated provider startup
  (`MAC_DEV_BRIDGE_MCP_START_DEADLINE_MS`, default 15 s). Previously `fetchTools` allowed
  20 sequential `tools/list` pages at 15 s each and `startAll` awaited providers
  serially, so one slow provider could hold the entire tool surface — including native
  read-only tools — for up to 300 s per provider, additive.
- Fixed federation `containmentVerified` being evaluated one line after SIGKILL, while
  the child was still an unreaped zombie, so it recorded false even for a clean kill. A
  field that is never true carries no information, and a genuine escape was
  indistinguishable from the normal case. Now uses a bounded retry and reports
  `uncontainedPids`, matching `pty_close`.
- Fixed a provider that fails its handshake reporting `state: "stopped"` instead of
  `"failed"`, which hid `lastError` from both operator and model — a regression of a fix
  the surrounding comment already described.
- Removed dead federation state: `spawnArgs`, `negotiatedProtocol` (the exact
  write-then-echo pattern removed from `bridge.mjs` earlier), `lastGroupSweep`, and a
  duplicated `failedTerminally` assignment.
- Fixed the unlock re-check being armed only when a live-child count was non-zero at
  one instant during startup. A federated provider that crashed on its first start was
  still `restarting` at that moment, so the count read 0, the interval was never armed,
  and `Provider.start()` on the restart path had no callback to arm it later. The
  restarted child then ran with the kill switch inert — removing the unlock file caused
  no revocation whatsoever. Armed unconditionally now; the cost is one `readFile` per
  interval on an unref'd timer.
- Fixed a timed-out `pty_start` orphaning the shell it had already forked. SIGKILLing
  the helper skipped its own `teardown('parent_gone')`, the only code that kills the
  leader group, and `leaderPid` was still null so `killProcessGroup` refused as well —
  leaving an unrestricted process reparented to pid 1, absent from `bridge_status`, and
  with no job metadata for `disable.sh`. The helper's stdin is now closed first so it
  reclaims its own group, with SIGKILL as a bounded fallback.
- Tool errors now carry their `code`. The 15-value pty taxonomy was built and
  documented in README, then discarded at the transport boundary, so no client could
  see one and the tests had to match English prose. `name` is dropped; it was always
  the literal `"Error"`.
- `bridge_status.envKeysForwarded` no longer lists keys the child env builder refused —
  it was reporting `MAC_DEV_BRIDGE_FULL_ACCESS_ACK` as forwarded to a federated child.
  Enforcement was always correct; the field operators are told to audit was not.
- `pty_start`'s `idle_timeout_ms` is clamped to the operator's configured window, which
  README already described as a ceiling. A model could previously request an hour
  against a 60-second reclaim setting. The effective value is now in `bridge_status`.
- `shell_start` fails closed if its job metadata cannot be written, matching pty
  sessions and federated children. It was the one path that left a detached,
  unrecorded job that `disable.sh` could never find.
- **Made the unlock file a real latch.** `bridge.mjs` now re-reads it before every
  tool call and exits 78 when it is gone, so `rm` alone refuses the next call.
  Previously it was read once at startup and thereafter a frozen boolean, which
  meant containment had to be synthesized from outside by hunting processes —
  the layering error behind three consecutive false-"disabled" bugs. Authority
  over "is full access permitted right now" belongs beside the tools it gates.
- Fixed `disable.sh` killing background jobs by process group while verifying by
  leader pid. A job running `sleep 300 &` left the leader dead and a group member
  alive, and passed verification. Signal, escalation, and verification now all
  drive from one target list, so the verified set is definitionally the killed set.
- The pidfile pid is now cross-checked against the process's command line before
  being signalled. `process.on("exit")` does not run on `SIGKILL` and neither
  reboot nor `uninstall.sh` removes the file, so a stale pidfile plus pid reuse
  would have signalled an unrelated process.
- Added a hard guard rejecting any signal target below 2. A malformed job
  metadata file yielding `1` would have made `kill -TERM -1` signal every process
  the user owns; `0` would have killed the script's own session.
- Removed `MAC_DEV_BRIDGE_JOB_DIR`, which nothing else supported — setting it
  pointed the kill switch at a directory the bridge never writes to.
- Fixed the kill switch not stopping `shell_start` background jobs. They spawn
  detached and unref'd, so their process groups outlive `bridge.mjs`; the script
  hunted only `mcp-http.mjs`/`bridge.mjs` and then reported containment while a
  detached job kept running, reparented to pid 1. It now kills the process
  groups recorded in `$DATA_DIR/jobs/*.json` and re-checks each pid.
- `mcp-http.mjs` writes `$DATA_DIR/mcp-http.pid`, and `disable.sh` treats it as
  authoritative. Identifying the process by `pgrep` pattern was wrong three
  ways: it matched command lines that merely mentioned the filename, it missed
  node binaries named `node22`/`node24` (which `run-bridge.sh` supports via
  `NODE_BIN`) and then reported "Nothing was running" with exit 0, and it matched
  other checkouts plus `node --check mcp-http.mjs`. The fallback scan now
  requires the resolved install path to be the script the interpreter is running,
  not merely present in argv.
- `disable.sh` no longer claims success it did not verify: a failed `rm` of the
  unlock file, a failed `launchctl bootout`, and an unqueryable `launchctl`
  domain (routine over SSH, where `gui/<uid>` is unreachable) are all reported
  and set a non-zero exit. Previously each printed an affirmative line. The
  LaunchAgent is re-queried after bootout because `KeepAlive` with
  `ThrottleInterval=10` can relaunch the chain after the checks would have run.
- Fixed `mcp-http.mjs` recording only `notifications/initialized` while
  `bridge.mjs` also accepts the bare `initialized` alias. A client using the bare
  form was never replayed after a respawn and got `-32002` on every subsequent
  call, permanently, with no way to recover short of reconnecting.
- Fixed a stdin error leaving the child in place: no `exit` fires, so the child
  was never discarded and every later request got 503 with the waiter's timer
  still armed.
- Removed the now-unreachable try/catch in `startChild` (nothing awaits between
  spawn and the checks) and the comments asserting a hazard that no longer exists.
- `doctor.sh` no longer reports a mode-000 token file as "TOO OPEN" — `stat -f
  '%OLp'` drops leading zeros, so 000 arrived as "0" and fell into the
  world-readable branch, inverting the diagnosis.
- Rewrote `scripts/disable.sh`. It previously removed the unlock file, booted out
  a LaunchAgent that does not exist on the HTTP transport, and printed
  "disabled" unconditionally. Because `bridge.mjs` reads the unlock file only at
  startup, a running bridge kept serving `200` with unrestricted shell — verified
  end to end. It now stops the front end and bridge processes, probes the port to
  confirm, warns when `cloudflared` is still publishing, and exits non-zero
  rather than claiming success it cannot verify.
- Added `MAC_DEV_BRIDGE_HTTP_TOKEN_FILE`. An environment-passed token stays
  readable via `ps eww` for the process lifetime, since that reads the kernel's
  exec-time snapshot; a mode-0600 file avoids it.
- Added `tests/http.mjs` covering auth guards, cross-client id isolation, token
  scrubbing, malformed bodies, malformed request targets, and respawn replay.
- Fixed `tests/integration.mjs` comparing an unresolved `os.tmpdir()` against a
  shell-resolved `$PWD`; on macOS `/var` is a symlink to `/private/var`, so the
  assertion failed and aborted `install.sh` under `set -e`.

Not yet done: `install.sh` still hard-requires `tunnel-client` and a
`tunnel_...` id, so it cannot install the HTTP transport, and there is no
LaunchAgent for it — nothing restarts the front end after a crash or reboot.
`uninstall.sh` removes files but does not stop a running front end.

## 0.2.0 — 2026-07-29

- Added unrestricted foreground and background shell execution.
- Added complete filesystem read/write/management tools and unified patch application.
- Added read-only Codex thread list/read/turn pagination adapters through `codex app-server`.
- Added standard and current MCP protocol handling with structured tool results.
- Added full-access acknowledgement latch and immediate disable/enable scripts.
- Added metadata/full/off JSONL auditing.
- Added Secure MCP Tunnel installer, Keychain runtime-key storage, LaunchAgent persistence, diagnostics, and key rotation.
- Scrubbed the tunnel runtime key from the MCP process and child command environment.
- Added integration coverage for filesystem modes, symlinks, copy/move, patches, process lifecycle, Codex adapters, auditing, and secret scrubbing.
