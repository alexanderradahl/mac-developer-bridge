## ADDED Requirements

### Requirement: Submit through the first-party ChatGPT runtime
The system SHALL use a fixed browser function to invoke a narrowly identified first-party conversation action in the signed-in ChatGPT page runtime without typing into or clicking the visible composer.

#### Scenario: Successful background submission
- **WHEN** an eligible signed-in ChatGPT tab exposes the validated first-party conversation action and the operator invokes `chatgpt_conversation_start` with the default transport
- **THEN** the page submits the prompt through that runtime action without activating the tab or window and without DOM input or click automation

#### Scenario: Runtime contract changed
- **WHEN** the fixed function cannot uniquely identify and validate the first-party conversation action
- **THEN** the operation fails before submission with a classified runtime-contract error and does not fall back to UI automation

### Requirement: Exclude request credentials and proof material
The app-native transport MUST NOT inspect, return, persist, audit, synthesize, or replay ChatGPT request authorization, cookie, device, Sentinel, Turnstile, Arkose, or proof values.

#### Scenario: Response observation is installed
- **WHEN** the app-native transport observes the conversation request
- **THEN** it reads only the matching response clone and stable response metadata and does not inspect request headers or credentials

### Requirement: Normalize a bounded app-native result
The system SHALL return bounded assistant text, completion state, conversation identifiers when observed, and classified errors using the existing conversation result envelope.

#### Scenario: First-party response completes
- **WHEN** the observed response stream reaches completion within all configured limits
- **THEN** the tool returns `complete: true` with bounded normalized assistant text and any observed conversation identifier

#### Scenario: Response transport changes but the page renders a result
- **WHEN** no matching response stream is available but the page renders a bounded latest assistant message and a conversation URL
- **THEN** the tool returns the DOM-observed result with its observation source identified

### Requirement: Prevent duplicate submission after ambiguity
The system MUST NOT automatically retry or switch transports after the page may have submitted a prompt.

#### Scenario: Post-submit completion is uncertain
- **WHEN** the send action occurs but MDB cannot prove whether the response completed
- **THEN** MDB returns `CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN` with any observed identifiers and performs no second submission

### Requirement: Make runtime-native transport the default
The existing MCP tool and loopback endpoint SHALL accept `transport` values `runtime` and `raw`, default omitted values to `runtime`, and retain `raw` only as an explicit diagnostic mode.

#### Scenario: Caller omits transport
- **WHEN** a caller submits a valid prompt without a transport field
- **THEN** MDB uses the runtime-native browser transport

#### Scenario: Caller explicitly selects raw
- **WHEN** a caller submits a valid prompt with `transport: "raw"`
- **THEN** MDB uses the existing private-request diagnostic path and retains its fail-closed proof behavior

### Requirement: Preserve background tab lease semantics
The system SHALL perform app-native submission within the existing MDB tab lease lifecycle and SHALL release the lease and temporary observer state on success or failure.

#### Scenario: Operation completes or fails
- **WHEN** app-native processing reaches any terminal outcome
- **THEN** the tab remains unactivated, the workspace lease is released, and temporary observer state is removed or expires within a bounded period
