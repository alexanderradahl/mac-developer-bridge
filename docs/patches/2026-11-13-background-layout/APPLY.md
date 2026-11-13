# Applying this overlay

This package is a narrow patch over a combined operator working tree with prior
uncommitted repairs. The Git branch deliberately stores an overlay rather than
staging unrelated installed-source changes.

Check every existing file against manifest.json's baseline hashes and require all
new-file destinations absent before `git apply --check background-layout-only.patch`.
Never apply it blindly to the older clean Git base. After applying, verify installed
hashes, run npm run check and npm test, then npm run test:browser-popup with a separately
installed Playwright and a fresh isolated headless Chrome profile. The prior keyboard
suite uses its separately preserved pre-keycode worker as its comparison baseline.

Reload the existing MDB extension through the supported chrome_reload_extension
maintenance action with the exact running build. Do not bypass an active-operation
refusal or restart the owner browser. Verify bridge_status reports 0.2.25 and
browser-body-layout-bootstrap-20261113.8. A long-lived connector can discover/use the
new public tools with scripts/mcp-call-stdio.mjs without restarting the shared bridge.

Use the compatibility action only on an inactive saved MDB page after checking the
fresh URL/document guard and preserving unsaved user edits. See README.md for scope,
limits, the restoration-status read and native metadata verification workflow.

The owned installed fixture is tests/chrome-body-layout-installed-smoke.mjs. It starts
only a loopback server and prints its origin. Inspect it through ordinary public MDB
tools, compare the initial native-hidden result before/after an explicit bootstrap,
and close the owned tab/stop the fixture after acceptance. Do not attach a debugger
to the owner's browser or submit an account mutation merely to test a dropdown.
