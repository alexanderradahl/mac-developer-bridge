#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { createFederation, consumePersonalApproval } from "./lib/federation.mjs";
import { backgroundChromeCall, backgroundChromeStatus } from "./lib/chrome-extension-client.mjs";

const BRIDGE_VERSION = "0.2.0";
const SERVER_NAME = "mac-developer-bridge";
const SERVER_TITLE = "Mac Developer Bridge";
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const HOME = os.homedir();
const APP_SUPPORT_DIR = process.env.MAC_DEV_BRIDGE_DATA_DIR || path.join(HOME, "Library", "Application Support", "MacDeveloperBridge");
const JOB_DIR = path.join(APP_SUPPORT_DIR, "jobs");
const LOG_DIR = process.env.MAC_DEV_BRIDGE_LOG_DIR || path.join(HOME, "Library", "Logs", "MacDeveloperBridge");
const AUDIT_LOG = process.env.MAC_DEV_BRIDGE_AUDIT_LOG || path.join(LOG_DIR, "audit.jsonl");
const DEFAULT_OUTPUT_BYTES = clampInt(process.env.MAC_DEV_BRIDGE_DEFAULT_OUTPUT_BYTES, 1_000_000, 1_024, 8_000_000);
const MAX_OUTPUT_BYTES = clampInt(process.env.MAC_DEV_BRIDGE_MAX_OUTPUT_BYTES, 8_000_000, 1_024, 64_000_000);
const AUDIT_MODE = ["off", "metadata", "full"].includes(process.env.MAC_DEV_BRIDGE_AUDIT_MODE || "metadata")
  ? (process.env.MAC_DEV_BRIDGE_AUDIT_MODE || "metadata")
  : "metadata";
const DEFAULT_SHELL = process.platform === "darwin" && fs.existsSync("/bin/zsh")
  ? "/bin/zsh"
  : fs.existsSync("/bin/bash")
    ? "/bin/bash"
    : "/bin/sh";
const SHELL = process.env.MAC_DEV_BRIDGE_SHELL || DEFAULT_SHELL;
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Interactive pty sessions. Every limit below is a bound on a publicly reachable
// endpoint, so each one carries the number it was measured against.
const PTY_HELPER_PERL = process.env.MAC_DEV_BRIDGE_PTY_PERL || "/usr/bin/perl";
const PTY_HELPER_PL = process.env.MAC_DEV_BRIDGE_PTY_HELPER || path.join(BRIDGE_DIR, "lib", "ptyhelper.pl");
// kern.tty.ptmx_max is 511 SYSTEM-WIDE (measured, with 20 already in use), so
// exhausting it breaks Terminal.app, iTerm and ssh for the human at the keyboard.
// Eight helpers at ~7 MB RSS is a trivial share of that.
const PTY_MAX_SESSIONS = clampInt(process.env.MAC_DEV_BRIDGE_PTY_MAX_SESSIONS, 8, 1, 64);
// Per-session output retention. `yes` inside a session out-produces any client, so
// an unbounded chunk list here is a remote-driven memory leak.
const PTY_RING_BYTES = clampInt(process.env.MAC_DEV_BRIDGE_PTY_RING_BYTES, 262_144, 4_096, 4_000_000);
// The real bound is per-item cap x item count, which is why the session table
// itself is capped at PTY_MAX_SESSIONS entries including exited ones.
const PTY_RING_GLOBAL_BYTES = PTY_MAX_SESSIONS * PTY_RING_BYTES;
// A forgotten interactive shell is the same exposure as an orphan. Env override
// exists so tests can drive reaping without sleeping for minutes.
const PTY_IDLE_TIMEOUT_MS = clampInt(process.env.MAC_DEV_BRIDGE_PTY_IDLE_TIMEOUT_MS, 900_000, 1_000, 3_600_000);
const PTY_MAX_LIFETIME_MS = clampInt(process.env.MAC_DEV_BRIDGE_PTY_MAX_LIFETIME_MS, 28_800_000, 5_000, 86_400_000);
const PTY_WRITE_MAX = 65_536;
const PTY_START_TIMEOUT_MS = clampInt(process.env.MAC_DEV_BRIDGE_PTY_START_TIMEOUT_MS, 5_000, 500, 60_000);
const PTY_ACK_TIMEOUT_MS = 2_000;
const PTY_CLOSE_GRACE_MS = 2_000;
// How long a session may still report exited:false after the helper process is
// gone. 'close' normally follows 'exit' within a tick and carries the last of the
// transcript with it, so it is worth waiting for; it can also be deferred
// indefinitely by a descriptor the session program inherited, which is how a
// SIGKILLed helper left an orphaned shell reported as live for up to 15 minutes.
const PTY_HELPER_CLOSE_GRACE_MS = 250;
// Canonical-mode MAX_CANON on Darwin. A line at or above this length is DISCARDED
// ENTIRELY by the line discipline, not truncated. Measured: 1023 bytes + \r
// arrived intact, 1024 bytes + \r arrived as nothing at all while pty_write
// reported bytesWritten: 1025.
const PTY_MAX_CANON = 1024;
const PTY_SWEEP_MS = 5_000;
// Bounds how long a live session can outlive a removed unlock file while the
// client is making no calls at all. Without this interval, "removing the unlock
// file kills pty sessions" is false whenever the client simply stops polling.
const UNLOCK_RECHECK_MS = clampInt(process.env.MAC_DEV_BRIDGE_UNLOCK_RECHECK_MS, 3_000, 250, 60_000);
const PTY_TERMS = ["xterm-256color", "xterm", "vt100", "dumb"];
const PTY_SIGNALS = ["INT", "TERM", "KILL", "HUP", "QUIT", "USR1", "USR2", "WINCH", "TSTP", "CONT"];

const TUNNEL_RUNTIME_KEY_WAS_PRESENT = Boolean(process.env.CONTROL_PLANE_API_KEY);
delete process.env.CONTROL_PLANE_API_KEY;
const FULL_ACCESS_ACK = "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS";
// Capture the environment acknowledgement, then remove it from our own environment so
// no child can inherit it.
//
// Every child got it before: mergedEnv() copies process.env into shell_exec and
// shell_start, so any command the model ran could re-launch bridge.mjs with the ack
// already set — and a bridge started that way never reads the unlock file, so it is
// unstoppable by the kill switch. That is a route around the revocation latch created
// by the very tool the latch is meant to gate. CONTROL_PLANE_API_KEY has been scrubbed
// on the line above for the same reason; this variable was missed.
//
// Behaviour for THIS process is unchanged: the captured value still unlocks, exactly
// as documented in SECURITY.md.
const FULL_ACCESS_ACK_FROM_ENV = process.env.MAC_DEV_BRIDGE_FULL_ACCESS_ACK;
delete process.env.MAC_DEV_BRIDGE_FULL_ACCESS_ACK;
const FULL_ACCESS_UNLOCK_FILE = process.env.MAC_DEV_BRIDGE_UNLOCK_FILE || path.join(APP_SUPPORT_DIR, "FULL_ACCESS_ENABLED");

await Promise.all([
  fsp.mkdir(APP_SUPPORT_DIR, { recursive: true, mode: 0o700 }),
  fsp.mkdir(JOB_DIR, { recursive: true, mode: 0o700 }),
  fsp.mkdir(LOG_DIR, { recursive: true, mode: 0o700 }),
]);
await Promise.all([
  fsp.chmod(APP_SUPPORT_DIR, 0o700).catch(() => {}),
  fsp.chmod(JOB_DIR, 0o700).catch(() => {}),
  fsp.chmod(LOG_DIR, 0o700).catch(() => {}),
  fsp.chmod(AUDIT_LOG, 0o600).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  }),
]);

let fullAccessUnlocked = FULL_ACCESS_ACK_FROM_ENV === FULL_ACCESS_ACK;
if (!fullAccessUnlocked) {
  try {
    fullAccessUnlocked = (await fsp.readFile(FULL_ACCESS_UNLOCK_FILE, "utf8")).trim() === FULL_ACCESS_ACK;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (!fullAccessUnlocked) {
  stderr(`Refusing to start unrestricted bridge. Create ${FULL_ACCESS_UNLOCK_FILE} containing ${FULL_ACCESS_ACK}, or set MAC_DEV_BRIDGE_FULL_ACCESS_ACK to that exact value.`);
  process.exit(78);
}

let legacyInitialized = false;

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return nested.toString();
    if (Buffer.isBuffer(nested)) return nested.toString("base64");
    return nested;
  });
}

function writeProtocolMessage(message) {
  process.stdout.write(`${safeJson(message)}\n`);
}

function stderr(message) {
  process.stderr.write(`[${nowIso()}] ${message}\n`);
}

function serverInfo() {
  return {
    name: SERVER_NAME,
    title: SERVER_TITLE,
    version: BRIDGE_VERSION,
    description: "Unrestricted local shell, filesystem, process, patch, and Codex-history access on the host Mac.",
  };
}

function isModernRequest(message) {
  const version = message?.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  return version === MODERN_PROTOCOL || message?.method === "server/discover";
}

function resultMeta() {
  return { "io.modelcontextprotocol/serverInfo": serverInfo() };
}

function completeResult(payload, modern, cache = null) {
  if (!modern) return payload;
  return {
    resultType: "complete",
    ...payload,
    ...(cache ? { ttlMs: cache.ttlMs, cacheScope: cache.cacheScope } : {}),
    _meta: { ...(payload?._meta || {}), ...resultMeta() },
  };
}

