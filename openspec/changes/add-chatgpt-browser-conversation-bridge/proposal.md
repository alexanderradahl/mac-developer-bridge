## Why

Captured `chatgpt.com/backend-api/f/conversation` requests can prove that a browser session is capable of starting a ChatGPT conversation, but replaying their bearer and Sentinel headers is unsafe and short-lived. MDB needs a bounded experimental bridge that keeps browser credentials inside the authenticated ChatGPT tab while giving Codex and local orchestrators a stable, auditable call surface.

## What Changes

- Add an experimental `chatgpt_conversation_start` MCP tool that starts one conversation through an already-open, signed-in `chatgpt.com` tab.
- Add an authenticated, loopback-only HTTP endpoint for local orchestrators to call the same operation without exposing MDB's internal Chrome socket.
- Keep access tokens, cookies, and anti-abuse proofs inside the page context; never accept, return, persist, or audit them.
- Parse the bounded ChatGPT event stream into a stable result containing safe status, conversation/message identifiers, and assistant text when available.
- Fail closed when the normal page context cannot satisfy ChatGPT session or anti-abuse requirements. The bridge will not synthesize, solve, or bypass Sentinel/Turnstile proofs.
- Explicitly keep this endpoint out of automatic OpenCodex model failover: the private ChatGPT conversation protocol is not Responses API-compatible and does not preserve Codex tool-call semantics.

## Capabilities

### New Capabilities

- `chatgpt-browser-conversation-bridge`: Authenticated, secret-contained, bounded conversation kickoff through an existing ChatGPT browser session.

### Modified Capabilities

None.

## Impact

- Affected code: `bridge.mjs`, `mcp-http.mjs`, `lib/chrome-extension-client.mjs`, `chrome-extension/service-worker.js`, tests, and operator documentation.
- Runtime dependency: the existing MDB background-Chrome native host and an already-open signed-in `chatgpt.com` tab.
- Security posture: new externally mutating browser operation, protected by the existing MDB bearer/OAuth boundary, loopback binding, browser URL policy, unlock latch, bounded payloads, and metadata-only auditing.
- Compatibility: no new package dependency and no change to existing tools or OpenCodex routing defaults.
