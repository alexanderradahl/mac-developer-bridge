import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  backgroundChromeCall, backgroundChromeOperationStatus, backgroundChromeStatus,
} from "../lib/chrome-extension-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp("/tmp/mdb-transport-");
const hostPath = path.join(root, "scripts/chrome-native-host.mjs");
const binding = { profileDirectory: "Fixture", expectedEmail: "fixture@example.com", expectedGaiaId: "123456789" };
const profile = { signedIn: true, email: binding.expectedEmail, id: binding.expectedGaiaId };
const canary = "transport-private-canary-DO-NOT-LOG";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let assertionGroups = 0;
const passed = (label) => { assertionGroups += 1; process.stdout.write("PASS " + label + "\n"); };

async function eventually(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("Condition did not settle within the fixture deadline.");
    await delay(10);
  }
}
function nativeFrame(message) {
  const body = Buffer.from(typeof message === "string" ? message : JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
const handlers = new Map();
const effects = new Map();
const workerOutcomes = new Map();
const hosts = [];

async function startHost(name, sourceRoot = root, publicSocketName = "chrome-background.sock") {
  const dataDir = path.join(temporary, name);
  const socketPath = path.join(dataDir, publicSocketName);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "chrome-background-profile.json"), JSON.stringify(binding));
  const child = spawn(process.execPath, [path.join(sourceRoot, "scripts/chrome-native-host.mjs")], {
    env: { ...process.env, MAC_DEV_BRIDGE_DATA_DIR: dataDir, MAC_DEV_BRIDGE_CHROME_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const generation = crypto.randomUUID();
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let stopped = false;
  let exited = false;
  const exitPromise = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.on("error", () => {});
  function write(message) { if (!exited && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(nativeFrame(message)); }
  function complete(request, result, error = null) {
    const response = { type: "response", id: request.id, ok: !error, result,
      ...(error ? { error } : {}), connectionGeneration: generation };
    workerOutcomes.set(request.id, { state: "completed", ok: !error, result, ...(error ? { error } : {}) });
    write(response);
  }
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < size + 4) return;
      const request = JSON.parse(buffer.subarray(4, size + 4).toString());
      buffer = buffer.subarray(size + 4);
      if (request.type === "operationStatus") {
        write({ type: "operationStatusResponse", id: request.id, connectionGeneration: generation,
          operation: workerOutcomes.get(request.operationId) || { state: "not_found" } });
      } else if (request.type === "request") {
        effects.set(request.id, (effects.get(request.id) || 0) + 1);
        workerOutcomes.set(request.id, { state: "dispatched" });
        const handler = handlers.get(request.id);
        if (handler) handler(request, { complete, write, child });
        else complete(request, { actionCount: effects.get(request.id) });
      }
    }
  });
  await eventually(async () => { try { await fs.stat(socketPath); return true; } catch { if (exited) throw new Error(stderr); return false; } });
  write({ type: "ready", version: "fixture", buildId: "fixture-loaded-build", connectionGeneration: generation, profile });
  await eventually(async () => (await backgroundChromeStatus({ socketPath })).extensionReady);
  const host = {
    child, dataDir, socketPath, generation, write, get stderr() { return stderr; },
    async stop() {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      const forceStop = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2_000);
      await exitPromise;
      clearTimeout(forceStop);
    },
  };
  hosts.push(host);
  return host;
}

