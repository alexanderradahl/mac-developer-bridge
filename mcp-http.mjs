#!/usr/bin/env node
// Streamable-HTTP front end for bridge.mjs, for ChatGPT "Server URL" plugins.
//
// ChatGPT cannot use OpenAI Secure MCP Tunnel on personal accounts, so the
// connection is: ChatGPT -> Cloudflare Tunnel -> this server -> bridge.mjs stdio.
//
// Auth accepts either the static bearer token or an OAuth access token this file
// issues itself. The OAuth half exists because ChatGPT's connector dialog offers
// only OAuth / No Auth / Mixed and has no API-key field at all, so a bearer-only
// server is undiscoverable to it: it probes the well-known documents, finds
// nothing, and reports that the server advertised no supported auth.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ChatgptResponsesError,
  buildChatgptResponsesPendingResponse,
  buildChatgptResponsesResponse,
  chatgptResponsesErrorBody,
  parseChatgptResponsesEnvelope,
  prepareChatgptResponsesRequest,
} from "./lib/chatgpt-responses-adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.MAC_DEV_BRIDGE_ENTRY || path.join(HERE, "bridge.mjs");
const HOST = "127.0.0.1"; // never bind wider; the only intended peer is cloudflared on loopback
const MCP_PATH = "/mcp";
const EXPERIMENTAL_CHATGPT_PATH = "/experimental/chatgpt/conversation";
const CHATGPT_RESPONSES_PATH = "/v1/responses";
const PORT = Number(process.env.MAC_DEV_BRIDGE_HTTP_PORT || 8787);
// Prefer a 0600 file: an environment variable stays readable for the process
// lifetime via `ps eww`, which reads the kernel's exec-time snapshot and is
// therefore unaffected by deleting the key from process.env.
const TOKEN_FILE = process.env.MAC_DEV_BRIDGE_HTTP_TOKEN_FILE || "";

// --- OAuth configuration ---------------------------------------------------
// None of this may ever be required: the test harness sets only the token vars,
// and a missing value here must degrade to "OAuth is unusable", never to a
// refusal to start.
const PUBLIC_URL_RAW = (process.env.MAC_DEV_BRIDGE_PUBLIC_URL || "").trim().replace(/\/+$/, "");
// A bad override is logged and ignored rather than fatal, and the shape is
// checked here so it can never carry a quote, CR or LF into a response header.
const PUBLIC_URL = /^https?:\/\/[^\s"'\\/?#]+$/.test(PUBLIC_URL_RAW) ? PUBLIC_URL_RAW : "";
// Both forms are documented for ChatGPT connectors and the rule selecting
// between them is unknown, so allowlist both rather than betting on one.
// ChatGPT mints a NEW callback path per connector — observed 7WkU7U_Y2vFg on one
// and 9Jf_WtxFPY80 on another — so an exact-match list cannot work: the first
// connector's URL was hardcoded here and every subsequent connector was rejected
// with "Unrecognised redirect_uri".
const DEFAULT_REDIRECT_URIS = ["https://chatgpt.com/connector_platform_oauth_redirect"];

/// True for ChatGPT's per-connector callback shape.
///
/// Validated by PARSING, never by string prefix. A prefix test would accept
/// `https://chatgpt.com.evil.com/connector/oauth/x` and
/// `https://chatgpt.com@evil.com/connector/oauth/x`, turning the authorization
/// endpoint into an open redirect that hands codes to an attacker.
function isChatGptCallback(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (!/^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname)) return false;
  // The raw string must ALREADY be in canonical form. Comparing against the
  // reassembled URL rejects every sloppy variant in one test — a trailing space
  // (new URL silently trims it), an explicit :443, added userinfo, a query or
  // fragment, a different host case, http instead of https, or dot-segments the
  // parser collapsed. Checking the parsed pieces alone let the space through.
  return uri === `https://chatgpt.com${u.pathname}`;
}
// Appends, never replaces: an operator adding their own value must not be able
// to silently drop the measured one.
const REDIRECT_URIS = [
  ...DEFAULT_REDIRECT_URIS,
  ...(process.env.MAC_DEV_BRIDGE_OAUTH_REDIRECT_URIS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];
const OAUTH_SCOPE = "mcp";
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const REFRESH_GRACE_MS = 120_000;
const CODE_TTL_MS = 60_000;
const AUTHREQ_TTL_MS = 300_000;
const MAX_STORED_TOKENS = 256;
const MAX_PENDING_AUTHREQS = 32;
const MAX_PENDING_CODES = 32;
// A flat per-request delay, not a lockout with a counter. POST /authorize is
// reachable from the public tunnel by anyone, so any stateful "too many
// failures" brake is a denial-of-service primitive against the only path that
// can approve the connector: five anonymous requests would deny the operator's
// CORRECT token for as long as the lockout lasted. The token's own entropy (>=24
// printable-ASCII bytes, compared as a sha256 digest) is the anti-guessing
// control; this only removes the value of a fast guessing loop.
const APPROVE_FAIL_DELAY_MS = 250;
// RFC 7636 s4.1 verifier charset. Used for both the verifier and the challenge:
// they are the same alphabet, and rejecting anything else keeps every value that
// reaches a hash or a comparison known-ASCII.
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(78);
}

let TOKEN = "";
if (TOKEN_FILE) {
  // Keep the exit-78 contract: an unreadable path must not surface as a raw
  // ENOENT stack with exit 1.
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch (e) {
    die(`MAC_DEV_BRIDGE_HTTP_TOKEN_FILE could not be read (${TOKEN_FILE}): ${e.code || e.message}`);
  }
  if (!TOKEN) die(`MAC_DEV_BRIDGE_HTTP_TOKEN_FILE is empty: ${TOKEN_FILE}`);
} else {
  TOKEN = process.env.MAC_DEV_BRIDGE_HTTP_TOKEN || "";
}
const MAX_BODY = 8 * 1024 * 1024;
const RESPAWN_BACKOFF_MS = 2_000;

const rawTimeout = Number(process.env.MAC_DEV_BRIDGE_HTTP_TIMEOUT_MS || 600_000);
// A malformed value would otherwise become NaN, and setTimeout(NaN) fires in 1ms.
const REQUEST_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600_000;

if (!TOKEN) die("MAC_DEV_BRIDGE_HTTP_TOKEN is required. Refusing to start without auth.");
if (Buffer.byteLength(TOKEN) < 24) die("MAC_DEV_BRIDGE_HTTP_TOKEN must be at least 24 bytes.");
// Node decodes incoming header bytes as latin1 while env vars arrive as UTF-8, so a
// non-ASCII token would never match on the wire. Fail loudly at startup instead.
if (!/^[\x21-\x7e]+$/.test(TOKEN)) {
  die("MAC_DEV_BRIDGE_HTTP_TOKEN must be printable ASCII without spaces (e.g. openssl rand -hex 32).");
}

// Hash the token, then keep the plaintext out of the child's environment so
// shell_exec and background jobs do not inherit it. bridge.mjs does the same
// for CONTROL_PLANE_API_KEY.
//
// Scope of this guarantee: descendants' environments only. Deleting the key
// from our own process.env does NOT remove it from `ps eww` output, which comes
// from the kernel's exec-time snapshot. With unrestricted shell access already
// granted, an attacker-controlled model could read it back from there. Use
// MAC_DEV_BRIDGE_HTTP_TOKEN_FILE if that matters to you.
const TOKEN_DIGEST = crypto.createHash("sha256").update(TOKEN, "latin1").digest();
// Read the secret before the scrub below removes it, and keep only the digest:
// a client secret is never persisted and never logged, so this is the only copy.
const CLIENT_SECRET_DIGEST = process.env.MAC_DEV_BRIDGE_OAUTH_CLIENT_SECRET
  ? crypto.createHash("sha256").update(process.env.MAC_DEV_BRIDGE_OAUTH_CLIENT_SECRET, "latin1").digest()
  : null;
const CONFIGURED_CLIENT_ID = (process.env.MAC_DEV_BRIDGE_OAUTH_CLIENT_ID || "").trim();
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.MAC_DEV_BRIDGE_HTTP_TOKEN;
delete CHILD_ENV.MAC_DEV_BRIDGE_HTTP_TOKEN_FILE;
delete process.env.MAC_DEV_BRIDGE_HTTP_TOKEN;
// Same reasoning as the bearer token: shell_exec must not be able to read the
// OAuth client credentials out of its own environment.
delete CHILD_ENV.MAC_DEV_BRIDGE_OAUTH_CLIENT_SECRET;
delete CHILD_ENV.MAC_DEV_BRIDGE_OAUTH_CLIENT_ID;
delete CHILD_ENV.MAC_DEV_BRIDGE_OAUTH_REDIRECT_URIS;
delete process.env.MAC_DEV_BRIDGE_OAUTH_CLIENT_SECRET;

const log = (m) => process.stderr.write(`[${new Date().toISOString()}] ${m}\n`);

