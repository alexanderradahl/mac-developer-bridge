import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.resolve(here, "..", "bridge.mjs");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mac-developer-bridge-test-"));
const dataDir = path.join(tempRoot, "data");
const logDir = path.join(tempRoot, "logs");
const workDir = path.join(tempRoot, "work");
const foregroundApprovalFile = path.join(dataDir, "FOREGROUND_GUI_APPROVED");
const settingsFile = path.join(dataDir, "settings.json");
await fs.mkdir(workDir, { recursive: true });

async function verifyLockedByDefault() {
  const locked = spawn(process.execPath, [bridge], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MAC_DEV_BRIDGE_DATA_DIR: path.join(tempRoot, "locked-data"),
      MAC_DEV_BRIDGE_LOG_DIR: path.join(tempRoot, "locked-logs"),
      MAC_DEV_BRIDGE_UNLOCK_FILE: path.join(tempRoot, "locked-data", "FULL_ACCESS_ENABLED"),
      MAC_DEV_BRIDGE_FULL_ACCESS_ACK: "",
    },
  });
  let stderr = "";
  locked.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      locked.kill("SIGKILL");
      reject(new Error("locked bridge did not exit"));
    }, 5000);
    locked.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 78);
  assert.match(stderr, /Refusing to start unrestricted bridge/);
}

await verifyLockedByDefault();