function sendResult(id, result) {
  writeProtocolMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data = undefined) {
  writeProtocolMessage({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function toolTextResult(value, { isError = false, modern = false } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return completeResult(
    {
      content: [{ type: "text", text }],
      structuredContent: typeof value === "string" ? { text: value } : value,
      isError,
    },
    modern,
  );
}

function requireString(args, key, { allowEmpty = false } = {}) {
  const value = args?.[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`'${key}' must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(args, key, fallback = undefined) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`'${key}' must be a string`);
  return value;
}

function optionalBoolean(args, key, fallback = false) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`'${key}' must be a boolean`);
  return value;
}

function optionalInteger(args, key, fallback, min, max) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw new Error(`'${key}' must be an integer`);
  if (value < min || value > max) throw new Error(`'${key}' must be between ${min} and ${max}`);
  return value;
}

function requireInteger(args, key, min, max) {
  const value = args?.[key];
  if (!Number.isInteger(value)) throw new Error(`'${key}' must be an integer`);
  if (value < min || value > max) throw new Error(`'${key}' must be between ${min} and ${max}`);
  return value;
}

const GUI_FOCUS_POLICY = process.env.MAC_DEV_BRIDGE_GUI_FOCUS_POLICY || "background-first";
const SETTINGS_FILE = process.env.MAC_DEV_BRIDGE_SETTINGS_FILE || path.join(APP_SUPPORT_DIR, "settings.json");
const DEFAULT_OPERATOR_SETTINGS = Object.freeze({ strictApprovals: false });
const RELAXED_BROWSER_PATTERNS = Object.freeze(["http://*/*", "https://*/*"]);
const FOREGROUND_GUI_APPROVAL_FILE = process.env.MAC_DEV_BRIDGE_FOREGROUND_GUI_APPROVAL_FILE
  || path.join(APP_SUPPORT_DIR, "FOREGROUND_GUI_APPROVED");
const FOREGROUND_GUI_MAX_TTL_MS = 5 * 60 * 1000;

async function readOperatorSettings() {
  let raw;
  try {
    raw = await fsp.readFile(SETTINGS_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULT_OPERATOR_SETTINGS };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed operator settings file fails toward the safer behavior rather
    // than silently granting broader browser/GUI access.
    return { strictApprovals: true, settingsError: "invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { strictApprovals: true, settingsError: "invalid-shape" };
  }
  return {
    strictApprovals: typeof parsed.strictApprovals === "boolean"
      ? parsed.strictApprovals
      : DEFAULT_OPERATOR_SETTINGS.strictApprovals,
  };
}

function extractQuotedTargets(command, pattern) {
  const out = [];
  for (const match of command.matchAll(pattern)) {
    const value = String(match[1] || match[2] || "").trim();
    if (value) out.push(value);
  }
  return out;
}

function guiFocusRisk(command) {
  if (process.platform !== "darwin" || GUI_FOCUS_POLICY !== "background-first") return null;
  if (typeof command !== "string" || command.length === 0) return null;

  const usesOsascript = /(^|[\s;&|()])(?:\/usr\/bin\/)?osascript(?:[\s;&|<]|$)/m.test(command);
  const jxaApps = extractQuotedTargets(command, /\bApplication\s*\(\s*(?:["']([^"']+)["'])\s*\)/g);
  const tellApps = extractQuotedTargets(command, /tell\s+application\s+(?:["']([^"']+)["'])/gi);
  const tellProcesses = extractQuotedTargets(command, /tell\s+process\s+(?:["']([^"']+)["'])/gi);
  const appTargets = [...new Set([...jxaApps, ...tellApps, ...tellProcesses])];
  const nonSystemTargets = appTargets.filter((name) => name.toLowerCase() !== "system events");

  if ((usesOsascript || jxaApps.length > 0) && nonSystemTargets.length > 0) {
    return { reason: "apple-events-app-control", apps: nonSystemTargets };
  }

  if (usesOsascript && /\b(?:activate|frontmost\s+(?:to|=)\s+true|AXRaise|keystroke|key code)\b/i.test(command)) {
    return { reason: "apple-events-focus-action", apps: appTargets.length ? appTargets : ["System Events"] };
  }

  if (/(^|[\s;&|()])(?:\/usr\/bin\/)?open(?:[\s;&|<]|$)/m.test(command) && !/(^|\s)-g(?:\s|$)/m.test(command)) {
    const appMatches = extractQuotedTargets(command, /(?:^|\s)-a\s+(?:["']([^"']+)["'])/gm);
    return { reason: "macos-open-foreground", apps: appMatches.length ? appMatches : ["open"] };
  }

  return null;
}


// Chrome is different from other desktop apps: MDB has a dedicated background
// browser path that preserves the signed-in profile without taking over the
// operator's screen. Approval strictness must never decide whether a model may
// bypass that path. Relaxed mode removes approval ceremony; it does NOT make
// AppleScript/JXA/direct launches/shell web `open` an alternate Chrome transport.
function chromeBackgroundRoutingRisk(command) {
  if (process.platform !== "darwin" || typeof command !== "string" || command.length === 0) return null;

  const usesOsascript = /(^|[\s;&|()])(?:\/usr\/bin\/)?osascript(?:[\s;&|<]|$)/m.test(command);
  const chromeAppleEvent = /\btell\s+(?:application|process)(?:\s+id)?\s+["'](?:Google Chrome|com\.google\.Chrome)["']/i.test(command)
    || /\bApplication\s*\(\s*["'](?:Google Chrome|com\.google\.Chrome)["']\s*\)/i.test(command);
  if (chromeAppleEvent && (usesOsascript || /\bApplication\s*\(/.test(command))) {
    return { reason: "chrome-apple-events", apps: ["Google Chrome"] };
  }

  const usesOpen = /(^|[\s;&|()])(?:\/usr\/bin\/)?open(?:[\s;&|<]|$)/m.test(command);
  if (usesOpen) {
    const explicitlyChrome = /(?:^|\s)-a\s+(?:["']Google Chrome["']|Google\\\s+Chrome)(?:\s|$)/im.test(command)
      || /(?:^|\s)-b\s+["']?com\.google\.Chrome["']?(?:\s|$)/im.test(command);
    const opensWebUrl = /\bhttps?:\/\/[^\s"']+/i.test(command);
    // Even `open -g https://…` bypasses the MDB group and creates an
    // unowned browser tab, so all shell-opened web URLs are refused.
    if (explicitlyChrome || opensWebUrl) {
      return { reason: explicitlyChrome ? "chrome-open-app" : "browser-open-bypasses-mdb", apps: ["Google Chrome"] };
    }
  }

  const directChromeExecutable = /(^|[\s;&|()])(?:["']?\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome["']?)(?:[\s;&|<]|$)/m.test(command);
  if (directChromeExecutable) {
    return { reason: "chrome-direct-executable", apps: ["Google Chrome"] };
  }

  return null;
}

async function foregroundGuiApprovalPresent() {
  try {
    await fsp.stat(FOREGROUND_GUI_APPROVAL_FILE);
    return { present: true, path: FOREGROUND_GUI_APPROVAL_FILE };
  } catch (error) {
    return { present: false, path: FOREGROUND_GUI_APPROVAL_FILE, reason: error?.code || String(error) };
  }
}

async function consumeForegroundGuiApproval(risk) {
  let raw;
  try {
    raw = await fsp.readFile(FOREGROUND_GUI_APPROVAL_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let grant;
  try {
    grant = JSON.parse(raw);
  } catch (source) {
    const error = new Error("Foreground GUI approval file is invalid JSON.");
    error.code = "GUI_FOREGROUND_APPROVAL_INVALID";
    throw error;
  }

  const nonce = typeof grant?.nonce === "string" ? grant.nonce : "";
  const expiresAt = typeof grant?.expiresAt === "string" ? grant.expiresAt : "";
  const allowedApps = Array.isArray(grant?.allowedApps) ? grant.allowedApps.filter((x) => typeof x === "string") : [];
  const expiry = Date.parse(expiresAt);
  const now = Date.now();
  if (!/^[0-9a-fA-F]{32}$/.test(nonce) || !Number.isFinite(expiry) || expiry <= now || expiry - now > FOREGROUND_GUI_MAX_TTL_MS) {
    await fsp.unlink(FOREGROUND_GUI_APPROVAL_FILE).catch(() => {});
    const error = new Error("Foreground GUI approval is missing, expired, or malformed.");
    error.code = "GUI_FOREGROUND_APPROVAL_INVALID";
    throw error;
  }

  const normalized = new Set(allowedApps.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const missing = risk.apps.filter((app) => !normalized.has(String(app).trim().toLowerCase()));
  if (missing.length > 0) {
    const error = new Error(`Foreground GUI approval does not allow: ${missing.join(", ")}.`);
    error.code = "GUI_FOREGROUND_APP_NOT_APPROVED";
    throw error;
  }

  // Single use. Unlink before executing the focus-stealing shell call.
  await fsp.unlink(FOREGROUND_GUI_APPROVAL_FILE);
  return { nonce, expiresAt, allowedApps };
}

function optionalStringArray(args, key, fallback = undefined) {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`'${key}' must be an array of strings`);
  }
  return value;
}

function resolvePath(input, cwd = HOME) {
  if (typeof input !== "string" || input.length === 0) throw new Error("path must be a non-empty string");
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return path.join(HOME, input.slice(2));
  return path.resolve(cwd, input);
}

function normalizeEnv(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("'env' must be an object");
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (value === null) output[key] = null;
    else if (["string", "number", "boolean"].includes(typeof value)) output[key] = String(value);
    else throw new Error(`Environment value for '${key}' must be string, number, boolean, or null`);
  }
  return output;
}

function mergedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function redactString(input) {
  return String(input)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s'\"]+/gi, "$1[REDACTED]");
}

// Keystrokes are never written to the audit log, at any AUDIT_MODE.
//
// This is centralised inside audit() rather than applied at the call site because
// three separate paths log a tool's raw arguments: the success path, the failure
// path in tools/call, and assertStillUnlocked's revocation record. Measured while
// building this: driving an ssh-keygen passphrase and a `read -s` prompt through
// pty_write turns AUDIT_MODE=full into a plaintext password store, and redactString
// cannot help because a passphrase looks like any other word. The byte length and a
// hash prefix keep the record useful for correlating a session without keeping the
// secret.
function auditSafeArguments(tool, args) {
  if (tool !== "pty_write" || typeof args?.data !== "string") return args;
  const bytes = Buffer.byteLength(args.data, "utf8");
  const digest = crypto.createHash("sha256").update(args.data, "utf8").digest("hex").slice(0, 16);
  return { ...args, data: `[REDACTED ${bytes} bytes sha256:${digest}]` };
}

async function audit(tool, argsInput, summary = {}, error = null) {
  if (AUDIT_MODE === "off") return;
  try {
    const args = auditSafeArguments(tool, argsInput);
    const raw = safeJson(args ?? {});
    const entry = {
      timestamp: nowIso(),
      pid: process.pid,
      tool,
      argumentsHash: crypto.createHash("sha256").update(raw).digest("hex"),
      summary,
      error: error ? String(error?.message || error) : null,
    };
    if (AUDIT_MODE === "full") entry.arguments = JSON.parse(redactString(raw));
    else {
      const preview = redactString(raw).slice(0, 512);
      entry.argumentsPreview = preview;
    }
    await fsp.appendFile(AUDIT_LOG, `${safeJson(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (auditError) {
    stderr(`audit failure: ${auditError?.message || auditError}`);
  }
}

function boundedCollector(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
      } else {
        chunks.push(chunk);
        bytes += chunk.length;
      }
    },
    value() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
    get bytes() {
      return bytes;
    },
  };
}

async function runCommand({ command, cwd, env = {}, stdin = undefined, timeoutMs = 120_000, maxOutputBytes = DEFAULT_OUTPUT_BYTES }) {
  const effectiveCwd = resolvePath(cwd || HOME);
  const stdout = boundedCollector(Math.min(maxOutputBytes, MAX_OUTPUT_BYTES));
  const stderrOutput = boundedCollector(Math.min(maxOutputBytes, MAX_OUTPUT_BYTES));
  const startedAt = Date.now();
  let timedOut = false;
  let settled = false;

  return await new Promise((resolve, reject) => {
    const child = spawn(SHELL, ["-lc", command], {
      cwd: effectiveCwd,
      env: mergedEnv(env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Registered so a revocation can kill in-flight commands. Without this the
    // bridge exits and leaves an unrestricted process running past its own
    // timeout, invisible to disable.sh (shell_exec writes no job metadata).
    inFlightCommands.add(child);
    child.once("close", () => inFlightCommands.delete(child));

    let timer = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    child.once("error", fail);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderrOutput.append(chunk));

    if (stdin !== undefined) child.stdin.end(String(stdin));
    else child.stdin.end();

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try { child.kill("SIGTERM"); } catch {}
        }
        setTimeout(() => {
          if (settled) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try { child.kill("SIGKILL"); } catch {}
          }
        }, 2_000).unref();
      }, timeoutMs);
      timer.unref();
    }

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command,
        shell: SHELL,
        cwd: effectiveCwd,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.value(),
        stderr: stderrOutput.value(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderrOutput.truncated,
        capturedStdoutBytes: stdout.bytes,
        capturedStderrBytes: stderrOutput.bytes,
      });
    });
  });
}

async function readJobMetadata(jobId) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(jobId)) throw new Error("Invalid job_id");
  const metadataPath = path.join(JOB_DIR, `${jobId}.json`);
  return JSON.parse(await fsp.readFile(metadataPath, "utf8"));
}

async function writeJobMetadata(metadata) {
  // Write then rename, so the file is never partially visible.
  //
  // A plain writeFile let process.exit land between open and write, leaving a 0-byte
  // file. disable.sh's job_field then extracts nothing and builds no target, so a live
  // unrestricted process read as "no job" — the reclaimer silently skipped it. Measured
  // during a revocation that raced a provider restart.
  const metadataPath = path.join(JOB_DIR, `${metadata.id}.json`);
  const tmpPath = `${metadataPath}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmpPath, metadataPath);
}

function processRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function tailFile(filePath, maxBytes = 100_000) {
  // pty session metadata lives in the same jobs directory so scripts/disable.sh
  // reclaims it, but a pty has no log files: its output is a ring buffer read
  // through pty_read. Without this guard shell_job_status on a pty entry threw an
  // opaque TypeError from stat(undefined) instead of returning empty logs.
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { text: "", size: 0, returnedBytes: 0, truncated: false };
  }
  try {
    const stat = await fsp.stat(filePath);
    const length = Math.min(stat.size, maxBytes);
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return { text: buffer.toString("utf8"), size: stat.size, returnedBytes: length, truncated: stat.size > length };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "", size: 0, returnedBytes: 0, truncated: false };
    throw error;
  }
}

async function callCodexAppServer(method, params, timeoutMs = 30_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const rl = readline.createInterface({ input: child.stdout });
    const stderrCollector = boundedCollector(200_000);
    child.stderr.on("data", (chunk) => stderrCollector.append(chunk));

    let done = false;
    let timer = null;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      rl.close();
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!done) finish(new Error(`codex app-server exited before responding (code=${code}, signal=${signal}): ${stderrCollector.value()}`));
    });

    rl.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0) {
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
        return;
      }
      if (message.id === 1) {
        if (message.error) finish(new Error(`Codex app-server error ${message.error.code}: ${message.error.message}`));
        else finish(null, message.result);
      }
    });

    child.stdin.write(`${JSON.stringify({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: BRIDGE_VERSION },
        capabilities: { experimentalApi: true },
      },
    })}\n`);

    timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Codex app-server after ${timeoutMs}ms: ${stderrCollector.value()}`));
    }, timeoutMs);
    timer.unref();
  });
}

const TOOLS = [
  {
    name: "bridge_status",
    title: "Bridge status",
    description: "Inspect the host identity, runtime paths, permissions context, configured shell, audit log, and Codex executable. This is read-only.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "chrome_workspace_status",
    title: "MDB Chrome workspace status",
    description: "Inspect the extension-owned MDB Chrome tab group and reusable background-tab pool. This is local extension state only and does not access authenticated websites, so it does not consume a personal-browser URL grant.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "chrome_workspace_setup",
    title: "Set up MDB Chrome workspace",
    description: "Create or expand the extension-owned MDB Chrome tab group and its reusable background-tab pool. This is a one-time/local setup action and does not access authenticated websites. On macOS, setup refuses to create tabs unless a normal Chrome window is already focused, because Chrome may otherwise steal focus even for active:false tab creation.",
    inputSchema: {
      type: "object",
      properties: {
        pool_size: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          default: 4,
          description: "Number of reusable extension-owned tabs to keep in the MDB group.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "chrome_tabs",
    title: "List approved Chrome tabs in background",
    description: "List tabs from the user's real signed-in Chrome profile without activating Chrome. Relaxed mode is the default and needs no per-site approval. When Strict approvals is enabled in the menu-bar app, only tabs covered by active scoped grants are returned.",
    inputSchema: {
      type: "object",
      properties: {
        url_contains: { type: "string", description: "Optional case-insensitive URL substring filter." },
        title_contains: { type: "string", description: "Optional case-insensitive title substring filter." },
        max_tabs: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "chrome_open",
    title: "Open background Chrome tab",
    description: "Open a URL in an idle tab from the persistent MDB Chrome tab group. Routine calls never create a new Chrome tab, which avoids macOS focus theft. Relaxed mode is the default and permits normal HTTP/HTTPS sites without per-site approvals; Strict approvals optionally restores scoped URL grants.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: 20000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "chrome_navigate",
    title: "Navigate Chrome tab in background",
    description: "Navigate an existing MDB Chrome tab without selecting it or activating Chrome. In relaxed mode normal HTTP/HTTPS navigation needs no per-site approval; Strict approvals restricts navigation to active scoped grants.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", minimum: 0 },
        url: { type: "string", minLength: 1, maxLength: 20000 },
      },
      required: ["tab_id", "url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "chrome_snapshot",
    title: "Read Chrome page in background",
    description: "Read visible text and a bounded list of interactive elements from an MDB Chrome tab without activating Chrome. Password input values are redacted. Strict approvals, when enabled, restricts readable URLs to active scoped grants.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", minimum: 0 },
        max_text_chars: { type: "integer", minimum: 1000, maximum: 200000, default: 50000 },
        max_elements: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      required: ["tab_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "chrome_click",
    title: "Click Chrome element in background",
    description: "Programmatically click an element in an MDB Chrome tab without activating Chrome. Use selectors returned by chrome_snapshot. Relaxed mode is the default; Strict approvals optionally restricts sites. Trusted-user-gesture flows, CAPTCHAs, native dialogs, and file pickers may still require foreground/manual interaction.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", minimum: 0 },
        selector: { type: "string", minLength: 1, maxLength: 10000 },
      },
      required: ["tab_id", "selector"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "chrome_fill",
    title: "Fill Chrome field in background",
    description: "Fill an input, textarea, select, or contenteditable element in an MDB Chrome tab without activating Chrome. Relaxed mode is the default; Strict approvals optionally restricts sites. File inputs remain foreground-only.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", minimum: 0 },
        selector: { type: "string", minLength: 1, maxLength: 10000 },
        value: { type: "string", maxLength: 500000 },
        submit: { type: "boolean", default: false, description: "If true, request form submission after filling. This can trigger external side effects." },
      },
      required: ["tab_id", "selector", "value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "chrome_close",
    title: "Close background Chrome tab",
    description: "Release an MDB workspace tab back to the pool, or close a non-workspace Chrome tab. Strict approvals affects site access, not local workspace cleanup.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", minimum: 0 },
        allow_active: { type: "boolean", default: false },
      },
      required: ["tab_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "shell_exec",
    title: "Execute shell command",
    description: "Run an arbitrary command through the configured login shell with the full permissions of the macOS user running this bridge. Use for commands that finish within the requested timeout. This can read, modify, delete, deploy, access the network, or invoke other programs.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Exact shell command to execute." },
        cwd: { type: "string", description: "Working directory. Supports absolute paths, relative paths, and ~/ paths. Defaults to the user's home directory." },
        env: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] }, description: "Environment overrides. Set a value to null to remove it." },
        stdin: { type: "string", description: "Optional text to send to stdin." },
        timeout_ms: { type: "integer", minimum: 0, maximum: 1_800_000, default: 120000, description: "0 disables the bridge timeout. Prefer shell_start for long-running services." },
        max_output_bytes: { type: "integer", minimum: 1024, maximum: 64000000, description: "Maximum bytes captured separately from stdout and stderr." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "shell_start",
    title: "Start background shell job",
    description: "Start an arbitrary detached background command with full host permissions. Output is written to persistent log files and the job can be inspected or stopped later.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
        label: { type: "string", maxLength: 100 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "shell_job_status",
    title: "Inspect background job",
    description: "Check whether a background job is running and return the tail of its stdout and stderr logs.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        max_log_bytes: { type: "integer", minimum: 1024, maximum: 8000000, default: 100000 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "shell_job_list",
    title: "List background jobs",
    description: "List persistent background-job metadata and current running state.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "shell_job_kill",
    title: "Stop background job",
    description: "Send a signal to the background job's process group. Defaults to SIGTERM.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        signal: { type: "string", enum: ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"], default: "SIGTERM" },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "fs_read",
    title: "Read file",
    description: "Read any file accessible to the macOS user. Supports byte ranges and text or base64 output.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        offset: { type: "integer", minimum: 0, default: 0 },
        max_bytes: { type: "integer", minimum: 1, maximum: 64000000, default: 1000000 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "fs_write",
    title: "Write file",
    description: "Create, replace, or append to any file accessible to the macOS user. Parent directories can be created automatically. Replacement writes are atomic by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        append: { type: "boolean", default: false },
        atomic: { type: "boolean", default: true },
        create_parents: { type: "boolean", default: true },
        mode: { type: "integer", minimum: 0, maximum: 4095, description: "Optional POSIX mode as a decimal integer, for example 420 for 0644." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "fs_list",
    title: "List directory",
    description: "List a directory, optionally recursively, with type, size, mode, and timestamps. Symlinks are not followed during recursion.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", default: false },
        include_hidden: { type: "boolean", default: true },
        max_entries: { type: "integer", minimum: 1, maximum: 100000, default: 5000 },
        max_depth: { type: "integer", minimum: 0, maximum: 100, default: 10 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "fs_stat",
    title: "Inspect filesystem path",
    description: "Return lstat metadata for any accessible filesystem path, including symlink target when applicable.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "fs_manage",
    title: "Manage filesystem path",
    description: "Perform unrestricted filesystem operations: mkdir, remove, move, copy, chmod, or symlink. Remove is recursive when requested. These operations use the host user's permissions.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["mkdir", "remove", "move", "copy", "chmod", "symlink"] },
        path: { type: "string", description: "Primary path or symlink path." },
        destination: { type: "string", description: "Destination for move/copy, or target for symlink." },
        recursive: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        mode: { type: "integer", minimum: 0, maximum: 4095 },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "apply_patch",
    title: "Apply unified diff",
    description: "Apply a unified diff using git apply in the specified working directory. This does not invoke a model and can modify any paths permitted by git apply and the host OS.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        check_only: { type: "boolean", default: false },
        reverse: { type: "boolean", default: false },
        three_way: { type: "boolean", default: false },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "codex_thread_read",
    title: "Read Codex thread",
    description: "Read a stored local Codex thread through codex app-server without resuming it or starting a model turn. Set include_turns to true for the full persisted history.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        include_turns: { type: "boolean", default: true },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "codex_thread_list",
    title: "List Codex threads",
    description: "Page through stored local Codex threads without resuming them or starting model turns. Supports search, cwd, archived state, sorting, and cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        cursor: { type: "string" },
        search_term: { type: "string" },
        cwd: { type: "string" },
        archived: { type: "boolean" },
        is_pinned: { type: "boolean" },
        use_state_db_only: { type: "boolean", default: false },
        model_providers: { type: "array", items: { type: "string" } },
        source_kinds: {
          type: "array",
          items: { type: "string", enum: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"] },
        },
        sort_key: { type: "string", enum: ["created_at", "updated_at", "recency_at"], default: "recency_at" },
        sort_direction: { type: "string", enum: ["asc", "desc"], default: "desc" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "codex_thread_turns_list",
    title: "Page Codex thread turns",
    description: "Page a stored Codex thread's turns without resuming it or starting a model turn. Use items_view=full to recover complete persisted turn items when codex_thread_read is too large for one response.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        cursor: { type: "string" },
        sort_direction: { type: "string", enum: ["asc", "desc"], default: "asc" },
        items_view: { type: "string", enum: ["notLoaded", "summary", "full"], default: "full" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "audit_tail",
    title: "Read bridge audit log",
    description: "Return the tail of the bridge's local JSONL audit log. The default metadata mode redacts common token patterns and stores only an argument preview plus a hash.",
    inputSchema: {
      type: "object",
      properties: { max_bytes: { type: "integer", minimum: 1024, maximum: 8000000, default: 200000 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "pty_start",
    title: "Start interactive pty session",
    description: "Start a program on a real pseudo-terminal and keep it running as a session that can be written to, read from, resized, and signalled. Use this for anything that prompts or redraws: interactive authentication, sudo and ssh passphrase prompts, REPLs, test watchers, git rebase, and full-screen TUIs. 'command' plus 'args' is an argv vector, not a shell string; for a shell use command '/bin/zsh' with args ['-i']. Sessions are in memory only and do not survive a bridge restart. Removing the full-access unlock file terminates every live session.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Executable to run. Absolute path, or a name resolved through PATH." },
        args: { type: "array", items: { type: "string" }, maxItems: 256, description: "Argument vector. Not parsed by a shell." },
        cwd: { type: "string", description: "Working directory. Supports absolute, relative, and ~/ paths. Defaults to the user's home directory." },
        env: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] }, maxProperties: 64, description: "Environment overrides. Set a value to null to remove it." },
        cols: { type: "integer", minimum: 20, maximum: 500, default: 120 },
        rows: { type: "integer", minimum: 5, maximum: 200, default: 30 },
        term: { type: "string", enum: ["xterm-256color", "xterm", "vt100", "dumb"], default: "xterm-256color", description: "TERM for the child. Programs that call tput fail outright without it." },
        idle_timeout_ms: { type: "integer", minimum: 30000, maximum: 3600000, default: 900000, description: "Session is reclaimed after this long with no pty tool call against it. Output from the child does not count as activity." },
        label: { type: "string", maxLength: 100 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "pty_read",
    title: "Read pty session output",
    description: "Read a byte range of a session's output. 'cursor' is an absolute byte offset, so the same cursor always returns the same bytes and 'next_cursor' continues without gap or overlap; a retried read never loses output. Reading a session that has already exited is not an error and is how final output is collected. ANSI escapes and carriage-return progress redraws are removed by default; disable both to see raw TUI bytes.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 128 },
        cursor: { type: "integer", minimum: 0, default: 0, description: "Absolute byte offset. Start at 0, then pass the previous next_cursor." },
        max_bytes: { type: "integer", minimum: 1024, maximum: 1000000, default: 65536 },
        strip_ansi: { type: "boolean", default: true },
        collapse_carriage_returns: { type: "boolean", default: true },
        wait_ms: { type: "integer", minimum: 0, maximum: 30000, default: 0, description: "Wait up to this long for new output before returning. 0 returns immediately." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "pty_write",
    title: "Write to pty session",
    description: "Send bytes to the session's terminal exactly as typed. End a line with \\r to submit it. Control characters: \\u0003 is Ctrl-C (interrupts only the foreground program), \\u0004 is end-of-file, \\u001a is Ctrl-Z, \\u001b is Escape. Input is never echoed back by this tool; read it with pty_read. The written bytes are never recorded in the audit log, so passphrase prompts are safe to answer here. Line length limit: while the terminal is in canonical mode (the default, and what every interactive prompt uses), the line discipline DISCARDS an entire input line of 1024 bytes or more rather than truncating it, so a write that would build such a line is refused with PTY_WRITE_CANON_LIMIT instead of being reported as delivered. Bytes accumulate across calls until a \\r or \\n, so chunking a long line does not evade it. Send lines of at most 1023 bytes.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 128 },
        data: { type: "string", maxLength: 65536 },
      },
      required: ["session_id", "data"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "pty_resize",
    title: "Resize pty session",
    description: "Change the terminal window size and deliver SIGWINCH to the session, so full-screen programs redraw at the new geometry. The returned cols and rows are the kernel's own read-back of the window size, not the requested values; a resize that cannot be confirmed is reported as an error rather than as success.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 128 },
        cols: { type: "integer", minimum: 20, maximum: 500 },
        rows: { type: "integer", minimum: 5, maximum: 200 },
      },
      required: ["session_id", "cols", "rows"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "pty_signal",
    title: "Signal pty session",
    description: "Send a signal to the session's entire process group, which includes the shell itself and every program it started. To interrupt only the foreground program and keep the shell alive, use pty_write with \\u0003 instead. Signals are delivered by the pty helper to the session leader's group; the result reports whether delivery was confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 128 },
        signal: { type: "string", enum: ["INT", "TERM", "KILL", "HUP", "QUIT", "USR1", "USR2", "WINCH", "TSTP", "CONT"] },
      },
      required: ["session_id", "signal"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "pty_close",
    title: "Close pty session",
    description: "End a session and reclaim it. Sends SIGTERM, waits for the grace period, then SIGKILL to the leader's process group, then SIGKILL to anything still holding the session's controlling terminal (interactive job control puts every background job — a plain 'cmd &' — in its own process group, which a group kill does not reach; those pids are listed in 'ttyProcessesKilled'). 'leaderGroupGone' reports the group check alone. 'containment_verified' is true only when the group is gone AND nothing that shared the terminal survived; survivors are listed in 'uncontainedPids'. It can legitimately be false: a descendant that both called setsid() and detached from the terminal escapes both kills. Idempotent: closing an already-closed session reports its recorded outcome.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", minLength: 1, maxLength: 128 },
        force: { type: "boolean", default: false, description: "Skip SIGTERM and the grace period." },
        grace_ms: { type: "integer", minimum: 0, maximum: 10000, default: 2000 },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// Re-read the unlock state before every tool call, so removing the unlock file
// is genuinely fail-closed.
//
// Checking it only at startup made `rm` of the file a no-op against a process
// already serving: it kept answering 200 with unrestricted shell until someone
// found and killed it. That turned containment into an external process-hunting
// problem, which is where three separate false-"disabled" bugs came from. The
// authority over "is full access permitted right now" belongs here, next to the
// tools it gates. One stat+read per call is nothing beside spawning a login shell.
//
// MAC_DEV_BRIDGE_FULL_ACCESS_ACK in the environment still unlocks, unchanged —
// but that is the operator's own process env, not a file anyone can revoke, so
// it is deliberately not a kill-switch surface.
// Foreground shell_exec children, so revocation can reclaim them.
const inFlightCommands = new Set();

function killInFlightCommands() {
  for (const child of inFlightCommands) {
    // Negative pid: the whole group, since runCommand spawns detached. The
    // pid > 1 guard is not paranoia: in JS -0 === 0, and process.kill(-0) signals
    // THIS process group, which on the tunnel transport contains tunnel-client —
    // so a spawn that failed to produce a pid would make the kill switch take out
    // its own supervisor. scripts/disable.sh refuses the same target for the same
    // reason.
    if (killProcessGroup(child.pid, "SIGKILL") !== null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
  inFlightCommands.clear();
}

// One guarded group kill for every reclaim path. Returns null on success, or the
// errno / reason string, so a caller can report honestly instead of assuming.
function killProcessGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) return "INVALID_TARGET";
  try {
    process.kill(-pgid, signal);
    return null;
  } catch (error) {
    return error?.code || String(error?.message || error);
  }
}

// Verified by the same predicate the kill used: -pgid. Verifying containment by
// the helper's exit code instead is how this project shipped three "Disabled"
// verdicts it had not achieved.
function processGroupGone(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return true;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// A process-GROUP kill does not contain a pty session.
//
// Interactive job control puts every background job in its own pgid. Measured on
// a plain `/bin/zsh -i`: `sleep & ` produced leader pgid 29441 and job pgid 29650,
// and pty_close reported containmentVerified:true while the job was still running,
// reparented to pid 1. No setsid(), no attacker, the single most ordinary thing
// anyone types in a terminal.
//
// What every descendant DOES keep on Darwin is the controlling terminal, so the
// pts is the session identity a group id only approximates.
const PTS_PATTERN = /^\/dev\/tty[a-z0-9]{1,12}$/;

// Only ever called while the helper still holds the master fd, so the device
// cannot have been recycled to someone else's session between the scan and the
// kill. That ordering is the whole safety argument — /dev/ttysNNN is reused as
// freely as a pid, and killing by a stale device name would be the recycled-pgid
// mistake in a new costume.
// Bounds the work every reclaim path does. A session with more processes than
// this on its terminal is pathological, and this runs between a revocation
// decision and process.exit.
const PTY_TTY_SCAN_MAX = 64;
// The kill switch must never become slower than the thing it contains. Consulting
// ps costs 1.1ms measured, but a hung ps would cost the timeout, and a reclaim
// sweep touches every session: 8 sessions x 2 calls x a 2s timeout is 32 seconds
// of delay before the bridge exits. One budget covers a whole sweep, and the
// per-call timeout bounds the last call that starts inside it, so the worst case
// the revocation path can pay is BUDGET + TIMEOUT.
const PTY_TTY_SCAN_TIMEOUT_MS = 1_000;
const PTY_TTY_SCAN_BUDGET_MS = 1_000;
let ptyTtyScanDeadline = 0;

function beginPtyTtyScanBudget() {
  ptyTtyScanDeadline = Date.now() + PTY_TTY_SCAN_BUDGET_MS;
}

function psRows(args) {
  // Out of budget means the terminal sweep is skipped, not that the kill is: the
  // process-group kill has already happened and is not gated on this.
  if (Date.now() >= ptyTtyScanDeadline) return new Map();
  let stdout;
  try {
    stdout = execFileSync("/bin/ps", args, {
      encoding: "utf8",
      timeout: PTY_TTY_SCAN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1_000_000,
    });
  } catch (error) {
    // ps exits non-zero when the device or the pid is already gone, which is the
    // normal outcome once the leader has been reaped.
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const rows = new Map();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space < 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, space), 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    rows.set(pid, trimmed.slice(space + 1).trim());
  }
  return rows;
}

// Records who shares the session's controlling terminal, as pid -> start time.
//
// A pid on its own is not an identity: between this snapshot and the kill the
// process can exit and the number be reused, and killing a recycled pid is the
// recycled-pgid mistake scripts/disable.sh already had to fix, in a new costume.
// The start time is what makes the later kill provably aimed at the same process.
//
// Only ever called while the HELPER still owns the master fd, because once that
// is gone /dev/ttysNNN can belong to somebody else's session entirely.
function snapshotPtyTtyProcesses(session) {
  if (typeof session.pts !== "string" || !PTS_PATTERN.test(session.pts)) return;
  if (!Number.isInteger(session.helperPid) || processGone(session.helperPid)) return;
  if (!session.ttyTargets) session.ttyTargets = new Map();
  for (const [pid, lstart] of psRows(["-t", session.pts, "-o", "pid=,lstart="])) {
    if (pid === process.pid || pid === process.ppid) continue;
    if (pid === session.leaderPid || pid === session.helperPid) continue;
    if (session.ttyTargets.size >= PTY_TTY_SCAN_MAX) break;
    if (!session.ttyTargets.has(pid)) session.ttyTargets.set(pid, lstart);
  }
}

// SIGKILLs everything recorded by snapshotPtyTtyProcesses whose start time still
// matches. A pid whose start time has changed is somebody else now, and is left
// alone and reported rather than killed.
function killPtyTtyStragglers(session, result) {
  const targets = session.ttyTargets;
  result.ttyProcessesKilled = [];
  result.ttyRecycledSkipped = [];
  if (!targets || targets.size === 0) return;
  const alive = [...targets.keys()].filter((pid) => !processGone(pid));
  if (alive.length === 0) return;
  const current = psRows(["-o", "pid=,lstart=", "-p", alive.join(",")]);
  for (const pid of alive) {
    const now = current.get(pid);
    if (now === undefined) continue;
    if (now !== targets.get(pid)) {
      // Recorded so the containment check does not count somebody else's process
      // as one of ours that survived.
      if (!session.ttyRecycled) session.ttyRecycled = new Set();
      session.ttyRecycled.add(pid);
      result.ttyRecycledSkipped.push(pid);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      result.ttyProcessesKilled.push(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") result.ttyKillErrors = (result.ttyKillErrors || []).concat(`${pid}:${error?.code || error}`);
    }
  }
}

// The membership record has to be kept fresh WHILE the session lives, because
// after it dies there is nothing left to scan.
//
// Measured on this machine: the instant the session leader exits, Darwin
// revoke()s the controlling terminal. `ps -t /dev/ttys001` then fails with "No
// such file or directory" and the surviving background job's tty reads as "??" —
// and that is true even at the helper's own "exited" event, with the helper
// still holding the master fd. So the last possible moment to learn that
// `nohup sleep &` exists is before the shell exits, not after.
//
// Throttled to one scan per session per interval, because pty_read/pty_write are
// the hot path and each scan is a ps fork (1.1ms measured). It arms the same
// budget every other caller uses, so a wedged ps costs the same bounded
// PTY_TTY_SCAN_TIMEOUT_MS here as it does on a reclaim path.
// 150ms, not 1000ms, and a pty_write scans unconditionally.
//
// At 1000ms the terminal-sweep fix did not fix the case its own comment cites:
// `nohup sleep 995 & ; disown ; exit` creates the job and ends the session inside one
// throttle window, so nothing is ever recorded and the job survives every reclaim path
// — including disable.sh, because the job metadata names the already-dead leader.
// Measured across the gap between backgrounding and exit: 0ms SURVIVED, 300ms SURVIVED,
// 1100ms REAPED. Two consecutive tool calls do not clear a 1s bar.
//
// The headroom is real: 400 back-to-back pty_read calls cost 76ms total, p50 0.09ms, so
// the scan was never the expensive part. A write is also the only thing that CREATES
// processes, so deferring the scan after one to a later, throttled call was backwards.
const PTY_TTY_REFRESH_MS = 150;

function refreshPtyTtyTargets(session, { force = false } = {}) {
  if (session.exited || session.closed) return;
  if (!Number.isInteger(session.helperPid) || processGone(session.helperPid)) return;
  const now = Date.now();
  // force is used after a pty_write, which is the only operation that can create a new
  // terminal member. Letting the throttle skip that scan is precisely how a job
  // backgrounded and abandoned in the same breath went unrecorded.
  if (!force && now - (session.ttyScanAt || 0) < PTY_TTY_REFRESH_MS) return;
  session.ttyScanAt = now;
  // Dead entries are dropped first. The record is capped at PTY_TTY_SCAN_MAX and
  // an interactive session churns pids — every command run at the prompt is one
  // more — so without pruning the cap would fill with corpses and the single pid
  // that matters, the background job started an hour in, would never be recorded.
  // Pruning only ever removes pids that are already gone, so it cannot lose a
  // target; it is also what keeps a recycled pid from lingering in the record.
  if (session.ttyTargets) {
    for (const pid of [...session.ttyTargets.keys()]) {
      if (processGone(pid)) session.ttyTargets.delete(pid);
    }
  }
  beginPtyTtyScanBudget();
  snapshotPtyTtyProcesses(session);
}

// A session that ends NATURALLY used to get only reclaimLeaderGroup() +
// markPtyExited(), and killPtyTtyStragglers ran solely from killPtySession.
// Measured: `nohup sleep 995 & ; disown ; exit` left the sleep running, and a
// later killPtySessions("revoked") could not even see it — the helper is gone by
// then, so snapshotPtyTtyProcesses returns early, and the group kill is aimed at
// a leader that is already dead. The job metadata scripts/disable.sh reads names
// that same dead leader, so the reclaimer skipped it too: an unrestricted process
// with no reclaim path anywhere, exactly the hole the pty sweep exists to close.
//
// Safe to run after the helper is gone: this kills by pid from the record taken
// while the helper still owned the device, and re-verifies each pid's start time
// with `ps -p` first, which keeps working after the terminal is revoked.
function sweepPtyTtyOnClose(session) {
  if (!session.ttyTargets || session.ttyTargets.size === 0) return;
  beginPtyTtyScanBudget();
  const result = { sessionId: session.id, reason: session.closeReason || "session_ended" };
  killPtyTtyStragglers(session, result);
  session.closeSweep = result;
  const killed = result.ttyProcessesKilled || [];
  const skipped = result.ttyRecycledSkipped || [];
  // Reported, not silent. leaderGroupError and ttyKillErrors are surfaced
  // precisely because unreported reclaim failures are this project's history, and
  // this path has no tool response to carry them.
  if (killed.length || skipped.length || result.ttyKillErrors) {
    stderr(`pty session ${session.id} ended; ${killed.length} process(es) still holding its terminal were reclaimed${killed.length ? ` (${killed.join(", ")})` : ""}${skipped.length ? `; ${skipped.length} recycled pid(s) deliberately not signalled (${skipped.join(", ")})` : ""}${result.ttyKillErrors ? `; kill errors ${result.ttyKillErrors.join(", ")}` : ""}.`);
  }
}

// ---------------------------------------------------------------------------
// Child MCP server federation
// ---------------------------------------------------------------------------

// The supervisor lives entirely in lib/federation.mjs and imports nothing from
// this file, so it can be tested against a stub child without starting a bridge.
// Everything it needs from here arrives as a callback — including
// writeJobMetadata, so a federated child lands in the same $DATA_DIR/jobs
// directory scripts/disable.sh already scans, with no change to its discovery
// loop.
const PERSONAL_BROWSER_APPROVAL_FILE = process.env.MAC_DEV_BRIDGE_PERSONAL_APPROVAL_FILE
  || path.join(APP_SUPPORT_DIR, "PERSONAL_BROWSER_APPROVED");

const federation = createFederation({
  audit,
  stderr,
  dataDir: APP_SUPPORT_DIR,
  jobDir: JOB_DIR,
  nowIso,
  writeJobMetadata,
  version: BRIDGE_VERSION,
  approvalFile: PERSONAL_BROWSER_APPROVAL_FILE,
  // Collisions with a built-in tool are rejected at startup rather than
  // shadowing one silently at call time.
  reservedToolNames: TOOLS.map((tool) => tool.name),
});

// Reported, never acted on: personal mode is gated by consuming the grant inside
// lib/federation.mjs. This exists so an operator can see from bridge_status that
// an unconsumed grant is sitting on disk.
async function personalBrowserApprovalPresent() {
  try {
    await fsp.stat(PERSONAL_BROWSER_APPROVAL_FILE);
    return { present: true, path: PERSONAL_BROWSER_APPROVAL_FILE };
  } catch (error) {
    return { present: false, path: PERSONAL_BROWSER_APPROVAL_FILE, reason: error?.code || String(error) };
  }
}

const BACKGROUND_CHROME_PROVIDER_KEY = "chrome-background";
const BACKGROUND_CHROME_GRANT_DIR = process.env.MAC_DEV_BRIDGE_BACKGROUND_CHROME_GRANT_DIR
  || path.join(APP_SUPPORT_DIR, "chrome-background-grants");
const BACKGROUND_CHROME_MAX_TTL_MS = 15 * 60 * 1000;
const BACKGROUND_CHROME_MAX_GRANT_FILES = 256;

function backgroundChromeApprovalError(reason) {
  const error = new Error(`Background Chrome is not approved for this website: ${reason}. Run scripts/approve-personal-browser.sh --provider chrome-background with the required URL patterns. Approvals are shared across all ChatGPT sessions on this bridge until their individual expiry times.`);
  error.code = "PERSONAL_MODE_NOT_APPROVED";
  return error;
}

function parseBackgroundChromeGrant(raw, sourcePath = null) {
  let grant;
  try {
    grant = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw backgroundChromeApprovalError(`grant ${sourcePath || "<memory>"} is not valid JSON`);
  }
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    throw backgroundChromeApprovalError(`grant ${sourcePath || "<memory>"} is not a JSON object`);
  }
  if (grant.provider !== BACKGROUND_CHROME_PROVIDER_KEY) {
    throw backgroundChromeApprovalError(`grant ${sourcePath || "<memory>"} names provider '${grant.provider}', not '${BACKGROUND_CHROME_PROVIDER_KEY}'`);
  }
  if (typeof grant.nonce !== "string" || !/^[0-9a-f]{32}$/i.test(grant.nonce)) {
    throw backgroundChromeApprovalError(`grant ${sourcePath || "<memory>"} has an invalid nonce`);
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw backgroundChromeApprovalError(`grant ${sourcePath || "<memory>"} has an invalid expiresAt timestamp`);
  }
  const patterns = grant.allowedUrlPatterns;
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((pattern) => typeof pattern !== "string" || pattern.length === 0)) {
    throw backgroundChromeApprovalError(`grant ${sourcePath || "<memory>"} must contain non-empty allowedUrlPatterns`);
  }
  return {
    nonce: grant.nonce,
    expiresAt,
    allowedUrlPatterns: [...new Set(patterns)],
    sourcePath,
  };
}

async function ensureBackgroundChromeGrantDir() {
  await fsp.mkdir(BACKGROUND_CHROME_GRANT_DIR, { recursive: true, mode: 0o700 });
  await fsp.chmod(BACKGROUND_CHROME_GRANT_DIR, 0o700).catch(() => {});
}

async function persistBackgroundChromeGrant(grant) {
  await ensureBackgroundChromeGrantDir();
  const target = path.join(BACKGROUND_CHROME_GRANT_DIR, `${grant.nonce}.json`);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const body = `${JSON.stringify({
    nonce: grant.nonce,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    provider: BACKGROUND_CHROME_PROVIDER_KEY,
    allowedUrlPatterns: grant.allowedUrlPatterns,
  }, null, 2)}
