## Why

MDB can now submit one bounded prompt through the signed-in ChatGPT page runtime, but Codex and OpenCodex cannot select that transport as a model. Exposing a separate Responses-compatible model keeps the experiment explicit while allowing the normal Codex agent loop to remain in charge of local tools.

## What Changes

- Add an authenticated loopback `POST /v1/responses` endpoint backed by the existing ChatGPT runtime transport.
- Translate bounded Responses input, instructions, and function tools into one fixed protocol prompt for the ChatGPT runtime.
- Normalize the returned protocol envelope into standard Responses streaming or JSON output, including assistant messages and function calls.
- Reject unsupported hosted/custom tool types, malformed envelopes, oversized prompts, and ambiguous runtime handoffs without retrying.
- Register the endpoint in OpenCodex as separate `chatgpt-runtime/chatgpt-browser` and `chatgpt-runtime/chatgpt-sol` models; do not add either to existing failover chains.
- Map the Sol model's Codex reasoning-effort selection to ChatGPT's mounted `gpt-5-6-thinking` runtime tiers.
- Bind new browser-runtime conversations to an operator-configured ChatGPT Project through the mounted composer state.

## Capabilities

### New Capabilities

- `chatgpt-browser-model-provider`: Select the signed-in ChatGPT browser runtime as an explicit Responses-compatible model while preserving Codex-owned function execution.

### Modified Capabilities

None.

## Impact

- Affects the MDB loopback HTTP server, one isolated adapter module, the mounted ChatGPT runtime transport, protocol tests, operator documentation, and the local OpenCodex provider/model registry.
- Reuses the existing static MDB bearer token and browser-tab lease lifecycle.
- Does not expose ChatGPT cookies, request proof, or authorization material and does not change the default model or existing fallback routes.