const child = spawn(process.execPath, [bridge], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    MAC_DEV_BRIDGE_DATA_DIR: dataDir,
    MAC_DEV_BRIDGE_LOG_DIR: logDir,
    MAC_DEV_BRIDGE_FOREGROUND_GUI_APPROVAL_FILE: foregroundApprovalFile,
    MAC_DEV_BRIDGE_FULL_ACCESS_ACK: "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS",
  },
});
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let childStderr = "";
child.stderr.on("data", (chunk) => { childStderr += chunk.toString("utf8"); });

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request ${id} timed out; stderr=${childStderr}`));
    }, 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function call(id, name, args = {}) {
  const response = await request(id, "tools/call", {
    _meta: meta,
    name,
    arguments: args,
  });
  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.isError, false, JSON.stringify(response.result));
  return response.result.structuredContent;
}

try {
  const discover = await request("discover", "server/discover", { _meta: meta });
  assert.equal(discover.result.resultType, "complete");
  assert.ok(discover.result.supportedVersions.includes("2026-07-28"));

  const tools = await request("tools", "tools/list", { _meta: meta });
  assert.equal(tools.result.resultType, "complete");
  const byName = new Map(tools.result.tools.map((tool) => [tool.name, tool]));
  assert.ok(byName.has("shell_exec"));
  if (process.platform === "darwin") {
    for (const tool of ["chrome_workspace_status", "chrome_workspace_setup", "chrome_tabs", "chrome_open", "chrome_navigate", "chrome_snapshot", "chrome_click", "chrome_fill", "chrome_close"]) {
      assert.ok(byName.has(tool), `expected ${tool} on macOS`);
    }
    assert.equal(byName.get("chrome_workspace_status").annotations.readOnlyHint, true);
    assert.equal(byName.get("chrome_tabs").annotations.readOnlyHint, true);
    assert.equal(byName.get("chrome_click").annotations.destructiveHint, true);
  }
  assert.equal(byName.get("fs_write").annotations.destructiveHint, true);
  assert.equal(byName.get("apply_patch").annotations.destructiveHint, true);

  const status = await call("status", "bridge_status");
  assert.equal(status.fullAccessUnlocked, true);
  assert.equal(status.dataDir, dataDir);
  assert.equal(status.operatorSettings.strictApprovals, false, "relaxed approvals should be the default");

  const command = await call("shell", "shell_exec", {
    command: "printf smoke",
    cwd: workDir,
    timeout_ms: 5000,
  });
  assert.equal(command.stdout, "smoke");
  assert.equal(command.exitCode, 0);

  if (process.platform === "darwin") {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify({ strictApprovals: true }), { mode: 0o600 });
    const strictStatus = await call("strict-status", "bridge_status");
    assert.equal(strictStatus.operatorSettings.strictApprovals, true);

    const focusBlocked = await request("focus-blocked", "tools/call", {
      _meta: meta,
      name: "shell_exec",
      arguments: { command: "osascript -e 'tell application \"Google Chrome\" to get URL of active tab of front window'" },
    });
    assert.equal(focusBlocked.result.isError, true);
    assert.match(focusBlocked.result.content[0].text, /Strict approvals is enabled/);

    const selfBypassBlocked = await request("focus-self-bypass-blocked", "tools/call", {
      _meta: meta,
      name: "shell_exec",
      arguments: {
        command: "if false; then osascript -e 'tell application \"Slack\" to activate'; fi; printf should-not-run",
        env: { MAC_DEV_BRIDGE_ALLOW_FOREGROUND_GUI: "1" },
      },
    });
    assert.equal(selfBypassBlocked.result.isError, true);
    assert.match(selfBypassBlocked.result.content[0].text, /Strict approvals is enabled/);

    await fs.writeFile(foregroundApprovalFile, JSON.stringify({
      nonce: "abcdef0123456789abcdef0123456789",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedApps: ["Slack"],
    }), { mode: 0o600 });
    const foregroundApproved = await call("focus-operator-approved", "shell_exec", {
      command: "if false; then osascript -e 'tell application \"Slack\" to activate'; fi; printf approved",
    });
    assert.equal(foregroundApproved.stdout, "approved");
    await assert.rejects(fs.stat(foregroundApprovalFile), (error) => error?.code === "ENOENT");

    // Switching Strict approvals off is live and requires no bridge restart. The
    // GUI-looking branch is false so this test never activates Slack.
    await fs.writeFile(settingsFile, JSON.stringify({ strictApprovals: false }), { mode: 0o600 });
    const relaxedGui = await call("relaxed-gui", "shell_exec", {
      command: "if false; then osascript -e 'tell application \"Slack\" to activate'; fi; printf relaxed",
    });
    assert.equal(relaxedGui.stdout, "relaxed");
  }

  const originalPath = path.join(workDir, "demo.txt");
  const copyPath = path.join(workDir, "copy.txt");
  const movedPath = path.join(workDir, "moved.txt");
  await call("write", "fs_write", { path: originalPath, content: "one\n" });
  const read = await call("read", "fs_read", { path: originalPath });
  assert.equal(read.content, "one\n");

  const patch = [
    "diff --git a/demo.txt b/demo.txt",
    "--- a/demo.txt",
    "+++ b/demo.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "",
  ].join("\n");
  const patched = await call("patch", "apply_patch", { cwd: workDir, patch });
  assert.equal(patched.exitCode, 0, patched.stderr);
  const patchedRead = await call("patched-read", "fs_read", { path: originalPath });
  assert.equal(patchedRead.content, "two\n");

  await call("copy", "fs_manage", { operation: "copy", path: originalPath, destination: copyPath });
  await call("move", "fs_manage", { operation: "move", path: copyPath, destination: movedPath });
  const listed = await call("list", "fs_list", { path: workDir });
  assert.ok(listed.entries.some((entry) => entry.name === "moved.txt"));
  const stat = await call("stat", "fs_stat", { path: movedPath });
  assert.equal(stat.type, "file");
  await call("remove", "fs_manage", { operation: "remove", path: movedPath, force: true });

  const job = await call("job-start", "shell_start", {
    command: "sleep 0.15; printf background-complete",
    cwd: workDir,
    label: "smoke-background",
  });
  let jobStatus;
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    jobStatus = await call(`job-status-${index}`, "shell_job_status", { job_id: job.id });
    if (jobStatus.stdout.text.includes("background-complete")) break;
  }
  assert.match(jobStatus.stdout.text, /background-complete/);
  const jobs = await call("job-list", "shell_job_list");
  assert.ok(jobs.jobs.some((entry) => entry.id === job.id));

  const audit = await call("audit", "audit_tail", { max_bytes: 500000 });
  assert.match(audit.text, /"tool":"shell_exec"/);
  assert.match(audit.text, /"tool":"fs_write"/);

  const legacyInit = await request("legacy-init", "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "legacy-smoke", version: "1" },
  });
  assert.equal(legacyInit.result.protocolVersion, "2025-11-25");
  notify("notifications/initialized");
  const legacyTools = await request("legacy-tools", "tools/list", {});
  assert.ok(Array.isArray(legacyTools.result.tools));

  console.log("smoke test passed");
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  await fs.rm(tempRoot, { recursive: true, force: true });
}
