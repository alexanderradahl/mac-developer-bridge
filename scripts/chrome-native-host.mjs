#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { safeChromeDiagnostics, safeChatGPTHandoff } from "../lib/chrome-extension-client.mjs";
import {
  ChromeOperationRegistry, MAX_RETAINED_OPERATIONS, OPERATION_RETENTION_MS,
  READ_OPERATION_RETENTION_MS, MAX_RETAINED_READ_OPERATIONS,
  isReadOnlyChromeMethod, operationFingerprint, operationMetadata,
} from "../lib/chrome-operation-registry.mjs";

// Captured once, before accepting requests. Status never substitutes later
// edited-on-disk bytes for the identity of this running host.
const NATIVE_HOST_BUILD_ID = crypto.createHash("sha256")
  .update(fs.readFileSync(new URL(import.meta.url)))
  .update(fs.readFileSync(new URL("../lib/chrome-operation-registry.mjs", import.meta.url)))
  .update(fs.readFileSync(new URL("../lib/chrome-extension-client.mjs", import.meta.url)))
  .digest("hex");
const DATA_DIR = process.env.MAC_DEV_BRIDGE_DATA_DIR
  || path.join(os.homedir(), "Library", "Application Support", "MacDeveloperBridge");
const SOCKET_PATH = process.env.MAC_DEV_BRIDGE_CHROME_SOCKET || path.join(DATA_DIR, "chrome-background.sock");
// Bind a private short pathname. Node/libuv unlinks its bound Unix socket path
// when server.close() runs, even if another listener has since replaced it.
// Keeping the public endpoint as an owned symlink prevents an old close from
// deleting a replacement host's socket.
const PRIVATE_SOCKET_PATH = path.join(path.dirname(SOCKET_PATH), ".c" + crypto.randomBytes(6).toString("hex") + ".sock");
const SOCKET_LIFECYCLE_LOCK = SOCKET_PATH + ".lifecycle-lock";
const PID_FILE = process.env.MAC_DEV_BRIDGE_CHROME_NATIVE_PID_FILE || path.join(DATA_DIR, "chrome-native-host.pid");
const PROFILE_BINDING_FILE = process.env.MAC_DEV_BRIDGE_CHROME_PROFILE_BINDING_FILE || path.join(DATA_DIR, "chrome-background-profile.json");
const OPERATION_JOURNAL_FILE = path.join(DATA_DIR, "chrome-operation-status.json");
const MAX_NATIVE_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOCKET_LINE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REQUEST_TIMEOUT_MS = 3_720_000;
const GRANTLESS_EXTENSION_METHODS = new Set(["status", "extension.reload", "workspace.status", "workspace.init", "workspace.release", "chatgpt.extensionStatus"]);
const safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const safeCode = (value) => typeof value === "string" && /^(CHROME|CHATGPT)_[A-Z0-9_]{1,100}$/.test(value)
  ? value : "CHROME_EXTENSION_ERROR";

function normalizeExtensionMethod(method) {
  return method === "tabs.open" ? "workspace.open" : method;
}

await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
await fsp.chmod(DATA_DIR, 0o700).catch(() => {});
let nativeBuffer = Buffer.alloc(0);
let extensionConnected = false;
let extensionReady = false;
let extensionInfo = null;
let profileError = null;
let shuttingDown = false;
let connectionGeneration = crypto.randomUUID();
const registry = new ChromeOperationRegistry(OPERATION_JOURNAL_FILE);
const reconciliationQueries = new Map();
const clientSockets = new Set();
const inFlightHandlers = new Set();
let ownedSocketIdentity = null;
let journalLoadError = null;
let registryInitialized = false;

function trackHandler(promise) {
  inFlightHandlers.add(promise);
  void promise.finally(() => inFlightHandlers.delete(promise)).catch(() => {});
  return promise;
}

function log(message) {
  process.stderr.write("[chrome-native-host " + new Date().toISOString() + "] " + message + "\n");
}

