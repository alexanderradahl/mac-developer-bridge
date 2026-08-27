import assert from "node:assert/strict";
import {
  CHATGPT_RESPONSES_MAX_PROMPT_BYTES,
  CHATGPT_RESPONSES_SOL_MODEL,
  buildChatgptResponsesResponse,
  chatgptResponsesSseBody,
  parseChatgptResponsesEnvelope,
  prepareChatgptResponsesRequest,
} from "../lib/chatgpt-responses-adapter.mjs";

const base = {
  model: "chatgpt-browser",
  instructions: "Be concise.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
};

const messagePrepared = prepareChatgptResponsesRequest(base);
assert.equal(messagePrepared.model, "chatgpt-browser");
assert.equal(messagePrepared.browserModel, "gpt-5-6-pro");
assert.equal(messagePrepared.thinkingEffort, "standard");
assert.equal(messagePrepared.stream, false);
assert.ok(messagePrepared.prompt.includes("<END_OF_TURN_DATA>"));
assert.ok(messagePrepared.prompt.includes("Do not emit Markdown"));
const message = parseChatgptResponsesEnvelope('{"kind":"message","text":"Hello back"}', messagePrepared);
const messageResponse = buildChatgptResponsesResponse(messagePrepared, message);
assert.equal(messageResponse.output[0].type, "message");
assert.equal(messageResponse.output[0].content[0].text, "Hello back");
assert.equal(messageResponse.usage.total_tokens, 0);
const messageSse = chatgptResponsesSseBody(messageResponse);
assert.match(messageSse, /"type":"response.created"/);
assert.match(messageSse, /"type":"response.output_item.done"/);
assert.match(messageSse, /"type":"response.completed"/);
assert.ok(messageSse.endsWith("data: [DONE]\n\n"));

const solEfforts = new Map([
  ["low", "low"],
  ["medium", "standard"],
  ["high", "high"],
  ["xhigh", "max"],
  ["max", "max"],
  ["ultra", "max"],
]);
for (const [reasoningEffort, thinkingEffort] of solEfforts) {
  const prepared = prepareChatgptResponsesRequest({
    ...base,
    model: CHATGPT_RESPONSES_SOL_MODEL,
    reasoning: { effort: reasoningEffort },
  });
  assert.equal(prepared.model, CHATGPT_RESPONSES_SOL_MODEL);
  assert.equal(prepared.browserModel, "gpt-5-6-thinking");
  assert.equal(prepared.requestedReasoningEffort, reasoningEffort);
  assert.equal(prepared.thinkingEffort, thinkingEffort);
}
assert.equal(
  prepareChatgptResponsesRequest({ ...base, model: CHATGPT_RESPONSES_SOL_MODEL }).thinkingEffort,
  "low",
);
assert.throws(
  () => prepareChatgptResponsesRequest({
    ...base,
    model: CHATGPT_RESPONSES_SOL_MODEL,
    reasoning: { effort: "extreme" },
  }),
  /unsupported for chatgpt-sol/,
);

