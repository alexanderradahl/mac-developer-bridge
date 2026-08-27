import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workerSource = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
const match = workerSource.match(/async function pageChatgptConversationStart\(input\) \{([\s\S]*?)\n\}\n\nfunction pageSnapshot/);
assert.ok(match, "pageChatgptConversationStart must remain a standalone executable function");
const functionSource = `(async function pageChatgptConversationStart(input) {${match[1]}\n})`;

function pageFunction(fetchImpl) {
  return vm.runInNewContext(functionSource, {
    AbortController,
    Date,
    Intl,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    console,
    crypto: { randomUUID: () => crypto.randomUUID() },
    document: { documentElement: { lang: "en-US" } },
    fetch: fetchImpl,
    location: { origin: "https://chatgpt.com" },
    setTimeout,
  });
}

const secretToken = "browser-only-access-token";
const seen = [];
const success = pageFunction(async (url, init = {}) => {
  seen.push({ url, init });
  if (url === "/api/auth/session") {
    return new Response(JSON.stringify({ accessToken: secretToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  assert.equal(url, "/backend-api/f/conversation");
  assert.equal(init.headers.authorization, `Bearer ${secretToken}`);
  const request = JSON.parse(init.body);
  assert.equal(request.model, "gpt-5-6-pro");
  assert.equal(request.local_function_names[0], "local.continue_in_work");
  assert.equal(request.messages[0].content.parts[0], "unit test prompt");
  const stream = [
    `data: ${JSON.stringify({ conversation_id: "conversation-1", message: { id: "assistant-1", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: ["Hello"] } } })}`,
    `data: ${JSON.stringify({ type: "message.completed", conversation_id: "conversation-1", message: { id: "assistant-1", author: { role: "assistant" }, status: "finished_successfully", content: { content_type: "text", parts: ["Hello world"] } } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
});
const successResult = await success({ prompt: "unit test prompt", model: "gpt-5-6-pro", thinkingEffort: "standard", continueInWork: true });
assert.equal(successResult.ok, true);
assert.equal(successResult.complete, true);
assert.equal(successResult.conversation_id, "conversation-1");
assert.equal(successResult.assistant_message_id, "assistant-1");
assert.equal(successResult.assistant_text, "Hello world");
assert.ok(!JSON.stringify(successResult).includes(secretToken), "access token escaped the page function result");
assert.equal(seen.length, 2);

const projectId = "g-p-6a8dee0602b0819184fa43aae5a20ee9";
const projectRequest = pageFunction(async (url, init = {}) => {
  if (url === "/api/auth/session") {
    return new Response(JSON.stringify({ accessToken: secretToken }), { status: 200 });
  }
  const request = JSON.parse(init.body);
  assert.equal(request.model, "gpt-5-6-thinking");
  assert.equal(request.thinking_effort, "max");
  assert.deepEqual(request.conversation_mode, { kind: "gizmo_interaction", gizmo_id: projectId });
  assert.equal(Object.hasOwn(request, "project_id"), false);
  const stream = [
    `data: ${JSON.stringify({ conversation_id: "project-conversation", message: { id: "assistant-project", author: { role: "assistant" }, status: "finished_successfully", content: { content_type: "text", parts: ["Project reply"] } } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
});
const projectResult = await projectRequest({
  prompt: "project probe",
  model: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
});
assert.equal(projectResult.ok, true);
assert.equal(projectResult.project_id, projectId);

const requirementsFailure = pageFunction(async (url) => {
  if (url === "/api/auth/session") return new Response(JSON.stringify({ accessToken: secretToken }), { status: 200 });
  return new Response(JSON.stringify({ error: "missing Sentinel chat requirements proof" }), { status: 403 });
});
const requirementsResult = await requirementsFailure({ prompt: "probe", model: "gpt-5-6-pro", thinkingEffort: "standard" });
assert.equal(requirementsResult.ok, false);
assert.equal(requirementsResult.error.code, "CHATGPT_CONVERSATION_REQUIREMENTS_UNAVAILABLE");
assert.equal(requirementsResult.error.status, 403);
assert.ok(!JSON.stringify(requirementsResult).includes(secretToken));

const changedProtocol = pageFunction(async (url) => {
  if (url === "/api/auth/session") return new Response(JSON.stringify({ accessToken: secretToken }), { status: 200 });
  return new Response("data: v1:opaque-private-encoding\n\n", { status: 200 });
});
const changedResult = await changedProtocol({ prompt: "probe", model: "gpt-5-6-pro", thinkingEffort: "standard" });
assert.equal(changedResult.ok, false);
assert.equal(changedResult.error.code, "CHATGPT_CONVERSATION_PROTOCOL_CHANGED");

console.log("chatgpt conversation page test passed");