async function readProfileBinding() {
  try {
    const parsed = JSON.parse(await fsp.readFile(PROFILE_BINDING_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || typeof parsed.profileDirectory !== "string" || !parsed.profileDirectory
        || typeof parsed.expectedEmail !== "string" || !parsed.expectedEmail.includes("@")
        || typeof parsed.expectedGaiaId !== "string" || !/^[0-9]+$/.test(parsed.expectedGaiaId)) throw new Error();
    return parsed;
  } catch {
    const error = new Error("Background Chrome profile binding is unavailable or invalid.");
    error.code = "CHROME_PROFILE_BINDING_INVALID";
    throw error;
  }
}
const profileBinding = await readProfileBinding();
const publicProfileBinding = () => ({
  profileDirectory: profileBinding.profileDirectory, expectedEmail: profileBinding.expectedEmail,
});

function sendNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error("Native message exceeds the size limit.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendSocket(socket, message) {
  if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify(message) + "\n");
}

function failure(id, code, message, details = {}) {
  return { id, ok: false, error: { code, message, details: safeChromeDiagnostics(details) } };
}

function notifyEntry(entry, response) {
  const envelope = { ...response, id: entry.id, operation: operationMetadata(entry) };
  for (const socket of entry.sockets) sendSocket(socket, envelope);
  entry.sockets.clear();
}

function uncertainResponse(entry, code = "CHROME_EXTENSION_TIMEOUT") {
  return failure(entry.id, code, "The browser action may have run. Query its operation ID; do not replay the action.", {
    ...operationMetadata(entry), state: "outcome_unknown",
  });
}

async function markUnknown(entry, stage, code = "CHROME_EXTENSION_TIMEOUT") {
  if (!["accepted", "dispatched", "outcome_unknown"].includes(entry.state)) return;
  clearTimeout(entry.timer);
  entry.state = entry.dispatched ? "outcome_unknown" : "cancelled_before_dispatch";
  entry.stage = stage;
  if (!entry.dispatched) entry.outcome = "cancelled";
  try { if (!entry.readOnly) await registry.persist(); } catch { registry.healthy = false; }
  if (entry.state === "completed") return; // A late result won the persistence race.
  notifyEntry(entry, entry.dispatched ? uncertainResponse(entry, code)
    : failure(entry.id, "CHROME_OPERATION_CANCELLED", "The browser action was cancelled before dispatch.", operationMetadata(entry)));
}

function safeResponse(message, method) {
  if (message.ok) return { id: message.id, ok: true, result: message.result ?? null };
  const response = failure(message.id, safeCode(message.error?.code), "The browser extension returned an error.", {
    ...safeChromeDiagnostics(message.error), ...safeChromeDiagnostics(message.error?.details),
  });
  // Existing ChatGPT conversation recovery uses a canonical conversation URL.
  // It is validated only for that method, never enabled for generic page errors.
  Object.assign(response.error.details, safeChatGPTHandoff({ ...message.error, ...message.error?.details }, method));
  return response;
}

async function completeEntry(entry, message) {
  if (entry.state === "completed" || entry.state === "cancelled_before_dispatch") return;
  clearTimeout(entry.timer);
  const wasUnknown = entry.state === "outcome_unknown" || entry.sockets.size === 0;
  entry.state = "completed";
  entry.stage = "extension-response";
  entry.completedAt = Date.now();
  entry.outcome = message.ok ? "succeeded" : "failed";
  entry.reconciled = wasUnknown;
  entry.response = safeResponse(message, entry.method);
  entry.error = entry.response.error || null;
  try { if (!entry.readOnly) await registry.persist(); } catch { registry.healthy = false; }
  notifyEntry(entry, entry.response);
  if (message.resultRetained === false) entry.response = null;
  registry.prune();
}

function respondStatus(socket, id, entry, requestedOperationId = null) {
  sendSocket(socket, { id, ok: true, result: entry ? {
    ...operationMetadata(entry),
    acceptedAt: new Date(entry.acceptedAt).toISOString(),
    completedAt: entry.completedAt ? new Date(entry.completedAt).toISOString() : null,
    error: entry.error ? { code: entry.error.code, details: safeChromeDiagnostics(entry.error.details) } : null,
  } : { operationId: requestedOperationId, state: "not_found", retryable: false, retentionMs: OPERATION_RETENTION_MS,
    message: "No retained outcome is available. Absence is not proof that a browser action did not run." } });
}

