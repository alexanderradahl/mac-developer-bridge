# Background control event compatibility, November 13, 2026

This is a narrow tested overlay for an operator checkout with existing uncommitted repairs. It is not a replacement for the combined working tree, and it does not claim that every third-party control now works.

## Changes

- Populate native-compatible keyCode, which and charCode for the eight existing non-text keyboard actions. The prior Enter event reported keyCode/which as zero. All events remain untrusted. No default click, retry, focus spoof or permission change is added.
- Exact-text snapshots now include bounded ordinary DOM control context: at most four visible ancestors and the center hit target, with selectors, role, pointer-events and accessibility state. Default snapshot output is unchanged. There is no framework state, handler source, hidden text or arbitrary evaluation capability.
- Version the extension as 0.2.24, build browser-control-events-20261113.1. Update the existing source/version assertions.

## Apply and verify

Use manifest.json to check every baseline SHA-256 before applying control-events-only.patch with git apply. Copy the new test from this package into tests/ only when its destination is absent or its exact contents already match. Do not overwrite a concurrent revision. Keep a complete rollback copy of the baseline files.

The test uses a fresh disposable headless Chrome profile and owned offline HTML. It does not attach to a signed-in browser. Set MDB_BROWSER_TEST_BASELINE to the pre-patch worker to reproduce the missing-key-code behavior, then run node tests/chrome-control-events-real-browser.mjs. A separately installed Playwright is required. The existing installed Chrome channel is the default for this test.

Reload only the existing MDB extension using the public chrome_reload_extension maintenance tool with the currently running expected build ID. Reconcile the returned operation before any retry, then verify the loaded version/build and profile binding using bridge_status. Never change grants, restart the owner browser or add a debugger/foreground route to make a provider accept synthetic input.

## Acceptance and remaining issue

Six dedicated real-browser scenarios passed, including baseline reproduction, all allowed key fields compared with native browser input, cancellation, disabled/deadline checks and passive bounded target discovery. Additional source regression results are recorded separately.

Installed acceptance confirmed the new extension build. A newly entered tag was saved on an existing unpublished provider draft and survived reopening. Selecting an existing tag and assigning a collection still failed with the supported background controls. Those failures remain open; successful event dispatch or a retained input value is not saved application state. No post was published, scheduled or sent during acceptance.

For controlled tag inputs, choose the public native-value-setter strategy explicitly when native insert-text retains the DOM value without updating the application. Press Enter only after inspecting the field, then verify a real tag chip and reopen. This observation does not justify automatically switching strategies or replaying writes.

## Follow-up

Investigate the remaining background popover/collection behavior using owned reproducible fixtures and passive live observations. Do not invent its cause or claim end-to-end provider completion. Preserve all existing account settings and content while diagnosing it.
