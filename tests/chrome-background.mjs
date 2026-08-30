import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
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
const auditFile = path.join(logDir, "audit.jsonl");
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

function rawSocketCall(payload, target = socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw native-host socket call timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
            : message.method === "workspace.release"
              ? { released: true, workspace: true, tabId: message.args?.tabId ?? null }
              : message.method === "chatgpt.extensionStatus"
                ? { available: true, pageBridgeAvailable: true, extensionId: "hehggadaopoacecdllhhajmbjkdcmajg", state: { nativeHostStatus: "connected" } }
                : message.method === "tabs.chatgptConversationStart"
                  ? {
                    ok: true,
                    complete: true,
                    conversation_id: message.args?.conversationId || "conversation-test",
                    assistant_message_id: "assistant-test",
                    assistant_text: "stub assistant response",
                    model: message.args?.model,
                    thinking_effort: message.args?.thinkingEffort,
                    max_runtime_seconds: message.args?.maxRuntimeSeconds,
                    prompt_bytes: Buffer.byteLength(message.args?.prompt || "", "utf8"),
                  }
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
  assert.equal(manifest.version, "0.2.11");
  assert.equal(manifest.permissions.includes("debugger"), false, "realistic click support must not require Chrome debugger permission");
  await Promise.all([16, 32, 48, 128].map(async (size) => {
    const stat = await fs.stat(path.join(root, "chrome-extension", "icons", `icon-${size}.png`));
    assert.ok(stat.size > 0, `expected non-empty ${size}px extension icon`);
  }));
  const workerSource = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
  assert.match(workerSource, /const VERSION = "0\.2\.11"/);
  assert.match(workerSource, /WORKSPACE_GROUP_TITLE = "MDB"/);
  assert.match(workerSource, /chrome\.tabs\.group/);
  assert.match(workerSource, /chrome\.tabGroups\.query/);
  assert.match(workerSource, /workspace\.open/);
  assert.match(workerSource, /case "tabs\.open"/);
  assert.match(workerSource, /initializeWorkspaceIfChromeFocused/);
  assert.match(workerSource, /chrome\.windows\.onFocusChanged/);
  const legacyOpenCase = workerSource.match(/case "workspace\.open":[\s\S]*?case "tabs\.list":/)?.[0] || "";
  assert.match(legacyOpenCase, /case "tabs\.open"/);
  assert.match(legacyOpenCase, /return await leaseWorkspaceTab/);
  assert.doesNotMatch(legacyOpenCase, /await chrome\.tabs\.create/);
  assert.match(workerSource, /CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED/);
  assert.match(workerSource, /targetWindow\.focused !== true/);
  assert.match(workerSource, /waitForApprovedNavigation/);
  assert.match(workerSource, /CHROME_NAVIGATION_TIMEOUT/);
  assert.match(workerSource, /DEFAULT_WORKSPACE_POOL_SIZE = 8/);
  assert.match(workerSource, /MAX_WORKSPACE_POOL_SIZE = 32/);
  assert.match(workerSource, /WORKSPACE_AUTO_GROW_STEP = 4/);
  assert.match(workerSource, /WORKSPACE_TARGET_KEY = "macDeveloperBridgeWorkspaceTarget"/);
  assert.match(workerSource, /provisionWorkspaceTargetSize/);
  assert.match(workerSource, /autoProvisionWorkspaceForPressure/);
  assert.match(workerSource, /pendingForegroundExpansion/);
  assert.match(workerSource, /targetWindow\.focused !== true/);
  assert.match(workerSource, /return workspaceProvisioningResult\(state, targetPoolSize, \{ deferred: true \}\)/);
  assert.match(workerSource, /WORKSPACE_LEASE_IDLE_TIMEOUT_MS = 10 \* 60 \* 1000/);
  assert.match(workerSource, /WORKSPACE_LEASE_WAIT_TIMEOUT_MS = 20_000/);
  assert.match(workerSource, /reserveIdleWorkspaceTab/);
  assert.match(workerSource, /touchWorkspaceLease/);
  assert.match(workerSource, /chatgptExtensionStatus/);
  assert.match(workerSource, /chatgpt-extension-request-status/);
  assert.match(workerSource, /async function pageChatgptConversationStart/);
  assert.match(workerSource, /async function pageChatgptRuntimeConversationStart/);
  assert.match(workerSource, /submitComposer:text_action/);
  assert.match(workerSource, /kind: "text_action", text: prompt/);
  assert.match(workerSource, /UI automation was not attempted/);
  assert.match(workerSource, /CHATGPT_CONVERSATION_REQUIREMENTS_UNAVAILABLE/);
  assert.match(workerSource, /case "tabs\.chatgptConversationStart"/);
  assert.match(workerSource, /transport === "runtime"[\s\S]*?pageChatgptRuntimeConversationStart[\s\S]*?pageChatgptConversationStart/);
  assert.match(workerSource, /modelReadyDeadline = Date\.now\(\) \+ 20_000/);
  assert.match(workerSource, /CHATGPT_RUNTIME_MODEL_MISMATCH/);
  assert.match(workerSource, /CHATGPT_RUNTIME_NOT_READY/);
  const nativeHostSource = await fs.readFile(path.join(root, "scripts", "chrome-native-host.mjs"), "utf8");
  assert.match(nativeHostSource, /MAX_REQUEST_TIMEOUT_MS = 3_720_000/);
  assert.match(workerSource, /dispatchPointer\("pointerdown", 1\)/);
  assert.match(workerSource, /dispatchMouse\("mousedown", 1\)/);
  assert.match(workerSource, /dispatchMouse\("mouseup", 0\)/);
  assert.match(workerSource, /strategy: "adaptive-pointer-mouse-sequence"/);
  assert.match(workerSource, /trusted: false/);
  assert.match(workerSource, /semanticMouseDownControl/);
  assert.match(workerSource, /activatedOnMouseDown/);
  assert.match(workerSource, /mouseDownAllowed === false/);
  assert.match(workerSource, /ariaExpanded: element\.getAttribute\("aria-expanded"\)/);
  assert.match(workerSource, /ariaHasPopup: element\.getAttribute\("aria-haspopup"\)/);
  assert.match(workerSource, /dataState: element\.getAttribute\("data-state"\)/);
  assert.match(workerSource, /executeInTab\(tab\.id, pageClick, \[String\(args\.selector \|\| ""\)\], "MAIN"\)/);
  assert.match(workerSource, /keyboardFallbackUsed/);
  assert.match(workerSource, /keydown:ArrowDown/);
  assert.match(workerSource, /activation = "keyboard-arrowdown"/);
  assert.match(workerSource, /message\.method === "extension\.reload"/);
  assert.match(workerSource, /chrome\.runtime\.reload\(\)/);
  assert.match(workerSource, /async function pageFill\(/);
  assert.match(workerSource, /CHROME_FILL_NOT_STICKY/);
  assert.match(workerSource, /FRAMEWORK_COMMIT_FALLBACK_MS = 250/);
  assert.match(workerSource, /fallbackTimer = setTimeout\(finish, FRAMEWORK_COMMIT_FALLBACK_MS\)/);
  assert.match(workerSource, /const matches = \[\.\.\.document\.querySelectorAll\(selector\)\]/);
  assert.match(workerSource, /requestSubmit:visible-submitter/);
  assert.match(workerSource, /if \(unique\(candidate\)\) return candidate/);
  assert.match(workerSource, /executeInTab\(tab\.id, pageFill, \[String\(args\.selector \|\| ""\), String\(args\.value \?\? ""\), Boolean\(args\.submit\)\], "MAIN"\)/);
  assert.equal((workerSource.match(/async function executeInTab\(/g) || []).length, 1, "executeInTab should have one definition");
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
  assert.deepEqual(new Set(host.seen.at(-1).allowedUrlPatterns), new Set(["http://*:*/*", "https://*:*/*"]));

  const sensitivePrompt = "browser bridge prompt must never appear in the audit log";
  const chatgptProjectId = "g-p-6a8dee0602b0819184fa43aae5a20ee9";
  const conversation = await bridgeTool(bridge, "chatgpt_conversation_start", {
    prompt: sensitivePrompt,
    model: "gpt-5-6-pro",
    thinking_effort: "standard",
    project_id: chatgptProjectId,
    max_runtime_seconds: 3300,
  });
  assert.equal(conversation.result.isError, false, conversation.result.content[0].text);
  assert.equal(conversation.result.structuredContent.complete, true);
  assert.equal(conversation.result.structuredContent.conversation_id, "conversation-test");
  assert.equal(host.seen.at(-1).method, "tabs.chatgptConversationStart");
  assert.equal(host.seen.at(-1).args.prompt, sensitivePrompt);
  assert.equal(host.seen.at(-1).args.transport, "runtime");
  assert.equal(host.seen.at(-1).args.maxRuntimeSeconds, 3300);
  assert.equal(host.seen.at(-1).args.continueInWork, true);
  assert.equal(host.seen.at(-1).args.projectId, chatgptProjectId);
  assert.deepEqual(new Set(host.seen.at(-1).allowedUrlPatterns), new Set(["http://*:*/*", "https://*:*/*"]));

  const continuation = await bridgeTool(bridge, "chatgpt_conversation_start", {
    prompt: "continue existing conversation",
    conversation_id: "conversation-test",
  });
  assert.equal(continuation.result.isError, false, continuation.result.content[0].text);
  assert.equal(continuation.result.structuredContent.conversation_id, "conversation-test");
  assert.equal(host.seen.at(-1).args.conversationId, "conversation-test");
  const auditText = await fs.readFile(auditFile, "utf8");
  assert.ok(!auditText.includes(sensitivePrompt), "conversation prompt leaked into the audit log");
  assert.match(auditText, /REDACTED \d+ bytes sha256:[0-9a-f]{16}/);

  const rawConversation = await bridgeTool(bridge, "chatgpt_conversation_start", {
    prompt: "explicit raw diagnostic",
    transport: "raw",
  });
  assert.equal(rawConversation.result.isError, false, rawConversation.result.content[0].text);
  assert.equal(host.seen.at(-1).args.transport, "raw");

  const beforeInvalidTransport = host.seen.length;
  const invalidTransport = await bridgeTool(bridge, "chatgpt_conversation_start", {
    prompt: "safe prompt",
    transport: "auto",
  });
  assert.equal(invalidTransport.result.isError, true);
  assert.match(invalidTransport.result.structuredContent.error, /runtime or raw/);
  assert.equal(host.seen.length, beforeInvalidTransport, "invalid transport must fail before browser dispatch");

  const beforeRefused = host.seen.length;
  const refusedSecurityFields = await bridgeTool(bridge, "chatgpt_conversation_start", {
    prompt: "safe prompt",
    authorization: "Bearer copied-value",
  });
  assert.equal(refusedSecurityFields.result.isError, true);
  assert.equal(refusedSecurityFields.result.structuredContent.code, "CHATGPT_SECURITY_FIELDS_REFUSED");
  assert.equal(host.seen.length, beforeRefused, "security-field rejection must happen before browser dispatch");

  const beforeOversize = host.seen.length;
  const oversizePrompt = await bridgeTool(bridge, "chatgpt_conversation_start", { prompt: "x".repeat(4_000_001) });
  assert.equal(oversizePrompt.result.isError, true);
  assert.match(oversizePrompt.result.structuredContent.error, /4000000 UTF-8 bytes/);
  assert.equal(host.seen.length, beforeOversize, "oversize prompt rejection must happen before browser dispatch");

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
  const reloadLocal = await backgroundChromeCall("extension.reload", {}, [], { socketPath });
  assert.equal(reloadLocal.echoedMethod, "extension.reload");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, []);
  const localStatus = await backgroundChromeCall("workspace.status", {}, [], { socketPath });
  assert.equal(localStatus.echoedMethod, "workspace.status");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, []);
  const chatgptStatus = await backgroundChromeCall("chatgpt.extensionStatus", {}, [], { socketPath });
  assert.equal(chatgptStatus.available, true);
  assert.equal(host.seen.at(-1).method, "chatgpt.extensionStatus");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, []);
  const directRelease = await backgroundChromeCall("workspace.release", { tabId: 42 }, [], { socketPath });
  assert.equal(directRelease.released, true);
  assert.equal(host.seen.at(-1).method, "workspace.release");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, []);
  const bridgeWorkspace = await bridgeTool(bridge, "chrome_workspace_status", {});
  assert.equal(bridgeWorkspace.result.isError, false, bridgeWorkspace.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.status");
  await fs.stat(approvalFile);
  const bridgeSetupDefault = await bridgeTool(bridge, "chrome_workspace_setup", {});
  assert.equal(bridgeSetupDefault.result.isError, false, bridgeSetupDefault.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.init");
  assert.equal(host.seen.at(-1).args.poolSize, 8);
  await fs.stat(approvalFile);
  const bridgeSetup = await bridgeTool(bridge, "chrome_workspace_setup", { pool_size: 16 });
  assert.equal(bridgeSetup.result.isError, false, bridgeSetup.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.init");
  assert.equal(host.seen.at(-1).args.poolSize, 16);
  await fs.stat(approvalFile);
  const bridgeSetupMax = await bridgeTool(bridge, "chrome_workspace_setup", { pool_size: 32 });
  assert.equal(bridgeSetupMax.result.isError, false, bridgeSetupMax.result.content[0].text);
  assert.equal(host.seen.at(-1).method, "workspace.init");
  assert.equal(host.seen.at(-1).args.poolSize, 32);
  const beforeTooLargePool = host.seen.length;
  const bridgeSetupTooLarge = await bridgeTool(bridge, "chrome_workspace_setup", { pool_size: 33 });
  assert.equal(bridgeSetupTooLarge.result.isError, true);
  assert.match(bridgeSetupTooLarge.result.content[0].text, /between 1 and 32/i);
  assert.equal(host.seen.length, beforeTooLargePool, "pool sizes above 32 must fail before extension dispatch");
  await fs.stat(approvalFile);

  // Workspace cleanup is grantless even in Strict mode. Removing the only
  // unconsumed approval must not prevent chrome_close from releasing MDB state.
  await fs.rm(approvalFile, { force: true });
  const bridgeRelease = await bridgeTool(bridge, "chrome_close", { tab_id: 42 });
  assert.equal(bridgeRelease.result.isError, false, bridgeRelease.result.content[0].text);
  assert.equal(bridgeRelease.result.structuredContent.released, true);
  assert.equal(host.seen.at(-1).method, "workspace.release");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, []);
  await fs.writeFile(approvalFile, JSON.stringify({
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    provider: "chrome-background",
    allowedUrlPatterns: ["https://www.producthunt.com/*"],
  }), { mode: 0o600 });
  await assert.rejects(
    backgroundChromeCall("tabs.list", { maxTabs: 3 }, [], { socketPath }),
    (error) => error?.code === "CHROME_NO_URL_GRANT",
  );

  // Direct client protocol forwards method, args and URL-pattern scope.
  const direct = await backgroundChromeCall("tabs.list", { maxTabs: 3 }, ["https://www.producthunt.com/*"], { socketPath });
  assert.equal(direct.count, 1);
  assert.equal(host.seen.at(-1).method, "tabs.list");
  assert.deepEqual(host.seen.at(-1).allowedUrlPatterns, ["https://www.producthunt.com/*"]);

  // Legacy callers may still use the old low-level tabs.open primitive. The
  // client must rewrite it to workspace.open so it cannot create a loose tab.
  const legacyClientOpen = await backgroundChromeCall(
    "tabs.open",
    { url: "https://www.producthunt.com/" },
    ["https://www.producthunt.com/*"],
    { socketPath },
  );
  assert.equal(legacyClientOpen.echoedMethod, "workspace.open");
  assert.equal(host.seen.at(-1).method, "workspace.open");
  assert.equal(host.seen.at(-1).args.url, "https://www.producthunt.com/");

  // The native host repeats the same normalization for callers that bypass the
  // JS client and talk to its local socket directly.
  const rawLegacy = await rawSocketCall({
    id: "raw-legacy-open",
    method: "tabs.open",
    args: { url: "https://www.producthunt.com/" },
    allowedUrlPatterns: ["https://www.producthunt.com/*"],
  });
  assert.equal(rawLegacy.ok, true);
  assert.equal(host.seen.at(-1).method, "workspace.open");
  assert.equal(host.seen.at(-1).args.url, "https://www.producthunt.com/");

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