async function handleNativeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) { log("invalid native envelope shape"); return; }
  if (message.type === "ready") {
    extensionConnected = true;
    const profile = message.profile && typeof message.profile === "object" ? message.profile : {};
    const signedIn = profile.signedIn === true && typeof profile.email === "string" && typeof profile.id === "string";
    extensionReady = Boolean(signedIn && profile.email.toLowerCase() === profileBinding.expectedEmail.toLowerCase()
      && profile.id === profileBinding.expectedGaiaId);
    profileError = extensionReady ? null : {
      code: !signedIn ? "CHROME_PROFILE_SIGNED_OUT" : "CHROME_PROFILE_MISMATCH",
      message: !signedIn ? "The extension has no signed-in primary profile." : "The extension profile does not match its binding.",
    };
    connectionGeneration = safeId(message.connectionGeneration) ? message.connectionGeneration : connectionGeneration;
    extensionInfo = {
      version: typeof message.version === "string" ? message.version.slice(0, 50) : null,
      extensionId: typeof message.extensionId === "string" ? message.extensionId.slice(0, 64) : null,
      buildId: safeId(message.buildId) ? message.buildId : null,
      connectionGeneration,
      readyAt: new Date().toISOString(),
      profile: { signedIn, email: typeof profile.email === "string" ? profile.email : null, matchesBinding: extensionReady },
    };
    log(extensionReady ? "extension ready; profile binding matched" : "extension refused by profile binding");
    return;
  }
  if (message.type === "operationStatusResponse" && safeId(message.id)) {
    const query = reconciliationQueries.get(message.id);
    if (!query || (message.connectionGeneration && message.connectionGeneration !== connectionGeneration)) return;
    clearTimeout(query.timer);
    reconciliationQueries.delete(message.id);
    const entry = registry.entries.get(query.operationId);
    if (entry && message.operation?.state === "completed" && typeof message.operation.ok === "boolean") {
      await completeEntry(entry, { id: entry.id, ok: message.operation.ok,
        result: message.operation.result, error: message.operation.error,
        resultRetained: message.operation.resultRetained });
    }
    respondStatus(query.socket, query.id, entry);
    return;
  }
  if (message.type !== "response" || !safeId(message.id) || typeof message.ok !== "boolean") {
    log("invalid native response envelope");
    return;
  }
  const entry = registry.entries.get(message.id);
  if (!entry || !entry.dispatched) return;
  if (message.connectionGeneration && message.connectionGeneration !== entry.connectionGeneration) {
    log("native response connection generation mismatch");
    return;
  }
  if (!message.ok && (!message.error || typeof message.error !== "object" || Array.isArray(message.error))) {
    log("invalid native error envelope");
    return;
  }
  await completeEntry(entry, message);
}

function parseNativeChunk(chunk) {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (length <= 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
      log("invalid native frame length; closing transport");
      process.exitCode = 1;
      void shutdown().then(() => process.exit(1));
      return;
    }
    if (nativeBuffer.length < 4 + length) return;
    const payload = nativeBuffer.subarray(4, 4 + length);
    nativeBuffer = nativeBuffer.subarray(4 + length);
    let message;
    try { message = JSON.parse(payload.toString("utf8")); }
    catch {
      log("invalid native JSON bytes=" + payload.length + " sha256=" + crypto.createHash("sha256").update(payload).digest("hex"));
      continue;
    }
    void trackHandler(handleNativeMessage(message)).catch(() => log("native message processing failed"));
  }
}

function pathIdentity(target) {
  try {
    const stat = fs.lstatSync(target);
    return { dev: stat.dev, ino: stat.ino, isSocket: stat.isSocket(), isLink: stat.isSymbolicLink(), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function unlinkIdentity(target, expected) {
  // Synchronous identity check + unlink inside the serialized lifecycle section
  // prevents this host's own async work from substituting another pathname.
  if (!sameIdentity(pathIdentity(target), expected)) return false;
  try { fs.unlinkSync(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function socketLifecycleError(code, message) {
  return Object.assign(new Error(message), { code });
}

function listenerExists() {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_PATH);
    let finished = false;
    const finish = (live) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => finish(true), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(!["ENOENT", "ECONNREFUSED"].includes(error.code)));
  });
}

async function acquireSocketLifecycleLock() {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const handle = await fsp.open(SOCKET_LIFECYCLE_LOCK, "wx", 0o600);
      const identity = pathIdentity(SOCKET_LIFECYCLE_LOCK);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid }) + "\n"); }
      finally { await handle.close(); }
      return () => { unlinkIdentity(SOCKET_LIFECYCLE_LOCK, identity); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = pathIdentity(SOCKET_LIFECYCLE_LOCK);
      let owner = null;
      try { owner = JSON.parse(await fsp.readFile(SOCKET_LIFECYCLE_LOCK, "utf8")); } catch {}
      let stale = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probeError) { stale = probeError.code === "ESRCH"; }
      } else stale = existing && Date.now() - existing.mtimeMs > 10_000;
      if (stale && unlinkIdentity(SOCKET_LIFECYCLE_LOCK, existing)) continue;
      if (Date.now() >= deadline) throw socketLifecycleError("CHROME_SOCKET_LIFECYCLE_BUSY", "Another host owns the socket lifecycle transition.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function preparePublicSocket() {
  const existing = pathIdentity(SOCKET_PATH);
  if (!existing) return;
  if (!existing.isSocket && !existing.isLink) {
    throw socketLifecycleError("CHROME_SOCKET_PATH_IN_USE", "The configured socket pathname contains a non-socket file.");
  }
  if (await listenerExists()) {
    throw socketLifecycleError("CHROME_SOCKET_ALREADY_RUNNING", "Another native host is already listening. Its socket, journal and PID file were preserved.");
  }
  if (!sameIdentity(pathIdentity(SOCKET_PATH), existing)) {
    throw socketLifecycleError("CHROME_SOCKET_OWNERSHIP_CHANGED", "The socket pathname changed during startup; refusing to replace it.");
  }
  unlinkIdentity(SOCKET_PATH, existing);
}

