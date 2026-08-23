import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(here, "..", "bridge.mjs");
// macOS: /var is a symlink to /private/var, and the shell resolves it in $PWD.
const temporaryRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mac-developer-bridge-test-")));
const workDir = path.join(temporaryRoot, "work");
const dataDir = path.join(temporaryRoot, "data");
const logDir = path.join(temporaryRoot, "logs");
await fsp.mkdir(workDir, { recursive: true });

const fakeCodex = path.join(temporaryRoot, "fake-codex.mjs");
await fsp.writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 0 && message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: 0, result: { userAgent: "fake-codex" } }) + "\\n");
    return;
  }
  if (message.id === 1 && message.method === "thread/read") {
    process.stdout.write(JSON.stringify({ id: 1, result: { thread: { id: message.params.threadId, turns: message.params.includeTurns ? [{ id: "turn-1" }] : [] } } }) + "\\n");
    return;
  }
  if (message.id === 1 && message.method === "thread/list") {
    process.stdout.write(JSON.stringify({ id: 1, result: { data: [{ id: "thread-a" }], nextCursor: null, received: message.params } }) + "\\n");
    return;
  }
  if (message.id === 1 && message.method === "thread/turns/list") {
    process.stdout.write(JSON.stringify({
      id: 1,
      result: {
        data: [{ id: "turn-a", items: message.params.itemsView === "full" ? [{ id: "item-a", type: "userMessage" }] : [] }],
        nextCursor: "cursor-next",
        backwardsCursor: null,
        received: message.params,
      },
    }) + "\\n");
  }
});
`, { mode: 0o755 });
await fsp.chmod(fakeCodex, 0o755);

function startBridge() {
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      MAC_DEV_BRIDGE_SHELL: fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
      MAC_DEV_BRIDGE_DATA_DIR: dataDir,
      MAC_DEV_BRIDGE_LOG_DIR: logDir,
      MAC_DEV_BRIDGE_AUDIT_MODE: "metadata",
      MAC_DEV_BRIDGE_FULL_ACCESS_ACK: "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS",
      CODEX_BIN: fakeCodex,
      CONTROL_PLANE_API_KEY: "sk-test-tunnel-runtime-key-not-a-real-secret",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message);
    }
  });
  child.once("exit", (code, signal) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`bridge exited code=${code} signal=${signal}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    child,
    get stderr() { return stderr; },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    request(method, params = {}, timeoutMs = 10_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request timed out: ${method}; stderr=${stderr}`));
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
  "io.modelcontextprotocol/clientInfo": { name: "integration-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function modernTool(client, name, args = {}) {
  const response = await client.request("tools/call", { _meta: modernMeta, name, arguments: args }, 20_000);
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.isError, false, response.result?.content?.[0]?.text);
  return response.result.structuredContent;
}

async function poll(predicate, { attempts = 40, delayMs = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("poll timed out");
}

try {
  const client = startBridge();
  const discovery = await client.request("server/discover", { _meta: modernMeta });
  assert.equal(discovery.result.resultType, "complete");
  assert.ok(discovery.result.supportedVersions.includes("2026-07-28"));

  const tools = await client.request("tools/list", { _meta: modernMeta });
  assert.equal(tools.result.resultType, "complete");
  const shellExec = tools.result.tools.find((tool) => tool.name === "shell_exec");
  assert.ok(shellExec, "shell_exec must be advertised");
  assert.equal(shellExec.inputSchema.properties.timeout_ms.default, 600_000);
  assert.equal(shellExec.inputSchema.properties.timeout_ms.maximum, 1_800_000);

  const status = await modernTool(client, "bridge_status");
  assert.equal(status.dataDir, dataDir);
  assert.equal(status.codexBin, fakeCodex);
  assert.equal(status.tunnelRuntimeKeyScrubbedFromChildEnvironment, true);

  const shell = await modernTool(client, "shell_exec", {
    command: "printf '%s|%s' \"$PWD\" \"$BRIDGE_TEST_VALUE\"",
    cwd: workDir,
    env: { BRIDGE_TEST_VALUE: "environment-ok" },
  });
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.stdout, `${workDir}|environment-ok`);

  const omittedTimeout = await modernTool(client, "shell_exec", {
    command: "sleep 0.15; printf long-default",
    cwd: workDir,
  });
  assert.equal(omittedTimeout.exitCode, 0);
  assert.equal(omittedTimeout.timedOut, false);
  assert.equal(omittedTimeout.stdout, "long-default");

  const explicitTimeout = await modernTool(client, "shell_exec", {
    command: "sleep 0.15; printf explicit-timeout",
    cwd: workDir,
    timeout_ms: 50,
  });
  assert.equal(explicitTimeout.timedOut, true);
  assert.notEqual(explicitTimeout.stdout, "explicit-timeout");

  const disabledTimeout = await modernTool(client, "shell_exec", {
    command: "sleep 0.15; printf timeout-disabled",
    cwd: workDir,
    timeout_ms: 0,
  });
  assert.equal(disabledTimeout.exitCode, 0);
  assert.equal(disabledTimeout.timedOut, false);
  assert.equal(disabledTimeout.stdout, "timeout-disabled");

  const scrubbed = await modernTool(client, "shell_exec", {
    command: "test -z \"${CONTROL_PLANE_API_KEY:-}\" && printf scrubbed",
    cwd: workDir,
  });
  assert.equal(scrubbed.exitCode, 0);
  assert.equal(scrubbed.stdout, "scrubbed");

  const nestedFile = path.join(workDir, "nested", "sample.txt");
  await modernTool(client, "fs_write", { path: nestedFile, content: "first", mode: 0o640 });
  await modernTool(client, "fs_write", { path: nestedFile, content: "-second", append: true });
  const read = await modernTool(client, "fs_read", { path: nestedFile });
  assert.equal(read.content, "first-second");
  const stat = await modernTool(client, "fs_stat", { path: nestedFile });
  assert.equal(stat.type, "file");
  assert.equal(stat.mode & 0o777, 0o640);

  await modernTool(client, "fs_write", { path: nestedFile, content: "replaced" });
  const replacedStat = await modernTool(client, "fs_stat", { path: nestedFile });
  assert.equal(replacedStat.mode & 0o777, 0o640, "atomic replacement should preserve an existing mode");

  const list = await modernTool(client, "fs_list", { path: workDir, recursive: true });
  assert.ok(list.entries.some((entry) => entry.path === nestedFile));

  const targetFile = path.join(workDir, "links", "target.txt");
  const linkFile = path.join(workDir, "links", "relative-link.txt");
  await modernTool(client, "fs_write", { path: targetFile, content: "target" });
  await modernTool(client, "fs_manage", { operation: "symlink", path: linkFile, destination: "target.txt" });
  const linkStat = await modernTool(client, "fs_stat", { path: linkFile });
  assert.equal(linkStat.type, "symlink");
  assert.equal(linkStat.symlinkTarget, "target.txt");

  const copiedFile = path.join(workDir, "copied.txt");
  const movedFile = path.join(workDir, "moved.txt");
  await modernTool(client, "fs_manage", { operation: "copy", path: targetFile, destination: copiedFile });
  await modernTool(client, "fs_manage", { operation: "move", path: copiedFile, destination: movedFile });
  assert.equal((await fsp.readFile(movedFile, "utf8")), "target");
  await assert.rejects(fsp.stat(copiedFile));

  const repository = path.join(workDir, "repository");
  await fsp.mkdir(repository);
  await modernTool(client, "shell_exec", { command: "git init -q", cwd: repository });
  await modernTool(client, "fs_write", { path: path.join(repository, "message.txt"), content: "before\n" });
  const patch = `diff --git a/message.txt b/message.txt\n--- a/message.txt\n+++ b/message.txt\n@@ -1 +1 @@\n-before\n+after\n`;
  const patchResult = await modernTool(client, "apply_patch", { cwd: repository, patch });
  assert.equal(patchResult.exitCode, 0, patchResult.stderr);
  assert.equal(await fsp.readFile(path.join(repository, "message.txt"), "utf8"), "after\n");

  const job = await modernTool(client, "shell_start", {
    command: "printf job-started; sleep 30",
    cwd: workDir,
    label: "integration",
  });
  assert.ok(Number.isInteger(job.pid));
  const running = await poll(async () => {
    const current = await modernTool(client, "shell_job_status", { job_id: job.id });
    return current.running && current.stdout.text.includes("job-started") ? current : null;
  });
  assert.equal(running.running, true);
  await modernTool(client, "shell_job_kill", { job_id: job.id, signal: "SIGTERM" });
  await poll(async () => {
    const current = await modernTool(client, "shell_job_status", { job_id: job.id });
    return current.running ? null : current;
  });

  const thread = await modernTool(client, "codex_thread_read", {
    thread_id: "019fa926-dbbd-7d72-aa0c-8edd41bd585c",
    include_turns: true,
  });
  assert.equal(thread.thread.id, "019fa926-dbbd-7d72-aa0c-8edd41bd585c");
  assert.equal(thread.thread.turns.length, 1);

  const threadList = await modernTool(client, "codex_thread_list", { limit: 7, search_term: "preview" });
  assert.equal(threadList.data[0].id, "thread-a");
  assert.equal(threadList.received.limit, 7);
  assert.equal(threadList.received.searchTerm, "preview");

  const turns = await modernTool(client, "codex_thread_turns_list", {
    thread_id: "019fa926-dbbd-7d72-aa0c-8edd41bd585c",
    limit: 25,
    sort_direction: "asc",
    items_view: "full",
  });
  assert.equal(turns.data[0].id, "turn-a");
  assert.equal(turns.data[0].items[0].id, "item-a");
  assert.equal(turns.received.threadId, "019fa926-dbbd-7d72-aa0c-8edd41bd585c");
  assert.equal(turns.received.limit, 25);
  assert.equal(turns.received.sortDirection, "asc");
  assert.equal(turns.received.itemsView, "full");
  assert.equal(turns.nextCursor, "cursor-next");

  const audit = await modernTool(client, "audit_tail", { max_bytes: 1_000_000 });
  assert.ok(audit.text.includes('"tool":"shell_exec"'));
  assert.ok(audit.text.includes('"tool":"codex_thread_read"'));
  assert.ok(audit.text.includes('"tool":"codex_thread_turns_list"'));

  await client.stop();

  const legacy = startBridge();
  const initialized = await legacy.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "legacy-test", version: "1" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  legacy.notify("notifications/initialized");
  const legacyTools = await legacy.request("tools/list", {});
  assert.ok(legacyTools.result.tools.some((tool) => tool.name === "fs_write"));
  const legacyCall = await legacy.request("tools/call", { name: "shell_exec", arguments: { command: "printf legacy-ok" } });
  assert.equal(legacyCall.result.isError, false);
  assert.equal(legacyCall.result.structuredContent.stdout, "legacy-ok");
  await legacy.stop();

  console.log("integration test passed");
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
