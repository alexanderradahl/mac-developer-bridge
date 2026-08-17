#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DATA_DIR = process.env.MAC_DEV_BRIDGE_DATA_DIR
  || path.join(os.homedir(), "Library", "Application Support", "MacDeveloperBridge");
const SOCKET_PATH = process.env.MAC_DEV_BRIDGE_CHROME_SOCKET
  || path.join(DATA_DIR, "chrome-background.sock");
const PID_FILE = process.env.MAC_DEV_BRIDGE_CHROME_NATIVE_PID_FILE
  || path.join(DATA_DIR, "chrome-native-host.pid");
const PROFILE_BINDING_FILE = process.env.MAC_DEV_BRIDGE_CHROME_PROFILE_BINDING_FILE
  || path.join(DATA_DIR, "chrome-background-profile.json");
const MAX_NATIVE_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOCKET_LINE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const GRANTLESS_EXTENSION_METHODS = new Set(["status", "workspace.status", "workspace.init"]);

await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
await fsp.chmod(DATA_DIR, 0o700).catch(() => {});

let nativeBuffer = Buffer.alloc(0);
let extensionConnected = false;
let extensionReady = false;
let extensionInfo = null;
let profileError = null;
let shuttingDown = false;
const pending = new Map();

function log(message) {
  process.stderr.write(`[chrome-native-host ${new Date().toISOString()}] ${message}\n`);
}

