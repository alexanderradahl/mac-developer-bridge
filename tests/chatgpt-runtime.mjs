import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workerSource = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
const match = workerSource.match(/async function pageChatgptRuntimeConversationStart\(input\) \{([\s\S]*?)\n\}\n\nasync function pageChatgptConversationStart/);
assert.ok(match, "pageChatgptRuntimeConversationStart must remain a standalone executable function");
const functionSource = `(async function pageChatgptRuntimeConversationStart(input) {${match[1]}\n})`;
assert.match(functionSource, /observedResponseSettled/);
assert.doesNotMatch(functionSource, /Promise\.race\(\[observedResponse/);

const persistedMatch = workerSource.match(/async function pageChatgptPersistedAssistantRead\(input\) \{([\s\S]*?)\n\}\n\nasync function pageChatgptRuntimeConversationStart/);
assert.ok(persistedMatch, "runtime completion must verify the persisted conversation message");
const persistedFunctionSource = `(async function pageChatgptPersistedAssistantRead(input) {${persistedMatch[1]}\n})`;

function runtimePage({
  assistantText = "runtime response",
  accepted = true,
  createConversation = true,
  exposeComposer = true,
  existingConversationId = null,
  loadedConversationId = existingConversationId,
  modelId = "gpt-5-6-pro",
  thinkingEffort = "standard",
  includeThinkingEffortQuery = true,
  projectId = null,
  mountedProjectId = projectId,
  completionNeverSettles = false,
} = {}) {
  let clock = 1_000;
  let submitted = null;
  const assistantNodes = existingConversationId ? [{
    innerText: "prior response",
    textContent: "prior response",
    closest: () => ({ getAttribute: () => "prior-assistant-message" }),
  }] : [];
  const effortQuery = includeThinkingEffortQuery ? `?thinking_effort=${thinkingEffort}` : "";
  const location = loadedConversationId
    ? {
        origin: "https://chatgpt.com",
        pathname: projectId ? `/g/${projectId}-coding-sessions/c/${loadedConversationId}` : `/c/${loadedConversationId}`,
        href: projectId
          ? `https://chatgpt.com/g/${projectId}-coding-sessions/c/${loadedConversationId}${effortQuery}`
          : `https://chatgpt.com/c/${loadedConversationId}${effortQuery}`,
      }
    : projectId
      ? {
          origin: "https://chatgpt.com",
          pathname: `/g/${projectId}/project`,
          href: `https://chatgpt.com/g/${projectId}/project${effortQuery}`,
        }
      : { origin: "https://chatgpt.com", pathname: "/", href: `https://chatgpt.com/${effortQuery}` };
  const secret = "must-not-escape-runtime-store";
  const sharedProps = {
    isComposerSubmissionReady: true,
    isDisabled: false,
    conversation: { id: "client-thread" },
    composerController: {},
    isNewThread: existingConversationId === null,
    conversationMode: mountedProjectId
      ? { kind: "gizmo_interaction", gizmo_id: mountedProjectId }
      : { kind: "primary_assistant" },
    availableSystemHints: [],
    accessToken: secret,
    submitComposer(event, intent) {
      submitted = { event, intent };
      if (!accepted) return { accepted: false, completion: Promise.resolve(false) };
      if (createConversation) {
        if (!existingConversationId) {
          location.pathname = projectId
            ? `/g/${projectId}-coding-sessions/c/runtime-conversation`
            : "/c/runtime-conversation";
          location.href = `https://chatgpt.com${location.pathname}?thinking_effort=${thinkingEffort}`;
        }
        if (assistantText) {
          assistantNodes.push({
            innerText: assistantText,
            textContent: assistantText,
            closest: () => ({ getAttribute: () => "runtime-assistant-message" }),
          });
        }
      }
      return {
        accepted: true,
        completion: completionNeverSettles ? new Promise(() => {}) : Promise.resolve(true),
      };
    },
  };
  const runtimeStore = { getSharedProps: () => sharedProps };
  const storeFiber = {
    child: null,
    sibling: null,
    return: null,
    elementType: function RuntimeStoreOwner() {},
    memoizedProps: {},
    memoizedState: { memoizedState: runtimeStore, baseState: null, next: null },
  };
  const onCreateNewCompletion = function (e) {
    return typeof e.content === "string" ? e.content.length : undefined;
  };
  const modelFiber = {
    child: storeFiber,
    sibling: null,
    return: null,
    elementType: function ComposerModelContext() {},
    memoizedProps: {
      onCreateNewCompletion,
      currentModelId: modelId,
      currentModelConfig: {},
      conversation: sharedProps.conversation,
      isNewThread: existingConversationId === null,
      disabled: false,
      submitPending: false,
      isCompletionInProgress: false,
    },
    memoizedState: null,
  };
  storeFiber.return = modelFiber;
  const rootFiber = {
    child: modelFiber,
    sibling: null,
    return: null,
    elementType: function Root() {},
    memoizedProps: {},
    memoizedState: null,
  };
  modelFiber.return = rootFiber;
  const composer = { "__reactFiber$test": modelFiber };
  const document = {
    querySelector(selector) {
      if (exposeComposer && selector === "#prompt-textarea") return composer;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantNodes;
      return [];
    },
  };
  const FakeDate = class extends Date {
    static now() { return clock; }
  };
  const context = {
    Date: FakeDate,
    Event,
    Intl,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    crypto: crypto.webcrypto,
    document,
    fetch: async () => { throw new Error("runtime test must not make a raw fetch"); },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    location,
    setTimeout(callback, ms = 0) {
      clock += Math.max(Number(ms) || 0, 40_000);
      queueMicrotask(callback);
      return 1;
    },
  };
  const run = vm.runInNewContext(functionSource, context);
  return { run, submitted: () => submitted, secret };
}

const successPage = runtimePage({ assistantText: "MDB_RUNTIME_OK" });
const success = await successPage.run({
  prompt: "runtime prompt",
  model: "gpt-5-6-pro",
  thinkingEffort: "standard",
  maxRuntimeSeconds: 900,
});
assert.equal(success.ok, true);
assert.equal(success.complete, true);
assert.equal(success.transport, "runtime");
assert.equal(success.runtime_action, "submitComposer:text_action");
assert.equal(success.max_runtime_seconds, 900);
assert.equal(success.conversation_id, "runtime-conversation");
assert.equal(success.assistant_message_id, "runtime-assistant-message");
assert.equal(success.assistant_text, "MDB_RUNTIME_OK");
assert.equal(success.observation_source, "rendered-runtime");
assert.equal(successPage.submitted().intent.kind, "text_action");
assert.equal(successPage.submitted().intent.text, "runtime prompt");
assert.ok(successPage.submitted().event instanceof Event);
assert.ok(!JSON.stringify(success).includes(successPage.secret), "runtime store secret escaped the result");

const projectId = "g-p-6a8dee0602b0819184fa43aae5a20ee9";
const projectPage = runtimePage({
  assistantText: "MDB_SOL_PROJECT_OK",
  modelId: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
});
const projectResult = await projectPage.run({
  prompt: "project runtime prompt",
  model: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
});
assert.equal(projectResult.ok, true);
assert.equal(projectResult.project_id, projectId);
assert.equal(projectResult.thinking_effort, "max");
assert.equal(projectResult.conversation_id, "runtime-conversation");
assert.match(projectResult.page_url, /coding-sessions\/c\/runtime-conversation/);

const queryConsumedPage = runtimePage({
  assistantText: "MDB_SOL_QUERY_CONSUMED_OK",
  modelId: "gpt-5-6-thinking",
  thinkingEffort: "max",
  includeThinkingEffortQuery: false,
  projectId,
});
const queryConsumedResult = await queryConsumedPage.run({
  prompt: "project runtime prompt after route query consumption",
  model: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
});
assert.equal(queryConsumedResult.ok, true);
assert.equal(queryConsumedResult.thinking_effort, "max");
assert.equal(queryConsumedPage.submitted().intent.text, "project runtime prompt after route query consumption");

const projectMismatchPage = runtimePage({
  modelId: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
  mountedProjectId: "g-p-different-project-id",
});
const projectMismatch = await projectMismatchPage.run({
  prompt: "project runtime prompt",
  model: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
});
assert.equal(projectMismatch.ok, false);
assert.equal(projectMismatch.error.code, "CHATGPT_RUNTIME_PROJECT_MISMATCH");
assert.equal(projectMismatchPage.submitted(), null);

const effortMismatchPage = runtimePage({
  modelId: "gpt-5-6-thinking",
  thinkingEffort: "high",
  projectId,
});
const effortMismatch = await effortMismatchPage.run({
  prompt: "project runtime prompt",
  model: "gpt-5-6-thinking",
  thinkingEffort: "max",
  projectId,
});
assert.equal(effortMismatch.ok, false);
assert.equal(effortMismatch.error.code, "CHATGPT_RUNTIME_THINKING_EFFORT_MISMATCH");
assert.equal(effortMismatchPage.submitted(), null);

const continuedPage = runtimePage({ assistantText: "MDB_RUNTIME_CONTINUE_OK", existingConversationId: "existing-conversation" });
const continued = await continuedPage.run({
  prompt: "continuation prompt",
  model: "gpt-5-6-pro",
  thinkingEffort: "standard",
  conversationId: "existing-conversation",
});
assert.equal(continued.ok, true);
assert.equal(continued.complete, true);
assert.equal(continued.operation, "continue");
assert.equal(continued.conversation_id, "existing-conversation");
assert.equal(continued.assistant_text, "MDB_RUNTIME_CONTINUE_OK");
assert.equal(continuedPage.submitted().intent.text, "continuation prompt");

const mismatchedContinuationPage = runtimePage({ existingConversationId: "existing-conversation", loadedConversationId: "other-conversation" });
const mismatchedContinuation = await mismatchedContinuationPage.run({
  prompt: "continuation prompt",
  model: "gpt-5-6-pro",
  thinkingEffort: "standard",
  conversationId: "existing-conversation",
});
assert.equal(mismatchedContinuation.ok, false);
assert.equal(mismatchedContinuation.error.code, "CHATGPT_RUNTIME_CONVERSATION_MISMATCH");
assert.equal(mismatchedContinuationPage.submitted(), null);

const refusedPage = runtimePage({ accepted: false });
const refused = await refusedPage.run({ prompt: "runtime prompt", model: "gpt-5-6-pro", thinkingEffort: "standard" });
assert.equal(refused.ok, false);
assert.equal(refused.error.code, "CHATGPT_RUNTIME_NOT_READY");

const ambiguousPage = runtimePage({ assistantText: "", createConversation: true });
const ambiguous = await ambiguousPage.run({ prompt: "runtime prompt", model: "gpt-5-6-pro", thinkingEffort: "standard" });
assert.equal(ambiguous.ok, false);
assert.equal(ambiguous.error.code, "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN");
assert.equal(ambiguous.error.conversation_id, "runtime-conversation");

const partialPage = runtimePage({
  assistantText: '{"kind":"tool_calls","calls":{"name":"exec\\n_',
  completionNeverSettles: true,
});
const partial = await partialPage.run({
  prompt: "runtime prompt",
  model: "gpt-5-6-pro",
  thinkingEffort: "standard",
  maxRuntimeSeconds: 600,
});
assert.equal(partial.ok, false);
assert.equal(partial.error.code, "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN");

const changedPage = runtimePage({ exposeComposer: false });
const changed = await changedPage.run({ prompt: "runtime prompt", model: "gpt-5-6-pro", thinkingEffort: "standard" });
assert.equal(changed.ok, false);
assert.equal(changed.error.code, "CHATGPT_RUNTIME_CONTRACT_CHANGED");

const persistedNode = {
  innerText: '{"kind":"tool_calls","calls":[{"name":"exec","arguments":{"input":"text(7);"}}]}',
  textContent: "ignored",
  closest: () => ({ getAttribute: () => "persisted-assistant-message" }),
};
let persistedClock = 1_000;
const persistedContext = {
  Date: class extends Date { static now() { return persistedClock; } },
  document: {
    readyState: "complete",
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [persistedNode];
      return [];
    },
  },
  getComputedStyle: () => ({ display: "none", visibility: "hidden" }),
  location: {
    origin: "https://chatgpt.com",
    pathname: `/g/${projectId}-coding-sessions/c/persisted-conversation`,
  },
  TextEncoder,
  setTimeout(callback, ms = 0) {
    persistedClock += Number(ms) || 0;
    queueMicrotask(callback);
    return 1;
  },
};
const readPersisted = vm.runInNewContext(persistedFunctionSource, persistedContext);
const persisted = await readPersisted({
  conversationId: "persisted-conversation",
  assistantMessageId: "persisted-assistant-message",
  timeoutMs: 5_000,
});
assert.equal(persisted.ok, true);
assert.equal(persisted.assistant_message_id, "persisted-assistant-message");
assert.equal(persisted.assistant_text, persistedNode.innerText);

console.log("chatgpt runtime page test passed");
