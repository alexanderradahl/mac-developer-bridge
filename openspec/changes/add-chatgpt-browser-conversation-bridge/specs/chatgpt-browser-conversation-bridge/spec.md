## ADDED Requirements

### Requirement: Start a conversation through the authenticated ChatGPT browser context
The system SHALL provide a `chatgpt_conversation_start` MCP tool that submits one bounded prompt through an already-open, signed-in `https://chatgpt.com/*` tab and returns a normalized result.

#### Scenario: Successful conversation kickoff
- **WHEN** the operator invokes the tool with a valid prompt while a matching signed-in ChatGPT tab is available and ChatGPT accepts the request
- **THEN** the result contains `complete: true`, a conversation identifier when supplied by ChatGPT, and bounded assistant text when supplied by ChatGPT

#### Scenario: No eligible ChatGPT tab
- **WHEN** no open signed-in `chatgpt.com` tab is available
- **THEN** the tool fails with a classified browser availability error without opening or foregrounding a new tab

### Requirement: Contain ChatGPT credentials and proof material
The system MUST keep ChatGPT bearer tokens, cookies, device identifiers, and anti-abuse proof material inside the browser page context and MUST NOT accept, return, persist, or audit those values.

#### Scenario: Caller supplies copied security headers
- **WHEN** a caller includes authorization, cookie, Sentinel, Turnstile, Arkose, proof, or device header fields
- **THEN** the request is rejected before browser execution

#### Scenario: Page context cannot satisfy ChatGPT requirements
- **WHEN** ChatGPT rejects the request because required session or anti-abuse material is unavailable
- **THEN** the bridge returns a classified fail-closed error and does not synthesize, solve, or request copied proof values

### Requirement: Bound private-protocol execution
The system SHALL enforce explicit limits on prompt size, request duration, response bytes, event count, and returned assistant text.

#### Scenario: Prompt exceeds the limit
- **WHEN** a prompt is larger than the configured maximum
- **THEN** the bridge rejects it before calling Chrome

#### Scenario: Event stream exceeds a bound
- **WHEN** the ChatGPT event stream exceeds any configured byte, event, time, or output-text limit
- **THEN** the bridge terminates processing and returns a classified bounded-execution error

### Requirement: Provide an authenticated loopback orchestration endpoint
The system SHALL expose `POST /experimental/chatgpt/conversation` as a loopback-only HTTP wrapper around the MCP tool and SHALL require the static MDB bearer credential.

#### Scenario: Authorized loopback request
- **WHEN** a loopback client sends a valid JSON request with the static MDB bearer
- **THEN** the endpoint invokes the same bridge operation and returns its normalized JSON result

#### Scenario: OAuth or remote request
- **WHEN** the request comes from a non-loopback peer or authenticates with an OAuth access token instead of the static MDB bearer
- **THEN** the endpoint rejects the request without dispatching a browser operation

### Requirement: Preserve Work Mode and router semantics
The system MUST NOT advertise the private ChatGPT conversation bridge as an OpenAI Responses-compatible provider or add it to automatic OpenCodex failover.

#### Scenario: Operator inspects documented integration
- **WHEN** the operator reviews the endpoint documentation
- **THEN** the documentation distinguishes explicit ChatGPT session kickoff from model routing and explains that Codex tool-call semantics are not preserved

### Requirement: Protect prompt content in audit logs
The system MUST replace the prompt with byte length and a hash prefix before audit serialization in every audit mode.

#### Scenario: Full audit mode
- **WHEN** `MAC_DEV_BRIDGE_AUDIT_MODE=full` and the conversation tool succeeds or fails
- **THEN** the audit entry contains no prompt plaintext and retains only bounded correlation metadata