// Record our own pid so scripts/disable.sh can identify this process exactly.
// Matching on `pgrep -f mcp-http.mjs` cannot distinguish us from another
// checkout, from `node --check mcp-http.mjs`, or from a node binary named
// node22/node24 — all of which produced wrong kill decisions.
const DATA_DIR = process.env.MAC_DEV_BRIDGE_DATA_DIR || path.join(process.env.HOME || "", "Library/Application Support/MacDeveloperBridge");
const PID_FILE = path.join(DATA_DIR, "mcp-http.pid");
const OAUTH_STATE_FILE = path.join(DATA_DIR, "oauth-state.json");
const CHATGPT_RUNTIME_CONFIG_FILE = process.env.MAC_DEV_BRIDGE_CHATGPT_RUNTIME_CONFIG_FILE
  || path.join(DATA_DIR, "chatgpt-runtime.json");
const CHATGPT_PROJECT_ID_PATTERN = /^g-p-[A-Za-z0-9_-]{8,128}$/;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // A recursive mkdir applies `mode` only to directories it creates, so an
  // existing world-readable DATA_DIR would keep leaking the OAuth state file's
  // presence and the pidfile. Tighten it explicitly.
  fs.chmodSync(DATA_DIR, 0o700);
  fs.writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o600 });
} catch (e) {
  log(`could not write pidfile ${PID_FILE}: ${e.message} (disable.sh will fall back to a process scan)`);
}
function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {}
}
process.on("exit", removePidFile);

// ---------------------------------------------------------------------------
// bridge.mjs child process
//
// Requests are re-keyed onto a server-side id before being written to stdin.
// Client ids cannot be trusted to be unique: every MCP client starts its
// counter at 1, so two concurrent conversations would otherwise collide in
// `pending` and receive each other's responses.
// ---------------------------------------------------------------------------
let child = null;
let starting = null;
let nextId = 1;
const pending = new Map(); // serverId -> waiter

// Replayed onto a replacement child. Only `notifications/initialized` matters:
// it sets bridge.mjs's `legacyInitialized`, which gates every non-ping method
// with -32002 (bridge.mjs:1147). Replaying `initialize` would accomplish
// nothing -- bridge.mjs assigns negotiatedProtocol and reads it back one line
// later to echo in the response, and nothing else ever reads it.
let sawInitialized = false;
let lastExit = null; // { code, signal, at }

function alive(proc) {
  return proc.exitCode === null && !proc.signalCode && !proc.stdin.destroyed;
}

function failAllPending(error) {
  for (const [, waiter] of pending) waiter.reject(error);
  pending.clear();
}

function wireChild(proc) {
  readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`unparseable line from bridge: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // server-initiated notification
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.resolve({ ...msg, id: waiter.clientId }); // restore the caller's own id
  });

  // A ChildProcess 'error' with no listener throws. On spawn failure 'exit'
  // never fires, so this is the only path that clears in-flight requests.
  proc.on("error", (e) => {
    log(`bridge process error: ${e.message}`);
    lastExit = { code: null, signal: null, at: Date.now() };
    failAllPending(new Error(`bridge process error: ${e.message}`));
    if (child === proc) child = null;
  });

  // A stdin error after a write was accepted emits no 'exit', so without this
  // the child is never cleared and ensureChild() hands back an unusable process
  // forever — 503 on every request, with the waiter's timer still armed.
  proc.stdin.on("error", (e) => {
    log(`bridge stdin error: ${e.message}; discarding this child`);
    lastExit = { code: null, signal: null, at: Date.now() };
    failAllPending(new Error(`bridge stdin error: ${e.message}`));
    if (child === proc) child = null;
    try {
      proc.kill("SIGKILL");
    } catch {}
  });

  proc.on("exit", (code, signal) => {
    lastExit = { code, signal, at: Date.now() };
    log(`bridge exited code=${code} signal=${signal}; failing ${pending.size} in-flight request(s)`);
    failAllPending(new Error(`bridge process exited (code=${code} signal=${signal})`));
    if (child === proc) child = null;
  });
}

function writeRaw(proc, message) {
  // Writing to an exited child's stdin returns false without throwing or
  // emitting an error, so a waiter registered against it would never settle.
  if (!alive(proc)) throw new Error("bridge process is not running");
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

// Register a waiter whose timer only ever evicts its own entry.
function register(serverId, clientId, resolve, reject, timeoutMs, label) {
  const waiter = { clientId };
  const timer = setTimeout(() => {
    if (pending.get(serverId) === waiter) pending.delete(serverId);
    reject(new Error(`bridge ${label} timed out`));
  }, timeoutMs);
  waiter.resolve = (v) => {
    clearTimeout(timer);
    resolve(v);
  };
  waiter.reject = (e) => {
    clearTimeout(timer);
    reject(e);
  };
  pending.set(serverId, waiter);
  return waiter;
}

async function startChild() {
  // A child that dies on startup (missing unlock file, bad entry path) would
  // otherwise be respawned once per inbound request, forever.
  if (lastExit && Date.now() - lastExit.at < RESPAWN_BACKOFF_MS) {
    throw new Error(
      `bridge exited immediately (code=${lastExit.code}); not respawning yet. ` +
        `bridge.mjs exits 78 when the full-access unlock file is missing.`,
    );
  }

  const proc = spawn(process.execPath, [BRIDGE], {
    stdio: ["pipe", "pipe", "inherit"],
    env: CHILD_ENV,
  });
  wireChild(proc);

  // Only replay on a genuine respawn. lastExit is null before any child died.
  // `child` stays unassigned until the handshake completes, so concurrent
  // callers queue on `starting` instead of receiving a half-initialized child
  // and getting -32002 from bridge.mjs's not-initialized gate.
  // Nothing here awaits, so `proc` cannot have exited yet and neither the write
  // nor the alive() check can throw. A child that dies immediately afterwards
  // (unlock file removed, so bridge.mjs exits 78) is caught by callBridge's
  // write guard and the exit handler instead.
  if (sawInitialized && lastExit) {
    log("replaying initialized notification onto replacement bridge child");
    writeRaw(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  child = proc;
  return proc;
}

function ensureChild() {
  if (child) return Promise.resolve(child);
  if (!starting) {
    starting = startChild().finally(() => {
      starting = null;
    });
  }
  return starting;
}

async function callBridge(message, timeoutMs = REQUEST_TIMEOUT_MS) {
  // Remember the one piece of handshake state a replacement child needs.
  // bridge.mjs:1114 accepts the bare `initialized` alias as well, so a client
  // using that form would otherwise never be replayed and would get -32002 on
  // every call after a respawn, permanently.
  if (message.method === "notifications/initialized" || message.method === "initialized") {
    sawInitialized = true;
  }

  const proc = await ensureChild();

  if (message.id === undefined || message.id === null) {
    writeRaw(proc, message); // notification: no reply expected
    return null;
  }

  const serverId = nextId++;
  return new Promise((resolve, reject) => {
    // waiter.reject, not reject: only the waiter clears the timeout timer.
    const waiter = register(serverId, message.id, resolve, reject, timeoutMs, "request");
    try {
      writeRaw(proc, { ...message, id: serverId });
    } catch (e) {
      pending.delete(serverId);
      waiter.reject(e);
    }
  });
}

let localBridgeInitialization = null;

async function ensureLocalBridgeInitialized() {
  if (sawInitialized) return;
  if (!localBridgeInitialization) {
    localBridgeInitialization = (async () => {
      const initialized = await callBridge({
        jsonrpc: "2.0",
        id: `local-init-${crypto.randomUUID()}`,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mac-developer-bridge-local-http", version: "1" },
        },
      });
      if (initialized?.error) throw new Error(initialized.error.message || "bridge initialization failed");
      await callBridge({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().finally(() => {
      localBridgeInitialization = null;
    });
  }
  await localBridgeInitialization;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server
//
// ChatGPT cannot be pointed at a static bearer token (its connector dialog has
// no API-key field), and it can neither register dynamically nor use CIMD
// against this server, so the operator pastes a client_id into its
// "User-Defined OAuth Client" field and this file plays the AS itself.
//
// Everything in this section is best-effort: no code path here may throw out of
// a request handler, and none may prevent startup. A state-directory problem has
// to degrade to "the connector needs re-approving", never to a dead endpoint.
// ---------------------------------------------------------------------------

// Memory only. A code or a half-finished consent that survived a restart would
// be a security regression, and a 60s/300s lifetime makes a restart mid-flow a
// retry rather than a broken connector.
const authReqs = new Map(); // rid -> validated authorization request
const codes = new Map(); // sha256hex(code) -> issued authorization code

// Rotating the bearer token must revoke every OAuth session. Persisting a digest
// of the digest lets the next start detect the rotation without ever storing
// anything that could be replayed. This is what makes the menubar's existing
// Rotate Token button revoke connector sessions with zero Swift changes.
const BEARER_EPOCH = crypto.createHash("sha256").update(TOKEN_DIGEST).digest("hex");

const HEX64 = /^[0-9a-f]{64}$/;

function sha(s) {
  return crypto.createHash("sha256").update(s, "latin1").digest();
}

function emptyStore() {
  return { v: 1, bearerEpoch: BEARER_EPOCH, client: { id: "", createdAt: 0 }, access: new Map(), refresh: new Map() };
}

// Only well-formed digests are rehydrated. A truncated or hand-edited `d` would
// otherwise reach Buffer.from(..., "hex") inside authorized(), where a
// short buffer makes timingSafeEqual throw -- and that throw turns a 401 into a
// 500 for every request.
function rehydrate(list, now) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.d !== "string" || !HEX64.test(r.d)) continue;
    if (typeof r.exp !== "number" || !Number.isFinite(r.exp) || r.exp <= now) continue;
    map.set(r.d, {
      digest: r.d,
      exp: r.exp,
      cid: typeof r.cid === "string" ? r.cid : "",
      aud: typeof r.aud === "string" ? r.aud : "",
      scope: OAUTH_SCOPE,
    });
  }
  return map;
}

function loadStore() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(OAUTH_STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") log(`oauth state unreadable (${e.code || e.message}); starting with empty OAuth state`);
    return emptyStore();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyStore();
  const now = Date.now();
  const next = emptyStore();
  if (parsed.client && typeof parsed.client.id === "string") {
    next.client.id = parsed.client.id;
    next.client.createdAt = typeof parsed.client.createdAt === "number" ? parsed.client.createdAt : 0;
  }
  if (parsed.bearerEpoch !== BEARER_EPOCH) {
    // The client_id survives deliberately: ChatGPT still holds it, and the
    // operator would otherwise have to rebuild the connector from scratch after
    // every rotation instead of just re-approving.
    const access = rehydrate(parsed.access, now).size;
    const refresh = rehydrate(parsed.refresh, now).size;
    if (access || refresh || parsed.bearerEpoch) {
      log(`bearer token rotated: revoked ${access} OAuth access and ${refresh} refresh token(s)`);
    }
    // Rewritten immediately by the caller. Without that the revoked digests and
    // the stale epoch stay on disk, and every later restart re-reports the same
    // rotation.
    next.rewrite = true;
    return next;
  }
  next.access = rehydrate(parsed.access, now);
  next.refresh = rehydrate(parsed.refresh, now);
  return next;
}

// Prune expired, then cap by dropping the soonest-expiring first, so the file
// cannot grow without bound under a client that refreshes before every call.
function serialise(map) {
  const now = Date.now();
  const out = [];
  for (const [hex, rec] of map) {
    if (rec.exp <= now) {
      map.delete(hex);
      continue;
    }
    out.push({ d: hex, exp: rec.exp, cid: rec.cid, aud: rec.aud, scope: rec.scope });
  }
  if (out.length > MAX_STORED_TOKENS) {
    out.sort((a, b) => a.exp - b.exp);
    for (const rec of out.splice(0, out.length - MAX_STORED_TOKENS)) map.delete(rec.d);
  }
  return out;
}

function saveStore() {
  // Every caller is inside a request handler, so a throw here would surface as a
  // 500 from /token. Swallow and log instead: losing persistence costs a
  // re-approval, losing the response costs the connector.
  try {
    const body = JSON.stringify({
      v: 1,
      bearerEpoch: BEARER_EPOCH,
      client: store.client,
      access: serialise(store.access),
      refresh: serialise(store.refresh),
    });
    // Atomic: SIGTERM can land mid-write, and a truncated file would lose the
    // client_id, which permanently breaks the connector in ChatGPT.
    fs.writeFileSync(`${OAUTH_STATE_FILE}.tmp`, body, { mode: 0o600 });
    fs.renameSync(`${OAUTH_STATE_FILE}.tmp`, OAUTH_STATE_FILE);
  } catch (e) {
    log(`could not persist OAuth state to ${OAUTH_STATE_FILE}: ${e.message}`);
  }
}

let store = emptyStore();
try {
  if (PUBLIC_URL_RAW && !PUBLIC_URL) {
    log(`ignoring malformed MAC_DEV_BRIDGE_PUBLIC_URL (expected e.g. https://host.example); falling back to the Host header`);
  }
  store = loadStore();
  if (!store.client.id) {
    store.client.id = CONFIGURED_CLIENT_ID || `mdb-${crypto.randomBytes(16).toString("hex")}`;
    store.client.createdAt = Date.now();
    store.rewrite = true;
  }
  if (store.rewrite) saveStore();
  // Logged because the operator has to type it into ChatGPT's User-Defined
  // OAuth Client field, and there is no other place it is exposed. A client
  // secret is never logged.
  log(`oauth client_id=${store.client.id} (paste into ChatGPT's OAuth Client ID field)`);
} catch (e) {
  log(`OAuth state initialisation failed: ${e.message}; OAuth will be unavailable this run`);
}

