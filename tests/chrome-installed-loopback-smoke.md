# Installed MDB loopback acceptance

The isolated browser suite runs in an active browser document. This opt-in
fixture checks the installed extension in a genuinely inactive Chrome tab:
`document.visibilityState` is `hidden`, and `document.hasFocus()` is `false`.
It starts only a local HTTP server. It never opens a browser, selects a profile,
accesses provider accounts, or invokes browser automation itself.

Use the same optional dependency directory as the real-browser suite. The
measured versions are React/ReactDOM 19.2.0 and esbuild 0.25.11:

```sh
npm install --prefix /tmp/mdb-browser-test-deps react@19.2.0 react-dom@19.2.0 esbuild@0.25.11
MDB_BROWSER_TEST_NODE_MODULES=/tmp/mdb-browser-test-deps/node_modules \
  node tests/chrome-installed-loopback-smoke.mjs
```

The server prints its random `127.0.0.1` origin, PID, dependency versions, and
temporary receipt directory. The React bundle is built in memory and served
locally; no third-party source or generated bundle is committed. CSP permits
only this origin's scripts and network requests. No cookie or credential API
is used. The fixture accepts only the fixed numeric amount 10.

Use public MDB tools for the following explicit acceptance steps:

1. Confirm the installed bridge/extension versions and an idle workspace slot.
   Open the printed origin in that idle slot without activating Chrome. If no
   slot exists, stop; reuse an existing completed-task tab only when its owner
   has explicitly authorized that reversible navigation and verified no
   unsaved work. Record its original URL for restoration.
2. Snapshot the fixture. Verify the returned selectors and initial visible
   evidence: actual React amount `null`, hidden visibility, no document focus,
   active element `BODY`, and zero event counts.
3. Call `chrome_fill` once with the observed `#smoke-amount` selector, value
   `10`, `input_strategy: "text-input"`, `commit: "blur"`,
   `normalization: "numeric"`, and `submit: false`. Use a unique operation ID.
4. Snapshot again. Successful application acceptance requires actual React
   amount 10, display value 10.00, and one React BeforeInput/Input/Change each.
   The page also exposes focus/focusin/blur/focusout, native input/change,
   `isTrusted`, active element, visibility, and document focus. Do not infer
   application success from a tool's retained DOM value alone.
5. Click the observed `#smoke-submit` once, then the observed `#direct-action`
   once with `click_strategy: "dom-click"`. Snapshot the actual outcomes:
   accepted amount 10, submission count 1, direct click 1, direct mousedown 0,
   and direct accepted 1. Native user activation is not claimed.
6. Preserve the public tool operation IDs, visible evidence, exact worker
   hash, and local `receipt.json`. If an action times out, reconcile its same
   operation ID and snapshot before considering another action; do not replay.
7. Release only a newly owned fixture lease, or restore and read back the
   original URL of an authorized reused tab without closing/releasing it.
   Stop the printed server PID, verify the port is closed, and remove only the
   printed temporary receipt directory after preserving the result.

No provider publication, messages, account changes, foreground activation,
CDP attachment, or arbitrary JavaScript in a user profile is part of this test.