const functionPrepared = prepareChatgptResponsesRequest({
  ...base,
  stream: true,
  tools: [{
    type: "function",
    name: "read_file",
    description: "Read one file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }],
});
const functionDecision = parseChatgptResponsesEnvelope(
  '```json\n{"kind":"tool_calls","calls":[{"name":"read_file","arguments":{"path":"/tmp/a"}}]}\n```',
  functionPrepared,
);
const functionResponse = buildChatgptResponsesResponse(functionPrepared, functionDecision);
assert.equal(functionResponse.output[0].type, "function_call");
assert.equal(functionResponse.output[0].name, "read_file");
assert.deepEqual(JSON.parse(functionResponse.output[0].arguments), { path: "/tmp/a" });

const customPrepared = prepareChatgptResponsesRequest({
  ...base,
  tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
});
const customDecision = parseChatgptResponsesEnvelope(
  '{"kind":"tool_calls","calls":[{"name":"apply_patch","input":"*** Begin Patch"}]}',
  customPrepared,
);
assert.equal(buildChatgptResponsesResponse(customPrepared, customDecision).output[0].type, "custom_tool_call");

const wrappedCustomDecision = parseChatgptResponsesEnvelope(
  '{"kind":"tool_calls","calls":[{"name":"apply_patch","arguments":{"input":"*** Begin Patch"}}]}',
  customPrepared,
);
assert.deepEqual(wrappedCustomDecision.calls[0], {
  type: "custom",
  name: "apply_patch",
  input: "*** Begin Patch",
});

const freeformFunctionPrepared = prepareChatgptResponsesRequest({
  ...base,
  tools: [{
    type: "function",
    name: "exec",
    description: "Execute raw JavaScript source",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    },
  }],
});
const freeformFunctionDecision = parseChatgptResponsesEnvelope(
  '{"kind":"tool_calls","calls":[{"name":"exec","input":"text(7);"}]}',
  freeformFunctionPrepared,
);
assert.deepEqual(JSON.parse(freeformFunctionDecision.calls[0].arguments), { input: "text(7);" });
const looseFreeformFunctionDecision = parseChatgptResponsesEnvelope(
  String.raw`{"kind":"tool_calls","calls":[{"name":"exec","input":"// @exec: {"max_output_tokens": 2200}\ntext("ok");"}]}`,
  freeformFunctionPrepared,
);
assert.deepEqual(JSON.parse(looseFreeformFunctionDecision.calls[0].arguments), {
  input: '// @exec: {"max_output_tokens": 2200}\ntext("ok");',
});
assert.throws(
  () => parseChatgptResponsesEnvelope(
    String.raw`{"kind":"tool_calls","calls":[{"name":"exec","input":"text("one");"},{"name":"exec","input":"text("two");"}]}`,
    freeformFunctionPrepared,
  ),
  /malformed protocol envelope/,
);
assert.throws(
  () => parseChatgptResponsesEnvelope(
    String.raw`{"kind":"tool_calls","calls":[{"name":"exec","input":"text("one");","unexpected":"field"}]}`,
    freeformFunctionPrepared,
  ),
  /malformed protocol envelope/,
);
assert.throws(
  () => parseChatgptResponsesEnvelope(
    '{"kind":"tool_calls","calls":[{"name":"exec","input":"text(7);","arguments":{"input":"text(8);"}}]}',
    freeformFunctionPrepared,
  ),
  /requires object arguments/,
);
assert.throws(
  () => parseChatgptResponsesEnvelope(
    '{"kind":"tool_calls","calls":[{"name":"read_file","input":"/tmp/a"}]}',
    functionPrepared,
  ),
  /requires object arguments/,
);

const namespacePrepared = prepareChatgptResponsesRequest({
  ...base,
  tools: [{
    type: "namespace",
    name: "collaboration",
    description: "Agent coordination",
    tools: [{
      type: "function",
      name: "list_agents",
      description: "List agents",
      parameters: { type: "object", properties: {} },
    }],
  }],
});
assert.equal(namespacePrepared.tools[0].name, "collaboration__list_agents");
const namespaceDecision = parseChatgptResponsesEnvelope(
  '{"kind":"tool_calls","calls":[{"name":"collaboration__list_agents","arguments":{}}]}',
  namespacePrepared,
);
const namespaceOutput = buildChatgptResponsesResponse(namespacePrepared, namespaceDecision).output[0];
assert.equal(namespaceOutput.name, "list_agents");
assert.equal(namespaceOutput.namespace, "collaboration");

assert.throws(
  () => prepareChatgptResponsesRequest({ ...base, tools: [{ type: "computer_use_preview" }] }),
  /unsupported tool type/,
);
assert.equal(
  prepareChatgptResponsesRequest({ ...base, tools: [{ type: "web_search" }] }).tools.length,
  0,
);
assert.throws(
  () => parseChatgptResponsesEnvelope(
    '{"kind":"tool_calls","calls":[{"name":"unknown","arguments":{}}]}',
    functionPrepared,
  ),
  /unknown tool/,
);
const plainMessage = parseChatgptResponsesEnvelope("plain final response", functionPrepared);
assert.deepEqual(plainMessage, { kind: "message", text: "plain final response" });
assert.throws(
  () => parseChatgptResponsesEnvelope('{"kind":"tool_calls","calls":', functionPrepared),
  /malformed protocol envelope/,
);
assert.throws(
  () => prepareChatgptResponsesRequest({ ...base, input: "x".repeat(CHATGPT_RESPONSES_MAX_PROMPT_BYTES) }),
  /maximum is/,
);

console.log("chatgpt responses adapter test passed");