`;
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.chmod(tmp, 0o600).catch(() => {});
  await fsp.rename(tmp, target);
  return target;
}

async function importLegacyBackgroundChromeApproval() {
  let raw;
  try {
    raw = await fsp.readFile(PERSONAL_BROWSER_APPROVAL_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  // The fixed legacy file is shared with federated personal-browser providers.
  // Only consume it here when it explicitly names chrome-background; otherwise
  // leave it untouched for the federation gateway.
  let preview;
  try {
    preview = JSON.parse(raw);
  } catch {
    return null;
  }
  if (preview?.provider !== BACKGROUND_CHROME_PROVIDER_KEY) return null;

  const consumed = await consumePersonalApproval(PERSONAL_BROWSER_APPROVAL_FILE, BACKGROUND_CHROME_PROVIDER_KEY);
  const grant = parseBackgroundChromeGrant({
    nonce: consumed.nonce,
    expiresAt: new Date(consumed.expiresAt).toISOString(),
    provider: BACKGROUND_CHROME_PROVIDER_KEY,
    allowedUrlPatterns: consumed.allowedUrlPatterns,
  }, PERSONAL_BROWSER_APPROVAL_FILE);
  await persistBackgroundChromeGrant(grant);
  return grant;
}

async function loadBackgroundChromeGrantPool({ importLegacy = true } = {}) {
  await ensureBackgroundChromeGrantDir();
  // Backward compatibility matters for other conversations that may have already
  // printed the old fixed-file command. Import a fresh legacy grant on EVERY call,
  // even when other grants are active, so a second chat can extend the shared scope.
  if (importLegacy) await importLegacyBackgroundChromeApproval();

  const names = (await fsp.readdir(BACKGROUND_CHROME_GRANT_DIR))
    .filter((name) => /^[0-9a-f]{32}\.json$/i.test(name))
    .sort()
    .slice(0, BACKGROUND_CHROME_MAX_GRANT_FILES);
  const now = Date.now();
  const grants = [];
  const invalid = [];
  for (const name of names) {
    const filePath = path.join(BACKGROUND_CHROME_GRANT_DIR, name);
    let raw;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      invalid.push({ file: name, reason: error?.code || String(error) });
      continue;
    }
    let grant;
    try {
      grant = parseBackgroundChromeGrant(raw, filePath);
    } catch (error) {
      invalid.push({ file: name, reason: error.message });
      continue;
    }
    if (grant.expiresAt <= now) {
      await fsp.unlink(filePath).catch(() => {});
      continue;
    }
    // An operator approval can never create more than 15 minutes of authority.
    // A persisted grant naturally has LESS remaining time after a restart.
    if (grant.expiresAt - now > BACKGROUND_CHROME_MAX_TTL_MS) {
      invalid.push({ file: name, reason: "remaining TTL exceeds 15-minute ceiling" });
      continue;
    }
    grants.push(grant);
  }

  const allowedUrlPatterns = [...new Set(grants.flatMap((grant) => grant.allowedUrlPatterns))];
  const expiries = grants.map((grant) => grant.expiresAt).sort((a, b) => a - b);
  return {
    grants,
    invalid,
    allowedUrlPatterns,
    nextExpiryAt: expiries[0] ?? null,
    lastExpiryAt: expiries.at(-1) ?? null,
  };
}

async function backgroundChromeGrantStatus() {
  const settings = await readOperatorSettings();
  if (!settings.strictApprovals) {
    return {
      active: true,
      required: false,
      accessMode: "relaxed",
      strictApprovals: false,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
      sharedAcrossSessions: true,
      persistentUntilExpiry: false,
      grantDirectory: BACKGROUND_CHROME_GRANT_DIR,
      grantCount: 0,
      grants: [],
      allowedUrlPatterns: RELAXED_BROWSER_PATTERNS.slice(),
      nextExpiryAt: null,
      lastExpiryAt: null,
      invalidGrantFiles: [],
    };
  }
  try {
    const pool = await loadBackgroundChromeGrantPool({ importLegacy: false });
    return {
      active: pool.grants.length > 0,
      required: true,
      accessMode: "strict",
      strictApprovals: true,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
      sharedAcrossSessions: true,
      persistentUntilExpiry: true,
      grantDirectory: BACKGROUND_CHROME_GRANT_DIR,
      grantCount: pool.grants.length,
      grants: pool.grants.map((grant) => ({
        nonce: grant.nonce,
        expiresAt: new Date(grant.expiresAt).toISOString(),
        allowedUrlPatterns: grant.allowedUrlPatterns.slice(),
      })),
      allowedUrlPatterns: pool.allowedUrlPatterns,
      nextExpiryAt: pool.nextExpiryAt ? new Date(pool.nextExpiryAt).toISOString() : null,
      lastExpiryAt: pool.lastExpiryAt ? new Date(pool.lastExpiryAt).toISOString() : null,
      invalidGrantFiles: pool.invalid,
    };
  } catch (error) {
    return {
      active: false,
      required: true,
      accessMode: "strict",
      strictApprovals: true,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
      sharedAcrossSessions: true,
      persistentUntilExpiry: true,
      grantDirectory: BACKGROUND_CHROME_GRANT_DIR,
      error: { code: error?.code || "BACKGROUND_CHROME_GRANT_ERROR", message: error?.message || String(error) },
    };
  }
}

async function ensureBackgroundChromeGrant() {
  // Profile binding is always enforced, regardless of approval strictness.
  const connection = await backgroundChromeStatus({ dataDir: APP_SUPPORT_DIR, timeoutMs: 1_000 });
  if (!connection?.extensionReady) {
    const error = new Error(connection?.profileError?.message || connection?.error?.message || "The background Chrome extension is not connected. Run scripts/install-background-chrome.sh and load chrome-extension/ once in Chrome.");
    error.code = connection?.profileError?.code || connection?.error?.code || "CHROME_EXTENSION_OFFLINE";
    throw error;
  }

  const settings = await readOperatorSettings();
  if (!settings.strictApprovals) {
    return {
      accessMode: "relaxed",
      strictApprovals: false,
      grants: [],
      invalid: [],
      allowedUrlPatterns: RELAXED_BROWSER_PATTERNS.slice(),
      nextExpiryAt: null,
      lastExpiryAt: null,
    };
  }

  const pool = await loadBackgroundChromeGrantPool();
  if (pool.grants.length === 0 || pool.allowedUrlPatterns.length === 0) {
    throw backgroundChromeApprovalError("strict approvals are enabled and no unexpired shared chrome-background grant is active");
  }
  return { ...pool, accessMode: "strict", strictApprovals: true };
}

async function callBackgroundChrome(toolName, method, args) {
  let pool;
  try {
    pool = await ensureBackgroundChromeGrant();
    const result = await backgroundChromeCall(method, args, pool.allowedUrlPatterns, { dataDir: APP_SUPPORT_DIR });
    const nonces = pool.grants.map((grant) => grant.nonce);
    await audit(toolName, args, {
      ok: true,
      backgroundChrome: true,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
      accessMode: pool.accessMode,
      strictApprovals: pool.strictApprovals,
      grantNonces: nonces,
      grantCount: nonces.length,
      nextGrantExpiryAt: pool.nextExpiryAt ? new Date(pool.nextExpiryAt).toISOString() : null,
      lastGrantExpiryAt: pool.lastExpiryAt ? new Date(pool.lastExpiryAt).toISOString() : null,
    });
    return {
      ...result,
      _background: {
        focusPolicy: "background-only",
        provider: BACKGROUND_CHROME_PROVIDER_KEY,
        accessMode: pool.accessMode,
        strictApprovals: pool.strictApprovals,
        sharedAcrossSessions: true,
        grantCount: nonces.length,
        nextGrantExpiryAt: pool.nextExpiryAt ? new Date(pool.nextExpiryAt).toISOString() : null,
        lastGrantExpiryAt: pool.lastExpiryAt ? new Date(pool.lastExpiryAt).toISOString() : null,
        allowedUrlPatterns: pool.allowedUrlPatterns.slice(),
      },
    };
  } catch (error) {
    await audit(toolName, args, {
      backgroundChrome: true,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
      ...(pool ? { grantNonces: pool.grants.map((grant) => grant.nonce) } : {}),
    }, error);
    throw error;
  }
}

async function callBackgroundChromeLocal(toolName, method, args = {}) {
  try {
    const connection = await backgroundChromeStatus({ dataDir: APP_SUPPORT_DIR, timeoutMs: 1_000 });
    if (!connection?.extensionReady) {
      const error = new Error(connection?.profileError?.message || connection?.error?.message || "The background Chrome extension is not connected.");
      error.code = connection?.profileError?.code || connection?.error?.code || "CHROME_EXTENSION_OFFLINE";
      throw error;
    }
    const result = await backgroundChromeCall(method, args, [], { dataDir: APP_SUPPORT_DIR });
    await audit(toolName, args, {
      ok: true,
      backgroundChrome: true,
      localWorkspaceOnly: true,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
    });
    return {
      ...result,
      _background: {
        focusPolicy: "background-only",
        provider: BACKGROUND_CHROME_PROVIDER_KEY,
        localWorkspaceOnly: true,
      },
    };
  } catch (error) {
    await audit(toolName, args, {
      backgroundChrome: true,
      localWorkspaceOnly: true,
      provider: BACKGROUND_CHROME_PROVIDER_KEY,
    }, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Interactive pty sessions
// ---------------------------------------------------------------------------

// leaderPid is stored separately from the child handle on purpose: the handle can
// be gone (helper exited) while the process group it started is very much not.
const ptySessions = new Map();
let ptyAvailable = false;
let ptySweeper = null;
let unlockRecheck = null;
let unlockRecheckInFlight = false;

// UTF-8 continuation bytes are 10xxxxxx. Reads are byte-ranged, so without these
// two the boundary between consecutive reads manufactures U+FFFD: measured, 48 of
// 54 arbitrary slices of mixed-width text were corrupted.
function alignUtf8Start(buf, index) {
  let i = index;
  let skipped = 0;
  while (i < buf.length && (buf[i] & 0xc0) === 0x80 && skipped < 4) {
    i += 1;
    skipped += 1;
  }
  return i;
}

// Trims an incomplete trailing sequence from an exclusive end index, so a
// codepoint split across two reads is emitted whole by the second one.
function alignUtf8End(buf, end) {
  let j = end - 1;
  let continuations = 0;
  while (j >= 0 && (buf[j] & 0xc0) === 0x80 && continuations < 3) {
    j -= 1;
    continuations += 1;
  }
  if (j < 0) return end;
  const lead = buf[j];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need === 1) return end;
  return continuations + 1 >= need ? end : j;
}

// OSC (terminated by BEL or ST), two-character escapes, then CSI. A realistic
// coloured build was 47.7% escape bytes, so a model reading raw output spends
// half its context on colour codes.
const ANSI_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

// ANSI_ESCAPES only matches a WHOLE sequence. A read boundary that falls inside
// one therefore defeats stripping in both directions: the first slice ends with a
// bare ESC (no following byte to match) and the second begins with "[0m" (no ESC),
// so both halves survive and reappear when the client concatenates. Measured: 300
// coloured lines read whole contained no ESC; the same transcript paged at 1024
// bytes did. An unterminated escape gets the same holdback a partial codepoint
// already gets.
//
// Bounded scan-back so a program emitting an endless CSI parameter run cannot make
// every read shrink to nothing; past the bound the slice is emitted as-is and the
// progress guarantee in ptySliceForCursor still applies.
const ANSI_MAX_HOLDBACK = 4096;

// True when a complete escape sequence starting at `k` ends before `end`.
function ansiSequenceComplete(buf, k, end) {
  if (k + 1 >= end) return false;
  const introducer = buf[k + 1];
  if (introducer === 0x5d) {
    // OSC: ESC ] ... terminated by BEL or ST (ESC \).
    for (let i = k + 2; i < end; i += 1) {
      if (buf[i] === 0x07) return true;
      if (buf[i] === 0x1b) return i + 1 < end && buf[i + 1] === 0x5c;
    }
    return false;
  }
  if (introducer === 0x5b) {
    // CSI: ESC [ parameters intermediates final.
    let i = k + 2;
    while (i < end && ((buf[i] >= 0x30 && buf[i] <= 0x39) || buf[i] === 0x3b || buf[i] === 0x3f)) i += 1;
    while (i < end && buf[i] >= 0x20 && buf[i] <= 0x2f) i += 1;
    return i < end && buf[i] >= 0x40 && buf[i] <= 0x7e;
  }
  // Either a complete two-character escape or not an escape at all. Neither can be
  // completed by the next read, so holding it back would stall rather than help.
  return true;
}

function trimPartialAnsi(buf, start, end) {
  const floor = Math.max(start, end - ANSI_MAX_HOLDBACK);
  for (let k = end - 1; k >= floor; k -= 1) {
    if (buf[k] !== 0x1b) continue;
    return ansiSequenceComplete(buf, k, end) ? end : k;
  }
  return end;
}

// Splits a payload the way the canonical line discipline sees it: runs of bytes
// between \r or \n. `first` is the run that continues whatever line is already in
// the discipline's buffer, `trailing` is what is left unterminated for the next
// write to continue.
function canonicalRuns(payload) {
  let first = -1;
  let longest = 0;
  let current = 0;
  let hasTerminator = false;
  for (let i = 0; i < payload.length; i += 1) {
    const byte = payload[i];
    if (byte === 0x0a || byte === 0x0d) {
      if (first < 0) first = current;
      hasTerminator = true;
      if (current > longest) longest = current;
      current = 0;
    } else {
      current += 1;
    }
  }
  if (current > longest) longest = current;
  if (first < 0) first = current;
  return { first, longest, trailing: current, hasTerminator };
}

function renderPtyText(bytes, { stripAnsi, collapseCarriageReturns }) {
  let text = bytes.toString("utf8");
  if (stripAnsi) text = text.replace(ANSI_ESCAPES, "");
  if (collapseCarriageReturns) {
    // CRLF folding belongs to this flag, not above it. A tty in ONLCR turns every
    // \n into \r\n, so folding unconditionally would mean collapse_carriage_returns
    // false is not actually raw — and the difference between a real pty and a pipe
    // would be unobservable through this tool.
    //
    // \r+ and not \r: a program that already emits CRLF arrives at the master as
    // \r\r\n, because ONLCR expands the \n it wrote. Folding exactly one CR left a
    // trailing CR on the line, and the redraw collapse below then kept only what
    // followed the last CR — which was nothing. Measured: printf 'alpha\r\nbeta\r\n'
    // rendered as two empty lines. Everything that prints CRLF on a terminal (ssh,
    // git, node's readline, every TUI) hit this.
    text = text.replace(/\r+\n/g, "\n");
    // A CR-redrawn progress line is ~30 overlapping copies of itself otherwise.
    text = text
      .split("\n")
      .map((line) => {
        const last = line.lastIndexOf("\r");
        return last === -1 ? line : line.slice(last + 1);
      })
      .join("\n");
  }
  return text;
}

// Fixed-capacity ring addressed by an ABSOLUTE byte offset.
//
// Two properties matter more than they look. It is allocated once at capacity,
// because appending to a chunk list from a pty is a remote-driven memory leak
// (`yes` in a session out-produces any reader) — the same class already fixed for
// HTTP request bodies. And reads are pure functions of an offset rather than a
// drain: this endpoint is public and retried, and a drain-on-read buffer destroys
// output on the first duplicated poll.
function createPtyRing(capacity) {
  const buf = Buffer.allocUnsafe(capacity);
  let writePos = 0;
  let total = 0;
  return {
    append(chunk) {
      total += chunk.length;
      // A single chunk larger than the ring keeps its NEWEST bytes. boundedCollector
      // drops the newest instead, which is right for one-shot capture and wrong for
      // a terminal, where the last screen is the one being looked at.
      const data = chunk.length > capacity ? chunk.subarray(chunk.length - capacity) : chunk;
      const firstLen = Math.min(data.length, capacity - writePos);
      data.copy(buf, writePos, 0, firstLen);
      if (firstLen < data.length) data.copy(buf, 0, firstLen);
      writePos = (writePos + data.length) % capacity;
    },
    get total() {
      return total;
    },
    get retained() {
      return Math.min(total, capacity);
    },
    get base() {
      return total - Math.min(total, capacity);
    },
    copy(fromAbsolute, length) {
      const out = Buffer.allocUnsafe(length);
      if (length === 0) return out;
      const retained = Math.min(total, capacity);
      const rel = fromAbsolute - (total - retained);
      const start = (writePos - retained + rel + capacity * 2) % capacity;
      const firstLen = Math.min(length, capacity - start);
      buf.copy(out, 0, start, start + firstLen);
      if (firstLen < length) buf.copy(out, firstLen, 0, length - firstLen);
      return out;
    },
  };
}

function ptySliceForCursor(session, cursor, maxBytes) {
  const ring = session.ring;
  const total = ring.total;
  const base = ring.base;
  const startAbsolute = Math.min(Math.max(cursor, base), total);
  const lostBytes = Math.max(0, base - cursor);
  const want = Math.min(maxBytes, total - startAbsolute);
  const raw = ring.copy(startAbsolute, want);
  // A cursor that fell behind the ring lands at an arbitrary byte, which is the
  // one case where the START of a slice can be mid-codepoint.
  let start = lostBytes > 0 ? alignUtf8Start(raw, 0) : 0;
  let end = raw.length;
  const moreFollows = startAbsolute + want < total;
  if (moreFollows || !session.exited) {
    end = alignUtf8End(raw, end);
    // An escape sequence split by the boundary is held back whole, for the same
    // reason and by the same rule as a partial codepoint.
    end = trimPartialAnsi(raw, start, end);
    // A lone trailing CR is held back for the same reason as a partial codepoint:
    // a read boundary between CR and LF otherwise emits a bare CR that no longer
    // collapses against its line.
    if (end > start && raw[end - 1] === 0x0d) end -= 1;
  }
  // Progress guarantee. Reachable only if max_bytes were smaller than one
  // codepoint, which the schema's 1024 minimum forbids; a silent stall would be
  // indistinguishable from a hung program, so refuse to create one.
  if (end <= start && want > 0 && moreFollows) end = raw.length;
  if (end < start) end = start;
  return {
    bytes: raw.subarray(start, end),
    nextCursor: startAbsolute + end,
    lostBytes,
    truncated: startAbsolute + end < total,
    totalBytes: total,
    retainedBytes: ring.retained,
  };
}

// fd 2 carries one JSON status line per event. Bounded, because an unterminated
// line from a helper must not grow this process without limit.
function attachHelperEvents(child, onEvent) {
  let pending = "";
  child.stderr.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 65_536) {
      stderr("pty helper status line exceeded 64 KiB; discarding it.");
      pending = "";
      return;
    }
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        stderr(`pty helper emitted a non-JSON status line: ${line.slice(0, 200)}`);
        continue;
      }
      onEvent(event);
    }
  });
}

function spawnPtyHelper({ command, args, cwd, env, cols, rows }) {
  // detached: false is deliberate, and the opposite of shell_start. Reproducing
  // shell_start's detached + unref'd pattern left the helper reparented to PID 1,
  // still executing, with its pipes broken and no way for the bridge to reach it:
  // an orphaned unrestricted shell outliving revocation. Staying attached is also
  // what makes stdin EOF a reliable "my bridge is gone" signal for the helper.
  return spawn(PTY_HELPER_PERL, [PTY_HELPER_PL, String(cols), String(rows), "--", command, ...args], {
    cwd,
    env,
    detached: false,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
}

// The pty_* tools are advertised only if a real pty can be allocated, resized, and
// read back on this machine. The ioctl request numbers in ptyhelper.pl are
// hardcoded Darwin constants and /usr/bin/perl could be removed by a future macOS,
// so the failure mode has to be a loud absence rather than six tools that fail at
// call time — or worse, a pty_resize that returns the numbers it was handed.
async function probePtySupport() {
  try {
    await fsp.access(PTY_HELPER_PERL, fs.constants.X_OK);
    await fsp.access(PTY_HELPER_PL, fs.constants.R_OK);
  } catch (error) {
    stderr(`pty helper unavailable (${error?.code || error}); pty_* tools will not be advertised.`);
    return false;
  }
  return await new Promise((resolve) => {
    let settled = false;
    let leaderPid = null;
    let child;
    let timer = null;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killProcessGroup(leaderPid, "SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {}
      if (!ok) stderr(`pty support self-test failed (${why}); pty_* tools will not be advertised.`);
      resolve(ok);
    };
    try {
      child = spawnPtyHelper({
        command: "/bin/cat",
        args: [],
        cwd: HOME,
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME, TERM: "dumb" },
        cols: 120,
        rows: 40,
      });
    } catch (error) {
      stderr(`pty support self-test could not spawn the helper (${error?.message || error}).`);
      resolve(false);
      return;
    }
    child.once("error", (error) => finish(false, error?.message || error));
    child.stdin.on("error", () => {});
    child.stdio[3].on("error", () => {});
    // Drained and discarded: an unread stdout pipe fills, which would block the
    // helper in syswrite and make the self-test time out for the wrong reason.
    child.stdout.resume();
    attachHelperEvents(child, (event) => {
      if (event.event === "started") {
        leaderPid = event.pid;
        // Deliberately a different geometry from the one it started with: if
        // TIOCSWINSZ were a no-op, the read-back would still report 120x40.
        child.stdio[3].write(`${JSON.stringify({ op: "resize", cols: 133, rows: 41 })}\n`);
      } else if (event.event === "fatal") {
        finish(false, event.error);
      } else if (event.event === "resize") {
        const ok = (event.ok === 1 || event.ok === true) && event.cols === 133 && event.rows === 41;
        finish(ok, `winsize read-back was ${event.cols}x${event.rows}`);
      } else if (event.event === "exited") {
        finish(false, "self-test child exited before the resize was confirmed");
      }
    });
    child.once("close", () => finish(false, "helper exited before confirming a resize"));
    timer = setTimeout(() => finish(false, `no confirmation within ${PTY_START_TIMEOUT_MS}ms`), PTY_START_TIMEOUT_MS);
    timer.unref();
  });
}

let ptyProbe = probePtySupport().then((ok) => {
  ptyAvailable = ok;
  return ok;
});

// Started eagerly, here, rather than on first use. tools/list is answered with
// ttlMs 300_000 and capabilities.tools.listChanged is false, and mcp-http.mjs
// drops id-less messages so notifications/tools/list_changed never reaches the
// client — a provider that finishes starting after the first tools/list would be
// invisible for five minutes with no way to correct it.
const federationReady = federation.start().then(() => {
  // Arms the idle unlock recheck for federated children, which unlike pty
  // sessions exist from boot and never call syncPtyTimers themselves.
  syncPtyTimers();
});

// Tools are filtered rather than removed from the static array so tools/list and
// the tools/call membership gate cannot disagree. The gate rejects anything absent
// from the advertised set with -32601, so a dispatchTool case reached through only
// one of the two would be unreachable in one direction and unguarded in the other.
function advertisedTools() {
  let base = ptyAvailable ? TOOLS : TOOLS.filter((tool) => !tool.name.startsWith("pty_"));
  if (process.platform !== "darwin") base = base.filter((tool) => !tool.name.startsWith("chrome_"));
  const federated = federation.listTools();
  return federated.length === 0 ? base : base.concat(federated);
}

function livePtySessions() {
  return [...ptySessions.values()].filter((session) => !session.exited);
}

function ptyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getPtySession(sessionId) {
  const session = ptySessions.get(sessionId);
  if (!session) {
    // The hint matters: without it a model whose session id is stale polls a dead
    // id forever instead of starting a new session.
    throw ptyError("PTY_NO_SESSION", `Unknown pty session '${sessionId}' (bridge restarted; pty sessions do not persist, and closed sessions are eventually evicted). Start a new one with pty_start.`);
  }
  return session;
}

// Same character class readJobMetadata enforces, because the id becomes a filename
// in the jobs directory.
function requirePtySessionId(args) {
  const sessionId = requireString(args, "session_id");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) throw new Error("Invalid session_id");
  return sessionId;
}

// Long-poll for new output. Opt-in (wait_ms defaults to 0) and always resolved by
// a timer as well as by data, so a session that never speaks again cannot hold a
// request open.
function waitForPtyOutput(session, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = session.outputWaiters.indexOf(done);
      if (index >= 0) session.outputWaiters.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    timer.unref();
    session.outputWaiters.push(done);
  });
}

// A SIGKILLed session leader stays visible to kill(2) as a zombie until whoever
// inherits it reaps it, so a single immediate check reports "not contained" for a
// group that is already dead. Bounded retry, and an honest false if it never goes.
// It also covers the processes that were sharing the session's controlling
// terminal. `leaderGroupGone` alone is what previously reported
// containmentVerified:true over a still-running background job.
async function verifyPtyContainment(session, timeoutMs) {
  const leaderPid = session.leaderPid;
  const recycled = session.ttyRecycled || new Set();
  const targets = session.ttyTargets ? [...session.ttyTargets.keys()].filter((pid) => !recycled.has(pid)) : [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const leaderGroupGone = processGroupGone(leaderPid);
    const survivors = targets.filter((pid) => !processGone(pid));
    if (leaderGroupGone && survivors.length === 0) {
      return { contained: true, leaderGroupGone, survivors: [] };
    }
    if (Date.now() >= deadline) return { contained: false, leaderGroupGone, survivors };
    await new Promise((r) => setTimeout(r, 25));
  }
}

function ptySessionSummary(session) {
  return {
    id: session.id,
    command: session.command,
    args: session.args,
    leaderPid: session.leaderPid,
    pts: session.pts,
    cols: session.cols,
    rows: session.rows,
    totalBytes: session.ring.total,
    idleTimeoutMs: session.idleTimeoutMs,
    idleMs: Date.now() - session.lastActivityAt,
    exited: session.exited,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    closeReason: session.closeReason,
  };
}

function writePtyControl(session, op) {
  const control = session.child.stdio[3];
  if (!control || control.destroyed) throw ptyError("PTY_EXITED", `pty session '${session.id}' is no longer accepting control operations`);
  control.write(`${JSON.stringify(op)}\n`);
}

// Waits for one helper acknowledgement. Every timer here is per-call, cleared on
// settle, and unref'd, so a pending resize can never keep the process alive after
// its transport closed.
//
// `id` is the correlation. Matching on kind alone meant four concurrent
// pty_resize calls each resolved on whichever ack arrived first, so all four
// reported their own geometry as confirmed while the kernel held only one of
// them; the same FIFO-by-kind matching let a concurrent pty_signal and the TERM
// inside pty_close consume each other's answer.
function awaitPtyAck(session, kind, timeoutMs, id = null) {
  return new Promise((resolve, reject) => {
    const waiter = { kind, id, resolve: null, reject: null, timer: null };
    waiter.resolve = (event) => {
      clearTimeout(waiter.timer);
      remove();
      resolve(event);
    };
    waiter.reject = (error) => {
      clearTimeout(waiter.timer);
      remove();
      reject(error);
    };
    const remove = () => {
      const index = session.ackWaiters.indexOf(waiter);
      if (index >= 0) session.ackWaiters.splice(index, 1);
    };
    waiter.timer = setTimeout(() => {
      waiter.reject(ptyError(
        kind === "resize" ? "PTY_RESIZE_UNCONFIRMED" : "PTY_SIGNAL_UNCONFIRMED",
        `pty helper did not acknowledge the ${kind} within ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    waiter.timer.unref();
    session.ackWaiters.push(waiter);
  });
}

