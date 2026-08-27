## 1. Protocol Contract

- [x] 1.1 Add bounded Responses request validation and deterministic prompt serialization
- [x] 1.2 Parse and validate message/tool-call envelopes without inferring missing calls
- [x] 1.3 Build canonical streaming and non-streaming Responses results

## 2. HTTP Integration

- [x] 2.1 Add static-bearer-only loopback `POST /v1/responses`
- [x] 2.2 Invoke the existing runtime transport without logging prompt contents or retrying ambiguous submissions

## 3. Verification and Registration

- [x] 3.1 Add automated message, tool-call, auth, malformed-output, unsupported-tool, and size-bound coverage
- [x] 3.2 Update operator and security documentation
- [x] 3.3 Run focused/full tests and strict OpenSpec validation
- [x] 3.4 Register and sync `chatgpt-runtime/chatgpt-browser` without modifying defaults or fallback chains
- [x] 3.5 Complete direct endpoint and end-to-end Codex text verification
- [x] 3.6 Complete reliable live Codex-owned tool-call-loop verification

## 4. Sol Effort and Project Binding

- [x] 4.1 Add `chatgpt-sol` request routing and bounded Codex-to-ChatGPT effort mapping
- [x] 4.2 Add validated Project configuration and runtime route/composer-state checks
- [x] 4.3 Add automated effort, Project binding, mismatch, and secret-containment coverage
- [x] 4.4 Register and sync `chatgpt-runtime/chatgpt-sol` with the 372,000-token Sol context window
- [x] 4.5 Verify Project-bound live Sol turns without changing defaults or fallback chains

## 5. Long-running Work Mode Reliability

- [x] 5.1 Open streaming Responses requests before awaiting the browser runtime and keep the stream active during long thinking turns
- [x] 5.2 Recover only an unambiguous single raw-input tool call when the runtime leaves inner quotes unescaped
- [x] 5.3 Add regressions for delayed stream startup and ambiguous malformed tool-call rejection
