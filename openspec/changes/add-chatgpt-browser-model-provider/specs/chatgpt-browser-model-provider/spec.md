## ADDED Requirements

### Requirement: Publish an explicit browser-runtime model
The system SHALL publish the signed-in ChatGPT browser runtime as the separate Codex-visible models `chatgpt-runtime/chatgpt-browser` and `chatgpt-runtime/chatgpt-sol` and SHALL NOT add either to an existing default or fallback chain.

#### Scenario: Model catalog is synchronized
- **WHEN** OpenCodex synchronizes its configured providers and custom models
- **THEN** both browser-runtime models appear as separately selectable models and all existing model routes retain their prior targets

#### Scenario: Context metadata matches GPT-5.6 Sol
- **WHEN** the browser-runtime model is written to the Codex catalog
- **THEN** it advertises the same 372,000-token context window and 334,800-token auto-compaction threshold as the live `gpt-5.6-sol` entry

### Requirement: Expose Sol reasoning effort
The Sol browser-runtime model SHALL activate ChatGPT's `gpt-5-6-thinking` model and SHALL translate Codex reasoning levels to a supported ChatGPT thinking effort before submission.

#### Scenario: Codex selects an effort
- **WHEN** Codex sends `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` for `chatgpt-runtime/chatgpt-sol`
- **THEN** MDB maps it to `low`, `standard`, `high`, `max`, `max`, or `max` respectively and verifies the mounted thinking route state before dispatch

#### Scenario: Fixed browser model receives reasoning metadata
- **WHEN** Codex sends reasoning metadata for `chatgpt-runtime/chatgpt-browser`
- **THEN** MDB retains that model's fixed `standard` ChatGPT thinking setting

### Requirement: Bind configured conversations to one ChatGPT Project
MDB SHALL load an optional validated Project id from its private runtime configuration and SHALL bind every new browser-runtime model conversation to that Project through first-party composer state.

#### Scenario: Project is configured
- **WHEN** a browser-runtime Responses turn starts and `$DATA_DIR/chatgpt-runtime.json` contains a valid `g-p-...` Project id
- **THEN** MDB leases the Project page and submits only after both the page route and mounted `conversationMode` identify that exact Project

#### Scenario: Project state does not match
- **WHEN** the loaded page or mounted composer state identifies another Project or primary-assistant mode
- **THEN** MDB returns a classified project-mismatch failure before submission

#### Scenario: Private request evidence is supplied
- **WHEN** a captured ChatGPT request contains cookies, authorization, Sentinel, device, session, or proof fields
- **THEN** MDB uses only the non-secret model, effort, Project-route, and conversation-mode contract and never persists or replays the private fields

### Requirement: Accept authenticated Responses requests
MDB SHALL accept bounded `POST /v1/responses` requests only from loopback clients presenting the static MDB bearer token.

#### Scenario: Authorized loopback request
- **WHEN** a loopback client sends a valid Responses request with the static bearer
- **THEN** MDB validates and processes the request with `Cache-Control: no-store`

#### Scenario: Missing or OAuth credential
- **WHEN** the endpoint receives no credential, a wrong credential, or an MDB OAuth access token
- **THEN** MDB returns 401 before invoking the browser runtime

### Requirement: Preserve Codex-owned function execution
The adapter SHALL serialize caller-provided function tools, including functions grouped under Responses namespaces, into a fixed decision protocol and SHALL convert only a valid, allowlisted tool-call envelope into standard Responses function-call events.

#### Scenario: Model selects a valid function
- **WHEN** the runtime returns a valid tool-call envelope naming a supplied function with JSON arguments
- **THEN** the endpoint emits a completed function-call output item that Codex can execute and replay on the next turn

#### Scenario: Free-form tool represented as an input-only function
- **WHEN** Codex supplies a function whose closed schema contains exactly one required string `input` property and the runtime returns that call with a top-level string `input`
- **THEN** MDB converts the value to the function's canonical `{ input: <string> }` arguments

#### Scenario: Ambiguous input-only function handoff
- **WHEN** a function call mixes top-level `input` with `arguments`, or the declared function schema is not the exact closed input-only shape
- **THEN** MDB rejects the turn and emits no tool call

