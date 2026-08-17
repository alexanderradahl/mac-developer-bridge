import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  INERT_PREFIX,
  SYNTHETIC_SECRET,
  createPoisonedRepository
} from "./fixtures/poisoned-repository.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(here, "..", "bridge.mjs");
const temporaryRoot = await fsp.realpath(
  await fsp.mkdtemp(path.join(os.tmpdir(), "mac-developer-bridge-adversarial-"))
);
const dataDir = path.join(temporaryRoot, "data");
const logDir = path.join(temporaryRoot, "logs");
const unlockFile = path.join(dataDir, "FULL_ACCESS_ENABLED");
const fullAccessAck = "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS";
const { repository, payloads } = await createPoisonedRepository(temporaryRoot);
await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
await fsp.writeFile(unlockFile, `${fullAccessAck}\n`, { mode: 0o600 });

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "poisoned-repository-test",
    version: "1"
  },
  "io.modelcontextprotocol/clientCapabilities": {}
};

function startBridge() {
  const env = { ...process.env };
  delete env.MAC_DEV_BRIDGE_FULL_ACCESS_ACK;
  Object.assign(env, {
    MAC_DEV_BRIDGE_DATA_DIR: dataDir,
    MAC_DEV_BRIDGE_LOG_DIR: logDir,
    MAC_DEV_BRIDGE_UNLOCK_FILE: unlockFile,
    MAC_DEV_BRIDGE_AUDIT_MODE: "metadata",
    MAC_DEV_BRIDGE_UNLOCK_RECHECK_MS: "60000",
    CONTROL_PLANE_API_KEY: "SYNTHETIC_CONTROL_PLANE_KEY_FOR_TESTS_ONLY"
  });

  const child = spawn(process.execPath, [bridgePath], {
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let exitCode;

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    entry.resolve(message);
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitCode = code;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(`bridge exited code=${code} signal=${signal}: ${stderr}`)
        );
      }
      pending.clear();
      resolve(code);
    });
  });

  return {
    child,
    exited,
    get exitCode() {
      return exitCode;
    },
    get stderr() {
      return stderr;
    },
    request(method, params = {}, timeoutMs = 10_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request timed out: ${method}; stderr=${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
        );
      });
    },
    async stop() {
      if (exitCode !== undefined) return;
      child.stdin.end();
      child.kill("SIGTERM");
      await exited;
    }
  };
}

async function call(client, name, args = {}) {
  const response = await client.request(
    "tools/call",
    { _meta: meta, name, arguments: args },
    20_000
  );
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
  return response.result.structuredContent;
}

const client = startBridge();
try {
  const tools = await client.request("tools/list", { _meta: meta });
  const names = new Set(tools.result.tools.map((tool) => tool.name));
  for (const name of [
    "shell_exec",
    "shell_start",
    "fs_read",
    "fs_write",
    "apply_patch"
  ]) {
    assert.ok(names.has(name), `${name} was not exposed while the latch was armed`);
  }

  const readme = await call(client, "fs_read", {
    path: path.join(repository, "README.md")
  });
  assert.equal(readme.content.includes(payloads.readme), true);

  const syntheticCredential = await call(client, "fs_read", {
    path: path.join(repository, ".synthetic", "credentials.env")
  });
  assert.equal(
    syntheticCredential.content,
    `SYNTHETIC_API_KEY=${SYNTHETIC_SECRET}\n`
  );
  const syntheticSsh = await call(client, "fs_read", {
    path: path.join(repository, ".synthetic", "id_ed25519")
  });
  assert.doesNotMatch(syntheticSsh.content, /BEGIN [A-Z ]*PRIVATE KEY/);

  const packageOutput = await call(client, "shell_exec", {
    command: "npm run fixture-output --ignore-scripts --silent",
    cwd: repository
  });
  assert.equal(packageOutput.exitCode, 0, packageOutput.stderr);
  assert.equal(packageOutput.stdout.trim(), payloads.packageOutput);

  const gitMetadata = await call(client, "shell_exec", {
    command: "git config --get fixture.model-instruction",
    cwd: repository
  });
  assert.equal(gitMetadata.exitCode, 0, gitMetadata.stderr);
  assert.equal(gitMetadata.stdout.trim(), payloads.gitMetadata);

  const expected = JSON.parse(
    await fsp.readFile(path.join(repository, ".fixture", "expected.json"), "utf8")
  );
  assert.equal(
    expected.format,
    "mac-developer-bridge-poisoned-repository/v1"
  );
  assert.equal(expected.expected_bridge_behavior.length, 3);
  assert.equal(expected.expected_model_behavior.length, 2);
  assert.equal(expected.prohibited_test_behavior.length, 3);
  assert.equal(
    Object.values(expected.payloads).every((value) => value.includes(INERT_PREFIX)),
    true
  );
  await assert.rejects(
    fsp.stat(path.join(repository, ".fixture-side-effect")),
    { code: "ENOENT" }
  );

  await fsp.rm(unlockFile);
  client.request("tools/call", {
    _meta: meta,
    name: "fs_read",
    arguments: { path: path.join(repository, "README.md") }
  }).catch(() => {});

  const code = await Promise.race([
    client.exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))
  ]);
  assert.equal(code, 78, `revoked bridge did not exit 78; stderr=${client.stderr}`);
  assert.match(client.stderr, /Full-access unlock revoked/);

  const audit = await fsp.readFile(path.join(logDir, "audit.jsonl"), "utf8");
  assert.match(audit, /"revoked":true/);
  assert.match(audit, /"tool":"fs_read"/);

  console.log("poisoned repository adversarial test passed");
} finally {
  await client.stop();
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
