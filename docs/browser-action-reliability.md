# Browser action reliability: bridge 0.3.6 / extension 0.2.16

## Purpose and scope

The October 7 repair addresses browser actions that acknowledged dispatch without establishing the expected page change. It repairs generic DOM actions, the native transport and diagnostic reporting. It does not add extension permissions, a general script-evaluation tool, a debugger backend, cookie access, a foreground browser-control route or automatic publication.

Initial repair development began at `94704cf6858f7ac5e315181a1b2d4a54e9df64b0`. The owner's prior local changes were verified byte-for-byte against composer revision `58fe6df295067668e8e0bfeb22730e7598b273cb`; the released repair branch builds on that revision. The first installed repair is commit `53f05edf99930cdb7fd53843fc4c852c9295860b`. The input-compatibility followup preserves that combined source. [Original-state hashes](releases/2026-10-07-browser-repair-original-state.json) and the installation receipts record preservation.

## Observable action contract

| Action | What is verified | What remains a separate application check |
|---|---|---|
| Snapshot | Visible text, controls and passive constraint-validity properties | Whether a business workflow is complete |
| Click | Event dispatch, control-associated activation and bounded popup observation | Saved account settings, created memberships or other durable effects |
| Fill | The current connected control retains the intended value under the selected comparison; optional blur commit | The application's domain-level acceptance |
| Drag | Original source and target identities, target drop acceptance, dispatched drop/end events | Persisted order or other application change; synthetic events are untrusted |
| Submit | Whether a submit event was observed or HTML validation blocked it | Server acceptance and persistence |
| Operation status | Recorded dispatch and eventual browser execution outcome | Whether the site's business operation succeeded |

`clicked` means an actual click event was dispatched. A control that activates on mousedown can have `clicked: false` with activation recorded separately. `submitted` is an alias for an observed submit event, not a copy of the caller's submit flag. A prevented submit event can be normal for a JavaScript application, so its `submitDefaultPrevented` value is reported separately.

### Click event compatibility

The pointer sequence finishes with a click carrying the same target coordinates, mouse pointer identity, window view and click count as its preceding events. The earlier `HTMLElement.click()` finish produced a keyboard-style event with detail 0 and coordinates 0/0 after a mouse sequence. The [native Chromium baseline](releases/2026-10-07-browser-input-compatibility-before.json) records that mismatch; the [followup regression](releases/2026-10-07-browser-input-compatibility-after.json) compares the corrected sequence and checks default activation. Synthetic events remain untrusted, and an account workflow still needs a fresh application readback.

The default `click_strategy: "adaptive-pointer"` retains that sequence. An explicitly selected `click_strategy: "dom-click"` performs one `HTMLElement.click()` after the normal target, visibility, disabled-state and deadline checks. It sends no pointer/hover/down prelude and does not focus the target. This is a separate programmatic activation choice for controls whose pointer handlers interfere with their click action; it is not a trusted hardware click or an automatic retry after a failed pointer sequence. Omitted and explicitly selected defaults retain the older wire payload; choosing `dom-click` changes the operation fingerprint.

~~~json
{
  "tab_id": 123,
  "selector": "#settings",
  "click_strategy": "dom-click",
  "operation_id": "settings-direct-20261007-01"
}
~~~

### Fill options

Existing calls retain the defaults `input_strategy: "set-value"`, `commit: "change"` and `normalization: "exact"`. For a numeric field that commits on blur:

~~~json
{
  "tab_id": 123,
  "selector": "#amount",
  "value": "5",
  "commit": "blur",
  "normalization": "numeric",
  "operation_id": "amount-example-20261007-01"
}
~~~

Numeric comparison is opt-in and limited to numeric input types or numeric/decimal input modes. It permits equivalent decimal formatting such as `5` and `5.00`, while preserving exact comparison for identifiers and ordinary text. Decimal normalization does not collapse different large integers through floating-point rounding.