function removeOwnedPublicSocket() {
  if (ownedSocketIdentity) unlinkIdentity(SOCKET_PATH, ownedSocketIdentity);
}

async function removeOwnPidFile() {
  let recorded;
  try { recorded = (await fsp.readFile(PID_FILE, "utf8")).trim(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; return; }
  if (recorded === String(process.pid)) await fsp.unlink(PID_FILE).catch(() => {});
}

async function dispatchEntry(entry, request) {
  try {
    if (!entry.readOnly) await registry.persist();
    if (entry.state !== "accepted") return;
    if (!entry.sockets.size || Date.now() >= entry.deadlineMs || !extensionReady || shuttingDown) {
      await markUnknown(entry, "cancel-before-dispatch");
      return;
    }
    entry.state = "dispatched";
    entry.stage = "native-dispatch";
    entry.dispatched = true;
    // The durable dispatched marker precedes the native write. A host crash can
    // therefore leave an unknown result, but can never justify an unsafe replay.
    if (!entry.readOnly) await registry.persist();
    if (!entry.sockets.size || Date.now() >= entry.deadlineMs || !extensionReady || shuttingDown) {
      entry.dispatched = false;
      entry.state = "accepted";
      await markUnknown(entry, "cancel-before-dispatch");
      return;
    }
    sendNative({
      type: "request", id: entry.id, method: request.method, args: request.args || {},
      allowedUrlPatterns: request.allowedUrlPatterns, deadlineMs: entry.deadlineMs,
      connectionGeneration: entry.connectionGeneration, fingerprint: entry.fingerprint,
    });
  } catch {
    // A write can fail after partially reaching Chrome. Keep the marker and do
    // not turn a transport failure into permission to run the action again.
    await markUnknown(entry, "native-write", registry.healthy ? "CHROME_NATIVE_WRITE_FAILED" : "CHROME_OPERATION_JOURNAL_FAILED");
  }
}

async function handleSocketRequest(socket, request) {
  const id = safeId(request?.id) ? request.id : null;
  if (!request || typeof request !== "object" || Array.isArray(request) || !id
      || typeof request.method !== "string" || !/^[a-zA-Z][a-zA-Z0-9.]{0,99}$/.test(request.method)) {
    sendSocket(socket, failure(id, "CHROME_REQUEST_INVALID", "A valid request ID and method are required."));
    return;
  }
  if (request.method === "host.status") {
    sendSocket(socket, { id, ok: true, result: {
      hostPid: process.pid, socketPath: SOCKET_PATH, nativeHostBuildId: NATIVE_HOST_BUILD_ID,
      connectionGeneration, extensionConnected, extensionReady, extension: extensionInfo,
      profileBinding: publicProfileBinding(), profileError,
      operations: { retained: registry.entries.size, retentionMs: OPERATION_RETENTION_MS,
        maximumRetained: MAX_RETAINED_OPERATIONS,
        durableRetained: [...registry.entries.values()].filter((entry) => !entry.readOnly).length,
        readRetentionMs: READ_OPERATION_RETENTION_MS, maximumRetainedReads: MAX_RETAINED_READ_OPERATIONS,
        journalHealthy: registryInitialized && registry.healthy && !journalLoadError },
    } });
    return;
  }
  if (request.method === "host.operationStatus") {
    const operationId = request.args?.operationId;
    if (!safeId(operationId)) { sendSocket(socket, failure(id, "CHROME_OPERATION_ID_INVALID", "A valid operation ID is required.")); return; }
    const entry = registry.entries.get(operationId);
    if (entry && entry.state === "outcome_unknown" && extensionReady) {
      const queryId = crypto.randomUUID();
      const timer = setTimeout(() => {
        reconciliationQueries.delete(queryId);
        respondStatus(socket, id, entry);
      }, 500);
      timer.unref();
      reconciliationQueries.set(queryId, { operationId, id, socket, timer });
      try { sendNative({ type: "operationStatus", id: queryId, operationId, connectionGeneration }); }
      catch { clearTimeout(timer); reconciliationQueries.delete(queryId); respondStatus(socket, id, entry); }
    } else respondStatus(socket, id, entry, operationId);
    return;
  }
  const method = normalizeExtensionMethod(request.method);
  request = { ...request, method };
  const grantless = GRANTLESS_EXTENSION_METHODS.has(method);
  if (!grantless && (!Array.isArray(request.allowedUrlPatterns) || request.allowedUrlPatterns.length === 0)) {
    sendSocket(socket, failure(id, "CHROME_NO_URL_GRANT", "allowedUrlPatterns must be a non-empty array."));
    return;
  }
  if (request.args !== undefined && (!request.args || typeof request.args !== "object" || Array.isArray(request.args))) {
    sendSocket(socket, failure(id, "CHROME_REQUEST_INVALID", "args must be an object."));
    return;
  }
  // Status metadata is available offline, but returning retained page content
  // still requires the original signed-in profile binding to be healthy.
  if (!extensionReady) {
    sendSocket(socket, failure(id, profileError?.code || "CHROME_EXTENSION_OFFLINE",
      "The extension is unavailable or its profile does not match.", { state: "not_dispatched", dispatchState: "not_dispatched" }));
    return;
  }
  registry.prune();
  const fingerprint = operationFingerprint(request);
  const previous = registry.entries.get(id);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      sendSocket(socket, failure(id, "CHROME_OPERATION_ID_CONFLICT", "The operation ID already belongs to a different request.", operationMetadata(previous)));
    } else if (previous.response) {
      sendSocket(socket, { ...previous.response, operation: operationMetadata(previous) });
    } else if (previous.state === "cancelled_before_dispatch") {
      sendSocket(socket, failure(id, "CHROME_OPERATION_CANCELLED", "This operation was cancelled before dispatch.", operationMetadata(previous)));
    } else if (["accepted", "dispatched"].includes(previous.state)) {
      previous.sockets.add(socket);
      socket.operationEntry = previous;
    } else {
      sendSocket(socket, failure(id, "CHROME_OPERATION_RECONCILIATION_REQUIRED", "The original action was not replayed.", operationMetadata(previous)));
    }
    return;
  }
  const readOnly = isReadOnlyChromeMethod(method);
  if (!readOnly && (journalLoadError || !registry.healthy)) {
    sendSocket(socket, failure(id, "CHROME_OPERATION_JOURNAL_FAILED", "Operation history is unavailable; browser writes are not dispatched."));
    return;
  }
  if (!registry.hasCapacity(readOnly)) {
    sendSocket(socket, failure(id, "CHROME_OPERATION_CAPACITY", "The retained operation limit has been reached; old operations were not evicted for replay."));
    return;
  }
  const requestedTimeout = Number(request.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeout))) : REQUEST_TIMEOUT_MS;
  const now = Date.now();
  const deadlineMs = Number.isFinite(request.deadlineMs)
    ? Math.min(Math.floor(request.deadlineMs), now + timeoutMs) : now + timeoutMs;
  const entry = {
    id, fingerprint, method, readOnly, state: "accepted", stage: "accepted", dispatched: false,
    acceptedAt: now, deadlineMs, targetTabId: Number.isSafeInteger(request.args?.tabId) ? request.args.tabId : null,
    connectionGeneration, sockets: new Set([socket]), timer: null, response: null,
  };
  registry.entries.set(id, entry);
  socket.operationEntry = entry;
  entry.timer = setTimeout(() => { void markUnknown(entry, "action-deadline"); }, Math.max(1, deadlineMs - Date.now()));
  entry.timer.unref();
  void trackHandler(dispatchEntry(entry, request));
}