// Trusting Host is defensible ONLY while nothing security-decisive is derived
// from it: the metadata is public and secret-free (a forged Host poisons only
// the forger's own response), the tokens are opaque random bytes rather than
// signed JWTs so there is no issuer-confusion attack, and the /authorize
// Location comes from the redirect allowlist rather than from here. The moment a
// change builds a Location, a token audience check, or a signature input out of
// this value, that reasoning collapses.
//
// The regex is not cosmetic: it is the only thing standing between a hostile
// Host header and ERR_INVALID_CHAR inside res.writeHead, which the guard at the
// bottom of this file would turn into a 500 -- and a 500 is not a 401.
function publicOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers.host;
  if (typeof host !== "string") return null;
  if (!/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:\d{1,5})?$/.test(host)) return null;
  // Through cloudflared the public hostname arrives only as Host; there is no
  // x-forwarded-host, and the scheme is only visible in these two headers.
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const visitor = String(req.headers["cf-visitor"] || "");
  const scheme = proto === "https" || visitor.includes('"scheme":"https"') ? "https" : "http";
  return `${scheme}://${host}`;
}

// Exact membership in the allowlist, treating redirect_uri as an opaque string.
// No parsing, no normalisation, no substring match on "chatgpt.com": the value
// is fully attacker-controlled and `new URL("[")` throws.
function allowedRedirect(uri) {
  if (typeof uri !== "string") return null;
  // Exact match first, so an operator-supplied literal keeps working unchanged.
  if (REDIRECT_URIS.includes(uri)) return uri;
  // Then ChatGPT's per-connector shape. The ORIGINAL string is returned, because
  // /token must compare byte-for-byte against what /authorize was given.
  return isChatGptCallback(uri) ? uri : null;
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Normalise just enough to compare an RFC 8707 `resource` against our own
// origin, without handing an attacker-controlled string to `new URL`.
function normaliseResource(value) {
  if (typeof value !== "string" || value.includes("#")) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!m) return null;
  return m[1].toLowerCase() + (m[2] || "").replace(/\/+$/, "");
}

// Both well-known documents are served, one claiming ORIGIN and one claiming
// ORIGIN/mcp, so both values must be accepted here. Absent is always fine:
// ChatGPT has been captured omitting it, and servers that demand it produce
// documented refresh failures.
function resourceAccepted(value, origin) {
  if (value === null || value === undefined) return true;
  const got = normaliseResource(value);
  if (got === null) return false;
  const base = origin.toLowerCase();
  return got === base || got === base + MCP_PATH;
}

function mintToken(map, clientId, aud, ttlMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  const hex = sha(token).toString("hex");
  map.set(hex, { digest: hex, exp: Date.now() + ttlMs, cid: clientId, aud, scope: OAUTH_SCOPE });
  return token;
}

// Confirm a Map hit with a constant-time compare. The lookup is O(1) location
// only; the authoritative comparison is timingSafeEqual, which gives constant
// time without a linear scan over 256 records on the hot path.
function digestMatches(map, hex) {
  const rec = map.get(hex);
  if (!rec) return null;
  return crypto.timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(rec.digest, "hex")) ? rec : null;
}

// Receives the ALREADY-COMPUTED digest so both credential paths share one
// latin1 decode: re-hashing as utf8 here would silently fail to match any token
// containing a non-ASCII byte. Reads memory only -- it is called from a
// synchronous function that must never await.
function oauthAccessValid(digestBuf) {
  const hex = digestBuf.toString("hex");
  const rec = store.access.get(hex);
  if (!rec) return false;
  if (rec.exp <= Date.now()) {
    store.access.delete(hex);
    return false;
  }
  return crypto.timingSafeEqual(digestBuf, Buffer.from(rec.digest, "hex"));
}

// Called before every insert, so a drive-by flood of GET /authorize cannot grow
// either map without bound.
function sweep(map, cap) {
  const now = Date.now();
  for (const [k, v] of map) if (v.exp <= now) map.delete(k);
  if (map.size < cap) return;
  const byExp = [...map.entries()].sort((a, b) => a[1].exp - b[1].exp);
  for (const [k] of byExp.slice(0, map.size - cap + 1)) map.delete(k);
}

