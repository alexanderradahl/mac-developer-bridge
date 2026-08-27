## Context

MDB already has three relevant boundaries: a bearer/OAuth-protected HTTP front end, a deterministic stdio MCP bridge, and a native host that executes fixed functions in the main world of approved Chrome tabs. The captured ChatGPT request includes a bearer token and short-lived Sentinel/Turnstile proof headers, so replaying it from Node would create a credential store and a brittle anti-abuse bypass. The only acceptable experiment is to execute inside an existing signed-in ChatGPT page and let the normal page context determine whether the request is permitted.

OpenCodex already uses ChatGPT's Codex backend through its supported Responses-compatible path. The `/backend-api/f/conversation` protocol is a different consumer ChatGPT protocol and cannot transparently preserve Codex tool definitions, function-call continuations, or Responses events.

## Goals / Non-Goals

**Goals:**

- Expose one stable MCP operation and one local HTTP operation for starting a new ChatGPT conversation.
- Keep ChatGPT access tokens, cookies, device identifiers, and proof headers inside the browser page.
- Bound prompt, response, event count, runtime, and returned text.
- Reuse MDB's unlock latch, browser profile binding, strict-mode URL grants, audit log, and background-tab policy.
- Return enough normalized data for a caller to identify the created conversation and inspect the final assistant text.

**Non-Goals:**

- Implement or imitate Sentinel proof-of-work, Turnstile, Arkose, or any other anti-abuse challenge.
- Accept copied authorization/proof headers from callers.
- Patch OpenAI's Chrome extension or call its private native-host protocol.
- Pretend the endpoint is an OpenAI Responses-compatible model provider or add it to automatic OpenCodex failover.
- Continue arbitrary existing ChatGPT conversations in the first version.

## Decisions

### Execute the request in the ChatGPT page main world

The Chrome extension will select an already-open `https://chatgpt.com/*` tab and execute a fixed `pageChatgptConversationStart` function in the main world. The function may obtain the current access token from ChatGPT's same-origin session endpoint, but it never returns that token. It submits the conversation request with same-origin credentials and only stable client headers. If ChatGPT requires proof material that the normal page context does not provide, the operation returns a bounded, classified failure.

Alternative considered: replay the captured cURL from Node. Rejected because it persists or transports secrets, expires quickly, and encourages bypassing anti-abuse controls.

### Provide explicit orchestration surfaces, not a model-provider shim

`chatgpt_conversation_start` is added to the MCP tool catalog. `POST /experimental/chatgpt/conversation` calls the same MCP tool through the existing child bridge and returns its normalized JSON result. The HTTP route is loopback-only and requires the static MDB bearer, even when the main MCP endpoint also supports OAuth.

Alternative considered: expose `/v1/responses` and register it as an OpenCodex provider. Rejected because ChatGPT conversation events do not preserve Codex's arbitrary tool schemas or Responses continuation semantics; automatic failover would appear healthy while silently disabling core Work Mode behavior.

### Redact the prompt from every audit mode

The centralized audit sanitizer will replace `prompt` for this tool with byte length and a SHA-256 prefix before metadata or full audit serialization. Browser credentials are never bridge arguments and therefore cannot enter the audit path.

### Normalize and bound the event stream in the page

The page function reads at most 4 MiB, 2,000 SSE data frames, 100,000 output characters, and 180 seconds. It recognizes conversation/message identifiers and assistant text from known event shapes while retaining only safe event type names for diagnostics. Unknown events do not expose raw payloads.

### Keep live activation explicit

Source and tests can be installed without changing OpenCodex configuration. The running MDB/Chrome extension must be reloaded before live use, and the operator can remove or disable the route by rolling back the code or stopping MDB.

## Risks / Trade-offs

- [Private ChatGPT protocol changes] -> Return classified `CHATGPT_CONVERSATION_PROTOCOL_CHANGED` failures, keep parsing conservative, and cover captured fixture shapes in tests.
- [Normal page fetch lacks required Sentinel proofs] -> Fail closed with `CHATGPT_CONVERSATION_REQUIREMENTS_UNAVAILABLE`; do not synthesize or accept proof tokens.
- [Conversation is created but the stream disconnects] -> Return any observed conversation ID with `complete: false` and an explicit terminal error so callers do not retry blindly.
- [Prompt appears in logs] -> Central audit redaction applies before both metadata previews and full argument storage; HTTP logs contain route/status only.
- [Remote tunnel reaches the experimental route] -> Enforce kernel peer loopback plus static bearer before reading or dispatching the request body.
- [The endpoint is mistaken for an OpenCodex fallback] -> Use an `/experimental/` path, omit `/v1/responses`, and document the semantic mismatch.

## Migration Plan

1. Add source, unit tests, and documentation without changing active router configuration.
2. Reload the unpacked MDB Chrome extension and restart the MDB HTTP service.
3. Run a bounded single-prompt live verification against an already-open ChatGPT tab.
4. If the page context cannot satisfy ChatGPT requirements, retain the endpoint as a fail-closed probe and do not add a credential/proof workaround.
5. Roll back by reverting the change and restarting MDB; no persisted conversation credentials or schema migrations require cleanup.

## Open Questions

- No unresolved implementation question remains for this bounded experiment. Live verification on August 25, 2026 established that the current ChatGPT page context returns HTTP 403 unless browser-generated requirements/proof material is supplied. MDB therefore exposes the operation and its stable fail-closed classification but does not cross that boundary.

## Verification Outcome

- The unit fixture verifies successful plain-SSE normalization, credential containment, proof-requirement classification, and unknown-encoding failure.
- The full MDB test suite passes with the new MCP and HTTP boundaries.
- The live unpacked extension reached `/backend-api/f/conversation` from an inactive signed-in ChatGPT tab and returned `CHATGPT_CONVERSATION_REQUIREMENTS_UNAVAILABLE` with HTTP status 403.
- After restarting the menu-bar service, `/experimental/chatgpt/conversation` is active on port 8787, returns `Cache-Control: no-store`, maps the live boundary to HTTP 424, and `tools/list` advertises `chatgpt_conversation_start`.
