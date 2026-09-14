import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bridgePath = path.join(root, "bridge.mjs");
const hostPath = path.join(root, "scripts", "chrome-native-host.mjs");
const tempRoot = await fs.mkdtemp("/tmp/mdb-chatgpt-runs-");
const dataDir = path.join(tempRoot, "data");
const logDir = path.join(tempRoot, "logs");
const socketPath = path.join(dataDir, "chrome-background.sock");
const profileBindingFile = path.join(dataDir, "chrome-background-profile.json");
const auditFile = path.join(logDir, "audit.jsonl");
const runFile = path.join(dataDir, "chatgpt-conversation-runs.json");

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(logDir, { recursive: true });

function frameNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function waitForPath(target, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.stat(target);
      return;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startFakeExtensionHost() {
  const child = spawn(process.execPath, [hostPath], {
    env: {
      ...process.env,
      MAC_DEV_BRIDGE_DATA_DIR: dataDir,
      MAC_DEV_BRIDGE_CHROME_SOCKET: socketPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      if (message.type !== "request") continue;
      const result = message.method === "tabs.chatgptConversationStart"
        ? {
          ok: true,
          complete: true,
          conversation_id: "conversation-async",
          assistant_message_id: "assistant-async",
          assistant_text: "async stub response",
          usage: { total_tokens: 7 },
        }
        : { echoedMethod: message.method, echoedArgs: message.args };
      const respond = () => child.stdin.write(frameNative({
        type: "response",
        id: message.id,
        ok: true,
        result,
      }));
      if (message.method === "tabs.chatgptConversationStart") setTimeout(respond, 400);
      else respond();
    }
  });
  return {
    get stderr() { return stderr; },
    ready(profile = { signedIn: true, email: "bound@example.com", id: "123456789012345678901" }) {
      child.stdin.write(frameNative({
        type: "ready",
        version: "0.1.0",
        extensionId: "pcebfblnmcappinbenkmddjdapaoajgm",
        profile,
      }));
    },
    async stop() {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function startBridge() {
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      MAC_DEV_BRIDGE_DATA_DIR: dataDir,
      MAC_DEV_BRIDGE_LOG_DIR: logDir,
      MAC_DEV_BRIDGE_CHROME_SOCKET: socketPath,
      MAC_DEV_BRIDGE_FULL_ACCESS_ACK: "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS",
      MAC_DEV_BRIDGE_AUDIT_MODE: "full",
      MAC_DEV_BRIDGE_AUDIT_LOG: auditFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });
  return {
    get stderr() { return stderr; },
    request(method, params, timeoutMs = 12_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge request timed out: ${method}; stderr=${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async stop() {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "chatgpt-conversation-runs-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function bridgeTool(client, name, args = {}) {
  return await client.request("tools/call", { _meta: modernMeta, name, arguments: args });
}

function toolResult(response) {
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
  return response.result.structuredContent;
}

async function waitForCompletedRun(bridge, runId) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const status = toolResult(await bridgeTool(bridge, "chatgpt_conversation_status", { run_id: runId }));
    if (status.status === "completed") return status;
    assert.equal(status.status, "running");
    if (Date.now() >= deadline) throw new Error(`timed out waiting for run ${runId} to complete`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForPersistedRun(runId, status = "completed") {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      const parsed = JSON.parse(await fs.readFile(runFile, "utf8"));
      const run = parsed.runs?.find((entry) => entry.run_id === runId);
      if (run?.status === status) return run;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`timed out waiting for persisted run ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

try {
  await fs.writeFile(profileBindingFile, JSON.stringify({
    profileDirectory: "Default",
    expectedEmail: "bound@example.com",
    expectedGaiaId: "123456789012345678901",
  }), { mode: 0o600 });

  const host = startFakeExtensionHost();
  try {
    await waitForPath(socketPath);
  } catch (error) {
    throw new Error(`${error.message}; host stderr=${host.stderr}`);
  }
  host.ready();
  await new Promise((resolve) => setTimeout(resolve, 50));

  let bridge = startBridge();
  // Warm the bridge first so the wait:false timing below measures the tool, not boot.
  await bridge.request("ping", {});
  const distinctivePrompt = "async ChatGPT registry prompt must not appear in audit records";
  const startedAt = Date.now();
  const started = toolResult(await bridgeTool(bridge, "chatgpt_conversation_start", {
    prompt: distinctivePrompt,
    wait: false,
  }));
  assert.ok(Date.now() - startedAt < 300, "wait:false should return before the delayed host response");
  assert.match(started.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(started.conversation_id, null);
  assert.equal(started.status, "running");
  assert.ok(!Number.isNaN(Date.parse(started.started_at)));

  const initialStatus = toolResult(await bridgeTool(bridge, "chatgpt_conversation_status", { run_id: started.run_id }));
  assert.equal(initialStatus.status, "running");
  assert.equal(initialStatus.conversation_id, null);
  assert.equal(initialStatus.finished_at, null);
  assert.equal(initialStatus.error, null);

  const runningResult = toolResult(await bridgeTool(bridge, "chatgpt_conversation_result", { run_id: started.run_id }));
  assert.deepEqual(runningResult, {
    run_id: started.run_id,
    status: "running",
    conversation_id: null,
    started_at: started.started_at,
  });
  assert.equal("assistant_text" in runningResult, false);

  const completedStatus = await waitForCompletedRun(bridge, started.run_id);
  assert.equal(completedStatus.conversation_id, "conversation-async");
  assert.ok(!Number.isNaN(Date.parse(completedStatus.finished_at)));
  assert.equal(completedStatus.error, null);

  const completedResult = toolResult(await bridgeTool(bridge, "chatgpt_conversation_result", { run_id: started.run_id }));
  assert.equal(completedResult.assistant_text, "async stub response");
  assert.equal(completedResult.conversation_id, "conversation-async");
  assert.equal(completedResult.usage.total_tokens, 7);
  assert.equal(completedResult.status, "completed");
  assert.equal(completedResult._background.focusPolicy, "background-only");

  const persistedRun = await waitForPersistedRun(started.run_id);
  assert.equal(persistedRun.status, "completed");
  assert.equal((await fs.stat(runFile)).mode & 0o777, 0o600);

  const unknown = await bridgeTool(bridge, "chatgpt_conversation_status", {
    run_id: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.code, "CHATGPT_RUN_UNKNOWN");

  await bridge.stop();
  bridge = startBridge();
  const persistedResult = toolResult(await bridgeTool(bridge, "chatgpt_conversation_result", { run_id: started.run_id }));
  assert.equal(persistedResult.assistant_text, "async stub response");
  assert.equal(persistedResult.status, "completed");

  const blocking = toolResult(await bridgeTool(bridge, "chatgpt_conversation_start", { prompt: "blocking" }));
  assert.equal(blocking.assistant_text, "async stub response");
  assert.equal("run_id" in blocking, false);

  // A run whose bridge exits mid-turn can never finish; the next bridge reports it lost.
  const lost = toolResult(await bridgeTool(bridge, "chatgpt_conversation_start", { prompt: "restart mid-turn", wait: false }));
  await waitForPersistedRun(lost.run_id, "running");
  await bridge.stop();
  bridge = startBridge();
  const lostStatus = toolResult(await bridgeTool(bridge, "chatgpt_conversation_status", { run_id: lost.run_id }));
  assert.equal(lostStatus.status, "failed");
  assert.equal(lostStatus.error.code, "CHATGPT_RUN_LOST");
  assert.ok(!Number.isNaN(Date.parse(lostStatus.finished_at)));
  const lostResult = toolResult(await bridgeTool(bridge, "chatgpt_conversation_result", { run_id: lost.run_id }));
  assert.equal(lostResult.status, "failed");
  assert.equal("assistant_text" in lostResult, false);

  const auditLog = await fs.readFile(auditFile, "utf8");
  assert.equal(auditLog.includes(distinctivePrompt), false);

  await bridge.stop();
  await host.stop();
  console.log("chatgpt conversation runs test passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
