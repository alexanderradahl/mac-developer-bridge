## Why

The existing experimental ChatGPT conversation bridge is blocked by browser-generated Sentinel, Turnstile, and proof material when it posts directly to the private conversation endpoint. A signed-in ChatGPT tab already runs the first-party submission pipeline that generates this material, so the bridge should invoke that runtime action directly instead of synthesizing credentials or automating the visible UI.

## What Changes

- Add a runtime-native transport that leases a background ChatGPT tab, discovers a narrowly identified first-party conversation action, and invokes that action without DOM typing or clicking.
- Observe the resulting conversation response without reading or returning authorization, cookie, Sentinel, Turnstile, or proof request headers.
- Return stable conversation identifiers and assistant text through the existing MCP tool and HTTP endpoint.
- Treat an ambiguous post-submit state as terminal and do not automatically submit the prompt again.
- Keep the raw private-request transport available only as an explicit diagnostic mode; make app-native submission the default.

## Capabilities

### New Capabilities

- `chatgpt-app-native-transport`: Submit a ChatGPT prompt through the signed-in page's first-party runtime action and observe the resulting response without UI automation or extraction of session credentials and proof material.

### Modified Capabilities

None.

## Impact

- Affects the Chrome extension background worker, native messaging timeout path, bridge tool handler, local HTTP endpoint, tests, and operator documentation.
- Uses the existing MDB background-tab lease pool and signed-in Chrome profile.
- Does not add a public OpenAI API dependency or expose browser session secrets to Codex/MCP clients.
