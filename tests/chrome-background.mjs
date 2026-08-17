import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { backgroundChromeCall, backgroundChromeStatus } from "../lib/chrome-extension-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bridgePath = path.join(root, "bridge.mjs");
const hostPath = path.join(root, "scripts", "chrome-native-host.mjs");
const tempRoot = await fs.mkdtemp("/tmp/mdb-chrome-");
const dataDir = path.join(tempRoot, "data");
const logDir = path.join(tempRoot, "logs");
const socketPath = path.join(dataDir, "chrome-background.sock");
const approvalFile = path.join(dataDir, "PERSONAL_BROWSER_APPROVED");
const profileBindingFile = path.join(dataDir, "chrome-background-profile.json");
const sharedGrantDir = path.join(dataDir, "chrome-background-grants");
const settingsFile = path.join(dataDir, "settings.json");
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
  const seen = [];
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      seen.push(message);
      if (message.type === "request") {
        child.stdin.write(frameNative({
          type: "response",
          id: message.id,
          ok: true,
          result: message.method === "tabs.list"
            ? { tabs: [{ tabId: 42, windowId: 7, active: false, title: "Allowed", url: "https://www.producthunt.com/test", status: "complete" }], count: 1 }
            : { echoedMethod: message.method, echoedArgs: message.args },
        }));
      }
    }
  });
  return {
    child,
    seen,
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
      MAC_DEV_BRIDGE_PERSONAL_APPROVAL_FILE: approvalFile,
      MAC_DEV_BRIDGE_CHROME_SOCKET: socketPath,
      MAC_DEV_BRIDGE_FULL_ACCESS_ACK: "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS",
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
  "io.modelcontextprotocol/clientInfo": { name: "chrome-background-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function bridgeTool(client, name, args = {}) {
  return await client.request("tools/call", { _meta: modernMeta, name, arguments: args });
}

try {
  // Stable extension id: the manifest public key must continue to hash to the id
  // written into the native-host allowlist by install-background-chrome.sh.
  const manifest = JSON.parse(await fs.readFile(path.join(root, "chrome-extension", "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("tabGroups"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.icons?.["16"] && manifest.icons?.["128"]);
  await Promise.all([16, 32, 48, 128].map(async (size) => {
    const stat = await fs.stat(path.join(root, "chrome-extension", "icons", `icon-${size}.png`));
    assert.ok(stat.size > 0, `expected non-empty ${size}px extension icon`);
  }));
  const workerSource = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
  assert.match(workerSource, /WORKSPACE_GROUP_TITLE = "MDB"/);
  assert.match(workerSource, /chrome\.tabs\.group/);
  assert.match(workerSource, /chrome\.tabGroups\.query/);
  assert.match(workerSource, /workspace\.open/);
  assert.match(workerSource, /CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED/);
  assert.match(workerSource, /targetWindow\.focused !== true/);
  assert.match(workerSource, /waitForApprovedNavigation/);
  assert.match(workerSource, /CHROME_NAVIGATION_TIMEOUT/);
  const publicKey = Buffer.from(manifest.key, "base64");
  const digest = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const extensionId = [...digest].flatMap((byte) => [byte >> 4, byte & 0x0f]).map((n) => String.fromCharCode(97 + n)).join("");
  assert.equal(extensionId, "pcebfblnmcappinbenkmddjdapaoajgm");

  await fs.writeFile(profileBindingFile, JSON.stringify({
    profileDirectory: "Default",
    expectedEmail: "bound@example.com",
    expectedGaiaId: "123456789012345678901",
  }), { mode: 0o600 });

  const offline = await backgroundChromeStatus({ socketPath, timeoutMs: 100 });
  assert.equal(offline.extensionReady, false);
  assert.equal(offline.error.code, "CHROME_EXTENSION_OFFLINE");

  await fs.writeFile(settingsFile, JSON.stringify({ strictApprovals: true }), { mode: 0o600 });
  const bridge = startBridge();
  await fs.writeFile(approvalFile, JSON.stringify({
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    provider: "chrome-background",
    allowedUrlPatterns: ["https://www.producthunt.com/*"],
  }), { mode: 0o600 });

  // Offline setup state MUST NOT consume the single-use approval.
  const failed = await bridgeTool(bridge, "chrome_tabs", {});
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /background chrome extension is offline/i);
  await fs.stat(approvalFile);

  const host = startFakeExtensionHost();
  await waitForPath(socketPath);

  host.ready({ signedIn: true, email: "wrong@example.com", id: "999999999999999999999" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const wrongProfileStatus = await backgroundChromeStatus({ socketPath });
  assert.equal(wrongProfileStatus.extensionConnected, true);
  assert.equal(wrongProfileStatus.extensionReady, false);
  assert.equal(wrongProfileStatus.profileError.code, "CHROME_PROFILE_MISMATCH");
  await assert.rejects(
    backgroundChromeCall("tabs.list", { maxTabs: 3 }, ["https://www.producthunt.com/*"], { socketPath }),
    (error) => error?.code === "CHROME_PROFILE_MISMATCH",
  );

  host.ready();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const hostStatus = await backgroundChromeStatus({ socketPath });
  assert.equal(hostStatus.extensionConnected, true);
  assert.equal(hostStatus.extensionReady, true);
  assert.equal(hostStatus.extension.extensionId, extensionId);
  assert.equal(hostStatus.extension.profile.email, "bound@example.com");
  assert.equal(hostStatus.extension.profile.matchesBinding, true);
  assert.equal(hostStatus.profileBinding.expectedEmail, "bound@example.com");

  // Relaxed is the product default: authenticated browser work needs no URL-grant
  // file, and changing the setting is live.
  await fs.rm(approvalFile, { force: true });
  await fs.writeFile(settingsFile, JSON.stringify({ strictApprovals: false }), { mode: 0o600 });
  const relaxed = await bridgeTool(bridge, "chrome_tabs", { max_tabs: 5 });
  assert.equal(relaxed.result.isError, false, relaxed.result.content[0].text);
  assert.equal(relaxed.result.structuredContent._background.accessMode, "relaxed");
  assert.equal(relaxed.result.structuredContent._background.strictApprovals, false);
  assert.deepEqual(new Set(host.seen.at(-1).allowedUrlPatterns), new Set(["http://*/*", "https://*/*"]));

  // Switch Strict approvals back on for the scoped-grant regression below.
  await fs.writeFile(settingsFile, JSON.stringify({ strictApprovals: true }), { mode: 0o600 });
  await fs.writeFile(approvalFile, JSON.stringify({
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    provider: "chrome-background",
    allowedUrlPatterns: ["https://www.producthunt.com/*"],
  }), { mode: 0o600 });

  // Workspace setup/status are local extension state. They must not require or
  // consume an authenticated-site URL grant.
  const localStatus = await backgroundChromeCall("workspace.status", {}, [], { socketPath });
  assert.equal(localStatus.echoedMethod, "workspace.status");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, []);
  const bridgeWorkspace = await bridgeTool(bridge, "chrome_workspace_status", {});
  assert.equal(bridgeWorkspace.result.isError, false, bridgeWorkspace.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.status");
  await fs.stat(approvalFile);
  const bridgeSetup = await bridgeTool(bridge, "chrome_workspace_setup", { pool_size: 6 });
  assert.equal(bridgeSetup.result.isError, false, bridgeSetup.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.init");
  assert.equal(host.seen.at(-1).args.poolSize, 6);
  await fs.stat(approvalFile);
  await assert.rejects(
    backgroundChromeCall("tabs.list", { maxTabs: 3 }, [], { socketPath }),
    (error) => error?.code === "CHROME_NO_URL_GRANT",
  );

  // Direct client protocol forwards method, args and URL-pattern scope.
  const direct = await backgroundChromeCall("tabs.list", { maxTabs: 3 }, ["https://www.producthunt.com/*"], { socketPath });
  assert.equal(direct.count, 1);
  assert.equal(host.seen.at(-1).method, "tabs.list");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, ["https://www.producthunt.com/*"]);

  // The bridge now consumes the grant, returns only the fake extension result,
  // and reuses the in-memory grant for later calls until expiry.
  const worked = await bridgeTool(bridge, "chrome_tabs", { max_tabs: 5 });
  assert.equal(worked.result.isError, false, worked.result.content[0].text);
  assert.equal(worked.result.structuredContent.count, 1);
  assert.equal(worked.result.structuredContent._background.provider, "chrome-background");
  assert.equal(worked.result.structuredContent._background.sharedAcrossSessions, true);
  assert.equal(worked.result.structuredContent._background.grantCount, 1);
  await assert.rejects(fs.stat(approvalFile), (error) => error?.code === "ENOENT");
  const persistedAfterFirst = (await fs.readdir(sharedGrantDir)).filter((name) => name.endsWith(".json"));
  assert.equal(persistedAfterFirst.length, 1, "consumed legacy grant should persist until expiry");

  // A second chat may approve a different site while the first grant is still
  // active. The bridge must import and UNION that scope immediately, not ignore
  // it until the first grant expires.
  await fs.writeFile(approvalFile, JSON.stringify({
    nonce: "fedcba9876543210fedcba9876543210",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    provider: "chrome-background",
    allowedUrlPatterns: ["https://www.reddit.com/*"],
  }), { mode: 0o600 });
  const additive = await bridgeTool(bridge, "chrome_tabs", { title_contains: "allowed" });
  assert.equal(additive.result.isError, false, additive.result.content[0].text);
  assert.equal(additive.result.structuredContent._background.grantCount, 2);
  assert.deepEqual(
    new Set(additive.result.structuredContent._background.allowedUrlPatterns),
    new Set(["https://www.producthunt.com/*", "https://www.reddit.com/*"]),
  );
  assert.deepEqual(
    new Set(host.seen.at(-1).allowedUrlPatterns),
    new Set(["https://www.producthunt.com/*", "https://www.reddit.com/*"]),
  );
  await assert.rejects(fs.stat(approvalFile), (error) => error?.code === "ENOENT");
  assert.equal((await fs.readdir(sharedGrantDir)).filter((name) => name.endsWith(".json")).length, 2);

  // The shared pool is disk-backed: a replacement bridge child sees both still-
  // unexpired grants without asking the operator to approve them again.
  await bridge.stop();
  const bridgeAfterRestart = startBridge();
  const afterRestart = await bridgeTool(bridgeAfterRestart, "chrome_tabs", { max_tabs: 5 });
  assert.equal(afterRestart.result.isError, false, afterRestart.result.content[0].text);
  assert.equal(afterRestart.result.structuredContent._background.grantCount, 2);
  assert.deepEqual(
    new Set(afterRestart.result.structuredContent._background.allowedUrlPatterns),
    new Set(["https://www.producthunt.com/*", "https://www.reddit.com/*"]),
  );

  const opened = await bridgeTool(bridgeAfterRestart, "chrome_open", { url: "https://www.producthunt.com/" });
  assert.equal(opened.result.isError, false, opened.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.open", "chrome_open must lease a pre-created workspace tab");
  assert.equal(host.seen.at(-1).args.url, "https://www.producthunt.com/");
  assert.deepEqual(
    new Set(host.seen.at(-1).allowedUrlPatterns),
    new Set(["https://www.producthunt.com/*", "https://www.reddit.com/*"]),
  );

  await bridgeAfterRestart.stop();
  await host.stop();
  console.log("background Chrome test passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