function settlePtyAck(session, kind, event) {
  const eventId = Number.isInteger(event?.id) && event.id > 0 ? event.id : null;
  // Exact match first. The FIFO fallback covers only an ack that carries no id at
  // all, which a helper predating the correlation would produce; a request that
  // HAS an id is never settled by someone else's answer.
  let index = eventId === null
    ? -1
    : session.ackWaiters.findIndex((waiter) => waiter.kind === kind && waiter.id === eventId);
  if (index < 0 && eventId === null) {
    index = session.ackWaiters.findIndex((waiter) => waiter.kind === kind && waiter.id === null);
  }
  if (index < 0) return;
  session.ackWaiters[index].resolve(event);
}

// Allocates the correlation id, arms the waiter, then writes — in that order, so
// an ack cannot arrive before anyone is listening for it.
function sendPtyControl(session, kind, op, timeoutMs) {
  session.nextControlId += 1;
  const id = session.nextControlId;
  const pending = awaitPtyAck(session, kind, timeoutMs, id);
  try {
    writePtyControl(session, { ...op, id });
  } catch (error) {
    // The waiter must never be left armed: its timer would reject a promise
    // nobody is awaiting, which surfaces as an unhandled rejection.
    pending.catch(() => {});
    const waiter = session.ackWaiters.find((entry) => entry.id === id);
    if (waiter) waiter.reject(error);
    throw error;
  }
  return pending;
}