#### Scenario: Runtime leaves quotes unescaped in one raw input
- **WHEN** the runtime returns invalid outer JSON whose complete structure is still exactly one allowlisted custom or closed input-only function call with one string input
- **THEN** MDB recovers that raw input without changing it and emits the canonical single tool call

#### Scenario: Malformed raw-input structure is ambiguous
- **WHEN** malformed outer JSON could contain a second call, an extra call property, or any structure beyond the exact one-call input form
- **THEN** MDB rejects the turn and emits no tool call

#### Scenario: Model selects a namespaced function
- **WHEN** the runtime selects the exact flattened name of a function supplied inside a namespace tool
- **THEN** the endpoint restores the native function name plus namespace on the completed function-call output item

#### Scenario: Runtime wraps a custom-tool input like function arguments
- **WHEN** a declared custom tool is returned as `arguments: { input: <string> }` with no other argument keys or top-level input
- **THEN** MDB unwraps that exact string into the canonical Responses `custom_tool_call.input`

#### Scenario: Runtime returns an ambiguous custom-tool wrapper
- **WHEN** a custom-tool call mixes top-level and wrapped input, adds wrapper keys, or supplies a non-string input
- **THEN** MDB rejects the turn and emits no tool call

#### Scenario: Model names an unknown function
- **WHEN** the runtime returns a function name not present in the request
- **THEN** the endpoint returns a classified failed response and does not execute or substitute a tool

### Requirement: Return assistant messages through Responses
The adapter SHALL normalize a valid message envelope into the canonical Responses assistant-message sequence for streaming clients and an equivalent completed response object for non-streaming clients.

#### Scenario: Streaming message completion
- **WHEN** `stream` is true and the runtime returns a valid message envelope
- **THEN** MDB emits created before waiting for the browser runtime, keeps that stream active during long thinking, and later emits message/content, completed, and done events with the assistant text

#### Scenario: Streaming runtime failure after creation
- **WHEN** a streaming request has emitted `response.created` and the browser runtime later fails
- **THEN** MDB emits `response.failed` and done on that same response stream without submitting another browser turn

#### Scenario: Non-streaming message completion
- **WHEN** `stream` is false and the runtime returns a valid message envelope
- **THEN** MDB returns one completed Responses JSON object with the assistant message in `output`

#### Scenario: Runtime returns plain final text
- **WHEN** the runtime returns non-empty text that is neither JSON-like nor tool-like
- **THEN** MDB treats it as a final assistant message and never infers or executes a tool call

### Requirement: Fail closed on unsupported or ambiguous turns
The adapter MUST omit Codex's known API-hosted web-search declaration, reject other unsupported hosted/custom tool types, and reject oversized prompts, malformed JSON-like/tool-like protocol envelopes, and incomplete runtime handoffs without retrying or falling back to UI automation.

#### Scenario: Unsupported tool type
- **WHEN** the request contains a tool type other than a supported function definition
- **THEN** MDB returns 400 before browser submission

#### Scenario: Codex advertises hosted web search
- **WHEN** an ordinary Work-mode request includes `web_search` or `web_search_preview`
- **THEN** MDB omits that unavailable API-hosted capability and preserves the caller-owned function/custom/namespace tools for the turn

#### Scenario: Runtime result is ambiguous
- **WHEN** the underlying runtime cannot prove completion after submission
- **THEN** MDB returns a failed Responses result and performs no second submission

#### Scenario: Live rendered node is transient or malformed
- **WHEN** the accepted ChatGPT submission exposes a rendered assistant fragment that differs from the saved message
- **THEN** MDB reloads the exact returned conversation, reads the exact persisted assistant message id, and parses only that text without submitting a second model turn

### Requirement: Keep browser secrets contained
The Responses adapter MUST NOT inspect, return, persist, or audit ChatGPT cookies, authorization headers, browser-generated proof material, or model prompt contents.

#### Scenario: Responses request completes
- **WHEN** any Responses turn succeeds or fails
- **THEN** logs contain bounded structural metadata only and exclude the serialized prompt and browser session secrets