function prmDoc(origin, resource) {
  // `resource` must equal the identifier the well-known path was inserted into
  // (RFC 9728 s3.3), which is why the root and /mcp forms are different bodies:
  // a strict client MUST NOT use a document whose value disagrees, and it does
  // so silently -- exactly the "discovered nothing" symptom this fixes.
  return {
    resource,
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Mac Developer Bridge",
  };
}

// One issuer for the whole server, whatever path the document was fetched from.
// The alias paths below previously claimed ORIGIN/mcp, which contradicted the
// `iss` this server puts in the authorization response: RFC 9207 s2.4 makes that
// mismatch a MUST-reject, so a client resolving an alias completed consent,
// received the code and then silently discarded it with nothing reaching /token
// -- the same opaque abort the whole OAuth half exists to eliminate. A strict
// client that inserted a path and gets this root issuer merely declines the
// document (RFC 8414 s3.3) without any grant being approved and thrown away,
// which is a recoverable failure rather than a silent one.
function asDoc(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    revocation_endpoint: `${origin}/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    // Stated explicitly, not defaulted: RFC 8414 defaults these to
    // ["query","fragment"], ["authorization_code","implicit"] and
    // "client_secret_basic", so omitting them would advertise the implicit grant
    // (forbidden by OAuth 2.1) and make a conforming client send a Basic
    // credential that a public client does not have.
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    // MCP 2025-11-25 requires clients to refuse to proceed when this is absent,
    // which surfaces as an opaque client-side abort with nothing reaching /token.
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
  // Deliberately absent: registration_endpoint and
  // client_id_metadata_document_supported (advertising either routes the client
  // into a registration flow this file does not implement), and every OIDC
  // signing/subject field, which is what makes the openid-configuration alias
  // safe -- an OIDC-strict client aborts before it can demand an ID token.
}

// The seven paths clients actually probe. Each protected-resource document
// carries the `resource` matching the URL it was fetched from, because RFC 9728
// s3.3 requires that and both forms are accepted everywhere a resource is
// checked. Every authorization-server document instead carries the single root
// issuer -- see asDoc.
const DISCOVERY = new Map([
  ["/.well-known/oauth-protected-resource", (o) => prmDoc(o, o)],
  [`/.well-known/oauth-protected-resource${MCP_PATH}`, (o) => prmDoc(o, o + MCP_PATH)],
  ["/.well-known/oauth-authorization-server", asDoc],
  [`/.well-known/oauth-authorization-server${MCP_PATH}`, asDoc],
  ["/.well-known/openid-configuration", asDoc],
  [`/.well-known/openid-configuration${MCP_PATH}`, asDoc],
  [`${MCP_PATH}/.well-known/openid-configuration`, asDoc],
]);

// CORS is allowed on the discovery documents only, because they are public and
// secret-free. It must never be copied onto /mcp, /token, /authorize or
// /revoke*: on /mcp it would let any web page in the user's browser drive
// unrestricted shell execution with a replayed token. The two cases are kept
// visibly apart here rather than merged into one header helper, because the
// merge is the reflex that causes that mistake.
const DISCOVERY_HEADERS = {
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

function oauthError(res, status, code, desc) {
  // Single choke point for OAuth failures. Without this, a token exchange that never
  // arrived was indistinguishable from one that arrived and was refused — the exact
  // ambiguity that made a real ChatGPT connection failure undiagnosable.
  // `desc` is always server-authored, never echoed client input, so no secret leaks.
  log(`oauth error ${status} ${code}: ${desc}`);
  return send(res, status, { error: code, error_description: desc }, { "cache-control": "no-store" });
}

const PAGE_CSS =
  "body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem;color:#111}" +
  "h1{font-size:1.3rem}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px;word-break:break-all}" +
  ".warn{border-left:3px solid #b00;background:#fff5f5;padding:.75rem 1rem;margin:1.25rem 0}" +
  ".err{border-left:3px solid #b00;background:#fff5f5;padding:.75rem 1rem;margin:1.25rem 0;font-weight:600}" +
  "dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem .75rem;margin:1.25rem 0}dt{font-weight:600}dd{margin:0}" +
  "input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit}";

function pageHtml(title, body) {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${htmlEscape(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`
  );
}

function sendHtml(res, status, html, { formAction = "'self'" } = {}) {
  return send(res, status, html, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // This page shares an origin with the shell-execution endpoint, so it gets
    // no scripts, no external loads, and no framing. Nothing in it needs any.
    //
    // form-action must name the redirect target, not just 'self'. Chrome and Safari
    // enforce form-action against the REDIRECTS a form submission follows, so with
    // 'self' alone the consent POST succeeded server-side — code minted, 302 returned —
    // and the browser then silently refused to follow it to chatgpt.com. The page just
    // sat there with no error, which is indistinguishable from a dead button.
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; ` +
      "base-uri 'none'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
}

/// CSP form-action value permitting a submit to us plus the redirect we will issue.
///
/// Derived from the ALLOWLISTED literal only, never from raw client input — the value
/// has already passed allowedRedirect(), so this cannot be used to widen the policy.
function formActionFor(redirectUri) {
  try {
    const u = new URL(redirectUri);
    // `URL.origin` is the STRING "null" for non-special schemes, and CSP would read
    // that as a hostname, not a keyword — producing `form-action 'self' null`, which
    // blocks the redirect and reproduces the silent dead-button symptom this function
    // exists to prevent. Native-app callbacks (`myapp://cb`, `com.example:/cb`) are
    // exactly that case, so emit a CSP scheme-source for them instead.
    if (u.origin && u.origin !== "null") return `'self' ${u.origin}`;
    return `'self' ${u.protocol}`;
  } catch {
    return "'self'";
  }
}

function sendErrorPage(res, status, message) {
  return sendHtml(res, status, pageHtml("Authorization failed", `<h1>Authorization failed</h1><p>${htmlEscape(message)}</p>`));
}

// Nothing from the query string reaches this page except through htmlEscape(),
// and the form carries only rid + bearer: state, redirect_uri and code_challenge
// stay server-side in authReqs. That removes the reflected-XSS surface
// structurally instead of relying on escaping every hidden field correctly.
function consentPage(rid, areq, error) {
  const rows = [
    ["This server", areq.iss],
    ["Client ID", areq.clientId],
    ["Will redirect to", areq.redirectUri],
    ["Scope", OAUTH_SCOPE],
  ]
    .map(([k, v]) => `<dt>${htmlEscape(k)}</dt><dd><code>${htmlEscape(v)}</code></dd>`)
    .join("");
  return pageHtml(
    "Authorize connector access",
    `<h1>Authorize connector access</h1>` +
      `<div class="warn"><strong>Approving this grants unrestricted shell access to this Mac.</strong> ` +
      `Anything connecting with the issued token can read, write and run whatever your user account can.</div>` +
      (error ? `<div class="err">${htmlEscape(error)}</div>` : "") +
      `<dl>${rows}</dl>` +
      `<p>Paste the bridge token to approve. It is on the menubar's <em>Copy Token</em> item, ` +
      `or in <code>${htmlEscape(TOKEN_FILE || `${DATA_DIR}/http-token`)}</code>.</p>` +
      `<form method="post" action="/authorize">` +
      `<input type="hidden" name="rid" value="${htmlEscape(rid)}">` +
      `<label for="bearer">Bridge token</label>` +
      `<input id="bearer" type="password" name="bearer" autocomplete="off" autocapitalize="off" spellcheck="false">` +
      `<button type="submit">Approve</button></form>` +
      `<p>Close this tab to deny.</p>`,
  );
}

// Built from the allowlisted literal only. Reflecting the caller's redirect_uri
// string, or interpolating publicOrigin(), would turn this into an open redirect
// on the same origin as /mcp.
function redirectTo(res, literal, params) {
  const query = new URLSearchParams(params).toString();
  const location = literal + (literal.includes("?") ? "&" : "?") + query;
  return send(res, 302, "", { location, "cache-control": "no-store" });
}