function failPtyAcks(session, error) {
  for (const waiter of [...session.ackWaiters]) waiter.reject(error);
}

function markPtyExited(session, { code = null, signal = null } = {}) {
  if (!session.exited) {
    session.exited = true;
    session.exitedAt = Date.now();
  }
  if (session.exitCode === null && code !== null) session.exitCode = code;
  if (session.exitSignal === null && signal) session.exitSignal = signal;
  failPtyAcks(session, ptyError("PTY_EXITED", `pty session '${session.id}' ended before the operation was acknowledged`));
  syncPtyTimers();
}

// Resolve the executable ourselves so a typo fails as pty_start's ENOENT. Left to
// exec(2) inside the helper it would instead be a session that starts "successfully"
// and is immediately dead with status 127 and one line of output.
function resolveExecutable(command, env) {
  if (command.includes("/")) {
    const resolved = resolvePath(command);
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
    } catch (error) {
      throw ptyError("ENOENT", `Cannot execute '${resolved}': ${error?.code === "ENOENT" ? "no such file" : error?.code === "EACCES" ? "not executable" : error?.code || error}`);
    }
    return resolved;
  }
  const searchPath = (env.PATH || process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  for (const directory of searchPath) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw ptyError("ENOENT", `Cannot execute '${command}': not found on PATH`);
}

// The session table is capped including exited sessions, so the global retention
// bound really is PTY_MAX_SESSIONS x PTY_RING_BYTES. Keeping exited sessions
// forever so their final output stays readable is the same unbounded growth in a
// nicer costume.
function evictClosedPtySessions(pending = 0) {
  while (ptySessions.size + pending >= PTY_MAX_SESSIONS) {
    const oldest = [...ptySessions.values()]
      .filter((session) => session.exited)
      .sort((a, b) => (a.exitedAt || 0) - (b.exitedAt || 0))[0];
    if (!oldest) return false;
    ptySessions.delete(oldest.id);
  }
  return true;
}

// The cap has to be TAKEN, not merely checked.
//
// startPtySession used to test the cap and then await fsp.stat(cwd) before
// registering anything, so N concurrent pty_start calls all passed a check that
// none of them had yet invalidated. Measured against the shipped code: 60
// concurrent starts produced 58 live ptys against a cap of 8, 58 helper processes
// and 58 rings (15 MB where PTY_RING_GLOBAL_BYTES claims 2 MB). That matters
// beyond this process: kern.tty.ptmx_max is 511 SYSTEM-WIDE, so a large enough
// batch takes Terminal.app, iTerm and ssh away from the operator — the very path
// to scripts/disable.sh — and mcp-http.mjs deliberately caps neither connections
// nor concurrent requests.
//
// This counter bounds exactly one thing: how many pty_start calls may be between
// the cap check and their entry in ptySessions. A reserved slot is released on
// every exit from startPtySession, success or failure, so it cannot leak. It only
// ever makes the cap stricter (an in-flight start is counted while its session is
// also in the map, for the few ms between the two), never looser, and sequential
// use — one pty_start at a time — never sees a reservation at all.
let ptyStartsInFlight = 0;

function reservePtySlot() {
  if (livePtySessions().length + ptyStartsInFlight >= PTY_MAX_SESSIONS || !evictClosedPtySessions(ptyStartsInFlight)) {
    throw ptyError("PTY_SESSION_LIMIT", `pty session limit reached (${PTY_MAX_SESSIONS} live); close one with pty_close first.`);
  }
  ptyStartsInFlight += 1;
}

function releasePtySlot() {
  if (ptyStartsInFlight > 0) ptyStartsInFlight -= 1;
}

async function startPtySession(options) {
  if (!ptyAvailable) {
    throw ptyError("PTY_HELPER_UNAVAILABLE", `pty support is unavailable on this host (${PTY_HELPER_PERL} ${PTY_HELPER_PL}); the pty tools are not advertised.`);
  }
  // Everything above this line is synchronous, so the slot is taken before the
  // first suspension point and no concurrent caller can pass a check this one has
  // already consumed.
  reservePtySlot();
  try {
    return await startPtySessionInSlot(options);
  } finally {
    releasePtySlot();
  }
}

async function startPtySessionInSlot({ command, args, cwd, env, cols, rows, term, idleTimeoutMs, label }) {
  let cwdStat;
  try {
    cwdStat = await fsp.stat(cwd);
  } catch (error) {
    throw ptyError("PTY_BAD_CWD", `Working directory '${cwd}' is unusable: ${error?.code || error}`);
  }
  if (!cwdStat.isDirectory()) throw ptyError("PTY_BAD_CWD", `Working directory '${cwd}' is not a directory`);

  // TERM before the caller's overrides so an explicit env wins. Without TERM at
  // all, tput fails with "No value for $TERM"; with it, tput cols/lines matched
  // the real winsize.
  const childEnv = mergedEnv({ TERM: term, ...env });
  const resolved = resolveExecutable(command, childEnv);
  const id = `pty_${crypto.randomBytes(4).toString("hex")}`;
  const child = spawnPtyHelper({ command: resolved, args, cwd, env: childEnv, cols, rows });

  const session = {
    id,
    kind: "pty",
    label,
    command: resolved,
    args,
    cwd,
    term,
    cols,
    rows,
    child,
    helperPid: child.pid,
    leaderPid: null,
    pts: null,
    ring: createPtyRing(PTY_RING_BYTES),
    ackWaiters: [],
    nextControlId: 0,
    canonPendingBytes: 0,
    outputWaiters: [],
    idleTimeoutMs,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastReadAt: null,
    exited: false,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    closed: false,
    closeReason: null,
    startError: null,
    metadataPath: path.join(JOB_DIR, `${id}.json`),
  };
  ptySessions.set(id, session);
  syncPtyTimers();

  // Eagerly drained. A poll-driven read would leave the pipe full, which blocks
  // the helper in syswrite, which fills the pty, which blocks the CHILD — a
  // session that silently stalls its own build while the client thinks it is slow.
  child.stdout.on("data", (chunk) => {
    session.ring.append(chunk);
    const waiters = session.outputWaiters.splice(0, session.outputWaiters.length);
    for (const waiter of waiters) waiter();
  });
  // Mandatory on both writable ends: a stdin error after an accepted write emits
  // no 'exit', so without a handler it surfaces as a stray stream error while the
  // session keeps being reported as alive.
  child.stdin.on("error", (error) => {
    session.startError = session.startError || `stdin: ${error?.code || error?.message || error}`;
    markPtyExited(session);
  });
  child.stdio[3].on("error", () => {});
  child.once("error", (error) => {
    session.startError = String(error?.message || error);
    markPtyExited(session);
  });
  // Master-close raises SIGHUP, which usually suffices — but measured against
  // `trap '' HUP TERM INT` both the shell and its grandchild survived it. So the
  // group is reclaimed here explicitly instead of assuming the hangup worked.
  //
  // Bound to BOTH 'exit' and 'close'. 'close' waits for every stdio stream to end,
  // which a descriptor leaked into the session program can defer indefinitely;
  // 'exit' fires on the helper's death regardless. ptyhelper.pl now closes those
  // descriptors, so 'close' is no longer deferrable that way — but a reclaim path
  // that depends on the child cooperating is the kind of "containment" this
  // project has already shipped and had to retract, so it does not depend on it.
  const reclaimLeaderGroup = () => {
    if (!session.closed && session.leaderPid) killProcessGroup(session.leaderPid, "SIGKILL");
  };
  let helperCloseFallback = null;
  child.once("exit", () => {
    reclaimLeaderGroup();
    // Not markPtyExited() here: 'close' normally arrives within a tick and the
    // last of the transcript arrives with it, so marking the session finished on
    // 'exit' would cut off the final drain. The timer only exists for the case
    // where 'close' does not arrive at all.
    if (helperCloseFallback || session.exited) return;
    helperCloseFallback = setTimeout(() => {
      helperCloseFallback = null;
      stderr(`pty session ${session.id} helper exited without closing its pipes; marking the session ended.`);
      // Same reason as in the 'close' handler: this is the other way a session
      // can end without anyone calling killPtySession.
      sweepPtyTtyOnClose(session);
      markPtyExited(session);
    }, PTY_HELPER_CLOSE_GRACE_MS);
    helperCloseFallback.unref();
  });
  child.once("close", () => {
    if (helperCloseFallback) {
      clearTimeout(helperCloseFallback);
      helperCloseFallback = null;
    }
    reclaimLeaderGroup();
    // The group kill above cannot reach a background job: job control gave it its
    // own pgid. This is the only place a naturally-ended session gets swept.
    sweepPtyTtyOnClose(session);
    markPtyExited(session);
  });

  attachHelperEvents(child, (event) => {
    switch (event.event) {
      case "started":
        session.leaderPid = event.pid;
        session.pts = event.pts;
        session.cols = event.cols;
        session.rows = event.rows;
        break;
      case "resize":
        if (event.ok === 1 || event.ok === true) {
          session.cols = event.cols;
          session.rows = event.rows;
        }
        settlePtyAck(session, "resize", event);
        break;
      case "signal":
        settlePtyAck(session, "signal", event);
        break;
      case "termios":
        settlePtyAck(session, "termios", event);
        break;
      case "exited":
        markPtyExited(session, { code: event.code, signal: event.signal ? signalName(event.signal) : null });
        break;
      case "fatal":
        session.startError = event.error;
        markPtyExited(session);
        break;
      default:
        break;
    }
  });

  // Block until the helper reports readiness, so pty_start never returns an
  // optimistic success for a pty that was never allocated.
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(ptyError("PTY_START_TIMEOUT", `pty helper did not report readiness within ${PTY_START_TIMEOUT_MS}ms`));
    }, PTY_START_TIMEOUT_MS);
    timer.unref();
    const poll = setInterval(() => {
      if (settled) return;
      if (session.leaderPid) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      } else if (session.exited) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        reject(ptyError("PTY_ALLOC_FAILED", `pty allocation failed: ${session.startError || "helper exited before reporting readiness"}`));
      }
    }, 10);
    poll.unref();
  }).catch(async (error) => {
    // Close the helper's stdin first and give it a moment to tear itself down.
    //
    // SIGKILLing the helper skipped its own teardown('parent_gone'), the only code
    // that TERM/KILLs the leader group — and on this path leaderPid is usually still
    // null, so killProcessGroup refuses as well. The forked child was then orphaned
    // to pid 1, absent from bridge_status, and had no job metadata for disable.sh:
    // an unrestricted process with no reclaim path anywhere.
    try { session.child?.stdin?.end(); } catch {}
    {
      const deadline = Date.now() + 2000;
      while (session.child && session.child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // Bounded fallback: still SIGKILLs whatever the helper did not reclaim.
    killPtySession(session, "start_failed");
    ptySessions.delete(id);
    syncPtyTimers();
    throw error;
  });

  // Written for scripts/disable.sh, never read back. The reclaimer's discovery
  // loop is entirely field-driven, so the same shape shell_start writes makes pty
  // sessions reclaimable with no change to the script. startedAt MUST be nowIso():
  // disable.sh parses it with `date -j -u -f '%Y-%m-%dT%H:%M:%S'` and silently
  // skips any entry it cannot parse, which would let it print "Disabled" having
  // signalled nothing.
  //
  // Failing closed if the write fails: a live session the reclaimer cannot see is
  // exactly the "invisible to disable.sh" hole this metadata exists to close, and
  // shell_exec already demonstrates how that ends.
  try {
    await writeJobMetadata({
      id,
      kind: "pty",
      label,
      pid: session.leaderPid,
      processGroupId: session.leaderPid,
      command: `${resolved} ${args.join(" ")}`.trim(),
      cwd,
      startedAt: nowIso(),
      helperPid: session.helperPid,
      pts: session.pts,
      stdoutPath: null,
      stderrPath: null,
    });
  } catch (error) {
    killPtySession(session, "metadata_write_failed");
    ptySessions.delete(id);
    syncPtyTimers();
    throw ptyError("PTY_METADATA_FAILED", `pty session could not be recorded for the reclaimer (${error?.code || error}); the session was terminated rather than left untracked`);
  }
  // First membership record, while the helper certainly owns the device. Kept
  // fresh from pty_read/pty_write and from the 5s sweeper, because after the
  // session ends the terminal is revoked and cannot be scanned at all.
  refreshPtyTtyTargets(session);
  return session;
}

// Synchronous, because every caller is between a revocation decision and
// process.exit. An await here is a window in which the bridge dies with the pty
// still alive.
function killPtySession(session, reason, { startBudget = true } = {}) {
  if (startBudget) beginPtyTtyScanBudget();
  const result = {
    sessionId: session.id,
    reason,
    leaderGroupKilled: false,
    leaderGroupError: null,
    helperKilled: false,
  };
  // Last chance to see the terminal's membership while the helper still owns the
  // device. pty_close snapshots again before its graceful SIGTERM, because by the
  // time the grace period ends the leader — and with it the helper — is usually
  // gone and the device with it.
  snapshotPtyTtyProcesses(session);
  if (session.leaderPid) {
    // The leader group FIRST, and never -helperPid: measured, kill(-helperPid, 0)
    // is ESRCH because the helper never calls setsid(), so a reclaim path written
    // that way silently no-ops while reporting success.
    const error = killProcessGroup(session.leaderPid, "SIGKILL");
    if (error === null) result.leaderGroupKilled = true;
    else result.leaderGroupError = error;
  } else {
    result.leaderGroupError = "NO_LEADER";
  }
  // Then everything still holding this session's controlling terminal — the
  // background jobs job control put in their own process groups, which the group
  // kill above cannot reach. Both steps run BEFORE the helper is killed, while
  // its master fd still guarantees the device is ours.
  killPtyTtyStragglers(session, result);
  try {
    session.child.kill("SIGKILL");
    result.helperKilled = true;
  } catch (error) {
    result.helperError = error?.code || String(error?.message || error);
  }
  session.closed = true;
  session.closeReason = session.closeReason || reason;
  markPtyExited(session);
  return result;
}

// The killInFlightCommands() analogue: revocation and every exit path call this.
function killPtySessions(reason = "revoked") {
  beginPtyTtyScanBudget();
  const results = [];
  for (const session of ptySessions.values()) {
    if (session.closed && session.exited) continue;
    // One budget for the whole sweep, not one per session.
    results.push(killPtySession(session, reason, { startBudget: false }));
  }
  return results;
}

function signalName(number) {
  const names = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 9: "SIGKILL", 13: "SIGPIPE", 15: "SIGTERM", 19: "SIGSTOP", 20: "SIGTSTP" };
  if (!number) return null;
  return names[number] || `SIG${number}`;
}