const server = net.createServer((socket) => {
  clientSockets.add(socket);
  socket.setEncoding("utf8");
  let text = "";
  let received = false;
  socket.on("data", (chunk) => {
    if (received) return;
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > MAX_SOCKET_LINE_BYTES) {
      received = true;
      sendSocket(socket, failure(null, "CHROME_REQUEST_TOO_LARGE", "Request exceeds its size limit."));
      return;
    }
    const newline = text.indexOf("\n");
    if (newline === -1) return;
    received = true; // Exactly one envelope per socket; never overwrite ownership.
    const line = text.slice(0, newline);
    let request;
    try { request = JSON.parse(line); }
    catch {
      sendSocket(socket, failure(null, "CHROME_REQUEST_INVALID", "Request JSON is invalid.", {
        responseBytes: Buffer.byteLength(line), responseSha256: crypto.createHash("sha256").update(line).digest("hex"),
      }));
      return;
    }
    void trackHandler(handleSocketRequest(socket, request)).catch(() => {
      sendSocket(socket, failure(safeId(request?.id) ? request.id : null, "CHROME_HOST_INTERNAL_ERROR", "Background Chrome could not process the request."));
    });
  });
  socket.on("error", () => {});
  socket.on("end", () => { if (!received) socket.destroy(); });
  socket.on("close", () => {
    clientSockets.delete(socket);
    const entry = socket.operationEntry;
    if (entry) {
      entry.sockets.delete(socket);
      if (!entry.sockets.size && ["accepted", "dispatched"].includes(entry.state)) {
        void markUnknown(entry, "client-disconnected");
      }
    }
  });
});