For a text control that ignores direct value-setter events, choose `input_strategy: "insert-text"`. It selects the complete current value and invokes the browser's native text-editing command exactly once. Supported inputs are text, search, tel, url and password, plus textarea; unsupported control types are rejected before focus or mutation. Contenteditable retains its existing native editing behavior. The operation respects canceled edit intent and rechecks selection, focus, editability, replacement and deadline boundaries. If the browser does not accept the operation, there is no automatic value-setter fallback. Prefer `commit: "blur"` for native edits: the browser supplies its normal change event. Explicit `commit: "change"` sends a synthetic change while the field stays focused, and a later blur can produce an additional native change; use that mode only when its event semantics are intended. It does not add browser user activation or satisfy passkeys or other owner-presence challenges.

~~~json
{
  "tab_id": 123,
  "selector": "#amount",
  "value": "10.00",
  "input_strategy": "insert-text",
  "commit": "blur",
  "normalization": "exact",
  "operation_id": "amount-native-edit-20261007-01"
}
~~~

The additional explicit `input_strategy: "text-input"` supports text inputs and textarea controls whose framework listens for the legacy `textInput` event. It sends cancelable edit intent and one legacy TextEvent before the existing single native editing command. The React 19.2 probe measured that ordinary browser typing invokes React's `onBeforeInput` through this event, while `execCommand("insertText")` alone does not. This establishes a framework compatibility difference, not the cause of any particular provider failure.

This strategy rechecks cancellation, selection, focus, value changes, replacement, editability and the deadline after the legacy handler runs. It never follows a canceled or handler-mutated intent with another edit, and it has no fallback. It rejects unsupported controls, including contenteditable, before focus. Existing contenteditable and `insert-text` behavior is unchanged. Use `commit: "blur"` when one normal change event is intended. Event compatibility does not grant browser user activation or owner presence.

Omitted and explicitly selected `set-value` use the existing wire payload so older stable operation IDs remain compatible. Selecting either `insert-text` or `text-input` is a distinct logical action and contributes to the operation fingerprint.

The implementation resolves the current field after framework updates and checks its identity, visibility, editability and connectivity. Focus and beforeinput handlers can synchronously replace or lock a field, so editability is checked again before subsequent mutations. A rejected edit is not automatically written again. Contenteditable readback follows native block and line-break structure and retains exact spaces and line breaks.

`applicationAccepted: null` and `outcomeVerified: false` are deliberate: a generic DOM helper cannot establish that a Patreon tier or Google alias was saved. Use a fresh ordinary page readback for that check.

## Timeouts, duplicates and restart

Click, fill, open and navigate accept an optional stable `operation_id`. Every logical action also receives an ID when the caller omits one. An action deadline and a longer transport allowance are separate, allowing the native host to return an explicit deadline result before the client times out.

The mutation journal records dispatch metadata before writing the request to Chrome. It retains IDs, request fingerprints and lifecycle metadata, without request arguments, form values, page snapshots, response bodies or credentials. Matching duplicate requests reuse the existing operation or retained result; different arguments or grants with the same ID produce `CHROME_OPERATION_ID_CONFLICT`.

After an uncertain result, call:

~~~json
{ "operation_id": "amount-example-20261007-01" }
~~~

using `chrome_operation_status`. The result contains lifecycle metadata only. A dispatched action can complete after the original request timed out. A host restart preserves uncertainty and can reconcile a result retained by the surviving extension worker. Old asynchronous handlers reply only through their original live connection generation.

Each native host binds a short private Unix socket and publishes an owned symlink at the existing public path. Startup probes a live listener before touching the journal or PID file. Shutdown drains accepted handlers and removes only its own public endpoint. This matters because Node's own socket close unlinks its original bind pathname; a simple check around explicit unlink would not protect a replacement host.