// Both intervals exist only while a session does, and both are unref'd. A
// referenced interval would keep bridge.mjs alive after rl 'close' — an
// unrestricted bridge with no client and nothing watching it, which is the worst
// possible residue.
function syncPtyTimers() {
  const live = livePtySessions().length;
  if (live > 0) {
    if (!ptySweeper) {
      ptySweeper = setInterval(sweepPtySessions, PTY_SWEEP_MS);
      ptySweeper.unref();
    }
  } else if (ptySweeper) {
    clearInterval(ptySweeper);
    ptySweeper = null;
  }
  // The idle latch recheck is armed by pty sessions AND by federated children:
  // both are long-lived unrestricted processes that generate no tool calls of
  // their own, so a call-triggered latch alone never notices the unlock file is
  // gone while the client is quiet.
  // Armed unconditionally, NOT gated on a live-child count.
  //
  // Gating it was a measured hole: a provider that crashes on its first start is
  // still `restarting` when federationReady resolves, so childCount() reads 0 and
  // the interval is never armed — and Provider.start() on the restart path has no
  // callback into the host to arm it later. A live unrestricted child then ran with
  // the kill switch completely inert: removing the unlock file produced no
  // revocation at all, verified A/B against a clean start.
  //
  // Always arming it costs one readFile per UNLOCK_RECHECK_MS on an unref'd
  // interval, which cannot hold the process open — far cheaper than depending on a
  // count that reads 0 at exactly the wrong instant.
  if (!unlockRecheck) {
    unlockRecheck = setInterval(() => {
      recheckUnlock().catch((error) => stderr(`unlock recheck failed: ${error?.message || error}`));
    }, UNLOCK_RECHECK_MS);
    unlockRecheck.unref();
  }
}

function sweepPtySessions() {
  const now = Date.now();
  for (const session of livePtySessions()) {
    // Covers the session nobody is reading from: a job backgrounded at a prompt
    // and then left alone is still recorded, within PTY_SWEEP_MS, while the
    // terminal can still be scanned. That window is the residual exposure — a job
    // started AND its session ended inside the same interval, with no pty_read or
    // pty_write in between, is not in the record and survives.
    refreshPtyTtyTargets(session);
    if (now - session.lastActivityAt > session.idleTimeoutMs) {
      stderr(`pty session ${session.id} idle for ${now - session.lastActivityAt}ms; reclaiming.`);
      session.closeReason = "idle_timeout";
      killPtySession(session, "idle_timeout");
    } else if (now - session.createdAt > PTY_MAX_LIFETIME_MS) {
      stderr(`pty session ${session.id} exceeded the ${PTY_MAX_LIFETIME_MS}ms lifetime ceiling; reclaiming.`);
      session.closeReason = "max_lifetime";
      killPtySession(session, "max_lifetime");
    }
  }
}

// One shared teardown for the three immediate-exit handlers. Without it, SIGTERM —
// exactly what scripts/disable.sh sends — reclaimed bridge.mjs and printed its
// containment verdict while the pty shells it had started kept running, making the
// script structurally incapable of the containment it reported.
function teardownAll(reason) {
  try {
    killPtySessions(reason);
  } catch (error) {
    stderr(`pty teardown failed: ${error?.message || error}`);
  }
  try {
    // Federated children are spawned detached so their groups are reclaimable,
    // which also means they survive every one of these exit paths unless they are
    // killed here.
    federation.killAll();
  } catch (error) {
    stderr(`federation teardown failed: ${error?.message || error}`);
  }
  try {
    killInFlightCommands();
  } catch (error) {
    stderr(`in-flight teardown failed: ${error?.message || error}`);
  }
}

// Exit once stdout has actually drained, not after a fixed delay.
//
// process.stdout to a pipe is asynchronous, and process.exit() does not flush
// queued writes: with a large response pending, a fixed timer truncated the JSON
// mid-line, so the client got an unparseable fragment and a closed pipe instead
// of the revocation error. The timer remains only as a backstop.
function exitAfterFlush(code, backstopMs = 5000) {
  const done = () => process.exit(code);
  setTimeout(done, backstopMs).unref();
  if (process.stdout.writableLength === 0) {
    setImmediate(done);
    return;
  }
  process.stdout.once("drain", done);
}

// Continue only for errors that are genuinely momentary, by allowlist.
//
// An exclude-list ("anything but ENOENT is transient") is unsafe: EISDIR and
// ELOOP are permanent, so `rm -f <file> && mkdir <file>` would disarm the
// latch forever — and disable.sh's `-f` test is false for a directory, so it
// would report "already absent" and exit 0 claiming containment.
//
// The reason to tolerate the transient set at all is that an unrestricted
// shell can exhaust file descriptors, and a bridge that exits on EMFILE is a
// self-inflicted denial of service.
const TRANSIENT_LATCH_ERRNOS = new Set(["EMFILE", "ENFILE", "EIO", "EAGAIN", "EINTR", "EBUSY", "ETIMEDOUT"]);

// One reader for the latch, shared by the per-call check and the idle recheck.
// Two copies of this errno taxonomy would be two chances to diverge, and a
// divergent kill-vs-verify predicate is the origin of every false "Disabled"
// verdict this project has shipped.
//
// Returns "unlocked", "revoked", or "unreadable" (transient: the caller should
// leave the current state alone rather than revoke on a momentary failure).
async function readUnlockLatch() {
  try {
    return (await fsp.readFile(FULL_ACCESS_UNLOCK_FILE, "utf8")).trim() === FULL_ACCESS_ACK ? "unlocked" : "revoked";
  } catch (error) {
    if (TRANSIENT_LATCH_ERRNOS.has(error?.code)) {
      stderr(`Unlock file read failed transiently (${error.code}); retrying once.`);
      try {
        await new Promise((r) => setTimeout(r, 10));
        return (await fsp.readFile(FULL_ACCESS_UNLOCK_FILE, "utf8")).trim() === FULL_ACCESS_ACK ? "unlocked" : "revoked";
      } catch (retryError) {
        if (TRANSIENT_LATCH_ERRNOS.has(retryError?.code)) {
          stderr(`Unlock file still unreadable (${retryError.code}); leaving the current state in place.`);
          return "unreadable";
        }
        return "revoked";
      }
    }
    // ENOENT, EISDIR, ELOOP, ENOTDIR, EACCES, ... all mean "not a readable
    // unlock file", which is indistinguishable from revocation. Revoke.
    stderr(`Unlock file is not readable (${error?.code || error}); treating as revoked.`);
    return "revoked";
  }
}

// The latch is only consulted per tool call, so an idle pty session generates no
// checks at all: without this interval, "removing the unlock file terminates live
// sessions" is false for exactly as long as the client stops calling. Armed while
// any session is live, disarmed when none is.
async function recheckUnlock() {
  if (FULL_ACCESS_ACK_FROM_ENV === FULL_ACCESS_ACK) return;
  if (unlockRecheckInFlight) return;
  unlockRecheckInFlight = true;
  try {
    const state = await readUnlockLatch();
    if (state === "unreadable") return;
    fullAccessUnlocked = state === "unlocked";
    if (state === "unlocked") return;
    const sessions = livePtySessions().map((session) => ({ id: session.id, leaderPid: session.leaderPid }));
    stderr(`Full-access unlock revoked (${FULL_ACCESS_UNLOCK_FILE}); reclaiming ${sessions.length} pty session(s) and exiting.`);
    // Containment first here, unlike the per-call path: no response is pending on
    // this path, so there is nothing to flush and nothing to lose by killing before
    // the audit append. The audit is still awaited before exitAfterFlush, because
    // exitAfterFlush fires on an empty stdout via setImmediate and would otherwise
    // beat appendFile — and a revocation that leaves no trace is the one event that
    // must not.
    const reclaimed = killPtySessions("revoked");
    const federatedReclaimed = federation.killAll();
    killInFlightCommands();
    await audit("pty_unlock_recheck", {}, { revoked: true, sessions, reclaimed, federatedReclaimed }, new Error("Full-access unlock has been revoked; the bridge is shutting down."));
    exitAfterFlush(78);
  } finally {
    unlockRecheckInFlight = false;
  }
}

async function assertStillUnlocked(tool, args) {
  if (FULL_ACCESS_ACK_FROM_ENV === FULL_ACCESS_ACK) return;
  const state = await readUnlockLatch();
  if (state === "unreadable") return;
  // Keep bridge_status honest: this field previously froze at the startup value
  // and would report `true` while the file was gone.
  const ok = state === "unlocked";
  fullAccessUnlocked = ok;

  if (!ok) {
    const message = "Full-access unlock has been revoked; the bridge is shutting down.";
    stderr(`Full-access unlock revoked (${FULL_ACCESS_UNLOCK_FILE}); refusing further tool calls and exiting.`);
    // Audit HERE, awaited, before scheduling the exit. Relying on the caller's
    // catch to audit lost the record entirely: exitAfterFlush fires on an empty
    // stdout via setImmediate, which can beat the caller's appendFile. A
    // revocation that leaves no audit trace is the one event that must not.
    await audit(tool ?? "unknown", args ?? {}, { revoked: true }, new Error(message));
    // Reclaim in-flight commands: exiting without this leaves an unrestricted
    // process running past its own timeout with nothing tracking it.
    //
    // Both reclaims are synchronous and sit between the decision and the exit on
    // purpose. exitAfterFlush can process.exit on the very next tick, so any await
    // inserted here is a window in which the bridge dies with a live pty still
    // holding an unrestricted shell.
    killInFlightCommands();
    killPtySessions("revoked");
    federation.killAll();
    // Exit so a supervisor restarts into the locked state where startup fails 78,
    // but only after the response has been flushed.
    exitAfterFlush(78);
    throw new Error(message);
  }
}

