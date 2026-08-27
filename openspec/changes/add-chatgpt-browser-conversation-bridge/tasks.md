## 1. Browser conversation operation

- [x] 1.1 Add bounded page-context conversation request and conservative SSE normalization to the Chrome extension.
- [x] 1.2 Add native-host/client routing for the fixed ChatGPT conversation method without exposing arbitrary page JavaScript.

## 2. MDB surfaces and security

- [x] 2.1 Add the `chatgpt_conversation_start` MCP schema, validation, dispatch, strict-mode URL policy, and prompt-safe auditing.
- [x] 2.2 Add the static-bearer, loopback-only `POST /experimental/chatgpt/conversation` wrapper to `mcp-http.mjs`.

## 3. Verification and operator guidance

- [x] 3.1 Add unit and integration coverage for payload bounds, secret-field rejection, audit redaction, route authentication, and normalized results.
- [x] 3.2 Document setup, semantics, limitations, and the explicit non-provider boundary for OpenCodex/Work Mode.
- [x] 3.3 Run syntax checks, the focused test suite, full tests where practical, OpenSpec validation, and one bounded live probe after reloading MDB.