async function protocolFixture(name, handler, assertion) {
  const socketPath = path.join(temporary, name + ".sock");
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      handler(socket, JSON.parse(input.slice(0, input.indexOf("\n"))));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await assertion(() => backgroundChromeCall("tabs.click", { tabId: 7, selector: "#fixture" }, ["https://example.com/*"], {
      socketPath, operationId: "protocol-" + name, timeoutMs: 500,
    }));
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function rejection(run, code) {
  let caught;
  try { await run(); } catch (error) { caught = error; }
  assert.ok(caught, "expected a classified error");
  assert.equal(caught.code, code);
  assert.equal(JSON.stringify({ message: caught.message, details: caught.details }).includes(canary), false);
  return caught;
}

try {
  for (const [name, line] of [
    ["null", "null\n"], ["malformed", '{"secret":"' + canary + '"\n'],
    ["id", JSON.stringify({ id: "wrong-id", ok: true, result: canary }) + "\n"],
    ["missing-result", JSON.stringify({ id: "protocol-missing-result", ok: true }) + "\n"],
    ["partial", '{"id":"unfinished","secret":"' + canary + '"'],
  ]) {
    await protocolFixture(name, (socket) => socket.end(line), async (run) => {
      const started = Date.now();
      const error = await rejection(run, "CHROME_HOST_PROTOCOL_ERROR");
      assert.ok(Date.now() - started < 400, "EOF/protocol faults must settle before the timer");
      assert.match(error.details.responseSha256, /^[a-f0-9]{64}$/);
    });
  }
  passed("null, mismatched ID, malformed JSON and partial EOF are prompt, redacted protocol errors");

  await protocolFixture("safe-error", (socket, request) => socket.end(JSON.stringify({
    id: request.id, ok: false, error: { code: "CHROME_EXTENSION_ERROR", message: canary,
      details: { stage: "fill-commit", actionDispatched: null, clickDispatched: true, navigationObserved: false,
        popupObservedCount: 0, outcomeVerified: false, tabId: 7, frameId: 0, documentId: "fixture-document",
        operationId: "spoofed-id", state: "dispatched", dispatched: false,
        value: canary, responseBody: canary, selector: canary } },
    operation: { operationId: request.id, state: "completed", dispatched: true, dispatchState: "dispatched",
      stage: "extension-response", outcome: "failed" },
  }) + "\n"), async (run) => {
    const error = await rejection(run, "CHROME_EXTENSION_ERROR");
    assert.equal(error.details.stage, "fill-commit");
    assert.equal(error.details.operationStage, "extension-response");
    assert.equal(error.details.operationId, "protocol-safe-error");
    assert.equal(error.details.state, "completed");
    assert.equal(error.details.dispatched, true);
    assert.equal(error.details.actionDispatched, null);
    assert.equal(error.details.clickDispatched, true);
    assert.equal(error.details.navigationObserved, false);
    assert.equal(error.details.popupObservedCount, 0);
    assert.equal(error.details.outcomeVerified, false);
    assert.equal(error.details.tabId, 7);
    assert.equal(error.details.frameId, 0);
    assert.equal(error.details.documentId, "fixture-document");
    assert.equal(error.details.value, undefined);
    assert.equal(error.details.responseBody, undefined);
  });
  passed("safe diagnostics survive while raw messages, values and response bodies are excluded");

  let host = await startHost("main");
  const options = (operationId, timeoutMs = 1_000) => ({ socketPath: host.socketPath, operationId, timeoutMs });
  const args = { tabId: 7, selector: "#fixture", value: canary };
  const grants = ["https://example.com/*"];
  const firstStatus = await backgroundChromeStatus({ socketPath: host.socketPath });
  assert.match(firstStatus.nativeHostBuildId, /^[a-f0-9]{64}$/);
  assert.equal(firstStatus.extension.buildId, "fixture-loaded-build");
  assert.equal(firstStatus.connectionGeneration, host.generation);
  const missing = await backgroundChromeOperationStatus("missing-operation", { socketPath: host.socketPath });
  assert.equal(missing.operationId, "missing-operation");
  assert.equal(missing.state, "not_found");
  assert.equal(missing.retryable, false);
  passed("startup build identity and connection generation are observable");

  const originalSocket = await fs.lstat(host.socketPath);
  assert.equal(originalSocket.isSymbolicLink(), true);
  const originalJournal = await fs.readFile(path.join(host.dataDir, "chrome-operation-status.json"));
  const originalPid = await fs.readFile(path.join(host.dataDir, "chrome-native-host.pid"));
  const contender = spawn(process.execPath, [hostPath], {
    env: { ...process.env, MAC_DEV_BRIDGE_DATA_DIR: host.dataDir, MAC_DEV_BRIDGE_CHROME_SOCKET: host.socketPath },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let contenderStderr = "";
  contender.stderr.on("data", (chunk) => { contenderStderr += chunk.toString(); });
  const contenderExit = await new Promise((resolve) => {
    const timer = setTimeout(() => contender.kill("SIGKILL"), 2_000);
    contender.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(contenderExit, 1, "a competing host must refuse the live endpoint");
  assert.match(contenderStderr, /CHROME_SOCKET_ALREADY_RUNNING/);
  const preservedSocket = await fs.lstat(host.socketPath);
  assert.equal(preservedSocket.ino, originalSocket.ino);
  assert.equal(preservedSocket.dev, originalSocket.dev);
  assert.deepEqual(await fs.readFile(path.join(host.dataDir, "chrome-operation-status.json")), originalJournal);
  assert.deepEqual(await fs.readFile(path.join(host.dataDir, "chrome-native-host.pid")), originalPid);
  assert.equal((await backgroundChromeStatus({ socketPath: host.socketPath })).hostPid, host.child.pid);
  passed("a competing host preserves the live listener, journal and PID instead of unlinking or loading over them");

  handlers.set("late", (request, { complete }) => setTimeout(() => complete(request, { accepted: true }), 200));
  const started = Date.now();
  const lateError = await rejection(() => backgroundChromeCall("tabs.fill", args, grants, options("late", 70)), "CHROME_EXTENSION_TIMEOUT");
  assert.ok(Date.now() - started < 500, "host deadline should beat the longer transport allowance");
  assert.equal(lateError.details.operationId, "late");
  assert.equal(lateError.details.state, "outcome_unknown");
  const late = await eventually(async () => {
    const status = await backgroundChromeOperationStatus("late", { socketPath: host.socketPath });
    return status.state === "completed" ? status : false;
  });
  assert.equal(late.outcome, "succeeded");
  assert.equal(late.reconciled, true);
  const replay = await backgroundChromeCall("tabs.fill", args, grants, options("late"));
  assert.equal(replay.accepted, true);
  assert.equal(effects.get("late"), 1);
  passed("late completion reconciles after a deadline and same-ID retry does not repeat the side effect");

  handlers.set("concurrent", (request, { complete }) => setTimeout(() => complete(request, { accepted: true }), 40));
  const copies = await Promise.all([
    backgroundChromeCall("tabs.click", { tabId: 7, selector: "#fixture" }, grants, options("concurrent")),
    backgroundChromeCall("tabs.click", { tabId: 7, selector: "#fixture" }, grants, options("concurrent")),
  ]);
  assert.ok(copies.every((result) => result.accepted === true));
  assert.equal(effects.get("concurrent"), 1);
  await rejection(() => backgroundChromeCall("tabs.click", { tabId: 7, selector: "#different" }, grants, options("concurrent")),
    "CHROME_OPERATION_ID_CONFLICT");
  assert.equal(effects.get("concurrent"), 1);
  passed("concurrent duplicate IDs share exactly one dispatch and conflicting payloads are rejected");

  await rejection(() => backgroundChromeCall("tabs.click", args, grants, {
    ...options("expired"), deadlineMs: Date.now() - 20,
  }), "CHROME_OPERATION_CANCELLED");
  assert.equal(effects.get("expired"), undefined);
  const expired = await backgroundChromeOperationStatus("expired", { socketPath: host.socketPath });
  assert.equal(expired.state, "cancelled_before_dispatch");
  passed("expired absolute deadlines prevent dispatch");

  // A closed socket races actual journal I/O, not a mocked lifecycle method.
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(host.socketPath);
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: "closed-before", method: "tabs.click", args, allowedUrlPatterns: grants,
        deadlineMs: Date.now() + 1_000, timeoutMs: 1_000 }) + "\n");
      socket.destroy();
      resolve();
    });
  });
  await delay(80);
  assert.equal(effects.get("closed-before"), undefined);
  const closedBefore = await backgroundChromeOperationStatus("closed-before", { socketPath: host.socketPath });
  assert.equal(closedBefore.state, "cancelled_before_dispatch");
  passed("a client disconnect during durable acceptance cancels the undispatched action");

  let disconnectSocket;
  handlers.set("closed-after", (request, { complete }) => {
    disconnectSocket.destroy();
    setTimeout(() => complete(request, { accepted: true }), 80);
  });
  await new Promise((resolve, reject) => {
    disconnectSocket = net.createConnection(host.socketPath);
    disconnectSocket.on("error", reject);
    disconnectSocket.on("close", resolve);
    disconnectSocket.on("connect", () => disconnectSocket.write(JSON.stringify({
      id: "closed-after", method: "tabs.click", args, allowedUrlPatterns: grants,
      deadlineMs: Date.now() + 1_000, timeoutMs: 1_000,
    }) + "\n"));
  });
  const disconnected = await eventually(async () => {
    const status = await backgroundChromeOperationStatus("closed-after", { socketPath: host.socketPath });
    return status.state === "completed" ? status : false;
  });
  assert.equal(disconnected.outcome, "succeeded");
  assert.equal(effects.get("closed-after"), 1);
  passed("a client disconnect after dispatch retains and reconciles its eventual outcome");

  handlers.set("generation", (request, { write, complete }) => {
    write({ type: "response", id: request.id, ok: true, result: { wrong: true }, connectionGeneration: "wrong-generation" });
    setTimeout(() => complete(request, { correct: true }), 30);
  });
  const generationResult = await backgroundChromeCall("tabs.click", args, grants, options("generation"));
  assert.equal(generationResult.correct, true);
  assert.equal(generationResult.wrong, undefined);
  host.write('{"invalid":"' + canary + '"');
  host.write(null);
  assert.equal((await backgroundChromeStatus({ socketPath: host.socketPath })).extensionReady, true);
  assert.equal(host.stderr.includes(canary), false);
  passed("generation mismatch and malformed native frames are isolated from unrelated status requests");

  let finishRestart;
  handlers.set("restart", (request, { complete }) => { finishRestart = () => complete(request, { accepted: true }); });
  const interrupted = backgroundChromeCall("tabs.click", args, grants, options("restart")).catch((error) => error);
  await eventually(() => effects.get("restart") === 1);
  const oldHost = host;
  await oldHost.stop();
  const interruptedResult = await interrupted;
  assert.ok(["CHROME_EXTENSION_OFFLINE", "CHROME_HOST_CLOSED", "CHROME_HOST_CONNECTION_FAILED"].includes(interruptedResult.code));
  host = await startHost("main");
  await rejection(() => backgroundChromeCall("tabs.click", args, grants, options("restart")), "CHROME_OPERATION_RECONCILIATION_REQUIRED");
  assert.equal(effects.get("restart"), 1);
  finishRestart();
  const restarted = await backgroundChromeOperationStatus("restart", { socketPath: host.socketPath });
  assert.equal(restarted.state, "completed");
  assert.equal(restarted.outcome, "succeeded");
  assert.equal(restarted.reconciled, true);
  assert.equal(effects.get("restart"), 1);
  const journal = await fs.readFile(path.join(host.dataDir, "chrome-operation-status.json"), "utf8");
  assert.equal(journal.includes(canary), false);
  assert.equal(journal.includes("allowedUrlPatterns"), false);
  assert.equal(journal.includes('"selector"'), false);
  passed("host restart preserves no-replay status and queries the surviving worker for late completion");

  const durableBefore = (await backgroundChromeStatus({ socketPath: host.socketPath })).operations.durableRetained;
  for (let offset = 0; offset < 264; offset += 8) {
    await Promise.all(Array.from({ length: 8 }, (_, index) => backgroundChromeCall("tabs.snapshot", { tabId: 7 }, grants,
      options("read-" + (offset + index)))));
  }
  const readPressure = await backgroundChromeStatus({ socketPath: host.socketPath });
  assert.equal(readPressure.operations.durableRetained, durableBefore);
  assert.ok(readPressure.operations.retained <= durableBefore + 256);
  await backgroundChromeCall("tabs.click", args, grants, options("restart"));
  assert.equal(effects.get("restart"), 1);
  const afterReads = await fs.readFile(path.join(host.dataDir, "chrome-operation-status.json"), "utf8");
  assert.equal(afterReads.includes('"method":"tabs.snapshot"'), false);
  passed("read traffic has a separate bounded memory budget and cannot consume or evict mutation history");

  const buildRoot = path.join(temporary, "runtime-copy");
  for (const relative of ["scripts/chrome-native-host.mjs", "lib/chrome-extension-client.mjs", "lib/chrome-operation-registry.mjs"]) {
    await fs.mkdir(path.dirname(path.join(buildRoot, relative)), { recursive: true });
    await fs.copyFile(path.join(root, relative), path.join(buildRoot, relative));
  }
  const buildHost = await startHost("build", buildRoot);
  const originalBuild = (await backgroundChromeStatus({ socketPath: buildHost.socketPath })).nativeHostBuildId;
  await fs.appendFile(path.join(buildRoot, "scripts/chrome-native-host.mjs"), "\n// Fixture-only source change after process startup.\n");
  assert.equal((await backgroundChromeStatus({ socketPath: buildHost.socketPath })).nativeHostBuildId, originalBuild);
  await buildHost.stop();
  const changedHost = await startHost("build", buildRoot);
  assert.notEqual((await backgroundChromeStatus({ socketPath: changedHost.socketPath })).nativeHostBuildId, originalBuild);
  passed("running build identity remains fixed after on-disk edits and changes only after a new process loads them");

  const corruptHost = await startHost("corrupt");
  await corruptHost.stop();
  const corruptJournal = path.join(corruptHost.dataDir, "chrome-operation-status.json");
  await fs.writeFile(corruptJournal, '{"broken":"' + canary + '"');
  const refusedHost = await startHost("corrupt");
  assert.equal((await backgroundChromeStatus({ socketPath: refusedHost.socketPath })).operations.journalHealthy, false);
  await rejection(() => backgroundChromeCall("tabs.click", args, grants, {
    socketPath: refusedHost.socketPath, operationId: "journal-refusal",
  }), "CHROME_OPERATION_JOURNAL_FAILED");
  assert.equal(effects.get("journal-refusal"), undefined);
  assert.equal((await backgroundChromeCall("tabs.snapshot", { tabId: 7 }, grants, {
    socketPath: refusedHost.socketPath, operationId: "journal-read",
  })).actionCount, 1);
  assert.equal(refusedHost.stderr.includes(canary), false);
  assert.equal(await fs.readFile(corruptJournal, "utf8"), '{"broken":"' + canary + '"');
  passed("corrupt durable history blocks mutations while status and read-only inspection remain available");

  // macOS sun_path is short. Exercise a custom public path close to that bound,
  // then replace only its public endpoint while the old host remains alive.
  const customName = "custom-background.sock";
  const longDirectoryName = "s".repeat(Math.max(10, 98 - Buffer.byteLength(temporary) - customName.length - 2));
  const ownershipHost = await startHost(longDirectoryName, root, customName);
  const privateBasename = await fs.readlink(ownershipHost.socketPath);
  const privatePath = path.join(path.dirname(ownershipHost.socketPath), privateBasename);
  assert.ok(Buffer.byteLength(privatePath) < 104, "private bind name must fit macOS Unix socket paths");
  assert.equal((await fs.lstat(privatePath)).isSocket(), true);
  await fs.unlink(ownershipHost.socketPath);
  const replacement = net.createServer((socket) => socket.end("replacement-alive\n"));
  await new Promise((resolve, reject) => replacement.once("error", reject).listen(ownershipHost.socketPath, resolve));
  try {
    const replacementIdentity = await fs.lstat(ownershipHost.socketPath);
    await ownershipHost.stop();
    const stillPresent = await fs.lstat(ownershipHost.socketPath);
    assert.equal(stillPresent.ino, replacementIdentity.ino);
    assert.equal(stillPresent.dev, replacementIdentity.dev);
    const result = await new Promise((resolve, reject) => {
      const socket = net.createConnection(ownershipHost.socketPath);
      let result = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { result += chunk; });
      socket.on("end", () => resolve(result));
      socket.on("error", reject);
    });
    assert.equal(result, "replacement-alive\n");
    assert.equal(await fs.lstat(privatePath).then(() => true, () => false), false);
  } finally {
    await new Promise((resolve) => replacement.close(resolve));
  }
  passed("old-host shutdown preserves a replacement listener and cleans only its private socket, including a long custom path");

  // Exercise the actual worker connection implementation with two fake Chrome
  // native ports. DOM actions are represented by one held, observable dispatch.
  const worker = await fs.readFile(path.join(root, "chrome-extension/service-worker.js"), "utf8");
  const nativeSection = worker.slice(worker.indexOf("function pruneNativeOperations()"));
  const ports = [];
  const reconnects = [];
  let dispatchCount = 0;
  let resolveAction;
  function makePort() {
    return { messages: [], messageHandler: null, disconnectHandler: null,
      postMessage(message) { this.messages.push(message); },
      onMessage: { addListener(fn) { this.owner.messageHandler = fn; } },
      onDisconnect: { addListener(fn) { this.owner.disconnectHandler = fn; } } };
  }
  const context = vm.createContext({
    crypto: crypto.webcrypto, TextEncoder, Date, Promise, Map, Set, Infinity, Number,
    setTimeout(fn) { reconnects.push(fn); return reconnects.length; },
    chrome: { identity: { async getProfileUserInfo() { return { email: profile.email, id: profile.id }; } },
      runtime: { id: "fixture", lastError: null, connectNative() {
        const p = makePort(); p.onMessage.owner = p; p.onDisconnect.owner = p; ports.push(p); return p;
      } } },
    async initializeWorkspaceIfChromeFocused() { return null; },
    async setWorkspaceGroupActivity() {},
    errorPayload(error) { return { code: error.code || "CHROME_EXTENSION_ERROR", message: "Fixture error." }; },
    dispatch() { dispatchCount += 1; return new Promise((resolve) => { resolveAction = resolve; }); },
  });
  vm.runInContext(
    'const NATIVE_HOST = "fixture"; const VERSION = "fixture"; const LOADED_EXTENSION_BUILD_ID = "fixture-build";'
    + 'const NATIVE_INSTANCE_ID = crypto.randomUUID(); const NATIVE_OPERATION_RETENTION_MS = 86400000;'
    + 'const MAX_NATIVE_OPERATIONS = 5000; const MAX_NATIVE_RETAINED_RESULT_BYTES = 8388608;'
    + 'const nativeOperations = new Map(); let nativeConnectionSequence = 0; let port = null; let reconnectTimer = null;\n'
    + nativeSection, context);
  await eventually(() => ports.length === 1 && ports[0].messages.some((m) => m.type === "ready"));
  const firstPort = ports[0];
  const firstGeneration = firstPort.messages.find((m) => m.type === "ready").connectionGeneration;
  firstPort.messageHandler({ type: "request", id: "worker-expired", method: "tabs.click", fingerprint: "expired-fingerprint",
    connectionGeneration: firstGeneration, deadlineMs: 0 });
  assert.equal(dispatchCount, 0);
  assert.equal(firstPort.messages.find((m) => m.id === "worker-expired").error.code, "CHROME_OPERATION_CANCELLED");
  firstPort.messageHandler({ type: "request", id: "worker-held", method: "tabs.click", fingerprint: "fixture-fingerprint",
    connectionGeneration: firstGeneration, deadlineMs: Date.now() + 1_000 });
  await eventually(() => dispatchCount === 1);
  firstPort.disconnectHandler();
  reconnects.shift()();
  await eventually(() => ports.length === 2 && ports[1].messages.some((m) => m.type === "ready"));
  resolveAction({ applied: true });
  await delay(10);
  assert.equal(firstPort.messages.some((m) => m.type === "response" && m.id === "worker-held"), false);
  assert.equal(ports[1].messages.some((m) => m.type === "response"), false);
  const secondGeneration = ports[1].messages.find((m) => m.type === "ready").connectionGeneration;
  assert.notEqual(firstGeneration, secondGeneration);
  ports[1].messageHandler({ type: "operationStatus", id: "worker-status", operationId: "worker-held", connectionGeneration: secondGeneration });
  const workerStatus = ports[1].messages.find((m) => m.type === "operationStatusResponse");
  assert.equal(workerStatus.operation.state, "completed");
  assert.equal(workerStatus.operation.result.applied, true);
  ports[1].messageHandler({ type: "request", id: "worker-held", method: "tabs.click", fingerprint: "fixture-fingerprint",
    connectionGeneration: secondGeneration, deadlineMs: Date.now() + 1_000 });
  assert.equal(dispatchCount, 1);
  passed("old worker completion never replies through a new port; explicit status reconciles without duplicate dispatch");

  process.stdout.write("Transport reliability: " + assertionGroups + " behavioral groups passed.\n");
} finally {
  for (const host of hosts) await host.stop();
  await fs.rm(temporary, { recursive: true, force: true });
}
