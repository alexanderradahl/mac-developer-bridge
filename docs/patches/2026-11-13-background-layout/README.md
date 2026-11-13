# Background layout compatibility

## Reproduced problem and acceptance

The November 13, 2026 investigation distinguished input dispatch from application
readiness. Patreon’s public viewport hook initially reports a pending state and
uses a native body ResizeObserver callback to choose its breakpoint. Until that
callback arrives, its menu wrapper renders the visual button without menu
handlers. In the observed hidden tab, ordinary clicks and stronger event details
could not fix an uninitialized control.

An owned localhost fixture reproduced the dependency using a native observer and
a menu that remained closed until the initial body measurement. The explicit
bootstrap changed the fixture from zero deliveries and no menu to one measured
delivery and an operable menu, with the tab still hidden.

The initial 32-delivery limit was insufficient on the actual editor. Its diagnostic
receipt reached the cap before all viewport hooks initialized. The final 256 cap
covered 77 observed body subscriptions and 76 supplemental initial deliveries. The
real collection menu then exposed its native menu semantics and all choices,
including the already-selected Supporter Notebook. Existing tag suggestions also
rendered. The original constructor was restored after the ten-second window, with
zero pending supplemental callbacks. No collection was toggled for testing.

This verifies the installed hidden-tab workflow observed in this session. It does
not establish universal compatibility with arbitrary controls or future site code.

## Explicit tools

`chrome_reload_for_background_layout` requires:

- `tab_id`: an inactive extension-owned MDB tab.
- `expected_url` and `expected_document_id`: from a fresh snapshot.
- `reload_saved_page: true`: acknowledgement that unsaved edits will be discarded.
- `operation_id`: a unique stable ID for the one reload.

The action reloads only the guarded URL. A temporary top-frame document-start
registration recognizes a nonce-scoped marker in that tab, restores its previous
window name, and wraps newly created ResizeObservers for ten seconds. It supplies
at most one supplemental initial body content-box notification per eligible
observer, with caps of 256 pending and 256 delivered callbacks. CSS content/border
box dimensions and writing mode are measured; hidden, disconnected or non-finite
geometry is skipped. Explicit other box modes are not supplemented. Native first
delivery wins; disconnect and unobserve cancel pending supplementation. Later
native notifications remain unchanged. There is no ongoing synthetic resize loop.

The temporary registration is removed after the reload action. The constructor is
restored on timeout or page exit. `chrome_background_layout_status` reads only the
bridge’s own bounded counters and restoration state; it cannot inspect app stores,
callbacks, credentials or private framework properties. A fresh page can return no
receipt. Installation and event dispatch remain distinct from saved app acceptance.

Do not reload an editor containing unsaved user work. Never bypass a rejected URL,
profile, document or inactive-tab guard. Reconcile uncertain reload outcomes before
considering another action. The feature needs no new extension permissions,
foreground browser control, debugger, user-gesture spoof, private endpoint or
arbitrary script-evaluation interface.

## Other compatibility improvements

Adaptive pointer clicks now include pointerenter and mouseenter with their native
non-bubbling, non-cancelable, non-composed characteristics. The complete measured
sequence matches the native owned-button reference. The explicit dom-click mode
remains a single activation without this pointer prelude.

Enhanced snapshots include bounded visible native labels, ancestor/control context,
popup geometry and external script source URLs without query strings. They never
return hidden popup text or inline script contents. Default snapshots stay unchanged.

The opt-in `observe_animation_frames` click diagnostic temporarily counts native
frame registrations/completions. It never forces a frame. The observer is removed
before the response, cancellation still works, and no callback source is exposed.
The diagnostic rejected an early frame-only explanation for the actual Patreon
collection button: no frames were registered because its menu handler was absent.

## Patreon metadata workflow

For a published post, verify the exact existing ID, title, body, audience and
notification settings before saving. Do not treat a successful click or retained
input value as a persisted setting. Open the native menu and confirm the selected
collection by its actual label and checked state.

An existing tag may make Enter defer to the suggestion menu instead of creating a
chip. With menus initialized, inspect and select the ordinary suggestion. A second
supported path is the editor’s native blur commit: fill the input with `set-value`
and `commit: blur`, then inspect the resulting chips. The app can consume/recreate
the input during a successful commit, so a CHROME_TARGET_CHANGED receipt requires
reconciliation, not automatic replay or an assumption of failure.

When updating a published post, open Emails and notifications and verify the
member-notification switch is off unless notification is expressly authorized.
Compare the protected body/title and access with the saved baseline, use Update
once, then reopen the published page and verify its tags/collection/media. The
November 13 forest post required only its missing development tag; its owner had
already published it in Supporter Notebook. No republication or member notification
was performed by this repair.

## Tests

`npm run check` and `npm test` include syntax and bootstrap/routing guards.
`npm run test:browser-popup` uses an isolated headless Chrome profile and owned
fixtures. It does not attach to the owner’s session. The prior keyboard regression
can additionally be run against its saved pre-keycode baseline. Installed acceptance
used the normal public bridge tools against an owned loopback fixture, then inspected
the authorized Patreon editor. Private receipts stay outside the public patch package.