A missing or expired record is not proof that an action did not happen. Status explicitly reports `retryable: false`; do not create a new ID and replay a write solely because its response was lost.

### Bounds

- Mutation history: 24 hours, at most 5,000 records.
- Passive status/list/snapshot operations: a separate five-minute, 256-entry memory budget.
- Retained result payloads: an 8 MiB budget for each host/worker ledger.
- Corrupt or unavailable mutation history: refuse mutations; passive inspection and status remain available.
- Capacity exhaustion: refuse additional mutations rather than evicting active mutation history and permitting duplicates.

These are bounded reconciliation guarantees, not permanent exactly-once delivery.

## Diagnostics and runtime identity

Client responses validate the envelope, matching ID and result/error structure. Partial frames at EOF fail promptly. Invalid responses expose their byte count, digest and safe category rather than raw content.

The shared diagnostic filter carries operation identity, dispatch state, target identities and fixed action labels through the native client and MCP boundary. The action failure `stage`, such as `verify`, is distinct from `operationStage`, such as `extension-response`. Lifecycle metadata cannot be replaced by page diagnostics. Fill values are redacted centrally in every audit mode, including error and revocation paths.

Existing ChatGPT conversation recovery retains its validated conversation/message identifiers and canonical conversation URL only for the ChatGPT conversation-start method. Query strings and fragments are removed. Generic browser errors, lifecycle status and the journal never inherit that recovery URL.

`bridge_status` includes the bridge's startup source hash, the native host's startup identity, the extension's embedded release identity and connection generation. Inspect `backgroundChrome.operations.journalHealthy` in addition to the profile/extension readiness flags. A connection heartbeat alone is not proof that writes are available.

## Regression evidence

[Before](releases/2026-10-07-browser-regression-before.json) and [after](releases/2026-10-07-browser-regression-after.json) receipts use the same fixture and runner. The unmodified baseline reproduced an ordinary button receiving no click, snapshots emitting invalid events, and a React currency form submitting a null amount despite displaying 5. The repaired worker passed all 19 scenarios. The [combined installation candidate](releases/2026-10-07-browser-regression-candidate.json), which preserves the owner's existing local changes, also passed the same 19 scenarios.

The React fixture uses React 19.2.0. Its own HTTP endpoint receives numeric 5 exactly once after the control formats the display as 5.00. Other scenarios cover control replacement, rejected edits, disabled/read-only transitions, cancelable input, native select/contenteditable behavior, eight exact whitespace cases, blocked submission and suspended animation frames.

The browser regression runs the exact production page-function source in isolated Linux Chromium 153. It uses a newly created mode-0700 profile and a loopback fixture server, blocks requests outside that server, and verifies browser/profile/server cleanup. It does not attach to the owner's browser. These receipts do not establish the installed Mac runtime or authenticated provider acceptance; those are separate deployment checks.

The Mac suites use real Unix sockets/native-host child processes and actual MCP dispatch with a controlled extension. They exercise malformed frames, deadline ordering, concurrent duplicate IDs, disconnects, late completion, host restart, corrupt history, retained startup identity, read/write capacity separation and diagnostic redaction. Sixteen transport groups include real competing-host startup and old-host shutdown tests, verifying the replacement endpoint remains reachable and rejected startup leaves the journal and PID bytes unchanged. Four method-scoped handoff scenarios check that existing ChatGPT recovery details survive without leaking into generic errors or status.

## Running the checks

The bridge itself keeps its zero-dependency runtime.

~~~sh
npm run check
npm test
npm run test:browser-reliability
~~~

The real-browser test uses separately installed test dependencies:

~~~sh
npm install --prefix /tmp/mdb-browser-test-deps --no-audit --no-fund playwright@1.62.1 react@19.2.0 react-dom@19.2.0 esbuild@0.25.11
/tmp/mdb-browser-test-deps/node_modules/.bin/playwright install chromium --only-shell
MDB_BROWSER_TEST_PLAYWRIGHT=/tmp/mdb-browser-test-deps/node_modules/playwright/index.mjs MDB_BROWSER_TEST_NODE_MODULES=/tmp/mdb-browser-test-deps/node_modules node tests/chrome-actions-real-browser.mjs
~~~