async function readProfileBinding() {
  try {
    const parsed = JSON.parse(await fsp.readFile(PROFILE_BINDING_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("binding is not an object");
    if (typeof parsed.profileDirectory !== "string" || !parsed.profileDirectory) throw new Error("profileDirectory is missing");
    if (typeof parsed.expectedEmail !== "string" || !parsed.expectedEmail.includes("@")) throw new Error("expectedEmail is missing");
    if (typeof parsed.expectedGaiaId !== "string" || !/^[0-9]+$/.test(parsed.expectedGaiaId)) throw new Error("expectedGaiaId is missing");
    return parsed;
  } catch (error) {
    const wrapped = new Error(`Background Chrome profile binding is unavailable at ${PROFILE_BINDING_FILE}: ${error?.message || error}`);
    wrapped.code = "CHROME_PROFILE_BINDING_INVALID";
    throw wrapped;
  }
}

const profileBinding = await readProfileBinding();

function publicProfileBinding() {
  return {
    profileDirectory: profileBinding.profileDirectory,
    expectedEmail: profileBinding.expectedEmail,
  };
}

function sendNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error(`native message is ${body.length} bytes, above ${MAX_NATIVE_MESSAGE_BYTES}`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function sendSocket(socket, message) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(message)}\n`);
}

function rejectAll(code, message) {
  for (const [id, entry] of pending.entries()) {
    clearTimeout(entry.timer);
    sendSocket(entry.socket, { id, ok: false, error: { code, message } });
  }
  pending.clear();
}

function handleNativeMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "ready") {
    extensionConnected = true;
    const profile = message.profile && typeof message.profile === "object" ? message.profile : {};
    const signedIn = profile.signedIn === true && typeof profile.email === "string" && typeof profile.id === "string";
    const emailMatch = signedIn && profile.email.toLowerCase() === profileBinding.expectedEmail.toLowerCase();
    const idMatch = signedIn && profile.id === profileBinding.expectedGaiaId;
    extensionReady = Boolean(signedIn && emailMatch && idMatch);
    profileError = extensionReady ? null : {
      code: !signedIn ? "CHROME_PROFILE_SIGNED_OUT" : "CHROME_PROFILE_MISMATCH",
      message: !signedIn
        ? `The Mac Developer Bridge extension is running in a Chrome profile with no signed-in primary account. Expected ${profileBinding.expectedEmail}.`
        : `The Mac Developer Bridge extension is running in the wrong Chrome profile (${profile.email || "unknown"}). Expected ${profileBinding.expectedEmail}.`,
    };
    extensionInfo = {
      version: message.version || null,
      extensionId: message.extensionId || null,
      readyAt: new Date().toISOString(),
      profile: {
        signedIn,
        email: typeof profile.email === "string" ? profile.email : null,
        matchesBinding: extensionReady,
      },
    };
    if (extensionReady) {
      log(`extension ready id=${extensionInfo.extensionId || "unknown"} version=${extensionInfo.version || "unknown"} profile=${profile.email}`);
    } else {
      log(`extension connected but profile binding refused: ${profileError.message}`);
    }
    return;
  }
  if (message.type !== "response" || typeof message.id !== "string") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  sendSocket(entry.socket, message.ok
    ? { id: message.id, ok: true, result: message.result ?? null }
    : { id: message.id, ok: false, error: message.error || { code: "CHROME_EXTENSION_ERROR", message: "Background browser extension returned an unspecified error." } });
}

function parseNativeChunk(chunk) {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (length <= 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
      log(`invalid native message length ${length}; exiting`);
      process.exitCode = 1;
      shutdown();
      return;
    }
    if (nativeBuffer.length < 4 + length) return;
    const payload = nativeBuffer.subarray(4, 4 + length);
    nativeBuffer = nativeBuffer.subarray(4 + length);
    try {
      handleNativeMessage(JSON.parse(payload.toString("utf8")));
    } catch (error) {
      log(`invalid JSON from extension: ${error.message}`);
    }
  }
}

async function removeSocket() {
  await fsp.unlink(SOCKET_PATH).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

await removeSocket();
await fsp.writeFile(PID_FILE, `${process.pid}\n`, { mode: 0o600 });
await fsp.chmod(PID_FILE, 0o600).catch(() => {});

async function removeOwnPidFile() {
  let recorded = "";
  try {
    recorded = (await fsp.readFile(PID_FILE, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  if (recorded === String(process.pid)) await fsp.unlink(PID_FILE).catch(() => {});
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > MAX_SOCKET_LINE_BYTES) {
      sendSocket(socket, { ok: false, error: { code: "CHROME_REQUEST_TOO_LARGE", message: `Request exceeds ${MAX_SOCKET_LINE_BYTES} bytes.` } });
      return;
    }
    const newline = text.indexOf("\n");
    if (newline === -1) return;
    const line = text.slice(0, newline);
    text = "";
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      sendSocket(socket, { ok: false, error: { code: "CHROME_REQUEST_INVALID", message: `Invalid JSON: ${error.message}` } });
      return;
    }
    if (request?.method === "host.status") {
      sendSocket(socket, {
        id: request.id || null,
        ok: true,
        result: {
          hostPid: process.pid,
          socketPath: SOCKET_PATH,
          extensionConnected,
          extensionReady,
          extension: extensionInfo,
          profileBinding: publicProfileBinding(),
          profileError,
        },
      });
      return;
    }
    if (!extensionReady) {
      sendSocket(socket, {
        id: request?.id || null,
        ok: false,
        error: profileError || {
          code: extensionConnected ? "CHROME_PROFILE_MISMATCH" : "CHROME_EXTENSION_OFFLINE",
          message: extensionConnected
            ? "The background-browser extension is connected but its Chrome profile does not match the configured signed-in profile."
            : "The background-browser Chrome extension is not connected. Install/load chrome-extension/ and ensure its native host is registered.",
        },
      });
      return;
    }
    if (!request || typeof request.method !== "string" || request.method.length === 0) {
      sendSocket(socket, { id: request?.id || null, ok: false, error: { code: "CHROME_REQUEST_INVALID", message: "method is required" } });
      return;
    }
    const grantless = GRANTLESS_EXTENSION_METHODS.has(request.method);
    if (!grantless && (!Array.isArray(request.allowedUrlPatterns) || request.allowedUrlPatterns.length === 0)) {
      sendSocket(socket, { id: request.id || null, ok: false, error: { code: "CHROME_NO_URL_GRANT", message: "allowedUrlPatterns must be a non-empty array" } });
      return;
    }
    const id = typeof request.id === "string" && request.id ? request.id : crypto.randomUUID();
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      sendSocket(entry.socket, { id, ok: false, error: { code: "CHROME_EXTENSION_TIMEOUT", message: `Background browser extension did not answer within ${REQUEST_TIMEOUT_MS}ms.` } });
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    pending.set(id, { socket, timer });
    try {
      sendNative({
        type: "request",
        id,
        method: request.method,
        args: request.args || {},
        allowedUrlPatterns: request.allowedUrlPatterns,
      });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      sendSocket(socket, { id, ok: false, error: { code: "CHROME_NATIVE_WRITE_FAILED", message: error.message } });
    }
  });
  socket.on("error", () => {});
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(SOCKET_PATH, resolve);
});
await fsp.chmod(SOCKET_PATH, 0o600).catch(() => {});
log(`listening on ${SOCKET_PATH}`);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  extensionConnected = false;
  extensionReady = false;
  rejectAll("CHROME_EXTENSION_OFFLINE", "Chrome closed the native messaging connection.");
  await new Promise((resolve) => server.close(resolve)).catch(() => {});
  await removeSocket().catch(() => {});
  await removeOwnPidFile().catch(() => {});
}

process.stdin.on("data", parseNativeChunk);
process.stdin.on("end", async () => {
  await shutdown();
  process.exit(process.exitCode || 0);
});
process.stdin.on("error", async (error) => {
  log(`stdin error: ${error.message}`);
  process.exitCode = 1;
  await shutdown();
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}
