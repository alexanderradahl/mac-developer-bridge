## Context

Codex sends OpenAI Responses requests to the local OpenCodex router. OpenCodex can route a qualified custom model to a private loopback Responses endpoint, but MDB currently exposes only an operation-specific conversation endpoint. The ChatGPT browser runtime returns rendered assistant text rather than native Codex Responses events or caller-owned function calls.

## Goals / Non-Goals

**Goals:**

- Publish separate fixed-standard and effort-selectable models through the existing OpenCodex catalog.
- Preserve the Codex tool loop by representing caller-provided function tools in a fixed protocol and converting a valid model-selected call back into Responses events.
- Support both streaming and non-streaming Responses clients.
- Keep authorization, prompt bounds, audit redaction, background leases, and no-retry ambiguity semantics.

**Non-Goals:**

- Add the browser model to any automatic failover chain.
- Expose ChatGPT-native hosted tools as Codex tools.
- Claim native Responses fidelity, token accounting, reasoning traces, parallel agent state, or server-side response persistence.
- Accept arbitrary browser scripts, selectors, request headers, or page credentials.

## Decisions

### Add a dedicated adapter module

`lib/chatgpt-responses-adapter.mjs` owns request validation, prompt serialization, protocol-envelope parsing, and Responses event construction. `mcp-http.mjs` owns only HTTP authentication, body limits, bridge invocation, and response delivery.

### Use a fixed JSON envelope for the model decision

The runtime prompt requires exactly one JSON object with either `{"kind":"message","text":"..."}` or `{"kind":"tool_calls","calls":[{"name":"...","arguments":{...}}]}`. The adapter validates tool names against the request, JSON-serializes arguments, and rejects mixed text/tool output or unknown calls. A bounded fence/object recovery path may remove Markdown fences. Plain non-JSON, non-tool-like text is normalized as a final assistant message because that path executes no caller tool; malformed JSON-like or tool-like output still fails closed and the adapter never invents a call.

ChatGPT sometimes serializes a declared Responses custom tool with the function-style wrapper `{"arguments":{"input":"..."}}` even though the canonical custom-tool field is the top-level `input` string. MDB accepts only that exact one-key wrapper and unwraps it deterministically. Extra keys, mixed top-level/wrapped input, non-string input, and every other custom-tool shape remain errors.

Codex may also present a logically free-form tool such as `exec` to an OpenAI-compatible provider as a function with exactly one required string `input` property. ChatGPT can answer that declaration with the custom-style top-level `input` field. MDB accepts this inverse form only when the declared function schema is exactly that closed one-property shape, then serializes it as ordinary function arguments. Other function schemas and mixed `input`/`arguments` calls remain errors.

The browser runtime can occasionally leave quotes inside that one raw `input` string unescaped, producing invalid outer JSON even though the selected tool and raw program are otherwise unambiguous. MDB may recover only the exact one-call top-level or one-key wrapped `input` shape for a declared custom tool or closed input-only function. Any second call, extra call property, unknown tool, or other structural ambiguity remains a classified failure.

### Verify the persisted assistant message before parsing

ChatGPT's live rendered assistant node can briefly expose a malformed transition fragment even after the initial request stream has handed off. MDB therefore treats the returned conversation id and assistant message id as the completion boundary: it reloads that exact conversation once, reads the exact persisted assistant message, and only then passes the text to the Responses envelope parser. This is a read-after-write verification of the accepted submission, not a retry or second model turn.

### Rebuild each turn from Responses input

The endpoint is stateless. Each request serializes the supplied instructions and input items, including prior assistant messages, function calls, and function-call outputs. OpenCodex will configure `statelessResponses: true`, so it expands or repairs replay state before the request reaches MDB.

### Emit the canonical minimal Responses sequence

Streaming calls receive `response.created` immediately after request validation, before the browser runtime is awaited. The endpoint sends bounded SSE keepalive comments while the browser model is working, then emits output-item/content or function-argument events and `response.completed`, followed by `data: [DONE]`. A post-start failure is represented by `response.failed` on that same stream. Non-streaming calls receive the equivalent completed response object. Usage values are explicitly zero because the browser runtime does not expose reliable token accounting.

### Keep the experiment isolated

The provider is named `chatgpt-runtime`. The fixed-standard model remains `chatgpt-runtime/chatgpt-browser`; the effort-selectable model is `chatgpt-runtime/chatgpt-sol` and activates ChatGPT's mounted `gpt-5-6-thinking` runtime. The existing default model, native aliases, combos, subagent models, and fallback chains remain unchanged.

### Translate Codex effort labels at the adapter boundary

Codex advertises `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, while the observed ChatGPT runtime accepts `low`, `standard`, `high`, and `max`. The adapter maps them monotonically: `low -> low`, `medium -> standard`, `high -> high`, `xhigh -> max`, `max -> max`, and `ultra -> max`. The fixed browser model ignores a caller reasoning field and remains `standard`.

### Bind through first-party Project composer state

An optional mode-0600 `$DATA_DIR/chatgpt-runtime.json` stores one `projectId`. When present, the runtime leases the Project's first-party page, supplies the model and thinking effort through its route state, and verifies the mounted `conversationMode` is `gizmo_interaction` for that exact Project before calling `submitComposer`. It never replays captured cookies, authorization, Sentinel, device, or proof fields.

## Risks / Trade-offs

- [Model ignores the JSON protocol] -> Reject the turn with a classified adapter error; do not convert prose into an inferred tool call.
- [Large Codex prompt/tool catalog] -> Match the live `gpt-5.6-sol` 372k-token catalog window and 334.8k auto-compaction threshold, while retaining an explicit 4,000,000-byte serialized runtime-prompt ceiling and returning 413 before submission when exceeded.
- [Prompt injection in tool output] -> Delimit every input item as data and repeat the protocol rule after the transcript; this reduces but cannot eliminate model-level prompt-injection risk.
- [Frontend runtime drift] -> Preserve the existing classified runtime-contract errors and no-UI fallback.
- [Project route or state drift] -> Refuse before submission unless the loaded path and mounted composer state both identify the configured Project.
- [Reasoning tier mismatch] -> Reject unsupported effort values and verify the thinking route state before dispatch.
- [Private consumer runtime instability] -> Keep the model visibly experimental and separate from production fallbacks.
- [Transient rendered response differs from persisted response] -> Reload the exact returned conversation and require the exact persisted assistant message id before protocol parsing; never resubmit the prompt.
- [Maximum thinking exceeds the caller's quiet-response threshold] -> Open and identify the SSE response before awaiting ChatGPT, emit periodic comments to keep the connection active, and complete or fail that same response stream without starting another browser turn.

## Migration Plan

1. Add and test the adapter and HTTP route.
2. Restart MDB and verify the endpoint directly with the static bearer.
3. Add the `chatgpt-runtime` OpenCodex provider with private-network opt-in and `statelessResponses: true`.
4. Add `chatgpt-browser` and `chatgpt-sol` to the custom model catalog and sync Codex.
5. Write the selected Project id to the private runtime configuration file.
6. Run Project-bound text turns at multiple Sol effort levels plus one harmless tool-call turn through the qualified model.
7. Roll back by removing the custom models/provider and Project configuration; existing routes are unaffected.
