import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backgroundChromeCall, backgroundChromeStatus, backgroundChromeOperationStatus, safeChatGPTHandoff } from "../lib/chrome-extension-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp("/tmp/mdb-handoff-");
const socketPath = path.join(temp, "chrome.sock");
const canary = "HANDOFF-RAW-PAYLOAD-CANARY-3b621e";
const method = "tabs.chatgptConversationStart";
const handoff = {
  conversation_id: "conversation-fixture",
  assistant_message_id: "assistant-fixture",
  complete: false,
  page_url: "https://chatgpt.com/c/conversation-fixture?credential=" + canary + "#secret",
};
const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
let child;
const scenarios = [];
try {
  assert.deepEqual(safeChatGPTHandoff(handoff, "tabs.fill"), {});
  const validated = safeChatGPTHandoff(handoff, method);
  assert.equal(validated.page_url, "https://chatgpt.com/c/conversation-fixture");
  assert.equal(validated.assistant_message_id, "assistant-fixture");
  assert.equal(validated.conversation_id, "conversation-fixture");
  assert.equal(validated.complete, false);
  for (const page_url of [
    "http://chatgpt.com/c/conversation-fixture",
    "https://chatgpt.com.evil.invalid/c/conversation-fixture",
    "https://owner:secret@chatgpt.com/c/conversation-fixture",
    "https://chatgpt.com/backend-api/private",
    "https://chatgpt.com/c/other-conversation",
    "not a URL",
  ]) assert.equal(safeChatGPTHandoff({ ...handoff, page_url }, method).page_url, undefined);
  for (const prefix of ["c", "coding-sessions/c", "g/g-p-fixture/c"]) {
    const page_url = "https://chatgpt.com/" + prefix + "/conversation-fixture";
    assert.equal(safeChatGPTHandoff({ ...handoff, page_url }, method).page_url, page_url);
  }
  scenarios.push("method-scoped-validated-conversation-locator");

  await fs.writeFile(path.join(temp, "chrome-background-profile.json"), JSON.stringify({
    profileDirectory: "Default", expectedEmail: "fixture@example.invalid", expectedGaiaId: "123456789012345678901",
  }));
  child = spawn(process.execPath, [path.join(root, "scripts/chrome-native-host.mjs")], {
    env: { ...process.env, MAC_DEV_BRIDGE_DATA_DIR: temp, MAC_DEV_BRIDGE_CHROME_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let buffer = Buffer.alloc(0);
  let dispatched = 0;
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      if (message.type !== "request") continue;
      dispatched += 1;
      child.stdin.write(frame({
        type: "response", id: message.id, ok: false,
        error: {
          code: "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN",
          message: "Raw page error: " + canary,
          details: { ...handoff, stage: "handoff", rawPagePayload: canary },
        },
      }));
    }
  });
  child.stdin.write(frame({
    type: "ready", version: "0.2.12", buildId: "handoff-fixture", connectionGeneration: "handoff-generation",
    extensionId: "pcebfblnmcappinbenkmddjdapaoajgm",
    profile: { signedIn: true, email: "fixture@example.invalid", id: "123456789012345678901" },
  }));
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = await backgroundChromeStatus({ socketPath, timeoutMs: 100 });
    if (status.extensionReady) break;
    if (Date.now() >= deadline) throw new Error("Fixture host did not become ready: " + stderr);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const operationId = "chatgpt-handoff-fixture";
  await assert.rejects(
    () => backgroundChromeCall(method, { prompt: "fixture only" }, ["https://chatgpt.com/*"], { socketPath, operationId }),
    (error) => {
      assert.equal(error.code, "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN");
      assert.equal(error.details.conversation_id, handoff.conversation_id);
      assert.equal(error.details.assistant_message_id, handoff.assistant_message_id);
      assert.equal(error.details.page_url, "https://chatgpt.com/c/conversation-fixture");
      assert.equal(error.details.complete, false);
      assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /HANDOFF-RAW-PAYLOAD|credential|#secret|rawPagePayload/);
      return true;
    },
  );
  scenarios.push("real-host-and-client-retain-safe-chatgpt-handoff");
  const beforeStatus = dispatched;
  const status = await backgroundChromeOperationStatus(operationId, { socketPath });
  assert.equal(status.state, "completed");
  assert.equal(dispatched, beforeStatus);
  assert.doesNotMatch(JSON.stringify(status), /page_url|https:|assistant_message_id|HANDOFF-RAW-PAYLOAD/);
  scenarios.push("lifecycle-status-contains-no-handoff-url-or-result");
  await assert.rejects(
    () => backgroundChromeCall("tabs.fill", { value: "fixture" }, ["https://chatgpt.com/*"], { socketPath }),
    (error) => {
      assert.equal(error.details.page_url, undefined);
      assert.equal(error.details.assistant_message_id, undefined);
      assert.doesNotMatch(JSON.stringify(error.details), /https:|HANDOFF-RAW-PAYLOAD/);
      return true;
    },
  );
  scenarios.push("generic-browser-errors-cannot-export-chatgpt-locators");
  console.log(JSON.stringify({ passed: true, scenarios }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await fs.rm(temp, { recursive: true, force: true });
}