The recorded Linux run used the preinstalled Playwright 1.62.1 runtime and the separately installed `@sparticuz/chromium@153.0.0` package because the browser CDN download was unavailable in that environment. Its alternative is:

~~~sh
npm install --prefix /tmp/mdb-browser-test-deps --no-audit --no-fund @sparticuz/chromium@153.0.0
MDB_BROWSER_TEST_PLAYWRIGHT=/tmp/mdb-browser-test-deps/node_modules/playwright/index.mjs MDB_BROWSER_TEST_NODE_MODULES=/tmp/mdb-browser-test-deps/node_modules MDB_BROWSER_TEST_CHROMIUM_PACKAGE=/tmp/mdb-browser-test-deps/node_modules/@sparticuz/chromium/build/index.js node tests/chrome-actions-real-browser.mjs
~~~

No browser binary, third-party bundle or node_modules directory is vendored in this repository. The fixture bundles its small React test component at test time.

## Installation verification

1. Recheck the original file hashes and preserve all prior local changes in a combined candidate.
2. Run the syntax, full and focused tests on the combined source that will be installed.
3. Save the pre-install files and exact candidate hashes. Apply only the tested repair overlay.
4. Reload the existing unpacked extension through its supported local maintenance route. Keep its existing native-host registration and profile binding.
5. Restart only the bridge child through the existing supervisor path if required to load the new tool API. Do not restart the HTTP front end or change the unlock, account permissions or authentication configuration.
6. Verify the actual loaded hashes, extension version/release identity, native connection generation and mutation-journal health.
7. Use the supported Chrome tools for a disposable loopback smoke and fresh provider-state checks. A lost response must be reconciled before any account action is repeated.

The original host predates the new journal. Its missing persisted operation records do not prove that its transient pending map is empty. No old operation is replayed during upgrade.

## Inactive-tab focus and blur commits

The installed-extension acceptance page exposed a difference from an active headless page: a native focus/blur pair changed the document's active element but did not emit focus, focusin, blur or focusout while the document was hidden and unfocused. The React input handler ran, but the onBlur handler did not commit its model value.

For an actual target transition in an unfocused document, the fill path now observes the native event family and supplies only absent events. It checks the target, current focus, editability and deadline between callbacks. Native events are not duplicated, synthetic events remain untrusted, and the call does not activate the tab or window. The existing adaptive-click focus sites use the same bounded target-focus principle; direct DOM click mode still has no focus prelude.

Action receipts expose whether focus or blur event fallback was used. A retained DOM value still does not establish that the provider saved its application state; verify a fresh provider readback. The release receipts separate active-page regressions, installed inactive-page acceptance, and provider outcomes.

## Explicit HTML5 drag support

The October 8 update adds `chrome_drag` and passive discovery of explicit draggable controls. It retains URL/profile approvals and durable operation identities. The implementation sends one bounded HTML drag sequence, refuses ambiguous, disabled, replaced or pointer-only elements, requires target acceptance, and reports whether a drop was dispatched even when subsequent reconciliation fails. No extension permissions, arbitrary evaluation, caller-supplied drag payloads, credential access or foreground approval behavior change.

The isolated browser suite includes a native Chromium drag baseline and application-owned role ordering persisted through an HTTP receipt and fresh reload. It checks inactive-tab operation, before/after positioning, cancelled and rejected drags, ambiguous and disabled controls, element replacement, and deadlines before and during the action. A post-drop replacement must report the known dispatched drop without repeating it. Public MCP tests verify approved URL propagation, one dispatch per operation ID, conflicting reuse rejection, argument validation and sanitized outcome diagnostics.