function authorizeGet(req, res, url) {
  const q = url.searchParams;
  log(`GET /authorize from ${req.socket.remoteAddress} (ua=${req.headers["user-agent"] || "<none>"})`);

  const origin = publicOrigin(req);
  if (origin === null) return sendErrorPage(res, 400, "This server cannot determine its own public origin from the request.");

  // redirect_uri and client_id are validated BEFORE anything is redirected
  // anywhere. Until both are known-good, an error redirect would itself be the
  // vulnerability.
  const redirectUri = allowedRedirect(q.get("redirect_uri"));
  if (!redirectUri) {
    // Log it: a rejected callback is the most likely reason a connector fails, and
    // without this the rejection is invisible (the error PAGE deliberately does not
    // reflect the value, to avoid turning it into a phishing surface).
    //
    // A callback URL is not a secret, but it IS client input, so it is sanitised
    // before touching the log: control characters stripped so a newline cannot forge
    // a second log line, and truncated so a huge value cannot flood the file.
    log(`rejected redirect_uri: ${String(q.get("redirect_uri") ?? "<absent>").replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 200)}`);
    return sendErrorPage(res, 400, "Unrecognised redirect_uri. Set MAC_DEV_BRIDGE_OAUTH_REDIRECT_URIS if your client uses a different callback.");
  }
  const clientId = q.get("client_id");
  if (!store.client.id || clientId !== store.client.id) {
    return sendErrorPage(res, 400, "Unrecognised client_id. Check the OAuth Client ID configured in your client.");
  }

  const state = q.get("state");
  // Must stay equal to the `issuer` of every authorization-server document this
  // server serves, at every alias path: RFC 9207 s2.4 compares them as exact
  // strings and MUST reject the whole response on any difference.
  const iss = origin;
  const fail = (code, desc) => {
    const params = { error: code, error_description: desc, iss };
    if (state !== null) params.state = state;
    return redirectTo(res, redirectUri, params);
  };

  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  const challenge = q.get("code_challenge");
  if (q.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  if (typeof challenge !== "string" || !PKCE_RE.test(challenge)) return fail("invalid_request", "code_challenge is missing or malformed");
  const resource = q.get("resource");
  if (!resourceAccepted(resource, origin)) return fail("invalid_target", "resource does not identify this server");

  // scope is ignored on purpose: the captured ChatGPT request carries none, so
  // issuance must never be gated on it. "mcp" is granted either way.
  sweep(authReqs, MAX_PENDING_AUTHREQS);
  const rid = crypto.randomBytes(16).toString("hex");
  const areq = { clientId, redirectUri, challenge, state, resource, iss, exp: Date.now() + AUTHREQ_TTL_MS };
  authReqs.set(rid, areq);
  return sendHtml(res, 200, consentPage(rid, areq, ""), { formAction: formActionFor(areq.redirectUri) });
}

async function authorizePost(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, e?.httpStatus || 400, { error: String(e.message || e) });
  }
  // URLSearchParams, never bare decodeURIComponent: the latter throws on "%zz".
  const form = new URLSearchParams(raw);

  const rid = form.get("rid") || "";
  const areq = authReqs.get(rid);
  authReqs.delete(rid); // single use, whatever happens next
  if (!areq || areq.exp <= Date.now()) {
    return sendErrorPage(res, 400, "This approval link expired. Start again from your client.");
  }

  // Proof of possession of the static bearer is the whole gate in front of an
  // otherwise unauthenticated /token. Never accept it in a query string: URLs
  // land in browser history, referrers and logs.
  const got = crypto.createHash("sha256").update(form.get("bearer") || "", "latin1").digest();
  if (!crypto.timingSafeEqual(got, TOKEN_DIGEST)) {
    log(`POST /authorize refused from ${req.socket.remoteAddress}`);
    // Delay only the failure, and hold no state across requests. A correct token
    // is therefore never slowed and never refused, no matter how many wrong ones
    // arrived first -- which is what stops an anonymous caller from denying the
    // operator the one path that can approve the connector.
    await new Promise((r) => setTimeout(r, APPROVE_FAIL_DELAY_MS));
    // Re-issue under a fresh rid rather than saying which half was wrong.
    sweep(authReqs, MAX_PENDING_AUTHREQS);
    const retry = crypto.randomBytes(16).toString("hex");
    authReqs.set(retry, areq);
    return sendHtml(res, 403, consentPage(retry, areq, "That did not match. Check the token and try again."), {
      formAction: formActionFor(areq.redirectUri),
    });
  }

  sweep(codes, MAX_PENDING_CODES);
  const code = crypto.randomBytes(32).toString("base64url");
  const hex = sha(code).toString("hex");
  codes.set(hex, {
    digest: hex,
    challenge: areq.challenge,
    redirectUri: areq.redirectUri,
    clientId: areq.clientId,
    scope: OAUTH_SCOPE,
    resource: areq.resource,
    iss: areq.iss,
    exp: Date.now() + CODE_TTL_MS,
  });
  log(`authorization code issued to ${areq.clientId} for ${areq.redirectUri}`);

  // iss is RFC 9207 mix-up mitigation. The whole response is computed before the
  // first writeHead: a throw afterwards would emit a truncated body under a
  // success status line.
  const params = { code, iss: areq.iss };
  if (areq.state !== null) params.state = areq.state;
  return redirectTo(res, areq.redirectUri, params);
}

// Lenient by design. No verbatim capture of a real ChatGPT POST /token exists,
// so unknown fields are ignored and nothing is ever rejected merely for being
// unexpected. If it sends something surprising, the fix belongs here, not in a
// stricter validator.
function parseForm(req, raw) {
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    try {
      const o = JSON.parse(raw);
      const sp = new URLSearchParams();
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) {
          if (v !== null && v !== undefined && typeof v !== "object") sp.set(k, String(v));
        }
      }
      return sp;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

function formDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function clientCredentials(req, params) {
  let id = params.get("client_id");
  let secret = params.get("client_secret");
  const header = req.headers.authorization;
  if (typeof header === "string" && /^Basic[ \t]+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic[ \t]+/i, "").trim(), "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split >= 0) {
        // RFC 6749 s2.3.1 form-encodes both halves before base64.
        if (!id) id = formDecode(decoded.slice(0, split));
        if (!secret) secret = formDecode(decoded.slice(split + 1));
      }
    } catch {}
  }
  return { id, secret };
}

function issueTokens(res, clientId, aud) {
  const access_token = mintToken(store.access, clientId, aud, ACCESS_TTL_MS);
  // A refresh_token is returned on EVERY success, including refreshes: omitting
  // it lets the ChatGPT connect succeed and then hides every tool, before any
  // expiry. offline_access is deliberately not advertised for it.
  const refresh_token = mintToken(store.refresh, clientId, aud, REFRESH_TTL_MS);
  saveStore();
  // The happy path was silent, so a working exchange left no evidence either.
  log(`oauth token issued to ${clientId} (aud=${aud || "none"}), expires in ${Math.floor(ACCESS_TTL_MS / 1000)}s`);
  return send(
    res,
    200,
    {
      access_token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token,
      scope: OAUTH_SCOPE,
    },
    { "cache-control": "no-store" },
  );
}

async function tokenPost(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, e?.httpStatus || 400, { error: String(e.message || e) });
  }
  const params = parseForm(req, raw);

  const cred = clientCredentials(req, params);
  if (!store.client.id || cred.id !== store.client.id) {
    // No WWW-Authenticate Basic challenge: this is a public client endpoint and
    // a challenge would push a conforming client into an auth method it has no
    // credential for.
    return oauthError(res, 401, "invalid_client", "unknown client_id");
  }
  if (cred.secret) {
    if (CLIENT_SECRET_DIGEST === null) {
      // A secret is optional and must never be REQUIRED, so one that this
      // server was never configured with cannot be a hard failure either --
      // rejecting it would strand a client whose dialog filled the field in.
      log("POST /token presented a client_secret but none is configured; ignoring it");
    } else {
      const got = crypto.createHash("sha256").update(cred.secret, "latin1").digest();
      if (!crypto.timingSafeEqual(got, CLIENT_SECRET_DIGEST)) {
        return oauthError(res, 401, "invalid_client", "client authentication failed");
      }
    }
  }

  const grant = params.get("grant_type");
  log(`POST /token grant_type=${grant === "authorization_code" || grant === "refresh_token" ? grant : "<unsupported>"}`);
  if (grant === "authorization_code") {
    const code = params.get("code");
    if (typeof code !== "string" || !code) return oauthError(res, 400, "invalid_request", "code is required");
    const hex = sha(code).toString("hex");
    // Pop before validating anything: a parallel replay then cannot win, even
    // if validation goes on to fail.
    const rec = codes.get(hex);
    codes.delete(hex);
    if (!rec || !crypto.timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(rec.digest, "hex"))) {
      return oauthError(res, 400, "invalid_grant", "unknown or already-redeemed authorization code");
    }
    if (rec.exp <= Date.now()) return oauthError(res, 400, "invalid_grant", "authorization code expired");
    if (cred.id !== rec.clientId) return oauthError(res, 400, "invalid_grant", "code was issued to another client");
    const redirectUri = params.get("redirect_uri");
    if (redirectUri !== null && redirectUri !== rec.redirectUri) {
      return oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    const verifier = params.get("code_verifier");
    if (typeof verifier !== "string" || !PKCE_RE.test(verifier)) {
      return oauthError(res, 400, "invalid_request", "code_verifier is required and must be 43-128 unreserved characters");
    }
    // PKCE is enforced, not merely advertised. Length is checked first so
    // timingSafeEqual can never see mismatched buffers and throw.
    const computed = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (
      computed.length !== rec.challenge.length ||
      !crypto.timingSafeEqual(Buffer.from(computed, "ascii"), Buffer.from(rec.challenge, "ascii"))
    ) {
      return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    }
    if (!resourceAccepted(params.get("resource"), rec.iss)) {
      return oauthError(res, 400, "invalid_target", "resource does not identify this server");
    }
    return issueTokens(res, rec.clientId, rec.iss);
  }

  if (grant === "refresh_token") {
    const presented = params.get("refresh_token");
    if (typeof presented !== "string" || !presented) return oauthError(res, 400, "invalid_request", "refresh_token is required");
    const hex = sha(presented).toString("hex");
    const rec = digestMatches(store.refresh, hex);
    if (!rec) return oauthError(res, 400, "invalid_grant", "unknown refresh token");
    if (rec.exp <= Date.now()) {
      store.refresh.delete(hex);
      saveStore();
      // Loud, but with NO cascading revocation of the chain: for a single-user
      // bridge whose static bearer never expires anyway, a self-inflicted
      // lockout from one client retry is worse than the detection it buys.
      log(`refresh token reused after the ${REFRESH_GRACE_MS}ms rotation grace window; refusing`);
      return oauthError(res, 400, "invalid_grant", "refresh token expired or already rotated");
    }
    if (cred.id !== rec.cid) return oauthError(res, 400, "invalid_grant", "refresh token was issued to another client");
    if (!resourceAccepted(params.get("resource"), rec.aud || publicOrigin(req) || "")) {
      return oauthError(res, 400, "invalid_target", "resource does not identify this server");
    }
    // Rotate by SHORTENING the old record instead of deleting it. ChatGPT has
    // been observed refreshing before every single tool call and retrying, and a
    // strictly single-use refresh token breaks after the first retry.
    const grace = Date.now() + REFRESH_GRACE_MS;
    if (rec.exp > grace) rec.exp = grace;
    return issueTokens(res, rec.cid, rec.aud);
  }

  return oauthError(res, 400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
}