const releaseStartupLock = await acquireSocketLifecycleLock();
try {
  // Refuse a live endpoint before touching its shared operation history or PID.
  await preparePublicSocket();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PRIVATE_SOCKET_PATH, resolve); });
  await fsp.chmod(PRIVATE_SOCKET_PATH, 0o600);
  await fsp.symlink(path.basename(PRIVATE_SOCKET_PATH), SOCKET_PATH);
  ownedSocketIdentity = pathIdentity(SOCKET_PATH);
  try { await registry.load(); await registry.persist(); }
  catch { registry.entries.clear(); registry.healthy = false; journalLoadError = true; }
  registryInitialized = true;
  await fsp.writeFile(PID_FILE, String(process.pid) + "\n", { mode: 0o600 });
  await fsp.chmod(PID_FILE, 0o600);
} catch (error) {
  for (const socket of clientSockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  removeOwnedPublicSocket();
  await removeOwnPidFile().catch(() => {});
  throw error;
} finally {
  releaseStartupLock();
}
log("listening; nativeHostBuildId=" + NATIVE_HOST_BUILD_ID);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  extensionConnected = false;
  extensionReady = false;
  await Promise.all([...registry.entries.values()].map((entry) => markUnknown(entry, "native-disconnected", "CHROME_EXTENSION_OFFLINE")));
  // Drain already accepted handlers before allowing a replacement host to load
  // the journal; a late completion must not overwrite the new owner's history.
  while (inFlightHandlers.size) await Promise.allSettled([...inFlightHandlers]);
  await registry.writeChain;
  for (const query of reconciliationQueries.values()) {
    clearTimeout(query.timer);
    respondStatus(query.socket, query.id, registry.entries.get(query.operationId));
  }
  reconciliationQueries.clear();
  for (const socket of clientSockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve)).catch(() => {});
  let releaseShutdownLock;
  try {
    releaseShutdownLock = await acquireSocketLifecycleLock();
    removeOwnedPublicSocket();
    await removeOwnPidFile();
  } catch {
    log("socket ownership cleanup deferred; another lifecycle transition owns the path");
  } finally {
    releaseShutdownLock?.();
  }
}

process.stdin.on("data", parseNativeChunk);
process.stdin.on("end", async () => {
  if (nativeBuffer.length) log("native stream ended with an incomplete frame");
  await shutdown();
  process.exit(process.exitCode || 0);
});
process.stdin.on("error", async () => { log("native stdin error"); await shutdown(); process.exit(1); });
process.stdout.on("error", async () => { log("native stdout error"); await shutdown(); process.exit(1); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, async () => { await shutdown(); process.exit(0); });
}