async function dispatchTool(name, args) {
  await assertStillUnlocked(name, args);
  switch (name) {
    case "bridge_status": {
      const federationStatus = federation.status();
      const status = {
        bridgeVersion: BRIDGE_VERSION,
        pid: process.pid,
        hostname: os.hostname(),
        username: os.userInfo().username,
        uid: typeof process.getuid === "function" ? process.getuid() : null,
        gid: typeof process.getgid === "function" ? process.getgid() : null,
        home: HOME,
        platform: process.platform,
        architecture: process.arch,
        release: os.release(),
        node: process.version,
        shell: SHELL,
        codexBin: CODEX_BIN,
        tunnelRuntimeKeyScrubbedFromChildEnvironment: TUNNEL_RUNTIME_KEY_WAS_PRESENT,
        cwd: process.cwd(),
        dataDir: APP_SUPPORT_DIR,
        jobDir: JOB_DIR,
        auditLog: AUDIT_LOG,
        auditMode: AUDIT_MODE,
        guiFocusPolicy: GUI_FOCUS_POLICY,
        operatorSettings: await readOperatorSettings(),
        settingsFile: SETTINGS_FILE,
        foregroundGuiApproved: await foregroundGuiApprovalPresent(),
        fullAccessUnlocked,
        fullAccessUnlockFile: FULL_ACCESS_UNLOCK_FILE,
        // Set once by the startup probe and deliberately not recomputed: the helper
        // either works on this host or it does not, and re-probing per status call
        // would spawn a pty every time.
        ptyAvailable,
        ptyHelper: ptyAvailable ? { interpreter: PTY_HELPER_PERL, script: PTY_HELPER_PL } : null,
        ptyLimits: {
          maxSessions: PTY_MAX_SESSIONS,
          ringBytesPerSession: PTY_RING_BYTES,
          ringBytesGlobal: PTY_RING_GLOBAL_BYTES,
          idleTimeoutMs: PTY_IDLE_TIMEOUT_MS,
          maxLifetimeMs: PTY_MAX_LIFETIME_MS,
          writeMaxBytes: PTY_WRITE_MAX,
          unlockRecheckMs: UNLOCK_RECHECK_MS,
        },
        // Built at read time from the live registry, never cached. fullAccessUnlocked
        // once froze at its startup value and reported `true` while the file was gone;
        // a cached session inventory would repeat that mistake with processes.
        ptySessions: [...ptySessions.values()].map(ptySessionSummary),
        // Recomputed per call from the same live read, never cached. Surfacing
        // the child environment allowlist is what makes it observable and
        // therefore testable, the same reason
        // tunnelRuntimeKeyScrubbedFromChildEnvironment is reported above.
        federation: federationStatus,
        childServerEnvAllowlist: federationStatus.childServerEnvAllowlist,
        personalBrowserApproved: await personalBrowserApprovalPresent(),
        backgroundChrome: {
          ...(await backgroundChromeStatus({ dataDir: APP_SUPPORT_DIR, timeoutMs: 750 })),
          grant: await backgroundChromeGrantStatus(),
          providerKey: BACKGROUND_CHROME_PROVIDER_KEY,
          focusPolicy: "background-only via Chrome extension; no activate/select/new foreground window",
        },
        accessModel: "No bridge sandbox or path allowlist. Effective access equals the macOS account running tunnel-client/this server, subject to macOS TCC, Full Disk Access, ACLs, and sudo authentication.",
      };
      await audit(name, args, { ok: true });
      return status;
    }

    case "chrome_workspace_status": {
      return await callBackgroundChromeLocal(name, "workspace.status", {});
    }

    case "chrome_workspace_setup": {
      const poolSize = optionalInteger(args, "pool_size", 4, 1, 8);
      return await callBackgroundChromeLocal(name, "workspace.init", { poolSize });
    }

    case "chrome_tabs": {
      const urlContains = optionalString(args, "url_contains", "");
      const titleContains = optionalString(args, "title_contains", "");
      const maxTabs = optionalInteger(args, "max_tabs", 200, 1, 500);
      return await callBackgroundChrome(name, "tabs.list", { urlContains, titleContains, maxTabs });
    }

    case "chrome_open": {
      const url = requireString(args, "url");
      if (url.length > 20_000) throw new Error("'url' must be at most 20000 characters");
      return await callBackgroundChrome(name, "workspace.open", { url });
    }

    case "chrome_navigate": {
      const tabId = requireInteger(args, "tab_id", 0, 2_147_483_647);
      const url = requireString(args, "url");
      if (url.length > 20_000) throw new Error("'url' must be at most 20000 characters");
      return await callBackgroundChrome(name, "tabs.navigate", { tabId, url });
    }

    case "chrome_snapshot": {
      const tabId = requireInteger(args, "tab_id", 0, 2_147_483_647);
      const maxTextChars = optionalInteger(args, "max_text_chars", 50_000, 1_000, 200_000);
      const maxElements = optionalInteger(args, "max_elements", 200, 1, 500);
      return await callBackgroundChrome(name, "tabs.snapshot", { tabId, maxTextChars, maxElements });
    }

    case "chrome_click": {
      const tabId = requireInteger(args, "tab_id", 0, 2_147_483_647);
      const selector = requireString(args, "selector");
      if (selector.length > 10_000) throw new Error("'selector' must be at most 10000 characters");
      return await callBackgroundChrome(name, "tabs.click", { tabId, selector });
    }

    case "chrome_fill": {
      const tabId = requireInteger(args, "tab_id", 0, 2_147_483_647);
      const selector = requireString(args, "selector");
      const value = requireString(args, "value", { allowEmpty: true });
      const submit = optionalBoolean(args, "submit", false);
      if (selector.length > 10_000) throw new Error("'selector' must be at most 10000 characters");
      if (value.length > 500_000) throw new Error("'value' must be at most 500000 characters");
      return await callBackgroundChrome(name, "tabs.fill", { tabId, selector, value, submit });
    }

    case "chrome_close": {
      const tabId = requireInteger(args, "tab_id", 0, 2_147_483_647);
      const allowActive = optionalBoolean(args, "allow_active", false);
      return await callBackgroundChrome(name, "tabs.close", { tabId, allowActive });
    }

    case "shell_exec": {
      const command = requireString(args, "command");
      const cwd = optionalString(args, "cwd", HOME);
      const chromeRoutingRisk = chromeBackgroundRoutingRisk(command);
      if (chromeRoutingRisk) {
        const error = new Error(`Direct Chrome GUI automation is blocked (${chromeRoutingRisk.reason}). Chrome web work must use the built-in chrome_* tools and the MDB tab group so it stays in the signed-in profile without stealing focus. This routing rule applies in both Relaxed and Strict approval modes.`);
        error.code = "CHROME_BACKGROUND_REQUIRED";
        await audit(name, args, { blocked: true, chromeBackgroundRequired: true, chromeRoutingRisk }, error);
        throw error;
      }
      const focusRisk = guiFocusRisk(command);
      const operatorSettings = await readOperatorSettings();
      let foregroundGrant = null;
      if (focusRisk && operatorSettings.strictApprovals) {
        foregroundGrant = await consumeForegroundGuiApproval(focusRisk);
        if (!foregroundGrant) {
          const error = new Error(`Desktop GUI automation is blocked because Strict approvals is enabled (${focusRisk.reason}; targets: ${focusRisk.apps.join(", ")}). Use a background-capable API/connector/extension instead, or approve a one-time foreground action with scripts/approve-foreground-gui.sh.`);
          error.code = "GUI_FOCUS_BLOCKED";
          await audit(name, args, { guiFocusPolicy: GUI_FOCUS_POLICY, strictApprovals: true, blocked: true, focusRisk }, error);
          throw error;
        }
      }
      const env = normalizeEnv(args?.env);
      const stdin = optionalString(args, "stdin", undefined);
      const timeoutMs = optionalInteger(args, "timeout_ms", 120_000, 0, 1_800_000);
      const maxOutputBytes = optionalInteger(args, "max_output_bytes", DEFAULT_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES);
      try {
        const result = await runCommand({ command, cwd, env, stdin, timeoutMs, maxOutputBytes });
        await audit(name, args, { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs });
        return result;
      } catch (error) {
        await audit(name, args, {}, error);
        throw error;
      }
    }

    case "shell_start": {
      const command = requireString(args, "command");
      const chromeRoutingRisk = chromeBackgroundRoutingRisk(command);
      if (chromeRoutingRisk) {
        const error = new Error(`Direct Chrome GUI automation is blocked (${chromeRoutingRisk.reason}). Chrome web work must use the built-in chrome_* tools and the MDB tab group so it stays in the signed-in profile without stealing focus. This routing rule applies in both Relaxed and Strict approval modes.`);
        error.code = "CHROME_BACKGROUND_REQUIRED";
        await audit(name, args, { blocked: true, chromeBackgroundRequired: true, chromeRoutingRisk }, error);
        throw error;
      }
      const operatorSettings = await readOperatorSettings();
      const focusRisk = guiFocusRisk(command);
      if (focusRisk && operatorSettings.strictApprovals) {
        const foregroundGrant = await consumeForegroundGuiApproval(focusRisk);
        if (!foregroundGrant) {
          const error = new Error(`Desktop GUI automation is blocked because Strict approvals is enabled (${focusRisk.reason}; targets: ${focusRisk.apps.join(", ")}). Approve a one-time foreground action with scripts/approve-foreground-gui.sh, or use a background-capable API/web path.`);
          error.code = "GUI_FOCUS_BLOCKED";
          await audit(name, args, { guiFocusPolicy: GUI_FOCUS_POLICY, strictApprovals: true, blocked: true, focusRisk }, error);
          throw error;
        }
      }
      const cwd = resolvePath(optionalString(args, "cwd", HOME));
      const env = normalizeEnv(args?.env);
      const label = optionalString(args, "label", "background-job").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "background-job";
      const id = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${label}`;
      const stdoutPath = path.join(JOB_DIR, `${id}.stdout.log`);
      const stderrPath = path.join(JOB_DIR, `${id}.stderr.log`);
      const stdoutFd = fs.openSync(stdoutPath, "a", 0o600);
      const stderrFd = fs.openSync(stderrPath, "a", 0o600);
      let child;
      try {
        child = spawn(SHELL, ["-lc", command], {
          cwd,
          env: mergedEnv(env),
          detached: true,
          stdio: ["ignore", stdoutFd, stderrFd],
        });
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      } finally {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
      }
      child.unref();
      const metadata = {
        id,
        label,
        pid: child.pid,
        processGroupId: child.pid,
        command,
        cwd,
        startedAt: nowIso(),
        stdoutPath,
        stderrPath,
      };
      // Fail closed, as pty sessions and federated children already do. This job is
      // detached and unref'd, so if the metadata write fails (EACCES on JOB_DIR, ENOSPC)
      // nothing in $DATA_DIR/jobs names it and scripts/disable.sh can never find it — an
      // unrestricted job invisible to the kill switch. Kill it and report, rather than
      // leave it running unrecorded.
      try {
        await writeJobMetadata(metadata);
      } catch (metadataError) {
        killProcessGroup(child.pid, "SIGKILL");
        throw new Error(
          `Could not record job metadata, so the job was killed rather than left unreclaimable: ${metadataError?.message || metadataError}`,
        );
      }
      await audit(name, args, { jobId: id, pid: child.pid });
      return { ...metadata, running: processRunning(child.pid) };
    }

    case "shell_job_status": {
      const jobId = requireString(args, "job_id");
      const maxLogBytes = optionalInteger(args, "max_log_bytes", 100_000, 1_024, 8_000_000);
      const metadata = await readJobMetadata(jobId);
      const [stdout, stderrTail] = await Promise.all([
        tailFile(metadata.stdoutPath, maxLogBytes),
        tailFile(metadata.stderrPath, maxLogBytes),
      ]);
      const result = { ...metadata, running: processRunning(metadata.pid), stdout, stderr: stderrTail };
      await audit(name, args, { jobId, running: result.running });
      return result;
    }

    case "shell_job_list": {
      const files = (await fsp.readdir(JOB_DIR)).filter((entry) => entry.endsWith(".json")).sort().reverse();
      const jobs = [];
      for (const file of files.slice(0, 1000)) {
        try {
          const metadata = JSON.parse(await fsp.readFile(path.join(JOB_DIR, file), "utf8"));
          jobs.push({ ...metadata, running: processRunning(metadata.pid) });
        } catch (error) {
          jobs.push({ metadataFile: file, error: String(error?.message || error) });
        }
      }
      await audit(name, args, { count: jobs.length });
      return { jobs };
    }

    case "shell_job_kill": {
      const jobId = requireString(args, "job_id");
      const signal = optionalString(args, "signal", "SIGTERM");
      const metadata = await readJobMetadata(jobId);
      let killed = false;
      try {
        process.kill(-metadata.processGroupId, signal);
        killed = true;
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      const result = { jobId, pid: metadata.pid, signal, killed, running: processRunning(metadata.pid) };
      await audit(name, args, result);
      return result;
    }

    case "fs_read": {
      const filePath = resolvePath(requireString(args, "path"));
      const encoding = optionalString(args, "encoding", "utf8");
      const offset = optionalInteger(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const maxBytes = optionalInteger(args, "max_bytes", DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
      const bytesToRead = Math.max(0, Math.min(maxBytes, stat.size - offset));
      const handle = await fsp.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
        const data = buffer.subarray(0, bytesRead);
        const result = {
          path: filePath,
          size: stat.size,
          offset,
          bytesRead,
          nextOffset: offset + bytesRead < stat.size ? offset + bytesRead : null,
          truncated: offset + bytesRead < stat.size,
          encoding,
          content: encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
        };
        await audit(name, args, { path: filePath, bytesRead, truncated: result.truncated });
        return result;
      } finally {
        await handle.close();
      }
    }

    case "fs_write": {
      const filePath = resolvePath(requireString(args, "path"));
      const content = requireString(args, "content", { allowEmpty: true });
      const encoding = optionalString(args, "encoding", "utf8");
      const append = optionalBoolean(args, "append", false);
      const atomic = optionalBoolean(args, "atomic", true);
      const createParents = optionalBoolean(args, "create_parents", true);
      const mode = args?.mode === undefined ? undefined : optionalInteger(args, "mode", 0o644, 0, 0o7777);
      const data = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      if (createParents) await fsp.mkdir(path.dirname(filePath), { recursive: true });
      let effectiveMode = mode;
      if (!append && atomic && effectiveMode === undefined) {
        try {
          effectiveMode = (await fsp.stat(filePath)).mode & 0o7777;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      if (append) {
        await fsp.appendFile(filePath, data, mode === undefined ? undefined : { mode });
      } else if (atomic) {
        const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
        try {
          await fsp.writeFile(tempPath, data, effectiveMode === undefined ? undefined : { mode: effectiveMode });
          await fsp.rename(tempPath, filePath);
        } catch (error) {
          await fsp.rm(tempPath, { force: true }).catch(() => {});
          throw error;
        }
      } else {
        await fsp.writeFile(filePath, data, mode === undefined ? undefined : { mode });
      }
      if (mode !== undefined) await fsp.chmod(filePath, mode);
      const stat = await fsp.stat(filePath);
      const result = { path: filePath, bytesWritten: data.length, size: stat.size, append, atomic: append ? false : atomic, mode: stat.mode & 0o7777 };
      await audit(name, args, result);
      return result;
    }

    case "fs_list": {
      const root = resolvePath(requireString(args, "path"));
      const recursive = optionalBoolean(args, "recursive", false);
      const includeHidden = optionalBoolean(args, "include_hidden", true);
      const maxEntries = optionalInteger(args, "max_entries", 5000, 1, 100000);
      const maxDepth = optionalInteger(args, "max_depth", 10, 0, 100);
      const entries = [];
      let truncated = false;
      async function walk(directory, depth) {
        if (entries.length >= maxEntries) { truncated = true; return; }
        const dirents = await fsp.readdir(directory, { withFileTypes: true });
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const dirent of dirents) {
          if (!includeHidden && dirent.name.startsWith(".")) continue;
          if (entries.length >= maxEntries) { truncated = true; return; }
          const fullPath = path.join(directory, dirent.name);
          const stat = await fsp.lstat(fullPath);
          const entry = {
            name: dirent.name,
            path: fullPath,
            relativePath: path.relative(root, fullPath) || ".",
            type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
            size: stat.size,
            mode: stat.mode & 0o7777,
            modifiedAt: stat.mtime.toISOString(),
          };
          if (stat.isSymbolicLink()) entry.symlinkTarget = await fsp.readlink(fullPath).catch(() => null);
          entries.push(entry);
          if (recursive && stat.isDirectory() && depth < maxDepth) await walk(fullPath, depth + 1);
        }
      }
      await walk(root, 0);
      const result = { root, entries, count: entries.length, truncated };
      await audit(name, args, { root, count: entries.length, truncated });
      return result;
    }

    case "fs_stat": {
      const targetPath = resolvePath(requireString(args, "path"));
      const stat = await fsp.lstat(targetPath);
      const result = {
        path: targetPath,
        type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isSocket() ? "socket" : "other",
        size: stat.size,
        mode: stat.mode & 0o7777,
        uid: stat.uid,
        gid: stat.gid,
        inode: stat.ino,
        device: stat.dev,
        links: stat.nlink,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        changedAt: stat.ctime.toISOString(),
        accessedAt: stat.atime.toISOString(),
        symlinkTarget: stat.isSymbolicLink() ? await fsp.readlink(targetPath) : null,
      };
      await audit(name, args, { path: targetPath, type: result.type });
      return result;
    }

    case "fs_manage": {
      const operation = requireString(args, "operation");
      const targetPath = resolvePath(requireString(args, "path"));
      const destinationInput = args?.destination === undefined ? undefined : requireString(args, "destination");
      const destination = destinationInput === undefined
        ? undefined
        : operation === "symlink" && !path.isAbsolute(destinationInput) && !destinationInput.startsWith("~/")
          ? destinationInput
          : resolvePath(destinationInput);
      const recursive = optionalBoolean(args, "recursive", false);
      const force = optionalBoolean(args, "force", false);
      const mode = args?.mode === undefined ? undefined : optionalInteger(args, "mode", 0o755, 0, 0o7777);
      switch (operation) {
        case "mkdir":
          await fsp.mkdir(targetPath, { recursive, mode });
          break;
        case "remove":
          await fsp.rm(targetPath, { recursive, force });
          break;
        case "move":
          if (!destination) throw new Error("'destination' is required for move");
          if (force) await fsp.rm(destination, { recursive: true, force: true });
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          try {
            await fsp.rename(targetPath, destination);
          } catch (error) {
            if (error?.code !== "EXDEV") throw error;
            const stat = await fsp.lstat(targetPath);
            await fsp.cp(targetPath, destination, {
              recursive: stat.isDirectory(),
              force,
              errorOnExist: !force,
              preserveTimestamps: true,
              verbatimSymlinks: true,
            });
            await fsp.rm(targetPath, { recursive: stat.isDirectory(), force: true });
          }
          break;
        case "copy":
          if (!destination) throw new Error("'destination' is required for copy");
          if (force) await fsp.rm(destination, { recursive: true, force: true });
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          await fsp.cp(targetPath, destination, { recursive, force, errorOnExist: !force, preserveTimestamps: true, verbatimSymlinks: true });
          break;
        case "chmod":
          if (mode === undefined) throw new Error("'mode' is required for chmod");
          await fsp.chmod(targetPath, mode);
          break;
        case "symlink":
          if (!destination) throw new Error("'destination' is required as the symlink target");
          if (force) await fsp.rm(targetPath, { recursive: true, force: true });
          await fsp.mkdir(path.dirname(targetPath), { recursive: true });
          await fsp.symlink(destination, targetPath);
          break;
        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
      const result = { operation, path: targetPath, destination: destination ?? null, recursive, force, mode: mode ?? null };
      await audit(name, args, result);
      return result;
    }

    case "apply_patch": {
      const patchText = requireString(args, "patch");
      const cwd = optionalString(args, "cwd", HOME);
      const checkOnly = optionalBoolean(args, "check_only", false);
      const reverse = optionalBoolean(args, "reverse", false);
      const threeWay = optionalBoolean(args, "three_way", false);
      const flags = ["apply", "--recount", "--whitespace=nowarn"];
      if (checkOnly) flags.push("--check");
      if (reverse) flags.push("--reverse");
      if (threeWay) flags.push("--3way");
      const result = await runCommand({
        command: `git ${flags.map((flag) => JSON.stringify(flag)).join(" ")} -`,
        cwd,
        stdin: patchText,
        timeoutMs: 120_000,
        maxOutputBytes: DEFAULT_OUTPUT_BYTES,
      });
      await audit(name, args, { exitCode: result.exitCode, checkOnly, reverse, threeWay, durationMs: result.durationMs });
      return result;
    }

    case "codex_thread_read": {
      const threadId = requireString(args, "thread_id");
      const includeTurns = optionalBoolean(args, "include_turns", true);
      const timeoutMs = optionalInteger(args, "timeout_ms", 30_000, 1_000, 120_000);
      const result = await callCodexAppServer("thread/read", { threadId, includeTurns }, timeoutMs);
      await audit(name, args, { threadId, includeTurns, ok: true });
      return result;
    }

    case "codex_thread_list": {
      const timeoutMs = optionalInteger(args, "timeout_ms", 30_000, 1_000, 120_000);
      const params = {
        limit: optionalInteger(args, "limit", 50, 1, 200),
        sortKey: optionalString(args, "sort_key", "recency_at"),
        sortDirection: optionalString(args, "sort_direction", "desc"),
      };
      if (args?.cursor !== undefined) params.cursor = optionalString(args, "cursor");
      if (args?.search_term !== undefined) params.searchTerm = optionalString(args, "search_term");
      if (args?.cwd !== undefined) params.cwd = resolvePath(optionalString(args, "cwd"));
      if (args?.archived !== undefined) params.archived = optionalBoolean(args, "archived");
      if (args?.is_pinned !== undefined) params.isPinned = optionalBoolean(args, "is_pinned");
      if (args?.use_state_db_only !== undefined) params.useStateDbOnly = optionalBoolean(args, "use_state_db_only");
      if (args?.model_providers !== undefined) params.modelProviders = optionalStringArray(args, "model_providers");
      if (args?.source_kinds !== undefined) params.sourceKinds = optionalStringArray(args, "source_kinds");
      const result = await callCodexAppServer("thread/list", params, timeoutMs);
      await audit(name, args, { count: Array.isArray(result?.data) ? result.data.length : null, ok: true });
      return result;
    }

    case "codex_thread_turns_list": {
      const timeoutMs = optionalInteger(args, "timeout_ms", 30_000, 1_000, 120_000);
      const params = {
        threadId: requireString(args, "thread_id"),
        limit: optionalInteger(args, "limit", 50, 1, 200),
        sortDirection: optionalString(args, "sort_direction", "asc"),
        itemsView: optionalString(args, "items_view", "full"),
      };
      if (args?.cursor !== undefined) params.cursor = optionalString(args, "cursor");
      const result = await callCodexAppServer("thread/turns/list", params, timeoutMs);
      await audit(name, args, { threadId: params.threadId, count: Array.isArray(result?.data) ? result.data.length : null, ok: true });
      return result;
    }

    case "audit_tail": {
      const maxBytes = optionalInteger(args, "max_bytes", 200_000, 1_024, 8_000_000);
      const result = { path: AUDIT_LOG, ...(await tailFile(AUDIT_LOG, maxBytes)) };
      await audit(name, args, { returnedBytes: result.returnedBytes });
      return result;
    }

    case "pty_start": {
      const command = requireString(args, "command");
      // Every argument re-validated by hand and clamped to the same bounds the
      // schema advertises: the schema is a hint to the client, not an enforcement
      // boundary, and this endpoint is publicly reachable.
      const argv = optionalStringArray(args, "args", []);
      if (argv.length > 256) throw new Error("'args' must contain at most 256 entries");
      const cwd = resolvePath(optionalString(args, "cwd", HOME));
      const env = normalizeEnv(args?.env);
      if (Object.keys(env).length > 64) throw new Error("'env' must contain at most 64 properties");
      const cols = optionalInteger(args, "cols", 120, 20, 500);
      const rows = optionalInteger(args, "rows", 30, 5, 200);
      const term = optionalString(args, "term", "xterm-256color");
      if (!PTY_TERMS.includes(term)) throw new Error(`'term' must be one of ${PTY_TERMS.join(", ")}`);
      // Clamp to the operator's configured window. The schema range is the absolute
      // bound; PTY_IDLE_TIMEOUT_MS is the operator's policy, and a request may only
      // shorten it. Without the min(), a model could ask for an hour against a
      // 60-second reclaim setting and hold a live pty 60x longer than configured —
      // README already documents the intended behaviour as "may request less".
      const idleTimeoutMs = Math.min(
        PTY_IDLE_TIMEOUT_MS,
        optionalInteger(args, "idle_timeout_ms", PTY_IDLE_TIMEOUT_MS, 30_000, 3_600_000),
      );
      const label = optionalString(args, "label", path.basename(command)).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "pty";
      try {
        const session = await startPtySession({ command, args: argv, cwd, env, cols, rows, term, idleTimeoutMs, label });
        const result = {
          sessionId: session.id,
          leaderPid: session.leaderPid,
          helperPid: session.helperPid,
          pts: session.pts,
          cols: session.cols,
          rows: session.rows,
          term,
          cwd,
          command: session.command,
          args: argv,
          idleTimeoutMs,
          startedAt: new Date(session.createdAt).toISOString(),
          cursor: 0,
        };
        await audit(name, args, { sessionId: session.id, leaderPid: session.leaderPid, pts: session.pts, command: session.command });
        return result;
      } catch (error) {
        await audit(name, args, { code: error?.code || null }, error);
        throw error;
      }
    }

    case "pty_read": {
      const sessionId = requirePtySessionId(args);
      const cursor = optionalInteger(args, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
      const maxBytes = optionalInteger(args, "max_bytes", 65_536, 1_024, 1_000_000);
      const stripAnsi = optionalBoolean(args, "strip_ansi", true);
      const collapseCarriageReturns = optionalBoolean(args, "collapse_carriage_returns", true);
      const waitMs = optionalInteger(args, "wait_ms", 0, 0, 30_000);
      // Reading an exited session is deliberately not an error: its final output is
      // the most valuable thing it produced.
      const session = getPtySession(sessionId);
      // Throttled to at most one ps per PTY_TTY_REFRESH_MS per session, so a
      // polling reader does not put a fork in its own loop.
      refreshPtyTtyTargets(session);
      if (waitMs > 0 && session.ring.total <= cursor && !session.exited) await waitForPtyOutput(session, waitMs);
      const slice = ptySliceForCursor(session, cursor, maxBytes);
      // Measured before the read is recorded, so it answers "how long had this
      // session been unattended" rather than always answering zero.
      const idleMs = Date.now() - session.lastActivityAt;
      session.lastActivityAt = Date.now();
      session.lastReadAt = session.lastActivityAt;
      const result = {
        sessionId,
        cursor,
        nextCursor: slice.nextCursor,
        text: renderPtyText(slice.bytes, { stripAnsi, collapseCarriageReturns }),
        lostBytes: slice.lostBytes,
        truncated: slice.truncated,
        totalBytes: slice.totalBytes,
        retainedBytes: slice.retainedBytes,
        exited: session.exited,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        closeReason: session.closeReason,
        cols: session.cols,
        rows: session.rows,
        idleMs,
      };
      // Byte counts and offsets only. The transcript itself is never audited: it
      // contains everything typed at a prompt, including what a no-echo prompt
      // deliberately kept off the screen.
      await audit(name, args, {
        sessionId,
        cursor,
        nextCursor: result.nextCursor,
        returnedBytes: slice.bytes.length,
        lostBytes: slice.lostBytes,
        exited: session.exited,
      });
      return result;
    }

    case "pty_write": {
      const sessionId = requirePtySessionId(args);
      const data = requireString(args, "data", { allowEmpty: true });
      const session = getPtySession(sessionId);
      const payload = Buffer.from(data, "utf8");
      if (payload.length > PTY_WRITE_MAX) {
        throw ptyError("PTY_WRITE_TOO_LARGE", `'data' is ${payload.length} bytes; the limit is ${PTY_WRITE_MAX}`);
      }
      if (session.exited) throw ptyError("PTY_EXITED", `pty session '${sessionId}' has finished (exitCode=${session.exitCode}, exitSignal=${session.exitSignal}); start a new session with pty_start`);
      // Same throttle as pty_read. A write is usually what CREATES a new process
      // force: a write is the ONLY operation that can create a terminal member, so this
      // scan must not be throttled away. Deferring it to "the next call" meant a job
      // backgrounded and abandoned in the same breath was never recorded at all.
      refreshPtyTtyTargets(session, { force: true });
      const stdin = session.child.stdin;
      if (!stdin.writable || stdin.destroyed) throw ptyError("PTY_EXITED", `pty session '${sessionId}' is no longer accepting input`);
      // Refused rather than queued: an unbounded outbound buffer on a public
      // endpoint is the same memory-exhaustion vector as an unbounded ring.
      if (stdin.writableLength > PTY_WRITE_MAX) {
        throw ptyError("PTY_WRITE_BLOCKED", `pty session '${sessionId}' already has ${stdin.writableLength} bytes of unread input; retry once the program consumes it`);
      }
      // A byte count measured at a pipe is not a report about the program.
      //
      // In canonical mode the Darwin line discipline DISCARDS a whole line at or
      // over MAX_CANON (1024) — it does not truncate it. Measured on the shipped
      // code: 1023 bytes arrived intact; 1024, 2000, 4096, 20000 and 65000 all
      // arrived as literally nothing while pty_write returned the full
      // bytesWritten. Splitting the same line into 200-byte chunks failed
      // identically, because the limit is on the line the discipline is
      // assembling, not on the write. Canonical mode is the default for every
      // session and for every interactive prompt this tool exists to drive, so
      // that path silently ate SSH keys, commit bodies and base64 blobs.
      //
      // The mode is only knowable from inside the session (`stty raw` is
      // invisible from out here), so the helper is asked — but only when the
      // payload actually contains an over-long line. Ordinary typing costs no
      // extra round trip.
      const runs = canonicalRuns(payload);
      // MAX_CANON applies to the line the discipline is ASSEMBLING, not to one
      // write, so bytes carried over from earlier writes count. Measured: the same
      // over-long line sent as 200-byte chunks was discarded exactly as the single
      // write was.
      const longestLineRun = Math.max(session.canonPendingBytes + runs.first, runs.longest);
      let canonical = null;
      if (longestLineRun >= PTY_MAX_CANON) {
        let termios;
        try {
          termios = await sendPtyControl(session, "termios", { op: "termios" }, PTY_ACK_TIMEOUT_MS);
        } catch (error) {
          // A session that ended while we were asking is an exited session, not an
          // unreadable mode. Reporting it as the latter would send the caller
          // looking for a terminal problem that no longer exists.
          if (error?.code === "PTY_EXITED") throw error;
          throw ptyError(
            "PTY_WRITE_MODE_UNKNOWN",
            `this write would make the terminal's current input line ${longestLineRun} bytes, at or over the ${PTY_MAX_CANON}-byte MAX_CANON limit at which a canonical-mode line discipline discards the line entirely. The mode could not be read back (${error?.message || error}), so the write was refused rather than reported as delivered. Send lines of at most ${PTY_MAX_CANON - 1} bytes.`,
          );
        }
        // ok:0 is the helper reporting that POSIX::Termios->getattr FAILED. It
        // still sends icanon:0 alongside it, and reading that as "raw mode" reads
        // a failed measurement as a measurement of raw — so the over-long line was
        // written and reported delivered, which is the precise outcome
        // PTY_WRITE_CANON_LIMIT exists to prevent. PTY_WRITE_MODE_UNKNOWN
        // previously covered only a rejected promise: a timeout or a closed pipe,
        // never an answer that says "I could not read it".
        //
        // Not hypothetical: measured on this machine, once the session leader
        // exits Darwin revoke()s the controlling terminal and getattr on the
        // helper's own slave fd fails with ENOTTY, producing exactly this reply.
        if (termios.ok !== 1 && termios.ok !== true) {
          throw ptyError(
            "PTY_WRITE_MODE_UNKNOWN",
            `this write would make the terminal's current input line ${longestLineRun} bytes, at or over the ${PTY_MAX_CANON}-byte MAX_CANON limit at which a canonical-mode line discipline discards the line entirely. The helper could not read the line discipline's state back from the kernel (termios getattr failed), so the mode is unknown and the write was refused rather than reported as delivered. Send lines of at most ${PTY_MAX_CANON - 1} bytes.`,
          );
        }
        canonical = termios.icanon === 1 || termios.icanon === true;
        if (canonical) {
          throw ptyError(
            "PTY_WRITE_CANON_LIMIT",
            `this write would make the terminal's current input line ${longestLineRun} bytes with no \\r or \\n, and the session is in canonical mode, where the line discipline DISCARDS any line of ${PTY_MAX_CANON} bytes or more rather than truncating it — the program would receive none of it. Send lines of at most ${PTY_MAX_CANON - 1} bytes, or have the program put the terminal in raw mode first.`,
          );
        }
        // Raw mode has no canonical line buffer, so the carry-over is meaningless
        // and must not accumulate into a probe on every subsequent keystroke.
        session.canonPendingBytes = 0;
      }
      stdin.write(payload);
      // In raw mode there is no canonical line being assembled, so nothing carries
      // over — otherwise a TUI session would re-probe on every keystroke once its
      // running total passed MAX_CANON.
      session.canonPendingBytes = canonical === false
        ? 0
        : (runs.hasTerminator ? runs.trailing : session.canonPendingBytes + payload.length);
      session.lastActivityAt = Date.now();
      const result = {
        sessionId,
        bytesWritten: payload.length,
        // Honest about what was actually established. null means "not checked":
        // every line this write touches is comfortably under MAX_CANON, so the
        // mode does not change the outcome.
        canonicalMode: canonical,
        pendingLineBytes: longestLineRun,
      };
      await audit(name, args, result);
      return result;
    }

    case "pty_resize": {
      const sessionId = requirePtySessionId(args);
      const cols = optionalInteger(args, "cols", undefined, 20, 500);
      const rows = optionalInteger(args, "rows", undefined, 5, 200);
      if (cols === undefined || rows === undefined) throw new Error("'cols' and 'rows' are required");
      const session = getPtySession(sessionId);
      if (session.exited) throw ptyError("PTY_EXITED", `pty session '${sessionId}' has finished; nothing to resize`);
      const event = await sendPtyControl(session, "resize", { op: "resize", cols, rows }, PTY_ACK_TIMEOUT_MS);
      session.lastActivityAt = Date.now();
      const ok = (event.ok === 1 || event.ok === true) && event.confirmed === 1 && event.cols === cols && event.rows === rows;
      if (!ok) {
        // Never report a resize that the kernel did not confirm. A pty_resize that
        // echoes the requested numbers is indistinguishable from one that did
        // nothing, which is exactly the failure that ruled out script(1).
        throw ptyError("PTY_RESIZE_UNCONFIRMED", `resize to ${cols}x${rows} was not confirmed; the kernel reports ${event.cols}x${event.rows}`);
      }
      const result = { sessionId, ok: true, cols: event.cols, rows: event.rows };
      await audit(name, args, result);
      return result;
    }

    case "pty_signal": {
      const sessionId = requirePtySessionId(args);
      const signal = requireString(args, "signal");
      // Validated against the enum here, not just in the schema. shell_job_kill
      // hands its signal straight to process.kill; that is survivable for a fixed
      // four-value enum, but this list is longer and the target is a process group.
      if (!PTY_SIGNALS.includes(signal)) {
        throw ptyError("PTY_SIGNAL_NOT_ALLOWED", `'signal' must be one of ${PTY_SIGNALS.join(", ")}`);
      }
      const session = getPtySession(sessionId);
      if (session.exited) throw ptyError("PTY_EXITED", `pty session '${sessionId}' has finished; nothing to signal`);
      const event = await sendPtyControl(session, "signal", { op: "signal", sig: signal }, PTY_ACK_TIMEOUT_MS);
      session.lastActivityAt = Date.now();
      const result = {
        sessionId,
        delivered: event.delivered === 1 || event.delivered === true,
        signal,
        targetProcessGroup: session.leaderPid,
        note: "Delivered to the whole process group. Use pty_write with \\u0003 to interrupt only the foreground program.",
      };
      if (!result.delivered) throw ptyError("PTY_SIGNAL_UNCONFIRMED", `pty helper could not deliver ${signal} to process group ${session.leaderPid}`);
      await audit(name, args, result);
      return result;
    }

    case "pty_close": {
      const sessionId = requirePtySessionId(args);
      const force = optionalBoolean(args, "force", false);
      const graceMs = optionalInteger(args, "grace_ms", PTY_CLOSE_GRACE_MS, 0, 10_000);
      const session = getPtySession(sessionId);
      const reason = session.closeReason || (force ? "force_closed" : "closed");
      // Before the SIGTERM, not after: the graceful path usually ends with the
      // leader AND the helper gone, and once the helper releases the master fd
      // /dev/ttysNNN can belong to somebody else, so it can no longer be scanned
      // safely. Recorded here with each process's start time, and re-verified
      // against it before anything is signalled.
      beginPtyTtyScanBudget();
      snapshotPtyTtyProcesses(session);
      if (!force && !session.exited) {
        try {
          await sendPtyControl(session, "signal", { op: "signal", sig: "TERM" }, PTY_ACK_TIMEOUT_MS).catch(() => {});
        } catch {}
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline && !session.exited) await new Promise((r) => setTimeout(r, 25));
      }
      // A fresh budget: the grace period above may have consumed the first one,
      // and this is an interactive close, not the exit path.
      const killed = killPtySession(session, reason);
      // Bounded retry because a SIGKILLed leader stays visible as a zombie until
      // it is reaped. Allowed to come back false: a grandchild that called
      // setsid() AND redirected away from the terminal escapes both the group kill
      // and the tty sweep, exactly as shell_start does, and saying so is better
      // than claiming containment.
      const containment = await verifyPtyContainment(session, 1_000);
      // Pruned on a clean close, kept on a crash: this file is a tombstone for
      // scripts/disable.sh and never read back to resume anything, so leaving it
      // behind after an orderly close would only accumulate entries that name a
      // process group that no longer exists.
      await fsp.rm(session.metadataPath, { force: true }).catch(() => {});
      syncPtyTimers();
      const result = {
        sessionId,
        reason,
        leaderGroupKilled: killed.leaderGroupKilled,
        leaderGroupError: killed.leaderGroupError,
        helperKilled: killed.helperKilled,
        leaderGroupGone: containment.leaderGroupGone,
        // Processes that were sharing the session's controlling terminal but not
        // its process group — the ordinary `cmd &` case — killed individually.
        ttyProcessesKilled: killed.ttyProcessesKilled,
        // Recorded on this terminal earlier, but the pid is somebody else's
        // process now, so it was deliberately NOT signalled.
        ttyRecycledSkipped: killed.ttyRecycledSkipped,
        // True only when the leader group is gone AND nothing that shared the
        // terminal survived. It is not a claim about a descendant that both
        // called setsid() and detached from the tty.
        containmentVerified: containment.contained,
        uncontainedPids: containment.survivors,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        totalBytes: session.ring.total,
      };
      await audit(name, args, result);
      return result;
    }

    default:
      // Federated tools are routed here, AFTER assertStillUnlocked at the top of
      // this function, so they inherit the revocation entry check unchanged
      // rather than needing their own copy of it.
      if (federation.hasTool(name)) return await federation.callTool(name, args);
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const id = message.id;
  const method = message.method;

  if (typeof method !== "string") {
    if (id !== undefined) sendError(id, -32600, "Invalid Request");
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    legacyInitialized = true;
    return;
  }
  if (method === "notifications/cancelled" || method === "notifications/cancelled_request") return;

  if (method === "server/discover") {
    sendResult(id, {
      resultType: "complete",
      supportedVersions: [MODERN_PROTOCOL, "2025-11-25", "2025-06-18"],
      capabilities: { tools: { listChanged: false } },
      instructions: "This bridge has unrestricted access under the host macOS user. Prefer codex_thread_read over invoking Codex model turns. Use shell_start for long-running commands. Relaxed access is the default: routine HTTP/HTTPS work through the signed-in MDB Chrome workspace and non-Chrome foreground desktop-app control do not require per-site/per-app approval files. Direct Chrome AppleScript/JXA, direct Chrome executable launches, and shell web-open commands are always blocked in both Relaxed and Strict modes; Chrome web work must use the chrome_* MDB background tools. Prefer background browser/API paths so the operator keeps focus. If the operator enables Strict approvals in the menu-bar app, scoped browser and non-Chrome foreground-app approvals are required until they turn it off. Do not print secrets unless the user explicitly requests them.",
      ttlMs: 3_600_000,
      cacheScope: "private",
      _meta: resultMeta(),
    });
    return;
  }

  if (method === "initialize") {
    const requested = message?.params?.protocolVersion;
    // Local, not module-level: this value is only echoed in the response below.
    // As a module global it looked like session state that a transport would
    // need to restore after a restart, which it is not. Only legacyInitialized
    // survives a request.
    const negotiatedProtocol = LEGACY_PROTOCOLS.has(requested) ? requested : "2025-11-25";
    sendResult(id, {
      protocolVersion: negotiatedProtocol,
      capabilities: { tools: { listChanged: false } },
      serverInfo: serverInfo(),
      instructions: "This bridge runs without a filesystem sandbox or command allowlist. Effective permissions equal the macOS user running it. Prefer codex_thread_read for persisted Codex history without model usage. On macOS, use the MDB chrome_* background workspace for normal logged-in web work and prefer APIs/connectors over native UI automation. Direct Chrome AppleScript/JXA, direct Chrome executable launches, and shell web-open commands are always refused so Chrome cannot bypass the MDB group or steal focus. Relaxed access is the default and removes approval ceremony; Strict approvals is an operator-controlled optional mode for URL scopes and non-Chrome foreground apps.",
    });
    return;
  }

  const modern = isModernRequest(message);
  if (!modern && !legacyInitialized && method !== "ping") {
    sendError(id, -32002, "Server not initialized");
    return;
  }

  if (method === "ping") {
    sendResult(id, completeResult({}, modern));
    return;
  }

  if (method === "tools/list") {
    // Await the self-test before answering. tools/list is cached by the client for
    // 300s and capabilities.tools.listChanged is false, so a tool set that changed
    // after the first answer would be wrong for five minutes with no way to correct
    // it. Free after the first call: the probe is a settled promise.
    await ptyProbe;
    // Deliberately NOT awaited for native tools; see the dispatch default: branch.
    // tools/list genuinely must wait: the answer is cached by the client for 300s and
    // listChanged is false, so omitting a provider's tools here would be wrong for
    // five minutes with no way to correct it. tools/call does not wait — see below.
    await federationReady;
    sendResult(id, completeResult(
      { tools: advertisedTools() },
      modern,
      modern ? { ttlMs: 300_000, cacheScope: "private" } : null,
    ));
    return;
  }

  if (method === "tools/call") {
    const name = message?.params?.name;
    const args = message?.params?.arguments ?? {};
    if (typeof name !== "string") {
      sendError(id, -32602, "Invalid params: tool name is required");
      return;
    }
    await ptyProbe;
    // Do NOT await federationReady for a native tool.
    //
    // Awaiting it unconditionally meant one slow provider blocked bridge_status — a
    // native, read-only tool — for the whole provider start budget. Capping that
    // budget changed the number (20s to 15s) but not the coupling, and the documented
    // remedy of raising the deadline restored the original 20s exactly. A federated
    // call still waits, because it cannot be routed until the tool set is known.
    const federatedCall = typeof name === "string" && name.includes("__");
    if (federatedCall) await federationReady;
    // The same set tools/list advertised. A pty tool that is not advertised must be
    // -32601 here too: "advertised but fails at call time" and "callable but
    // unadvertised" are both ways of reporting a capability the host does not have.
    if (!advertisedTools().some((tool) => tool.name === name)) {
      sendError(id, -32601, `Unknown tool: ${name}`);
      return;
    }
    try {
      const value = await dispatchTool(name, args);
      // Discriminated escape for federated results. toolTextResult flattens
      // everything into one text block plus structuredContent, which is right for
      // the bridge's own 22 tools and destroys image, audio and resource content
      // coming back from a child MCP server — a screenshot is two blocks, and the
      // second one is the picture. toolTextResult stays byte-identical for
      // everything that is not a federated result.
      sendResult(id, value && typeof value === "object" && Array.isArray(value.__mcpContent)
        ? completeResult(
          {
            content: value.__mcpContent,
            ...(value.__structured === undefined ? {} : { structuredContent: value.__structured }),
            isError: Boolean(value.__isError),
            ...(value.__meta === undefined ? {} : { _meta: value.__meta }),
          },
          modern,
        )
        : toolTextResult(value, { modern }));
    } catch (error) {
      stderr(`tool ${name} failed: ${error?.stack || error}`);
      await audit(name, args, {}, error);
      // Include `code`. The pty taxonomy (PTY_WRITE_CANON_LIMIT and 14 others) was
      // built, documented in README, and then discarded here — no client could ever see
      // one, and the tests had to regex English prose instead. `name` is dropped: it was
      // always the literal "Error", since these are plain Error objects. Federated tool
      // errors already carry a code, so without this the bridge's own tools and its
      // proxied tools returned differently shaped error envelopes.
      sendResult(id, toolTextResult(
        { error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) },
        { isError: true, modern },
      ));
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    sendError(null, -32700, "Parse error", { detail: String(error?.message || error) });
    return;
  }
  handleMessage(message).catch((error) => {
    stderr(`unhandled request error: ${error?.stack || error}`);
    if (message?.id !== undefined) sendError(message.id, -32603, "Internal error", { detail: String(error?.message || error) });
  });
});

// All three exited with no cleanup, and detached pty groups survive every one.
// SIGTERM is exactly what scripts/disable.sh sends, and mcp-http.mjs sends it to
// this child on its own shutdown, so this path runs in normal operation: without
// teardownAll, disable.sh reclaimed the bridge and printed its containment verdict
// while the pty shells kept running.
rl.on("close", () => {
  teardownAll("transport_closed");
  process.exit(0);
});
process.on("SIGTERM", () => {
  teardownAll("sigterm");
  process.exit(0);
});
process.on("SIGINT", () => {
  teardownAll("sigint");
  process.exit(0);
});
process.on("uncaughtException", (error) => stderr(`uncaught exception: ${error?.stack || error}`));
process.on("unhandledRejection", (error) => stderr(`unhandled rejection: ${error?.stack || error}`));

stderr(`${SERVER_NAME} ${BRIDGE_VERSION} started (pid ${process.pid}, audit=${AUDIT_MODE})`);