async function revokePost(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, e?.httpStatus || 400, { error: String(e.message || e) });
  }
  const token = parseForm(req, raw).get("token");
  if (typeof token === "string" && token) {
    const hex = sha(token).toString("hex");
    for (const map of [store.access, store.refresh]) {
      if (digestMatches(map, hex)) map.delete(hex);
    }
    saveStore();
  }
  // RFC 7009 s2.2: 200 even for an unknown or already-expired token, so this
  // cannot be used as an oracle for which tokens exist. Unauthenticated because
  // possession of the token IS the credential.
  return send(res, 200, { ok: true }, { "cache-control": "no-store" });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
// Returns "bearer" | "oauth" | false. Callers that must not accept an OAuth
// token compare against "bearer" directly.
//
// MUST stay synchronous: the call site below does not await, and an unawaited
// Promise is always truthy, so an async version would authorize every request to
// a server fronting unrestricted shell access. Nothing here may await, which is
// why oauthAccessValid reads in-memory Maps and never disk.
function credential(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m) return false;
  // latin1 to match how Node decoded the header off the wire.
  const got = crypto.createHash("sha256").update(m[1], "latin1").digest();
  // Both operands are sha256 digests, so timingSafeEqual can never see
  // mismatched lengths. Comparing raw token bytes instead would make it throw on
  // a wrong-length token, and that throw escapes to the guard at the bottom of
  // this file, which answers 500 -- the 401 would stop being a 401.
  if (crypto.timingSafeEqual(got, TOKEN_DIGEST)) return "bearer";
  return oauthAccessValid(got) ? "oauth" : false;
}

function authorized(req) {
  return credential(req) !== false;
}

// The static bearer has no issuer, audience or expiry, so accepting it is a
// knowing deviation from MCP's "MUST validate that access tokens were issued
// specifically for them". It stays because the menubar's Copy Token flow and the
// named checks in tests/http.mjs depend on it; OAuth is additive, not a
// replacement.
function challengeFor(req) {
  const origin = publicOrigin(req);
  const parts = [];
  if (origin) parts.push(`resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`);
  parts.push(`scope="${OAUTH_SCOPE}"`);
  // RFC 6750 s3: no error information when the request carried no
  // authentication at all -- and that unauthenticated case is exactly the
  // discovery probe.
  if (typeof req.headers.authorization === "string") parts.push(`error="invalid_token"`);
  // One physical line. The RFC 9728 example is printed wrapped, but that is RFC
  // typography: obs-fold is deprecated, and res.writeHead throws
  // ERR_INVALID_CHAR on a value containing CR or LF, which the guard at the
  // bottom of this file would turn into a 500.
  return `Bearer ${parts.join(", ")}`;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers); // no content-type/length; RFC 7230 forbids them on 204
  res.end();
}

// Some Streamable-HTTP clients advertise only text/event-stream and reject a
// plain JSON POST response, so mirror the payload as a single SSE frame.
function sendEventStream(res, body) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}

function wantsEventStream(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/event-stream") && !accept.includes("application/json");
}

// Bounding buffered request bodies.
//
// Three attempts, and the reasoning matters because two of them were wrong:
//
// 1. `MAX_BODY` alone capped ONE body at 8 MiB. But `server.requestTimeout = 0`
//    (needed so a long shell_exec RESPONSE is not cut off) also disables Node's
//    deadline for RECEIVING a body, and `headersTimeout` covers only headers. So a
//    connection could finish its headers then dribble a body staying just under the
//    cap forever, pinning ~8 MiB and never firing `end`. 250 of those reached 1.75 GB
//    and OOM-kill a process fronting unrestricted shell.
// 2. Capping CONCURRENT CONNECTIONS fixed the memory but was a far cheaper denial of
//    service: 48 sockets sending one byte each held every slot for the full timeout,
//    denying all POST routes for ~10 KB of traffic. It also braked POST /authorize —
//    the only path that can approve a connector — which is exactly the primitive the
//    approval-throttle comment above refuses to build.
// 3. This version counts BYTES, because bytes are the resource being protected. Tiny
//    bodies — which is all real traffic here — cost almost nothing and can never
//    exclude anyone. Only an actual attempt to buffer hundreds of megabytes is
//    refused.
//
// The deadline is IDLE-based, not total: it bounds stalls, which is what the attack
// exploits, rather than transfer time. A total deadline would truncate a legitimate
// large `fs_write` (base64 `content` is bounded only by MAX_BODY) whenever the tunnel
// was slower than MAX_BODY/deadline.
function clampMs(raw, fallback) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  if (raw !== undefined && raw !== "") {
    // Never silently fall back: `BODY_IDLE_TIMEOUT_MS=30s` becomes NaN, and
    // setTimeout(NaN) fires in ~1ms, which kills every POST with no response.
    log(`ignoring malformed numeric override ${JSON.stringify(raw)}; using ${fallback}`);
  }
  return fallback;
}

const BODY_IDLE_TIMEOUT_MS = clampMs(process.env.MAC_DEV_BRIDGE_BODY_IDLE_TIMEOUT_MS, 30_000);
const MAX_BUFFERED_BYTES = clampMs(process.env.MAC_DEV_BRIDGE_MAX_BUFFERED_BYTES, 96 * 1024 * 1024);
let bufferedBytes = 0;
let lastLimitLogAt = 0;

function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

// Rate-limited, so the log cannot itself be flooded by the condition it reports.
function logLimit(message) {
  const now = Date.now();
  if (now - lastLimitLogAt < 1000) return;
  lastLimitLogAt = now;
  log(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let counted = 0;   // bytes this request has added to the global budget
    let settled = false;

    const chunks = [];
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      bufferedBytes -= counted;
      clearTimeout(timer);
      fn(arg);
    };

    // Reset on every chunk: a slow-but-progressing upload is legitimate, a stalled
    // one is the attack.
    let timer = setTimeout(onIdle, BODY_IDLE_TIMEOUT_MS);
    function onIdle() {
      logLimit(`request body stalled for ${BODY_IDLE_TIMEOUT_MS}ms; dropping the connection`);
      // Destroy here, unlike the 413/503 paths: a client that has stopped sending is
      // not waiting for a reply, and leaving the socket open is the leak.
      settle(reject, httpError(408, "request body timed out"));
      req.destroy();
    }

    req.on("data", (c) => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(onIdle, BODY_IDLE_TIMEOUT_MS);

      size += c.length;
      counted += c.length;
      bufferedBytes += c.length;

      if (size > MAX_BODY) {
        // Pause rather than destroy, so the 413 actually reaches the client.
        req.pause();
        settle(reject, httpError(413, "request body too large"));
        return;
      }
      if (bufferedBytes > MAX_BUFFERED_BYTES) {
        // Same reasoning: the victim of a global budget is usually an innocent
        // caller, and it needs a retryable 503 rather than a bare TCP reset.
        logLimit(`buffered request bodies exceeded ${MAX_BUFFERED_BYTES} bytes; shedding load`);
        req.pause();
        settle(reject, httpError(503, "server is buffering too much request data; retry shortly"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => settle(resolve, Buffer.concat(chunks).toString("utf8")));
    // A transport failure is not a payload problem; 400 rather than the old 413.
    req.on("error", (e) => settle(reject, e?.httpStatus ? e : httpError(400, String(e?.message || e))));
    req.on("aborted", () => settle(reject, httpError(400, "request aborted")));
  });
}

function isDirectLoopbackRequest(req) {
  const remote = String(req.socket.remoteAddress || "").toLowerCase();
  const loopbackPeer = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!loopbackPeer) return false;
  const host = String(req.headers.host || "").trim();
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  return ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip", "cf-ray"]
    .every((header) => req.headers[header] === undefined);
}

function experimentalToolStatus(result) {
  if (!result?.isError) return 200;
  const code = String(result?.structuredContent?.code || "");
  if (/INVALID|REFUSED|UNKNOWN|SECURITY_FIELDS/i.test(code)) return 400;
  if (/TAB_UNAVAILABLE|SESSION_UNAVAILABLE|PROFILE|EXTENSION_OFFLINE|MODEL_MISMATCH|NOT_READY|NOT_NEW_THREAD/i.test(code)) return 409;
  if (/REQUIREMENTS_UNAVAILABLE|RUNTIME_CONTRACT_CHANGED/i.test(code)) return 424;
  if (/TIMEOUT/i.test(code)) return 504;
  return 502;
}

async function experimentalChatgptConversation(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (!isDirectLoopbackRequest(req)) {
    log(`403 on ${EXPERIMENTAL_CHATGPT_PATH}: direct loopback request required`);
    return send(res, 403, { error: "direct loopback request required" }, { "cache-control": "no-store" });
  }
  if (credential(req) !== "bearer") {
    log(`401 on ${EXPERIMENTAL_CHATGPT_PATH}: static bearer required`);
    return send(res, 401, { error: "static bearer required" }, {
      "cache-control": "no-store",
      "www-authenticate": challengeFor(req),
    });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    return send(res, error?.httpStatus || 400, { error: String(error?.message || error) }, { "cache-control": "no-store" });
  }
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: "expected a JSON object" }, { "cache-control": "no-store" });
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return send(res, 400, { error: "expected a JSON object" }, { "cache-control": "no-store" });
  }

  try {
    await ensureLocalBridgeInitialized();
    const requestedRuntimeSeconds = Number(args.max_runtime_seconds || 600);
    const bridgeTimeoutMs = Math.max(30, Math.min(3600, Number.isFinite(requestedRuntimeSeconds) ? requestedRuntimeSeconds : 600)) * 1000 + 120_000;
    const reply = await callBridge({
      jsonrpc: "2.0",
      id: `experimental-chatgpt-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name: "chatgpt_conversation_start", arguments: args },
    }, bridgeTimeoutMs);
    if (reply?.error) {
      log(`${EXPERIMENTAL_CHATGPT_PATH} bridge error: ${reply.error.message || "unknown"}`);
      return send(res, 502, { error: "bridge request failed" }, { "cache-control": "no-store" });
    }
    const result = reply?.result || {};
    const body = result.structuredContent || (() => {
      const text = result.content?.find((item) => item?.type === "text")?.text;
      try { return JSON.parse(text || "{}"); } catch { return { error: "bridge returned an unreadable result" }; }
    })();
    const status = experimentalToolStatus(result);
    log(`${EXPERIMENTAL_CHATGPT_PATH} completed status=${status} toolError=${Boolean(result.isError)}`);
    return send(res, status, body, { "cache-control": "no-store" });
  } catch (error) {
    log(`${EXPERIMENTAL_CHATGPT_PATH} failed: ${error?.message || error}`);
    return send(res, 503, { error: "bridge unavailable" }, { "cache-control": "no-store" });
  }
}

function responsesEventFrame(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function beginResponsesEventStream(res, pendingResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  res.write(responsesEventFrame({ type: "response.created", response: pendingResponse }));

  let open = true;
  const keepalive = setInterval(() => {
    if (open && !res.writableEnded) res.write(": keep-alive\n\n");
  }, 15_000);
  keepalive.unref?.();
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(keepalive);
  };
  res.once("close", close);

  return {
    complete(response) {
      if (!open || res.writableEnded) return;
      for (const [outputIndex, item] of response.output.entries()) {
        res.write(responsesEventFrame({ type: "response.output_item.done", output_index: outputIndex, item }));
      }
      res.write(responsesEventFrame({ type: "response.completed", response }));
      res.end("data: [DONE]\n\n");
      close();
    },
    fail(error) {
      if (!open || res.writableEnded) return;
      const failedResponse = {
        ...pendingResponse,
        status: "failed",
        error: {
          code: String(error?.code || "chatgpt_responses_error"),
          message: String(error?.message || "ChatGPT runtime model request failed"),
        },
      };
      res.write(responsesEventFrame({ type: "response.failed", response: failedResponse }));
      res.end("data: [DONE]\n\n");
      close();
    },
  };
}

function bridgeStructuredContent(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

function configuredChatgptProjectId() {
  const override = String(process.env.MAC_DEV_BRIDGE_CHATGPT_RESPONSES_PROJECT_ID || "").trim();
  if (override) {
    if (!CHATGPT_PROJECT_ID_PATTERN.test(override)) {
      throw new ChatgptResponsesError("configured ChatGPT Project id is invalid", {
        code: "chatgpt_responses_project_config_invalid",
        httpStatus: 500,
      });
    }
    return override;
  }

  let raw;
  let mode;
  try {
    const stat = fs.statSync(CHATGPT_RUNTIME_CONFIG_FILE);
    mode = stat.mode & 0o777;
    raw = fs.readFileSync(CHATGPT_RUNTIME_CONFIG_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new ChatgptResponsesError("ChatGPT runtime configuration could not be read", {
      code: "chatgpt_responses_project_config_unavailable",
      httpStatus: 500,
    });
  }
  if ((mode & 0o077) !== 0) {
    throw new ChatgptResponsesError("ChatGPT runtime configuration must not be group- or world-readable", {
      code: "chatgpt_responses_project_config_permissions",
      httpStatus: 500,
    });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new ChatgptResponsesError("ChatGPT runtime configuration is not valid JSON", {
      code: "chatgpt_responses_project_config_invalid",
      httpStatus: 500,
    });
  }
  const projectId = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? String(parsed.projectId || "").trim()
    : "";
  if (!CHATGPT_PROJECT_ID_PATTERN.test(projectId)) {
    throw new ChatgptResponsesError("ChatGPT runtime configuration must contain a valid projectId", {
      code: "chatgpt_responses_project_config_invalid",
      httpStatus: 500,
    });
  }
  return projectId;
}

async function chatgptResponses(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { "cache-control": "no-store" });
  if (!isDirectLoopbackRequest(req)) {
    log(`403 on ${CHATGPT_RESPONSES_PATH}: direct loopback request required`);
    return send(res, 403, { error: "direct loopback request required" }, { "cache-control": "no-store" });
  }
  if (credential(req) !== "bearer") {
    log(`401 on ${CHATGPT_RESPONSES_PATH}: static bearer required`);
    return send(res, 401, { error: "static bearer required" }, {
      "cache-control": "no-store",
      "www-authenticate": challengeFor(req),
    });
  }

  let prepared;
  try {
    const raw = await readBody(req);
    prepared = prepareChatgptResponsesRequest(JSON.parse(raw));
  } catch (error) {
    const normalized = error instanceof ChatgptResponsesError
      ? error
      : new ChatgptResponsesError(error instanceof SyntaxError ? "expected a JSON object" : String(error?.message || error));
    log(`${CHATGPT_RESPONSES_PATH} rejected code=${normalized.code} status=${normalized.httpStatus}`);
    return send(res, normalized.httpStatus, chatgptResponsesErrorBody(normalized), { "cache-control": "no-store" });
  }

  let projectId;
  try {
    projectId = configuredChatgptProjectId();
  } catch (error) {
    const normalized = error instanceof ChatgptResponsesError
      ? error
      : new ChatgptResponsesError("ChatGPT runtime configuration failed", { httpStatus: 500 });
    log(`${CHATGPT_RESPONSES_PATH} rejected code=${normalized.code} status=${normalized.httpStatus}`);
    return send(res, normalized.httpStatus, chatgptResponsesErrorBody(normalized), { "cache-control": "no-store" });
  }

  const maxRuntimeSeconds = Math.max(30, Math.min(
    3600,
    Number(process.env.MAC_DEV_BRIDGE_CHATGPT_RESPONSES_MAX_RUNTIME_SECONDS || 600) || 600,
  ));
  const browserModel = prepared.model === "chatgpt-browser"
    ? String(process.env.MAC_DEV_BRIDGE_CHATGPT_RESPONSES_BROWSER_MODEL || prepared.browserModel)
    : prepared.browserModel;
  log(
    `${CHATGPT_RESPONSES_PATH} start model=${prepared.model} stream=${prepared.stream} ` +
      `tools=${prepared.tools.length} promptBytes=${prepared.promptBytes}`,
  );

  const pendingResponse = prepared.stream
    ? buildChatgptResponsesPendingResponse(prepared)
    : null;
  const eventStream = pendingResponse
    ? beginResponsesEventStream(res, pendingResponse)
    : null;

  try {
    await ensureLocalBridgeInitialized();
    const reply = await callBridge({
      jsonrpc: "2.0",
      id: `chatgpt-responses-${crypto.randomUUID()}`,
      method: "tools/call",
      params: {
        name: "chatgpt_conversation_start",
        arguments: {
          prompt: prepared.prompt,
          transport: "runtime",
          model: browserModel,
          thinking_effort: prepared.thinkingEffort,
          max_runtime_seconds: maxRuntimeSeconds,
          continue_in_work: false,
          ...(projectId ? { project_id: projectId } : {}),
        },
      },
    }, maxRuntimeSeconds * 1000 + 120_000);
    if (reply?.error) {
      const error = new ChatgptResponsesError("bridge request failed", {
        code: "chatgpt_responses_bridge_error",
        httpStatus: 502,
      });
      log(`${CHATGPT_RESPONSES_PATH} bridge error`);
      if (eventStream) {
        eventStream.fail(error);
        return;
      }
      return send(res, error.httpStatus, chatgptResponsesErrorBody(error), { "cache-control": "no-store" });
    }
    const result = reply?.result || {};
    const structured = bridgeStructuredContent(result);
    if (result.isError || structured?.ok === false) {
      const error = new ChatgptResponsesError(
        String(structured?.message || structured?.error?.message || "ChatGPT runtime request failed"),
        {
          code: String(structured?.code || structured?.error?.code || "chatgpt_responses_runtime_error"),
          httpStatus: experimentalToolStatus(result),
        },
      );
      log(`${CHATGPT_RESPONSES_PATH} runtime error code=${error.code} status=${error.httpStatus}`);
      if (eventStream) {
        eventStream.fail(error);
        return;
      }
      return send(res, error.httpStatus, chatgptResponsesErrorBody(error), { "cache-control": "no-store" });
    }
    const decision = parseChatgptResponsesEnvelope(structured.assistant_text, prepared);
    const response = buildChatgptResponsesResponse(prepared, decision, pendingResponse || undefined);
    log(`${CHATGPT_RESPONSES_PATH} completed kind=${decision.kind} outputItems=${response.output.length}`);
    if (eventStream) {
      eventStream.complete(response);
      return;
    }
    return send(res, 200, response, { "cache-control": "no-store" });
  } catch (error) {
    const normalized = error instanceof ChatgptResponsesError
      ? error
      : new ChatgptResponsesError("bridge unavailable", {
          code: "chatgpt_responses_bridge_unavailable",
          httpStatus: 503,
        });
    log(`${CHATGPT_RESPONSES_PATH} failed code=${normalized.code} status=${normalized.httpStatus}`);
    if (eventStream) {
      eventStream.fail(normalized);
      return;
    }
    return send(res, normalized.httpStatus, chatgptResponsesErrorBody(normalized), { "cache-control": "no-store" });
  }
}

let loggedFirstRequest = false;

// Node's HTTP parser accepts request targets that `new URL` rejects (`//[/mcp`,
// absolute-form targets, a malformed Host header). Parsing without a guard let
// an unauthenticated single packet throw out of the async handler and kill the
// process before the bearer check ever ran.
function requestUrl(req) {
  try {
    return new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return null;
  }
}

async function handle(req, res) {
  // Parsed once. /authorize needs the query string too, and a second `new URL`
  // outside a try would reintroduce the same kill: a redirect_uri of "[" throws.
  const url = requestUrl(req);
  if (url === null) return send(res, 400, { error: "malformed request target" });
  const pathname = url.pathname;

  // Must stay the first branch: the menubar polls this over loopback with no
  // Host guarantee, so it can never depend on publicOrigin().
  if (req.method === "GET" && pathname === "/healthz") return send(res, 200, { ok: true });

  if (pathname === EXPERIMENTAL_CHATGPT_PATH) {
    return experimentalChatgptConversation(req, res);
  }

  if (pathname === CHATGPT_RESPONSES_PATH) {
    return chatgptResponses(req, res);
  }

  // --- OAuth ---------------------------------------------------------------
  // Exact pathname equality throughout, never startsWith: a prefix match would
  // stop GET /nope from being a 404. None of these routes touches
  // loggedFirstRequest -- that line means "first authorized MCP request", and
  // firing it on an anonymous discovery probe destroys its diagnostic value.
  const discovery = DISCOVERY.get(pathname);
  if (discovery) {
    // Unauthenticated by design: a client that cannot reach discovery cannot
    // learn how to get a token.
    if (req.method === "OPTIONS") return sendEmpty(res, 204, DISCOVERY_HEADERS);
    // GET and HEAD share one path; Node drops the body for HEAD itself.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "method not allowed" }, DISCOVERY_HEADERS);
    }
    const origin = publicOrigin(req);
    if (origin === null) return send(res, 400, { error: "cannot determine public origin" });
    return send(res, 200, discovery(origin), DISCOVERY_HEADERS);
  }

  if (pathname === "/authorize") {
    if (req.method === "GET") return authorizeGet(req, res, url);
    if (req.method === "POST") return authorizePost(req, res);
    return send(res, 405, { error: "method not allowed" });
  }

  if (pathname === "/token") {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    return tokenPost(req, res);
  }

  if (pathname === "/revoke") {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    return revokePost(req, res);
  }

  if (pathname === "/revoke-all") {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    // Static bearer only. An OAuth token must not be able to revoke the
    // operator's other sessions, nor itself out of the audit trail.
    if (credential(req) !== "bearer") {
      log(`401 on /revoke-all from ${req.socket.remoteAddress} (static bearer required)`);
      return send(res, 401, { error: "unauthorized" }, { "www-authenticate": challengeFor(req) });
    }
    const revoked = { access: store.access.size, refresh: store.refresh.size };
    store.access.clear();
    store.refresh.clear();
    codes.clear();
    authReqs.clear();
    saveStore();
    log(`/revoke-all revoked ${revoked.access} access and ${revoked.refresh} refresh token(s); client_id kept`);
    return send(res, 200, { revoked }, { "cache-control": "no-store" });
  }

  // Log every non-health request, including 404s. Clients discover auth support
  // by probing well-known paths, and a silent 404 makes that invisible — which
  // is exactly why a connector could report "the server did not advertise"
  // something with no trace of what it looked for.
  if (pathname !== MCP_PATH) {
    log(`404 ${req.method} ${pathname} (ua=${req.headers["user-agent"] || "<none>"})`);
    return send(res, 404, { error: "not found" });
  }

  if (!authorized(req)) {
    log(`401 from ${req.socket.remoteAddress} (bad or missing bearer token)`);
    // A bare "Bearer" told a client nothing about where to get a token, which is
    // why ChatGPT discovered no auth support at all.
    return send(res, 401, { error: "unauthorized" }, { "www-authenticate": challengeFor(req) });
  }

  if (!loggedFirstRequest) {
    loggedFirstRequest = true;
    // Makes an Accept / protocol-version mismatch diagnosable from the log.
    log(
      `first authorized request: accept=${req.headers.accept || "<none>"} ` +
        `mcp-protocol-version=${req.headers["mcp-protocol-version"] || "<none>"}`,
    );
  }

  // Session termination and the optional SSE stream: nothing to do, but answer
  // cleanly so clients that probe them don't treat it as a transport failure.
  if (req.method === "DELETE") return sendEmpty(res, 204);
  if (req.method === "GET") return send(res, 405, { error: "SSE stream not supported; POST JSON-RPC" });
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return send(res, e?.httpStatus || 400, { error: String(e.message || e) });
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  // `null`, scalars, and arrays must be rejected here. Letting them through
  // crashes the process: callBridge() throws on property access, and the catch
  // handler below would throw again reading msg.id.
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return send(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: Array.isArray(msg)
          ? "JSON-RPC batching is not supported"
          : "Invalid Request: expected a single JSON-RPC object",
      },
    });
  }

  const clientId = msg.id ?? null;
  try {
    const reply = await callBridge(msg);
    if (reply === null) return sendEmpty(res, 202); // notification accepted
    return wantsEventStream(req) ? sendEventStream(res, reply) : send(res, 200, reply);
  } catch (e) {
    const message = String(e?.message || e);
    log(`request failed: ${message}`);
    // Child-unavailable conditions are transient; tell the client so rather
    // than reporting a generic internal error.
    const status = /exited|not running/.test(message) ? 503 : 500;
    return send(res, status, { jsonrpc: "2.0", id: clientId, error: { code: -32603, message } });
  }
}

const server = http.createServer((req, res) => {
  // Last line of defence: an unexpected throw must not terminate a process that
  // fronts unrestricted shell access.
  handle(req, res).catch((e) => {
    log(`unhandled handler error: ${e?.stack || e}`);
    try {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    } catch {}
  });
});

server.requestTimeout = 0; // long shell_exec calls must not be cut off
server.headersTimeout = 65_000;

// bridge.mjs installs the same guards; without them a single stray rejection
// takes the whole endpoint down until someone restarts it by hand.
process.on("uncaughtException", (e) => log(`uncaughtException: ${e?.stack || e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${e?.stack || e}`));

server.on("error", (e) => {
  // EADDRINUSE and friends: exit non-zero so a supervisor sees a real failure.
  log(`server error: ${e?.message || e}`);
  process.exit(74);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}${MCP_PATH} -> ${BRIDGE}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    try {
      child?.kill("SIGTERM");
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
