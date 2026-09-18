// Generic child-MCP federation gateway.
//
// Starts operator-configured MCP servers as child processes, performs the
// handshake (dual-era: 2026-07-28 `server/discover` first, legacy `initialize`
// on any refusal or timeout), fetches their tool schemas, exposes them under a
// per-provider prefix, proxies calls, and preserves image/resource content
// instead of flattening it to text.
//
// Chrome is only the first provider. Nothing in this file names it: `command`
// and `args` are always operator-supplied, which is also what lets the tests run
// against a stub server instead of launching a browser.
//
// Zero imports from bridge.mjs and zero package dependencies. Everything the
// module needs from the host is passed in as a callback, so it is unit-testable
// on its own.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_CLIENT_PROTOCOL = "2025-06-18";
// -32022 UnsupportedProtocolVersionError. A modern server that refuses our
// preferred version answers with this and lists what it does support; that is a
// *negotiation*, not a reason to fall back to the legacy handshake.
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const DISCOVER_TIMEOUT_MS = 3_000;
const INITIALIZE_TIMEOUT_MS = 10_000;
const TOOLS_LIST_TIMEOUT_MS = 15_000;
// ONE wall-clock ceiling for everything Provider.start() does after the spawn:
// flag verification, the handshake, and every tools/list page.
//
// Per-request timeouts do not bound a start, because the requests are sequential
// and a slow-but-answering child never trips one. Measured against a stub that
// answered each tools/list page after 1s: 20 pages x 1s = 20s of startup, and
// bridge_status — a native read-only tool — was unavailable for all of it,
// because bridge.mjs awaits federationReady before answering. The theoretical
// worst case was MAX_TOOLS_PAGES x TOOLS_LIST_TIMEOUT_MS = 300s per provider,
// and providers were started serially, so it was additive across them.
//
// With this deadline and a concurrent startAll, the worst case is this value
// once, no matter how many providers are configured or how slow they are.
//
// 15s is chosen so the handshake path this gateway actually supports still fits
// inside it whole: DISCOVER_TIMEOUT_MS + INITIALIZE_TIMEOUT_MS is 13s, and a child
// slower than that already failed before this deadline existed. What it does
// refuse is a child that answers everything just fast enough to never time out
// and still takes minutes to finish starting. An operator with a genuinely slower
// provider can raise it; a provider that needs more is a provider that holds every
// other tool hostage for that long.
const PROVIDER_START_DEADLINE_MS = clampInt(process.env.MAC_DEV_BRIDGE_MCP_START_DEADLINE_MS, 15_000, 1_000, 120_000);
// Ceiling, enforced whether or not progress notifications arrive. Measured: zero
// notifications/progress from a real child across a 6.6s traced call, so progress
// is not a liveness signal and must never extend a deadline.
const CALL_TIMEOUT_CEILING_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const HTTP_DISCOVERY_TIMEOUT_MS = 2_000;
const HTTP_RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
// The only way to catch a hung-but-alive child. Overridable for tests only: an
// untested liveness check is exactly how "reports healthy while hung" ships.
const PING_IDLE_MS = clampInt(process.env.MAC_DEV_BRIDGE_MCP_PING_IDLE_MS, 30_000, 100, 600_000);
const PING_TIMEOUT_MS = Math.min(10_000, Math.max(100, Math.floor(PING_IDLE_MS / 2)));
const EMPTY_BUFFER = Buffer.alloc(0);
const MAX_TOOLS_PAGES = 20;
const STDERR_RING_LINES = 200;
const DEFAULT_MAX_RESULT_BYTES = 4_000_000;
const MAX_MAX_RESULT_BYTES = 16_000_000;
// An unbounded line accumulator on a publicly reachable endpoint is a
// memory-exhaustion vector, and real children do write non-MCP noise to stdout.
//
// It MUST clear MAX_MAX_RESULT_BYTES, or the configured ceiling is unreachable by
// construction. At 8 MiB it was not: a provider configured for 16 MB returning a
// 12 MB result had its child SIGKILLed instead of getting RESULT_TOO_LARGE, and
// because that kill was charged to the crash-restart budget, six such calls put
// the provider in state=failed until the bridge was restarted. Asking a legitimate
// tool for a full-page PNG six times is not a crash loop.
//
// The bound this buys: one provider can hold at most this many bytes of a single
// unterminated stdout line, transiently, plus one chunk. Complete lines are framed
// out first and never counted, so a chatty child cannot reach it by volume — only
// by writing one enormous line, which is now discarded rather than fatal.
const MAX_PENDING_LINE_BYTES = MAX_MAX_RESULT_BYTES + 2 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;
// Bounded retry for killNow's containment verdict, in the shape bridge.mjs uses
// for pty sessions: poll until contained or until the deadline, then report what
// is still alive. Synchronous, because killNow is called between a revocation
// decision and process.exit and must not yield.
const CONTAINMENT_VERIFY_MS = 500;
const CONTAINMENT_POLL_MS = 25;
// 500ms, 1s, 2s, 4s, 8s then terminal. Each restart of a browser provider spawns
// Node *and* a full Chrome, so unbounded respawn is a self-inflicted denial of
// service cheaper than the failure it is masking.
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
const RESTART_MAX_ATTEMPTS = RESTART_BACKOFF_MS.length;
const RESTART_WINDOW_MS = 600_000;
// A grant longer than this is refused at read time, so a malformed or
// over-generous approval fails closed instead of becoming set-and-forget.
const PERSONAL_APPROVAL_MAX_TTL_MS = 900_000;
const PERSONAL_APPROVAL_FILENAME = "PERSONAL_BROWSER_APPROVED";

// Tool names must survive clients that enforce ^[a-zA-Z0-9_-]{1,64}$ (Anthropic's
// tool API does). The spec-legal dot does not, so the separator is `__`.
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// ---------------------------------------------------------------------------
// Child environment: allowlist, never denylist
// ---------------------------------------------------------------------------

// A denylist leaks every secret added to the operator's shell after this line was
// written. The base environment for a child MCP server is therefore {} plus
// exactly these keys.
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

// Kept as executable documentation even where the variable is already absent from
// process.env: the guarantee must not silently depend on some other line in
// bridge.mjs never moving. Deny always beats a per-provider config entry, so an
// operator cannot re-add one of these by accident.
const ENV_DENYLIST = new Set([
  "CONTROL_PLANE_API_KEY",
  "MAC_DEV_BRIDGE_HTTP_TOKEN",
  "MAC_DEV_BRIDGE_HTTP_TOKEN_FILE",
  "MAC_DEV_BRIDGE_OAUTH_CLIENT_SECRET",
  "MAC_DEV_BRIDGE_OAUTH_CLIENT_ID",
  "MAC_DEV_BRIDGE_OAUTH_REDIRECT_URIS",
  "MAC_DEV_BRIDGE_FULL_ACCESS_ACK",
  "MAC_DEV_BRIDGE_UNLOCK_FILE",
  "MAC_DEV_BRIDGE_DATA_DIR",
  "MAC_DEV_BRIDGE_LOG_DIR",
  // A child that can write the audit log can forge or truncate the record of its
  // own use.
  "MAC_DEV_BRIDGE_AUDIT_LOG",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_API_TOKEN",
]);

const ENV_DENY_PATTERN = /(_TOKEN|_SECRET|_KEY|PASSWORD)$/;

function envKeyDenied(key) {
  if (ENV_DENYLIST.has(key)) return true;
  if (key.startsWith("npm_config_")) return true;
  if (key.startsWith("MAC_DEV_BRIDGE_")) return true;
  return ENV_DENY_PATTERN.test(key);
}

// Honest ceiling, repeated here because the allowlist reads like a sandbox and is
// not one: node and npx genuinely need PATH and HOME, and with HOME set the child
// can read ~/.ssh, ~/.aws and ~/Library/Application Support regardless. This is
// credential hygiene, not isolation.
function buildChildEnv(providerEnv) {
  const env = Object.create(null);
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const skipped = [];
  for (const [key, value] of Object.entries(providerEnv || {})) {
    if (envKeyDenied(key)) {
      skipped.push(key);
      continue;
    }
    env[key] = String(value);
  }
  return { env: { ...env }, skipped };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function validateEnvObject(input, where) {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where}: 'env' must be an object`);
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${where}: invalid environment variable name '${key}'`);
    // null means "delete" for shell tools; the base environment here is already
    // empty, so a null would silently do nothing. Reject it rather than accept a
    // no-op that reads like a removal.
    if (value === null) throw new Error(`${where}: env['${key}'] is null; child MCP server environments start empty, so there is nothing to remove`);
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`${where}: env['${key}'] must be a string, number, or boolean`);
    }
    output[key] = String(value);
  }
  return output;
}

function validateStringArray(value, where, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${where}: '${field}' must be an array of strings`);
  }
  return value.slice();
}

function validateHttpDiscovery(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: 'discovery' must be an object`);
  const serviceType = value.serviceType;
  const serviceName = value.serviceName;
  if (typeof serviceType !== "string" || !/^_[A-Za-z0-9-]+\._tcp$/.test(serviceType)) {
    throw new Error(`${where}: 'discovery.serviceType' must match _service._tcp (for example _http._tcp)`);
  }
  if (typeof serviceName !== "string" || serviceName.length === 0) {
    throw new Error(`${where}: 'discovery.serviceName' must be a non-empty string`);
  }
  const domain = value.domain === undefined || value.domain === null || value.domain === "" ? "local" : value.domain;
  if (typeof domain !== "string" || domain.length === 0) throw new Error(`${where}: 'discovery.domain' must be a string`);
  const path = value.path === undefined || value.path === null || value.path === "" ? "/" : value.path;
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`${where}: 'discovery.path' must begin with '/'`);
  return { serviceType, serviceName, domain, path };
}

function normalizeToolAlias(providerKey, childName) {
  return `${providerKey}__${childName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function textOfMcpResult(result) {
  return (result?.__mcpContent || []).map((block) => block.text || "").join("");
}

async function executeDnsSd(args, timeoutMs, { onLine = null } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    let settled = false;
    let stopping = false;
    let stopTimer = null;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const reap = (error, value) => {
      if (settled || stopping) return;
      stopping = true;
      if (child.exitCode !== null) {
        finish(error, value);
        return;
      }
      try { child.kill("SIGTERM"); } catch {}
      stopTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 250);
      stopTimer.unref();
      child.once("close", () => finish(error, value));
    };
    timer = setTimeout(() => {
      reap(new Error(`dns-sd did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    let lineBuffer = "";
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      if (!onLine) chunks.push(chunk);
      if (!onLine) return;
      lineBuffer += chunk.toString("utf8");
      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        let value;
        try { value = onLine(line); } catch (error) { reap(error); return; }
        if (value !== undefined && value !== null) {
          reap(null, value);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 2_000); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (stopping) return;
      if (code !== 0) finish(new Error(`dns-sd exited with code ${code}: ${stderr.trim()}`));
      else if (onLine) finish(new Error(`dns-sd exited before emitting a matching result`));
      else finish(null, Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function dnsToken(value) {
  return String(value || "").replace(/^\./, "").replace(/[.]$/, "");
}

function browseInstanceName(line, discovery) {
  const tokens = line.trim().split(/\s+/);
  const typeIndex = tokens.findIndex((token) => dnsToken(token) === discovery.serviceType);
  if (typeIndex < 0) return undefined;
  if (line.includes(discovery.serviceName)) return discovery.serviceName;
  const instance = tokens.slice(typeIndex + 1).join(" ").replace(/[.]$/, "");
  if (!instance || instance !== discovery.serviceName) return undefined;
  return instance;
}

function endpointFromLookupLine(line, pathName) {
  const match = line.match(/\bvia\s+(.+):([0-9]+)\b/i);
  if (!match) return undefined;
  let host = match[1].trim().replace(/[.]$/, "");
  const port = match[2];
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${urlHost}:${port}${pathName}`).toString();
}

async function resolveBonjourEndpoint(discovery) {
  const browseResult = await __testing.executeDnsSd(
    ["dns-sd", "-B", discovery.serviceType, discovery.domain],
    HTTP_DISCOVERY_TIMEOUT_MS,
    { onLine: (line) => browseInstanceName(line, discovery) },
  );
  const instanceName = typeof browseResult === "string" && browseResult.includes("\n")
    ? browseResult.split("\n").map((line) => browseInstanceName(line, discovery)).find(Boolean)
    : browseResult;
  if (!instanceName) throw new Error(`Bonjour service '${discovery.serviceName}.${discovery.serviceType}.${discovery.domain}' was not found`);
  const lookupResult = await __testing.executeDnsSd(
    ["dns-sd", "-L", instanceName, discovery.serviceType, discovery.domain],
    HTTP_DISCOVERY_TIMEOUT_MS,
    { onLine: (line) => endpointFromLookupLine(line, discovery.path) },
  );
  const endpoint = typeof lookupResult === "string" && lookupResult.includes("\n")
    ? lookupResult.split("\n").map((line) => endpointFromLookupLine(line, discovery.path)).find(Boolean)
    : lookupResult;
  if (!endpoint) throw new Error(`could not parse Bonjour endpoint for '${instanceName}'`);
  return endpoint;
}

export function parseProviderRegistry(raw, { source = "registry" } = {}) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`${source}: not valid JSON (${error?.message || error})`);
  }
  if (parsed === undefined || parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${source}: expected an object with a 'providers' array`);
  const providers = parsed.providers;
  if (providers === undefined || providers === null) return [];
  if (!Array.isArray(providers)) throw new Error(`${source}: 'providers' must be an array`);

  const seen = new Set();
  return providers.map((entry, index) => {
    const where = `${source}: providers[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const key = entry.key;
    if (typeof key !== "string" || !PROVIDER_KEY_PATTERN.test(key)) {
      throw new Error(`${where}: 'key' must match ${PROVIDER_KEY_PATTERN} (it becomes the tool-name prefix)`);
    }
    if (seen.has(key)) throw new Error(`${source}: duplicate provider key '${key}'`);
    seen.add(key);
    const transport = entry.transport === undefined || entry.transport === null ? "stdio" : entry.transport;
    if (transport !== "stdio" && transport !== "http") throw new Error(`${where}: 'transport' must be "stdio" or "http"`);
    if (transport === "stdio" && (typeof entry.command !== "string" || entry.command.length === 0)) {
      throw new Error(`${where}: 'command' must be a non-empty string`);
    }
    if (transport === "http") {
      if (entry.command !== undefined) throw new Error(`${where}: 'command' is not valid for transport 'http'`);
      if ((entry.url === undefined) === (entry.discovery === undefined)) {
        throw new Error(`${where}: HTTP providers require exactly one of 'url' or 'discovery'`);
      }
    }
    let url = null;
    if (entry.url !== undefined) {
      try {
        url = new URL(entry.url);
      } catch {
        throw new Error(`${where}: 'url' must be a valid absolute URL`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${where}: 'url' must use HTTP or HTTPS`);
      url = url.toString();
    }
    const discovery = validateHttpDiscovery(entry.discovery, where);
    const mode = entry.mode === undefined || entry.mode === null ? "isolated" : entry.mode;
    if (mode !== "isolated" && mode !== "personal") throw new Error(`${where}: 'mode' must be "isolated" or "personal"`);
    const cwd = entry.cwd === undefined || entry.cwd === null ? null : entry.cwd;
    if (cwd !== null && typeof cwd !== "string") throw new Error(`${where}: 'cwd' must be a string or null`);
    const maxResultBytes = entry.maxResultBytes === undefined || entry.maxResultBytes === null
      ? DEFAULT_MAX_RESULT_BYTES
      : entry.maxResultBytes;
    if (!Number.isInteger(maxResultBytes) || maxResultBytes < 1_024 || maxResultBytes > MAX_MAX_RESULT_BYTES) {
      throw new Error(`${where}: 'maxResultBytes' must be an integer between 1024 and ${MAX_MAX_RESULT_BYTES}`);
    }
    const callTimeoutMs = entry.callTimeoutMs === undefined || entry.callTimeoutMs === null
      ? DEFAULT_CALL_TIMEOUT_MS
      : entry.callTimeoutMs;
    if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 1_000 || callTimeoutMs > CALL_TIMEOUT_CEILING_MS) {
      throw new Error(`${where}: 'callTimeoutMs' must be an integer between 1000 and ${CALL_TIMEOUT_CEILING_MS}`);
    }

    // Flags a provider relies on as SECURITY controls are verified by behaviour,
    // not by exit code. Measured on chrome-devtools-mcp 1.6.0: both
    // --totally-bogus-flag-xyz and the nonexistent --cdp-endpoint started and
    // initialised normally, because yargs is not strict. A misspelled security
    // flag is therefore an absent security control with no error anywhere.
    const flagCheck = entry.flagCheck === undefined || entry.flagCheck === null ? null : entry.flagCheck;
    let normalizedFlagCheck = null;
    if (flagCheck !== null) {
      if (typeof flagCheck !== "object" || Array.isArray(flagCheck)) throw new Error(`${where}: 'flagCheck' must be an object`);
      normalizedFlagCheck = {
        args: validateStringArray(flagCheck.args, where, "flagCheck.args"),
        requireFlags: validateStringArray(flagCheck.requireFlags, where, "flagCheck.requireFlags"),
        timeoutMs: Number.isInteger(flagCheck.timeoutMs) ? Math.min(60_000, Math.max(1_000, flagCheck.timeoutMs)) : 20_000,
      };
      if (normalizedFlagCheck.args.length === 0) normalizedFlagCheck.args = ["--help"];
    }

    return {
      key,
      transport,
      url,
      discovery,
      command: entry.command,
      args: validateStringArray(entry.args, where, "args"),
      env: validateEnvObject(entry.env, where),
      cwd,
      mode,
      personalArgs: validateStringArray(entry.personalArgs, where, "personalArgs"),
      maxResultBytes,
      callTimeoutMs,
      flagCheck: normalizedFlagCheck,
    };
  });
}

async function loadRegistry({ inlineJson, filePath }) {
  if (typeof inlineJson === "string" && inlineJson.trim().length > 0) {
    return parseProviderRegistry(inlineJson, { source: "MAC_DEV_BRIDGE_MCP_SERVERS_JSON" });
  }
  if (typeof filePath === "string" && filePath.trim().length > 0) {
    const raw = await fsp.readFile(filePath, "utf8");
    return parseProviderRegistry(raw, { source: filePath });
  }
  // Default: a fresh install federates nothing until an operator configures it.
  return [];
}

// ---------------------------------------------------------------------------
// Personal-profile approval
// ---------------------------------------------------------------------------

// Same errno taxonomy assertStillUnlocked uses: only genuinely momentary errors
// get a retry, and everything else means "not approved". An exclude-list
// ("anything but ENOENT is transient") would let `rm -f file && mkdir file` turn
// a permanent EISDIR into an indefinite grant.
const TRANSIENT_ERRNOS = new Set(["EMFILE", "ENFILE", "EIO", "EAGAIN", "EINTR", "EBUSY", "ETIMEDOUT"]);

function personalRefusal(reason) {
  const error = new Error(`Personal-profile browser mode is not approved: ${reason}. Isolated mode remains available. An operator must run scripts/approve-personal-browser.sh (or use the menubar app) to create a fresh single-use grant.`);
  error.code = "PERSONAL_MODE_NOT_APPROVED";
  // Never retried: respawning would consume operator grants in a loop, and there
  // is nothing about a refused grant that a second attempt can improve.
  error.terminalStart = true;
  return error;
}

// Marks a start failure that cannot be improved by trying again: a tool name that
// is too long, a name collision, a protocol version the parent cannot speak, a
// grant that was refused. Restart backoff exists for crash loops, not for
// configuration errors.
function terminal(error) {
  error.terminalStart = true;
  return error;
}

async function readApprovalFile(approvalFile) {
  try {
    return await fsp.readFile(approvalFile, "utf8");
  } catch (error) {
    if (TRANSIENT_ERRNOS.has(error?.code)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await fsp.readFile(approvalFile, "utf8");
    }
    throw error;
  }
}

// Consumes the grant: validates it, then UNLINKS it. That single-use step is what
// makes personal mode per-use rather than a config flag a model can leave on.
//
// Honest limit, also stated in SECURITY.md: shell_exec can forge this file. The
// gate stops an unattended model from drifting into personal mode and creates an
// audit record; it does not contain a model that has already decided to escalate.
export async function consumePersonalApproval(approvalFile, providerKey) {
  let raw;
  try {
    raw = await readApprovalFile(approvalFile);
  } catch (error) {
    throw personalRefusal(`no readable approval at ${approvalFile} (${error?.code || error})`);
  }
  let grant;
  try {
    grant = JSON.parse(raw);
  } catch {
    throw personalRefusal("approval file is not valid JSON");
  }
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) throw personalRefusal("approval file is not a JSON object");
  if (typeof grant.nonce !== "string" || !/^[0-9a-f]{32}$/i.test(grant.nonce)) throw personalRefusal("'nonce' must be 32 hex characters");
  if (grant.provider !== providerKey) throw personalRefusal(`grant names provider '${grant.provider}', not '${providerKey}'`);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) throw personalRefusal("'expiresAt' is not a parseable timestamp");
  const now = Date.now();
  if (expiresAt <= now) throw personalRefusal(`grant expired at ${grant.expiresAt}`);
  if (expiresAt - now > PERSONAL_APPROVAL_MAX_TTL_MS) {
    throw personalRefusal(`grant TTL of ${expiresAt - now}ms exceeds the ${PERSONAL_APPROVAL_MAX_TTL_MS}ms ceiling`);
  }
  const patterns = grant.allowedUrlPatterns;
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((p) => typeof p !== "string" || p.length === 0)) {
    throw personalRefusal("'allowedUrlPatterns' must be a non-empty array of non-empty strings");
  }
  // Unlink before returning. If the unlink fails the grant is refused: a grant
  // that cannot be consumed is a grant that can be replayed, which is exactly the
  // set-and-forget behaviour this mechanism exists to prevent.
  try {
    await fsp.unlink(approvalFile);
  } catch (error) {
    throw personalRefusal(`grant could not be consumed (unlink failed: ${error?.code || error}), so it was refused rather than replayed`);
  }
  return { nonce: grant.nonce, expiresAt, allowedUrlPatterns: patterns.slice() };
}

// ---------------------------------------------------------------------------
// Content passthrough
// ---------------------------------------------------------------------------

// result.content is an opaque ORDERED array. Copy every block by value,
// preserving unknown `type` values and unknown keys.
//
// Every shortcut here silently breaks screenshots: content.map(c => c.text),
// JSON.stringify(result) into one text block, or content[0] only. Measured:
// take_screenshot returns TWO blocks (text + image/jpeg, 24,460 base64 chars).
function copyContentBlock(block) {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return { type: "text", text: String(block) };
  const copy = { ...block };
  // `resource` carries the payload one level down, and it may be `blob` rather
  // than `text` — dropping blob makes every binary resource vanish.
  if (copy.resource && typeof copy.resource === "object" && !Array.isArray(copy.resource)) {
    copy.resource = { ...copy.resource };
  }
  if (copy.annotations && typeof copy.annotations === "object" && !Array.isArray(copy.annotations)) {
    copy.annotations = { ...copy.annotations };
  }
  return copy;
}

function copyContent(content) {
  if (!Array.isArray(content)) return [];
  return content.map(copyContentBlock);
}

// For the audit record: shape and size, never the base64. Otherwise AUDIT_MODE
// full writes every screenshot and every heap snapshot into the JSONL log.
function summarizeContent(content) {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (!block || typeof block !== "object") return { type: typeof block };
    const summary = { type: block.type };
    if (typeof block.mimeType === "string") summary.mimeType = block.mimeType;
    if (typeof block.data === "string") summary.byteLength = block.data.length;
    else if (typeof block.text === "string") summary.byteLength = Buffer.byteLength(block.text, "utf8");
    else if (block.resource && typeof block.resource === "object") {
      const payload = typeof block.resource.blob === "string" ? block.resource.blob : block.resource.text;
      if (typeof payload === "string") summary.byteLength = Buffer.byteLength(payload, "utf8");
      if (typeof block.resource.mimeType === "string") summary.mimeType = block.resource.mimeType;
      if (typeof block.resource.uri === "string") summary.uri = block.resource.uri;
    }
    return summary;
  });
}

function textResult(text, structured, { isError = true } = {}) {
  return {
    __mcpContent: [{ type: "text", text }],
    __structured: structured,
    __isError: isError,
  };
}

// ---------------------------------------------------------------------------
// Process containment
// ---------------------------------------------------------------------------

// Synchronous sleep. killNow runs with process.exit possibly one tick away, so
// the bounded retry below cannot await; Atomics.wait is the only way to pause
// without a dependency and without yielding.
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEP_SLOT, 0, 0, ms);
}

// pid, ppid, pgid and "is this a corpse" for every process on the machine.
//
// Zombies are the whole reason ps is used here instead of process.kill(pid, 0).
// This process is the parent of every child MCP server and it does not reap them
// before exiting, so between the SIGKILL and the exit the child is a zombie —
// still a member of its process group, still signalable. Measured: after
// process.kill(-pgid,"SIGKILL"), kill(-pgid,0) reported the group alive on eight
// consecutive polls while ps reported STAT "Z" for the same pid, and the entry
// only disappeared once the event loop ran again. A containment check built on
// the signal probe therefore reports "not contained" for a perfectly clean kill,
// which is exactly what it did.
//
// Returns null if ps is unusable, so the caller can fall back rather than treat
// "no information" as "nothing survived".
function processTableSnapshot() {
  const probe = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (probe.error || typeof probe.stdout !== "string") return null;
  const rows = [];
  for (const line of probe.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: match[4].startsWith("Z"),
    });
  }
  return rows.length > 0 ? rows : null;
}

// Everything this kill is answerable for: the child, every descendant of it, and
// every member of its process group.
//
// Descendants are collected BEFORE the kill, and that is the point. A grandchild
// that called setsid() — which is what Node's `detached: true` does — is in a new
// process group, so the group kill never reaches it, and once its parent dies it
// is reparented to pid 1 and the ppid chain that identified it is gone. Measured:
// such a grandchild survives killAll and keeps running. Snapshotting first is the
// only moment it is still attributable to this provider.
//
// This function does not signal anything. Survivors are reported, the way
// pty_close reports uncontainedPids.
function containmentTargets(childPid, pgid, table) {
  const targets = new Set();
  if (!table) return targets;
  const childrenOf = new Map();
  for (const row of table) {
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else childrenOf.set(row.ppid, [row.pid]);
  }
  const stack = [];
  if (Number.isInteger(childPid) && childPid > 1) {
    targets.add(childPid);
    stack.push(childPid);
  }
  while (stack.length > 0) {
    const pid = stack.pop();
    for (const kid of childrenOf.get(pid) || []) {
      if (targets.has(kid)) continue;
      targets.add(kid);
      stack.push(kid);
    }
  }
  if (Number.isInteger(pgid) && pgid > 1) {
    for (const row of table) if (row.pgid === pgid) targets.add(row.pid);
  }
  // The same hazard killGroup guards against, one level down: this process must
  // never end up in its own containment target list.
  targets.delete(process.pid);
  targets.delete(1);
  targets.delete(0);
  return targets;
}

// Bounded retry, the shape bridge.mjs's verifyPtyContainment uses: poll until the
// group is gone AND nothing snapshotted survived, or until the deadline, then
// report the survivors by pid. Deliberately duplicated rather than imported —
// this module imports nothing from bridge.mjs, which is also why clampInt exists
// here a third time.
function verifyContainment(pgid, targets, timeoutMs) {
  const watched = [...targets];
  const groupTracked = Number.isInteger(pgid) && pgid > 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const table = processTableSnapshot();
    let groupGone;
    let survivors;
    if (table) {
      const live = new Set();
      for (const row of table) if (!row.zombie) live.add(row.pid);
      groupGone = !groupTracked || !table.some((row) => !row.zombie && row.pgid === pgid);
      survivors = watched.filter((pid) => live.has(pid));
    } else {
      // ps is unusable. Fall back to the signal probe and say so: it counts an
      // unreaped corpse as a survivor, so the verdict errs towards "not
      // contained" rather than towards a containment claim nothing checked.
      groupGone = !groupTracked || signalProbeGone(-pgid);
      survivors = watched.filter((pid) => !signalProbeGone(pid));
    }
    if (groupGone && survivors.length === 0) {
      return { contained: true, groupGone, survivors: [], probe: table ? "ps" : "signal" };
    }
    if (Date.now() >= deadline) {
      return { contained: false, groupGone, survivors, probe: table ? "ps" : "signal" };
    }
    sleepSync(CONTAINMENT_POLL_MS);
  }
}

function signalProbeGone(target) {
  if (!Number.isInteger(target) || target === 0 || target === 1 || target === -1) return false;
  try {
    process.kill(target, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class Provider {
  constructor(config, host) {
    this.config = config;
    this.host = host;
    this.key = config.key;
    this.state = "configured";
    this.era = null;
    this.child = null;
    this.pgid = null;
    this.pending = new Map();
    this.nextChildId = 1;
    this.lineBuffer = EMPTY_BUFFER;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.skipUntilNewline = false;
    this.stderrRing = [];
    this.tools = [];
    this.toolsByPrefixed = new Map();
    this.restartTimestamps = [];
    this.restartTimer = null;
    this.nextRetryAt = null;
    this.lastError = null;
    this.lastActivityAt = 0;
    this.pingTimer = null;
    this.killed = false;   // latched by killNow() only; never cleared
    this.stopping = false;
    this.personalGrant = null;
    this.grantTimer = null;
    this.envSkipped = [];
    this.serverInfo = null;
    this.protocolVersion = null;
    this.rootsDir = path.join(host.dataDir, "federation", this.key, "roots");
    this.metadataId = null;
    this.everSpawned = false;
    this.failedTerminally = false;
    this.firstRegistrationDone = false;
    this.advertised = null;
  }

  get attemptCount() {
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    this.restartTimestamps = this.restartTimestamps.filter((t) => t >= cutoff);
    return this.restartTimestamps.length;
  }

  log(message) {
    this.host.stderr(`federation[${this.key}] ${message}`);
  }

  // -- lifecycle ------------------------------------------------------------

  // Milliseconds left on this start's wall-clock deadline. Throws terminally once
  // the deadline has passed: a provider that cannot finish starting inside it is
  // an operator problem, and respawning it only spends the same budget again.
  startBudget(step, ceilingMs) {
    const remaining = this.startDeadline - Date.now();
    if (remaining <= 0) {
      throw terminal(new Error(`provider '${this.key}' did not finish starting within ${PROVIDER_START_DEADLINE_MS}ms (ran out during ${step}); it was abandoned rather than left holding up the whole tool surface`));
    }
    return Math.min(ceilingMs, remaining);
  }

  // The last request before the deadline gets a CLAMPED timeout, so when the
  // deadline is what actually ran out the raw error blames the child for a budget
  // this side shrank: "did not answer tools/list within 947ms" is both true and
  // misleading. Re-attribute it.
  attributeStartFailure(error) {
    if (error?.terminalStart) return error;
    if (Date.now() < this.startDeadline) return error;
    return terminal(new Error(`provider '${this.key}' did not finish starting within ${PROVIDER_START_DEADLINE_MS}ms; it was abandoned rather than left holding up the whole tool surface (the step that ran out reported: ${error?.message || error})`));
  }

  async start({ firstStart = false } = {}) {
    // killed is a LATCH: once revocation has run, this provider may never spawn again.
    //
    // `stopping` cannot serve here because start() resets it, and start() has awaits
    // (mkdir, consumePersonalApproval, verifyFlags) that it never re-checked. A
    // revocation landing in one of those windows took killNow's "no child process"
    // branch, reported containmentVerified:true, and then the restart spawned a fresh
    // unrestricted child anyway — detached, reparented to pid 1, past the kill switch.
    // Reproduced deterministically at a 4560ms offset.
    if (this.killed) {
      throw terminal(new Error(`provider '${this.key}' was revoked; refusing to start`));
    }
    this.state = "starting";
    this.stopping = false;
    // One deadline for the whole start, armed before anything that can block.
    this.startDeadline = Date.now() + PROVIDER_START_DEADLINE_MS;
    // A dead child's buffered bytes must not be framed together with its
    // replacement's first message. The stdout listener is provider-scoped, so
    // without this reset a partial line from the corpse was glued onto the new
    // child's handshake reply: measured, the reply was consumed as part of an
    // unparseable line and the provider silently fell back to the legacy era.
    this.lineBuffer = EMPTY_BUFFER;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.skipUntilNewline = false;
    await fsp.mkdir(this.rootsDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.rootsDir, 0o700).catch(() => {});

    let args = this.config.args.slice();
    if (this.config.mode === "personal") {
      // Re-read and consume the operator grant before EVERY personal-mode spawn.
      const grant = await consumePersonalApproval(this.host.approvalFile, this.key);
      this.personalGrant = grant;
      // Armed at consumption, not at first use. Nothing else expires a grant: the
      // TTL check lived only inside call(), armPing() keeps the child from ever
      // idling out, and federated children have no lifetime ceiling — so with the
      // model simply staying quiet, a browser holding every logged-in session on
      // the machine ran 6s past a 2s grant (measured) and bridge_status still
      // reported the grant as live.
      this.armGrantExpiry();
      args = this.config.personalArgs.slice();
      for (const pattern of grant.allowedUrlPatterns) args.push("--allowedUrlPattern", pattern);
      // The allowlist is only a control if the child actually implements the flag,
      // and a nonexistent flag is silently ignored. No verifiable flag surface, no
      // personal mode.
      if (!this.config.flagCheck) {
        throw personalRefusal("provider config has no 'flagCheck', so --allowedUrlPattern cannot be verified to exist; a silently-ignored flag is an absent security control");
      }
    }

    if (this.config.flagCheck) {
      const required = this.config.flagCheck.requireFlags.slice();
      if (this.config.mode === "personal" && !required.includes("--allowedUrlPattern")) required.push("--allowedUrlPattern");
      try {
        await this.verifyFlags(required);
      } catch (error) {
        throw this.attributeStartFailure(error);
      }
    }

    const { env, skipped } = buildChildEnv(this.config.env);
    this.envSkipped = skipped;
    if (skipped.length > 0) this.log(`refused to forward denied environment key(s) to the child: ${skipped.join(", ")}`);

    // Last gate before the irreversible step. Everything above this line can await.
    if (this.killed) {
      throw terminal(new Error(`provider '${this.key}' was revoked while starting; not spawning`));
    }
    const child = spawn(this.config.command, args, {
      cwd: this.config.cwd || this.host.dataDir,
      env,
      // Its own process group, so the group is reclaimable by killAll() and by
      // scripts/disable.sh from the recorded pgid. Not unref'd: we keep the pipes,
      // and closing our end on parent death is what makes the child exit.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.pgid = child.pid;
    this.everSpawned = true;

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    // Mandatory. A stdin error after an accepted write emits no 'exit', so
    // without this it becomes a stray stream error while the provider is still
    // reported healthy.
    child.stdin.on("error", (error) => {
      this.lastError = `stdin: ${error?.code || error?.message || error}`;
      this.failAllPending(`provider '${this.key}' stdin failed: ${this.lastError}`);
    });
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => this.onStderr(chunk));
    child.once("exit", (code, signal) => this.onExit(code, signal));

    this.metadataId = `mcp-${this.key}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      await this.host.writeJobMetadata({
        id: this.metadataId,
        kind: "mcp-child",
        label: `mcp-${this.key}`,
        pid: child.pid,
        processGroupId: child.pid,
        command: `${this.config.command} ${args.join(" ")}`.trim(),
        cwd: this.config.cwd || this.host.dataDir,
        // MUST be nowIso(). scripts/disable.sh parses it with
        // `date -j -u -f '%Y-%m-%dT%H:%M:%S'` and SILENTLY SKIPS any entry it
        // cannot parse, printing "Disabled" having signalled nothing.
        startedAt: this.host.nowIso(),
        stdoutPath: null,
        stderrPath: null,
      });
    } catch (error) {
      // A live child the reclaimer cannot see is the hole this metadata exists to
      // close, so fail closed rather than run untracked.
      this.killGroup("SIGKILL");
      throw terminal(new Error(`provider '${this.key}' could not be recorded for the reclaimer (${error?.code || error}); it was terminated rather than left untracked`));
    }

    try {
      this.era = await this.handshake();
      this.tools = await this.fetchTools();
    } catch (error) {
      throw this.attributeStartFailure(error);
    }
    // "Has a registration ever succeeded", and nothing else. The caller's
    // firstStart flag must not be consulted: scheduleRestart always passes false,
    // so `firstStart && !this.firstRegistrationDone` was false on every restart,
    // and setting firstRegistrationDone unconditionally below meant the flag never
    // protected anything. Measured against a stub that exited 9 on its first run:
    // after recovery the provider sat at state=ready with toolCount=0, listTools
    // empty and every call answered "Unknown federated tool", permanently.
    // registerTools sets the flag itself, inside the branch that actually claimed
    // the names.
    if (firstStart && this.registrationGate) await this.registrationGate;
    this.registerTools({ firstStart: !this.firstRegistrationDone });
    this.state = "ready";
    this.nextRetryAt = null;
    this.armPing();
    this.log(`ready (era=${this.era}, tools=${this.tools.length}, mode=${this.config.mode}, pid=${child.pid})`);
  }

  // Never trust a zero exit code. The child is asked to describe its own flag
  // surface and every security-critical flag must literally appear in it.
  async verifyFlags(requiredFlags) {
    if (requiredFlags.length === 0) return;
    // Charged against the start deadline like everything else: a flagCheck may be
    // configured with a timeout of up to 60s, which on its own used to exceed any
    // sane bound on how long federation.start() can hold the tool surface.
    const timeoutMs = this.startBudget("flag verification", this.config.flagCheck.timeoutMs);
    const { env } = buildChildEnv(this.config.env);
    const output = await new Promise((resolve, reject) => {
      if (this.killed) throw terminal(new Error(`provider '${this.key}' was revoked; not probing flags`));
      const probe = spawn(this.config.command, this.config.flagCheck.args, {
        cwd: this.config.cwd || this.host.dataDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks = [];
      let bytes = 0;
      const append = (chunk) => {
        if (bytes >= 1_000_000) return;
        bytes += chunk.length;
        chunks.push(chunk);
      };
      probe.stdout.on("data", append);
      probe.stderr.on("data", append);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        try { probe.kill("SIGKILL"); } catch {}
        finish(new Error(`flag verification for '${this.key}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      probe.once("error", (error) => finish(error));
      probe.once("close", () => finish(null, Buffer.concat(chunks).toString("utf8")));
    });
    const missing = requiredFlags.filter((flag) => !output.includes(flag));
    if (missing.length > 0) {
      throw terminal(new Error(`provider '${this.key}' does not document the flag(s) ${missing.join(", ")}; a flag the child does not implement is silently ignored, which would make it an absent security control rather than an error`));
    }
  }

  onStderr(chunk) {
    // Bounded ring, never the protocol channel, and never treated as an error
    // condition: real servers log progress to stderr.
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      this.stderrRing.push(line.slice(0, 2_000));
      if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
    }
  }

  onStdout(chunk) {
    // Everything after an over-long line is discarded up to its terminator, so the
    // framer resynchronises on the next real message instead of gluing the tail of
    // a junk line onto a good one.
    if (this.skipUntilNewline) {
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) return;
      this.skipUntilNewline = false;
      chunk = chunk.subarray(newline + 1);
      if (chunk.length === 0) return;
    }
    // Chunks are held unconcatenated until a newline actually arrives. Growing one
    // Buffer by concat per chunk is quadratic, and at this cap that is ~2.5 GB of
    // copying for a single oversized line — a CPU denial of service handed to us
    // by the child, which is exactly the trade this limit exists to refuse.
    this.pendingChunks.push(chunk);
    this.pendingBytes += chunk.length;
    if (chunk.indexOf(0x0a) === -1 && this.pendingBytes <= MAX_PENDING_LINE_BYTES) return;
    this.lineBuffer = this.pendingChunks.length === 1 ? this.pendingChunks[0] : Buffer.concat(this.pendingChunks, this.pendingBytes);
    let start = 0;
    let discarded = false;
    for (;;) {
      const newline = this.lineBuffer.indexOf(0x0a, start);
      if (newline === -1) break;
      // Checked BEFORE the line becomes a string. A complete line is still a line:
      // decoding an arbitrarily large one to UTF-16 and handing it to JSON.parse is
      // the memory cost this cap exists to refuse, terminator or no terminator.
      if (newline - start > MAX_PENDING_LINE_BYTES) {
        this.noteOversizedLine(newline - start);
        discarded = true;
        start = newline + 1;
        continue;
      }
      const line = this.lineBuffer.subarray(start, newline).toString("utf8").trim();
      start = newline + 1;
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Real children violate "stdout carries only MCP messages". Skipping and
        // logging keeps the framer in sync; desyncing on noise would lose every
        // subsequent reply.
        this.log(`skipped unparseable stdout line (${line.length} chars): ${line.slice(0, 200)}`);
        continue;
      }
      this.lastActivityAt = Date.now();
      try {
        this.onMessage(message);
      } catch (error) {
        this.log(`message handling failed: ${error?.message || error}`);
      }
    }
    const remainder = start === 0 ? this.lineBuffer : this.lineBuffer.subarray(start);
    // The same cap on the UNTERMINATED remainder, so a child that simply never
    // sends a newline cannot grow this without limit either. Charged against the
    // whole buffer, as it used to be, it fired on a child that emitted megabytes
    // of perfectly good newline-terminated lines in one chunk.
    if (remainder.length > MAX_PENDING_LINE_BYTES) {
      this.noteOversizedLine(remainder.length);
      // Resynchronise on the next newline instead of gluing the tail of the junk
      // line onto the next real message.
      this.skipUntilNewline = true;
      this.pendingChunks = [];
      this.pendingBytes = 0;
      this.lineBuffer = EMPTY_BUFFER;
      discarded = true;
    } else {
      this.pendingChunks = remainder.length === 0 ? [] : [remainder];
      this.pendingBytes = remainder.length;
      this.lineBuffer = remainder;
    }
    if (discarded) {
      // The reply that line was carrying is unrecoverable, so say so rather than
      // letting the caller wait out the full 120s call timeout.
      this.failAllPending(`provider '${this.key}' emitted a single stdout line over ${MAX_PENDING_LINE_BYTES} bytes; it was discarded rather than buffered`);
    }
  }

  // Discarded, never fatal. Killing the child here charged a payload-size event to
  // the crash-restart budget: measured, six oversized replies — six calls to a
  // legitimate tool asking for a full-page PNG — walked the provider through all
  // five restarts into state=failed for the life of the bridge. The cap now also
  // sits above MAX_MAX_RESULT_BYTES, so a result at the configured ceiling comes
  // back as RESULT_TOO_LARGE instead of reaching this path at all.
  noteOversizedLine(bytes) {
    this.lastError = `a single stdout line of ${bytes} bytes exceeded the ${MAX_PENDING_LINE_BYTES}-byte cap and was discarded`;
    this.log(`${this.lastError}. The child is left running: an oversized payload is not a crash loop.`);
  }

  onMessage(message) {
    if (Array.isArray(message)) {
      for (const entry of message) this.onMessage(entry);
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.id !== undefined && message.id !== null && typeof message.method === "string") {
      this.onServerRequest(message);
      return;
    }
    if (message.id === undefined || message.id === null) {
      if (message.method === "notifications/tools/list_changed") {
        this.refreshTools().catch((error) => {
          this.lastError = `tools/list refresh failed: ${error?.message || error}`;
          this.log(this.lastError);
        });
      }
      // Notification from the child. Progress is deliberately NOT treated as a
      // liveness signal or a deadline extension.
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) {
      // Late reply to something already settled (cancelled or timed out). The
      // id-map entry was deleted at cancel time on purpose, so there is nothing
      // to leak here.
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(`${message.error.message || "child error"}`), { rpc: message.error }));
    else waiter.resolve(message.result);
  }

  // Under the legacy era servers send real JSON-RPC requests to the client. Every
  // one must be answered, including the ones we do not implement: an unanswered
  // request blocks the child. Measured: advertising roots.listChanged without
  // answering roots/list made the child issue roots/list as a request and blocked
  // EVERY tools/call for ~60s (1.7s vs 60s+ for identical work).
  onServerRequest(message) {
    const deliver = (reply) => {
      try {
        const pending = this.send(reply);
        if (pending && typeof pending.catch === "function") pending.catch((error) => this.log(`failed to answer ${message.method}: ${error?.message || error}`));
      } catch (error) {
        this.log(`failed to answer ${message.method}: ${error?.message || error}`);
      }
    };
    const respond = (result) => deliver({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code, text) => deliver({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    switch (message.method) {
      case "ping":
        respond({});
        return;
      case "roots/list":
        respond({ roots: this.roots() });
        return;
      default:
        fail(-32601, `Method not found: ${message.method}`);
        return;
    }
  }

  // One narrow per-provider directory. This is simultaneously a containment
  // control: chrome-devtools-mcp's own --allowUnrestrictedPaths help text confirms
  // that file-writing tools are restricted to the negotiated roots (or the OS temp
  // dir when none are negotiated), so answering narrowly bounds where the child
  // may write. --allowUnrestrictedPaths is never passed.
  roots() {
    return [{ uri: `file://${this.rootsDir}`, name: `${this.key} workspace` }];
  }

  clientCapabilities() {
    // Advertise a client capability only if the reader loop services its
    // callbacks. roots/list is answered above, so this is honest. listChanged is
    // false because the answer never changes for a child's lifetime.
    return { roots: { listChanged: false } };
  }

  clientInfo() {
    return { name: "mac-developer-bridge", title: "Mac Developer Bridge", version: this.host.version };
  }

  send(message) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      const error = new Error(`provider '${this.key}' stdin is not writable`);
      error.code = "PROVIDER_UNREACHABLE";
      throw error;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  // The parent owns the child-side id space entirely. The public client's id is
  // never forwarded: ids are per-connection and a hostile caller could otherwise
  // force collisions inside this map.
  request(method, params, timeoutMs) {
    const id = this.nextChildId++;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, method };
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // Settle AND delete now, then tell the child to stop. A spec-correct
        // server sends no response at all after notifications/cancelled — measured
        // — so waiting for a reply to clean up leaks the entry permanently.
        this.pending.delete(id);
        try { this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } }); } catch {}
        const error = new Error(`provider '${this.key}' did not answer ${method} within ${timeoutMs}ms`);
        error.code = "PROVIDER_TIMEOUT";
        reject(error);
      }, timeoutMs);
      timer.unref();
      waiter.timer = timer;
      this.pending.set(id, waiter);
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  failAllPending(reason) {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, waiter] of entries) {
      clearTimeout(waiter.timer);
      const error = new Error(reason);
      error.code = "PROVIDER_GONE";
      waiter.reject(error);
    }
  }

  // -- handshake ------------------------------------------------------------

  // Ordered so it is correct whether or not the 2026-07-28 revision exists as
  // described: probe modern first, and degrade to the legacy path that is measured
  // to work. The fallback is deliberately NOT keyed to a specific error code —
  // legacy servers answer an unknown pre-initialize request with implementation
  // defined errors (-32601, -32602) or with nothing at all. Measured:
  // chrome-devtools-mcp 1.6.0 answers -32601 and tops out at 2025-11-25.
  async handshake() {
    const discoverParams = {
      protocolVersion: MODERN_PROTOCOL,
      clientInfo: this.clientInfo(),
      capabilities: this.clientCapabilities(),
      roots: this.roots(),
      _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      // Outside the try on purpose: a blown start deadline is terminal and must
      // not be mistaken for "server/discover was refused" and answered with a
      // legacy fallback.
      const discoverTimeout = this.startBudget("the server/discover handshake", DISCOVER_TIMEOUT_MS);
      try {
        result = await this.request("server/discover", discoverParams, discoverTimeout);
      } catch (error) {
        const rpc = error?.rpc;
        if (rpc && rpc.code === UNSUPPORTED_PROTOCOL_VERSION && Array.isArray(rpc.data?.supported)) {
          // A recognised modern negotiation error. Stay modern.
          const mutual = rpc.data.supported.find((version) => version === MODERN_PROTOCOL) || rpc.data.supported[0];
          if (attempt === 0 && typeof mutual === "string") {
            discoverParams.protocolVersion = mutual;
            discoverParams._meta["io.modelcontextprotocol/protocolVersion"] = mutual;
            continue;
          }
          throw terminal(new Error(`provider '${this.key}' offers no mutually supported modern protocol version (supported: ${rpc.data.supported.join(", ")})`));
        }
        if (error?.code === "PROVIDER_GONE") throw error;
        this.log(`server/discover was refused (${error?.message || error}); using the legacy initialize handshake`);
        await this.legacyInitialize();
        return "legacy";
      }
      const supported = Array.isArray(result?.supportedVersions) ? result.supportedVersions : [];
      this.serverInfo = result?.serverInfo || result?._meta?.["io.modelcontextprotocol/serverInfo"] || null;
      this.modernVersion = supported.includes(MODERN_PROTOCOL) ? MODERN_PROTOCOL : (supported[0] || MODERN_PROTOCOL);
      this.protocolVersion = this.modernVersion;
      return "modern";
    }
    await this.legacyInitialize();
    return "legacy";
  }

  async legacyInitialize() {
    const initializeTimeout = this.startBudget("the initialize handshake", INITIALIZE_TIMEOUT_MS);
    const result = await this.request("initialize", {
      protocolVersion: LEGACY_CLIENT_PROTOCOL,
      clientInfo: this.clientInfo(),
      capabilities: this.clientCapabilities(),
    }, initializeTimeout);
    const negotiated = result?.protocolVersion;
    if (typeof negotiated !== "string") throw terminal(new Error(`provider '${this.key}' returned no protocolVersion from initialize`));
    // A server that answers with a version we do not support is a server we
    // cannot talk to correctly. Disconnect rather than guess.
    if (negotiated !== LEGACY_CLIENT_PROTOCOL && !["2025-11-25", "2025-03-26", "2024-11-05"].includes(negotiated)) {
      throw terminal(new Error(`provider '${this.key}' negotiated unsupported protocol version '${negotiated}'`));
    }
    this.serverInfo = result?.serverInfo || null;
    this.protocolVersion = negotiated;
    await this.notify("notifications/initialized");
  }

  async fetchTools({ startup = true } = {}) {
    const collected = [];
    let cursor;
    for (let page = 0; page < MAX_TOOLS_PAGES; page += 1) {
      const params = cursor === undefined ? {} : { cursor };
      if (this.era === "modern") params._meta = { "io.modelcontextprotocol/protocolVersion": this.modernVersion };
      // Every page is charged against the ONE start deadline. Per-page timeouts
      // alone bound nothing: a child that answers each page just inside the
      // timeout is never late and still costs pages x timeout.
      const pageTimeout = startup
        ? this.startBudget(`tools/list page ${page + 1}`, TOOLS_LIST_TIMEOUT_MS)
        : TOOLS_LIST_TIMEOUT_MS;
      const result = await this.request("tools/list", params, pageTimeout);
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      // The child's ordering is preserved.
      collected.push(...tools);
      cursor = result?.nextCursor;
      if (cursor === undefined || cursor === null) return collected;
    }
    throw terminal(new Error(`provider '${this.key}' paginated tools/list past ${MAX_TOOLS_PAGES} pages; refusing to silently truncate its tool set`));
  }

  // Rewrite `name` only. description, inputSchema, annotations, execution and
  // every unknown field are copied verbatim: measured child schemas carry
  // "$schema": draft-07 and additionalProperties true, and stripping $schema
  // silently reclassifies them as 2020-12.
  //
  // Annotations are copied as DESCRIPTIVE METADATA ONLY. The spec makes clients
  // treat them as untrusted, and the gateway's own risk classification comes from
  // operator config keyed on the prefixed name — a compromised or merely updated
  // child must not be able to downgrade its own classification.
  registerTools({ firstStart, tools = this.tools }) {
    const mapped = [];
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
        throw terminal(new Error(`provider '${this.key}' advertised a tool with no name`));
      }
      const prefixed = normalizeToolAlias(this.key, tool.name);
      if (!TOOL_NAME_PATTERN.test(prefixed)) {
        throw terminal(new Error(`provider '${this.key}' tool '${tool.name}' becomes '${prefixed}' (${prefixed.length} chars), which is not a portable tool name; shorten the provider key or the child's tool set`));
      }
      if (mapped.some((entry) => entry.prefixed === prefixed)) {
        throw terminal(new Error(`provider '${this.key}' advertised duplicate normalized tool alias '${prefixed}'`));
      }
      mapped.push({ prefixed, original: tool.name, descriptor: { ...tool, name: prefixed } });
    }
    if (firstStart) {
      // Collisions are rejected at STARTUP, not at call time.
      this.host.claimToolNames(mapped.map((entry) => entry.prefixed), this.key);
      this.toolsByPrefixed = new Map(mapped.map((entry) => [entry.prefixed, entry]));
      this.advertised = mapped.map((entry) => entry.descriptor);
      // Set here and only here, after the names are actually claimed. A throw
      // above leaves it false so the next successful start still registers.
      this.firstRegistrationDone = true;
      this.host.notifyToolsChanged?.();
      return;
    }
    const next = new Map(mapped.map((entry) => [entry.prefixed, entry]));
    const vanished = [...this.toolsByPrefixed.keys()].filter((name) => !next.has(name));
    const appeared = [...next.keys()].filter((name) => !this.toolsByPrefixed.has(name));
    const claimResult = this.host.claimToolNames([...next.keys()], this.key);
    for (const name of vanished) this.host.releaseToolName?.(name, this.key);
    this.toolsByPrefixed = next;
    this.advertised = mapped.map((entry) => entry.descriptor);
    this.vanishedTools = new Set();
    for (const [name, entry] of next) {
      if (this.toolsByPrefixed.has(name)) this.toolsByPrefixed.set(name, entry);
    }
    if (vanished.length > 0) this.log(`these tools are no longer provided: ${vanished.join(", ")}`);
    if (appeared.length > 0) this.log(`new tools are now advertised: ${appeared.join(", ")}`);
    if (vanished.length > 0 || appeared.length > 0 || claimResult.preempted.length > 0) this.host.notifyToolsChanged?.();
  }

  removeToolClaim(name) {
    this.toolsByPrefixed.delete(name);
    if (this.advertised) this.advertised = this.advertised.filter((tool) => tool.name !== name);
  }

  async refreshTools() {
    if (this.state !== "ready" || this.toolsRefreshPromise) return this.toolsRefreshPromise;
    this.toolsRefreshPromise = (async () => {
      const tools = await this.fetchTools({ startup: false });
      this.registerTools({ firstStart: false, tools });
      this.tools = tools;
    })().finally(() => {
      this.toolsRefreshPromise = null;
    });
    return this.toolsRefreshPromise;
  }

  armPing() {
    this.disarmPing();
    // The only way to catch a hung-but-alive child. Measured: the child stays
    // alive and responsive while returning isError for every call when Chrome is
    // unreachable, so a process-liveness check alone reports "healthy".
    this.pingTimer = setInterval(() => {
      if (this.state !== "ready") return;
      if (Date.now() - this.lastActivityAt < PING_IDLE_MS) return;
      this.request("ping", undefined, PING_TIMEOUT_MS).catch((error) => {
        if (this.state !== "ready") return;
        this.lastError = `ping failed: ${error?.message || error}`;
        this.log(`${this.lastError}; treating the child as hung and restarting it`);
        this.killGroup("SIGKILL");
      });
    }, PING_IDLE_MS);
    this.pingTimer.unref();
  }

  disarmPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // The grant's expiry has to be a real deadline, not a precondition that is only
  // evaluated when someone happens to call a tool. unref'd, like every other timer
  // here, so it cannot keep the bridge alive after its transport closed — the
  // process exiting reclaims the child anyway.
  armGrantExpiry() {
    this.disarmGrantExpiry();
    const grant = this.personalGrant;
    if (!grant) return;
    const delay = Math.max(0, grant.expiresAt - Date.now());
    this.grantTimer = setTimeout(() => {
      this.grantTimer = null;
      if (!this.personalGrant) return;
      const expiredAt = new Date(this.personalGrant.expiresAt).toISOString();
      this.personalGrant = null;
      // Same wording the per-call refusal uses, so the operator and the model see
      // one story regardless of which path noticed first.
      this.lastError = `the grant expired at ${expiredAt}; the personal-mode provider has been shut down`;
      this.log(`${this.lastError}. A fresh operator grant is required to start it again.`);
      this.failedTerminally = true;
      // stop() sets this.stopping, so onExit will not schedule a restart.
      this.stop();
      // failed, not stopped: it cannot come back without a new operator action,
      // and call() surfaces lastError for a failed provider. failedTerminally is
      // set once, above, BEFORE stop() — onExit reads it, and setting it a second
      // time here happens after that read and so never changed anything.
      this.state = "failed";
    }, delay);
    this.grantTimer.unref();
  }

  disarmGrantExpiry() {
    if (this.grantTimer) {
      clearTimeout(this.grantTimer);
      this.grantTimer = null;
    }
  }

  // A grant past its expiry is not a live grant, whatever the timer has managed to
  // do about it yet. status() must never present one as current.
  grantStatus() {
    const grant = this.personalGrant;
    if (!grant) return null;
    return {
      nonce: grant.nonce,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      allowedUrlPatterns: grant.allowedUrlPatterns,
      expired: Date.now() >= grant.expiresAt,
      remainingMs: Math.max(0, grant.expiresAt - Date.now()),
    };
  }

  onExit(code, signal) {
    this.disarmPing();
    this.child = null;
    // Sweep the group NOW, then stop reporting a pgid at all.
    //
    // Two reasons, and the second is the one that bites. First, a grandchild that
    // did not setsid can outlive the leader, and closing our pipes only raises
    // SIGHUP — the pty layer measured a child surviving that behind
    // `trap '' HUP`. Second, from here until the next spawn this number names a
    // DEAD group, and macOS recycles pids: a later killAll() or a bridge_status
    // reader would be aiming at whatever now owns it. Sweeping in the same tick
    // as the exit is the only moment the number is still unambiguously ours.
    this.killGroup("SIGKILL");
    this.pgid = null;
    this.failAllPending(`provider '${this.key}' exited (code=${code}, signal=${signal}) before answering`);
    if (this.metadataId) {
      this.host.removeJobMetadata(this.metadataId);
      this.metadataId = null;
    }
    if (this.stopping) {
      // "stopped" means an orderly shutdown that could be undone. A grant that ran
      // out cannot be: it needs a fresh operator action, and call() only surfaces
      // lastError for a failed provider, so reporting "stopped" here hid the
      // reason from both the operator and the model.
      this.state = this.failedTerminally ? "failed" : "stopped";
      return;
    }
    this.lastError = this.lastError || `child exited (code=${code}, signal=${signal})`;
    this.scheduleRestart();
  }

  scheduleRestart() {
    // A personal-profile child is NEVER respawned automatically.
    //
    // Every personal-mode start consumes a single-use operator grant. Measured
    // against the shipped code: with the provider in state=restarting, writing a
    // NEW grant — the way an operator prepares a future, deliberate session — had
    // it consumed 3s later with no tool call and no user action, relaunching the
    // browser that holds every logged-in session on this machine. One approval
    // became a session the operator did not ask for. The restart budget is five
    // attempts over ~15.5s, so any grant written in that window was at risk.
    //
    // A crashed personal session therefore ends here and requires a fresh,
    // deliberate grant. That is the point of a per-use approval.
    if (this.config.mode === "personal") {
      this.state = "failed";
      this.nextRetryAt = null;
      this.personalGrant = null;
      this.disarmGrantExpiry();
      this.lastError = this.lastError || "personal-mode child exited";
      this.log("personal-mode provider will NOT be restarted automatically: each start consumes a single-use operator grant, and an automatic respawn would consume the next one. Operator action required: run scripts/approve-personal-browser.sh again and restart the bridge.");
      return;
    }
    const attempts = this.attemptCount;
    if (attempts >= RESTART_MAX_ATTEMPTS) {
      this.state = "failed";
      this.nextRetryAt = null;
      this.log(`gave up after ${attempts} restart attempts in ${RESTART_WINDOW_MS}ms; state=failed. Operator action required: check the provider command, its arguments, and ${this.stderrTail(3).join(" | ") || "its stderr"}.`);
      return;
    }
    const delay = RESTART_BACKOFF_MS[attempts];
    this.state = "restarting";
    this.restartAttempt = attempts + 1;
    this.nextRetryAt = Date.now() + delay;
    this.log(`restarting in ${delay}ms (attempt ${this.restartAttempt}/${RESTART_MAX_ATTEMPTS})`);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartTimestamps.push(Date.now());
      this.start({ firstStart: false }).catch((error) => {
        this.lastError = String(error?.message || error);
        this.log(`restart failed: ${this.lastError}`);
        if (this.child) {
          // The kill produces an 'exit', and onExit decides what happens next.
          this.killGroup("SIGKILL");
          return;
        }
        // Same rule startAll applies: a terminal failure is a configuration
        // error, not a crash loop, and retrying it only burns the budget (and,
        // for a refused personal grant, the operator's next approval).
        if (error?.terminalStart) {
          this.state = "failed";
          this.nextRetryAt = null;
          this.log(`not retrying: ${this.lastError}`);
          return;
        }
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
  }

  stderrTail(lines = 10) {
    return this.stderrRing.slice(-lines);
  }

  // -- calls ----------------------------------------------------------------

  async call(prefixed, args) {
    const entry = this.toolsByPrefixed.get(prefixed);
    if (!entry) {
      return textResult(
        `Tool '${prefixed}' is not provided by provider '${this.key}'.`,
        { provider: this.key, tool: prefixed, state: this.state },
      );
    }
    if (this.vanishedTools && this.vanishedTools.has(prefixed)) {
      return textResult(
        `Tool '${prefixed}' is no longer provided by provider '${this.key}' after its restart. The advertised tool list is cached by the client and cannot be corrected until the cache expires.`,
        { provider: this.key, tool: prefixed, state: this.state, stateLost: true },
      );
    }
    if (this.state !== "ready") {
      // Return IMMEDIATELY. Never hang, never a bare timeout, and replay nothing:
      // chrome-devtools-mcp is semantically stateful (uid=N_M element handles come
      // from take_snapshot and a restart invalidates them), so an auto-replayed
      // click can act on the wrong element.
      const retryAfterMs = this.nextRetryAt ? Math.max(0, this.nextRetryAt - Date.now()) : null;
      const structured = {
        provider: this.key,
        state: this.state,
        attempt: this.restartAttempt || this.attemptCount,
        maxAttempts: RESTART_MAX_ATTEMPTS,
        retryAfterMs,
        stateLost: true,
        lastError: this.lastError,
      };
      const detail = this.state === "failed"
        ? `Provider '${this.key}' is permanently unavailable (state=failed after ${this.attemptCount} of ${RESTART_MAX_ATTEMPTS} restart attempts). Operator action required: fix the provider command or configuration and restart the bridge. Last error: ${this.lastError}.`
        : `Provider '${this.key}' is unavailable (state=${this.state}, attempt ${structured.attempt}/${RESTART_MAX_ATTEMPTS}${retryAfterMs === null ? "" : `, next retry in ${(retryAfterMs / 1000).toFixed(1)}s`}). Any browser state, including element uids from a snapshot, has been lost. Re-run the provider's snapshot tool before retrying.`;
      return textResult(detail, structured);
    }
    if (this.config.mode === "personal") this.assertPersonalGrantLive();

    const params = { name: entry.original, arguments: args ?? {} };
    if (this.era === "modern") params._meta = { "io.modelcontextprotocol/protocolVersion": this.modernVersion };

    let result;
    try {
      result = await this.request("tools/call", params, this.config.callTimeoutMs);
    } catch (error) {
      const structured = { provider: this.key, tool: prefixed, state: this.state, code: error?.code || null, rpc: error?.rpc || null };
      return textResult(`Call to '${prefixed}' failed: ${error?.message || error}`, structured);
    }

    // A modern-era server signals a server->client interaction with
    // resultType input_required rather than by sending us a request. There is no
    // generic way for a gateway to satisfy one, so say so instead of hanging.
    if (result && result.resultType === "input_required") {
      return textResult(
        `Provider '${this.key}' requested interactive input to complete '${prefixed}', which this gateway cannot supply. Re-run the tool with the required arguments provided up front.`,
        { provider: this.key, tool: prefixed, resultType: "input_required", request: result?.request ?? null },
      );
    }

    const content = copyContent(result?.content);
    const payload = {
      __mcpContent: content,
      __structured: result?.structuredContent,
      __isError: Boolean(result?.isError),
    };
    if (result && result._meta !== undefined) payload.__meta = result._meta;

    const serialized = Buffer.byteLength(JSON.stringify({ content, structuredContent: result?.structuredContent }), "utf8");
    if (serialized > this.config.maxResultBytes) {
      const summary = summarizeContent(result?.content);
      await this.host.audit(prefixed, args, { provider: this.key, oversized: true, byteLength: serialized, maxResultBytes: this.config.maxResultBytes, content: summary });
      return textResult(
        `Result from '${prefixed}' was ${serialized} bytes, over the ${this.config.maxResultBytes}-byte limit for provider '${this.key}'. Ask for a smaller result (for example a JPEG screenshot at lower quality or width) rather than a full-page PNG or a heap snapshot.`,
        { provider: this.key, tool: prefixed, code: "RESULT_TOO_LARGE", byteLength: serialized, maxResultBytes: this.config.maxResultBytes, content: summary },
      );
    }

    await this.host.audit(prefixed, args, {
      provider: this.key,
      era: this.era,
      mode: this.config.mode,
      isError: payload.__isError,
      byteLength: serialized,
      // Shape and size only. Storing data/blob here would write every screenshot
      // into the JSONL audit log at AUDIT_MODE=full.
      content: summarizeContent(result?.content),
      ...(this.personalGrant ? { personalApprovalNonce: this.personalGrant.nonce } : {}),
    });
    return payload;
  }

  assertPersonalGrantLive() {
    const grant = this.personalGrant;
    if (!grant) throw personalRefusal("no grant is associated with this personal-mode provider");
    if (Date.now() >= grant.expiresAt) {
      this.personalGrant = null;
      this.disarmGrantExpiry();
      // Same reason the grant-expiry timer sets it: an expired grant needs a fresh
      // operator action, so onExit must settle on "failed" rather than the
      // "stopped" that reads like an orderly shutdown somebody could undo.
      this.failedTerminally = true;
      this.stop();
      throw personalRefusal(`the grant expired at ${new Date(grant.expiresAt).toISOString()}; the personal-mode provider has been shut down`);
    }
  }

  // -- teardown -------------------------------------------------------------

  killGroup(signal) {
    const pgid = this.pgid;
    // -0 === 0 in JS, so process.kill(-0) signals THIS process group, which on
    // the Tunnel transport contains tunnel-client. scripts/disable.sh refuses the
    // same target for the same reason.
    if (!Number.isInteger(pgid) || pgid <= 1) return "INVALID_TARGET";
    try {
      process.kill(-pgid, signal);
      return null;
    } catch (error) {
      return error?.code || String(error?.message || error);
    }
  }

  groupGone() {
    const pgid = this.pgid;
    if (!Number.isInteger(pgid) || pgid <= 1) return true;
    try {
      process.kill(-pgid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }

  // Spec order, and both revisions agree: close stdin first. Servers SHOULD exit
  // promptly when stdin closes, and it is the only portable graceful signal.
  stop() {
    // Deliberately does NOT set the killed latch. stop() is part of the RESTART path,
    // so latching here permanently prevented a provider from ever restarting — measured
    // as providers stuck in "starting" with a pending call. Only killNow() latches.
    this.stopping = true;
    this.disarmPing();
    this.disarmGrantExpiry();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) {
      if (this.metadataId) {
        this.host.removeJobMetadata(this.metadataId);
        this.metadataId = null;
      }
      return;
    }
    try { child.stdin.end(); } catch {}
    this.killGroup("SIGTERM");
    const timer = setTimeout(() => {
      if (this.groupGone()) return;
      this.killGroup("SIGKILL");
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
  }

  // Synchronous best-effort, called between a revocation decision and
  // process.exit. No awaits: exitAfterFlush can process.exit on the very next
  // tick, so anything asynchronous here is a window in which the bridge dies with
  // an unrestricted child still running.
  killNow() {
    // Latch first, before anything can await. start() re-checks this after each of its
    // awaits and immediately before spawn, which is what stops a revocation from
    // reporting containment while a restart spawns a fresh unrestricted child.
    this.killed = true;
    this.stopping = true;
    this.disarmPing();
    this.disarmGrantExpiry();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child && this.pgid === null) {
      // Nothing to reclaim: the child exited and its group was already swept in
      // the same tick. Reported as such rather than as a kill that "succeeded".
      // Mid-start counts as NOT contained: there is no pid to verify, and until the
      // killed latch above was added this branch reported success while a spawn was
      // still pending. Saying "starting" out loud is the honest answer.
      const midStart = this.state === "starting";
      this.state = "stopped";
      return {
        key: this.key,
        pgid: null,
        groupKilled: false,
        groupError: null,
        containmentVerified: !midStart,
        groupGone: true,
        uncontainedPids: [],
        containmentProbe: "none",
        note: midStart ? "revoked while starting; spawn refused by the killed latch" : "no child process",
      };
    }
    // Snapshotted BEFORE the kill: a grandchild that setsid()'d out of the group
    // is unattributable to this provider the moment its parent dies.
    const targets = containmentTargets(child ? child.pid : null, this.pgid, processTableSnapshot());
    if (child) {
      try { child.stdin.destroy(); } catch {}
    }
    const groupError = this.killGroup("SIGKILL");
    if (child) {
      try { child.kill("SIGKILL"); } catch {}
    }
    // Bounded retry rather than a single probe one line after the SIGKILL. That
    // probe was `process.kill(-pgid, 0)` against a child this process had not
    // reaped, so it answered "still there" for every clean kill: measured,
    // containmentVerified was false in BOTH a kill that left nothing behind and a
    // kill a setsid grandchild escaped. A field that is never true carries no
    // information, and it made a real escape indistinguishable from success.
    const containment = verifyContainment(this.pgid, targets, CONTAINMENT_VERIFY_MS);
    this.state = "stopped";
    if (containment.survivors.length > 0) {
      this.log(`killAll did NOT contain ${containment.survivors.length} process(es) belonging to this provider: ${containment.survivors.join(", ")}. They were snapshotted as descendants or group members before the kill and are still running; a descendant that called setsid() leaves the process group and cannot be reached by a group kill.`);
    }
    return {
      key: this.key,
      pgid: this.pgid,
      groupKilled: groupError === null,
      groupError,
      // True only when the process group is gone AND nothing snapshotted before
      // the kill survived it. Zombie-aware: an unreaped corpse of our own child is
      // not a survivor. It may legitimately be false — Chrome re-parents itself
      // out of the group — which is why the survivors are named rather than
      // summarised into a boolean.
      containmentVerified: containment.contained,
      groupGone: containment.groupGone,
      // Named the way pty_close names them, and never signalled from here: these
      // are reported so the operator can decide, not chased.
      uncontainedPids: containment.survivors,
      // "ps" is the real check; "signal" means ps was unusable and the verdict
      // came from a probe that cannot tell a corpse from a live process.
      containmentProbe: containment.probe,
    };
  }

  status() {
    return {
      key: this.key,
      state: this.state,
      era: this.era,
      mode: this.config.mode,
      pid: this.child ? this.child.pid : null,
      processGroupId: this.pgid,
      toolCount: this.advertised ? this.advertised.length : 0,
      restarts: this.attemptCount,
      maxRestarts: RESTART_MAX_ATTEMPTS,
      nextRetryInMs: this.nextRetryAt ? Math.max(0, this.nextRetryAt - Date.now()) : null,
      pendingCalls: this.pending.size,
      lastError: this.lastError,
      serverInfo: this.serverInfo,
      rootsDir: this.rootsDir,
      // Exclude keys buildChildEnv refused, or a secret appears in BOTH lists.
      // SECURITY.md points operators at this field to audit what a child received;
      // listing a refused GITHUB_TOKEN as forwarded is a false alarm in the one place
      // that is supposed to be authoritative.
      envKeysForwarded: ENV_ALLOWLIST.filter((key) => process.env[key] !== undefined)
        .concat(Object.keys(this.config.env).filter((key) => !this.envSkipped.includes(key))),
      envKeysRefused: this.envSkipped,
      personalGrant: this.grantStatus(),
      stderrTail: this.stderrTail(5),
    };
  }
}

class HttpProvider extends Provider {
  constructor(config, host) {
    super(config, host);
    this.endpoint = null;
    this.sessionId = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.startPromise = null;
  }

  async start({ firstStart = false } = {}) {
    if (this.killed) throw terminal(new Error(`provider '${this.key}' was revoked; not starting`));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startNow({ firstStart }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startNow({ firstStart = false } = {}) {
    this.stopping = false;
    this.state = "starting";
    this.startDeadline = Date.now() + PROVIDER_START_DEADLINE_MS;
    this.pending.clear();
    this.sessionId = null;
    this.protocolVersion = null;
    this.endpoint = this.config.url || await __testing.resolveBonjourEndpoint(this.config.discovery, this.host);
    this.era = await this.handshake();
    this.tools = await this.fetchTools();
    if (firstStart && this.registrationGate) await this.registrationGate;
    this.registerTools({ firstStart: !this.firstRegistrationDone });
    this.state = "ready";
    this.nextRetryAt = null;
    this.reconnectAttempt = 0;
    this.log(`ready (era=${this.era}, tools=${this.tools.length}, transport=http, endpoint=${this.endpoint})`);
  }

  scheduleReconnect(error = null) {
    if (this.killed || this.stopping) return;
    if (error) this.lastError = String(error?.message || error);
    const index = Math.min(this.reconnectAttempt, HTTP_RECONNECT_BACKOFF_MS.length - 1);
    const delay = HTTP_RECONNECT_BACKOFF_MS[index];
    this.reconnectAttempt += 1;
    this.state = "reconnecting";
    this.nextRetryAt = Date.now() + delay;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start({ firstStart: false }).catch((retryError) => this.handleReconnectFailure(retryError));
    }, delay);
    this.reconnectTimer.unref();
  }

  isRetryableStartError(error) {
    return !error?.terminalStart && !error?.httpStatus;
  }

  handleReconnectFailure(error) {
    if (this.isRetryableStartError(error)) {
      this.scheduleReconnect(error);
      return;
    }
    this.lastError = String(error?.message || error);
    this.nextRetryAt = null;
    this.state = "failed";
    this.failedTerminally = true;
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    super.stop();
  }

  async postMessage(message, timeoutMs, { recoverSession = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const sessionAtStart = this.sessionId;
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
          ...(sessionAtStart ? { "Mcp-Session-Id": sessionAtStart } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      if (response.status === 404 && sessionAtStart && recoverSession) {
        if (response.body) await response.body.cancel().catch(() => {});
        this.sessionId = null;
        this.protocolVersion = null;
        await this.reinitializeSession();
        return await this.postMessage(message, timeoutMs, { recoverSession: false });
      }
      if (response.status === 202 || response.status === 204) return undefined;
      if (!response.ok) {
        const error = new Error(message.id === undefined
          ? `HTTP notification returned status ${response.status}`
          : `HTTP ${response.status} ${response.statusText || ""}`.trim());
        error.httpStatus = response.status;
        error.code = `HTTP_${response.status}`;
        throw error;
      }
      const contentType = response.headers.get("content-type") || "";
      return await this.readResponseMessages(response, contentType, message.id);
    } catch (error) {
      if (error.name === "AbortError") {
        throw Object.assign(new Error(`provider '${this.key}' did not answer HTTP MCP within ${timeoutMs}ms`), { code: "PROVIDER_TIMEOUT" });
      }
      if (!error.code) error.code = "PROVIDER_UNREACHABLE";
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async readResponseMessages(response, contentType, expectedId) {
    if (!response.body) throw new Error(`HTTP MCP response had no body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let finalSeen = false;
    let finalResult;
    const processMessage = (message) => {
      if (!message || typeof message !== "object") throw new Error("HTTP MCP response was not a JSON-RPC object");
      if (expectedId !== undefined && message.id === expectedId && message.method === undefined) {
        if (message.error) throw Object.assign(new Error(message.error.message || "child error"), { rpc: message.error });
        finalSeen = true;
        finalResult = message.result;
        return true;
      }
      this.onMessage(message);
      return false;
    };
    const parse = (raw) => {
      if (raw === "[DONE]") return;
      let message;
      try { message = JSON.parse(raw); } catch (error) {
        throw new Error(`invalid JSON in HTTP MCP response: ${error?.message || error}`);
      }
      return processMessage(message);
    };
    if (contentType.includes("json")) {
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.config.maxResultBytes) {
          await reader.cancel().catch(() => {});
          const error = new Error(`HTTP result exceeds ${this.config.maxResultBytes} bytes`);
          error.code = "RESULT_TOO_LARGE";
          throw error;
        }
        chunks.push(value);
      }
      parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
    } else if (contentType.includes("text/event-stream")) {
      let lineBuffer = "";
      let dataLines = [];
      const dispatch = () => {
        if (dataLines.length === 0) return;
        const raw = dataLines.join("\n");
        dataLines = [];
        return parse(raw);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.config.maxResultBytes) {
          await reader.cancel().catch(() => {});
          const error = new Error(`HTTP result exceeds ${this.config.maxResultBytes} bytes`);
          error.code = "RESULT_TOO_LARGE";
          throw error;
        }
        lineBuffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = lineBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line === "") {
            if (dispatch()) {
              await reader.cancel().catch(() => {});
              return finalResult;
            }
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
      }
      lineBuffer += decoder.decode();
      if (lineBuffer.length > 0) {
        if (lineBuffer.startsWith("data:")) dataLines.push(lineBuffer.slice(5).replace(/^ /, ""));
      }
      if (dispatch()) return finalResult;
    } else {
      throw new Error(`unsupported HTTP MCP response Content-Type: ${contentType || "none"}`);
    }
    if (finalSeen) return finalResult;
    if (expectedId !== undefined) throw new Error("HTTP MCP response did not contain the requested JSON-RPC response");
    return undefined;
  }

  async request(method, params, timeoutMs, { recoverSession = true } = {}) {
    const id = this.nextChildId++;
    return this.postMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, timeoutMs, { recoverSession });
  }

  async reinitializeSession() {
    if (this.era === "legacy") {
      await this.legacyInitialize();
      return;
    }
    this.era = await this.handshake();
  }

  send(message) {
    return this.postMessage(message, this.config.callTimeoutMs);
  }

  async notify(method, params) {
    return this.postMessage({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, HTTP_DISCOVERY_TIMEOUT_MS);
  }

  async call(prefixed, args) {
    const entry = this.toolsByPrefixed.get(prefixed);
    if (!entry) {
      return textResult(`Tool '${prefixed}' is not provided by provider '${this.key}'.`, { provider: this.key, tool: prefixed, state: this.state });
    }
    if (this.vanishedTools && this.vanishedTools.has(prefixed)) {
      return textResult(`Tool '${prefixed}' is no longer provided by provider '${this.key}'.`, { provider: this.key, tool: prefixed, stateLost: true });
    }
    if (this.state !== "ready") {
      try {
        await this.start({ firstStart: false });
      } catch (error) {
        this.handleReconnectFailure(error);
        return textResult(`Provider '${this.key}' is unavailable: ${error?.message || error}`, {
          provider: this.key, tool: prefixed, state: this.state, code: "PROVIDER_UNREACHABLE",
        });
      }
    }
    const result = await super.call(prefixed, args);
    if (result?.__structured?.code === "PROVIDER_UNREACHABLE") {
      this.scheduleReconnect(new Error(textOfMcpResult(result)));
    }
    return result;
  }

  status() {
    return {
      ...super.status(),
      transport: "http",
      endpoint: this.endpoint,
      sessionId: this.sessionId,
      maxRestarts: null,
      reconnectAttempts: this.reconnectAttempt,
    };
  }
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

export function createFederation({
  audit,
  stderr,
  dataDir,
  nowIso,
  writeJobMetadata,
  jobDir,
  version = "0.0.0",
  reservedToolNames = [],
  approvalFile = null,
  registryPath = process.env.MAC_DEV_BRIDGE_MCP_SERVERS,
  registryJson = process.env.MAC_DEV_BRIDGE_MCP_SERVERS_JSON,
  onToolsChanged = null,
} = {}) {
  const claimed = new Map();
  const providerOrders = new Map();
  const providerObjects = new Map();
  for (const name of reservedToolNames) claimed.set(name, "bridge");

  const host = {
    audit,
    stderr,
    dataDir,
    nowIso,
    version,
    writeJobMetadata,
    approvalFile: approvalFile || path.join(dataDir, PERSONAL_APPROVAL_FILENAME),
    removeJobMetadata(id) {
      if (!jobDir) return;
      try {
        fs.rmSync(path.join(jobDir, `${id}.json`), { force: true });
      } catch {}
    },
    claimToolNames(names, providerKey) {
      const preempted = [];
      for (const name of names) {
        const owner = claimed.get(name);
        if (owner === undefined || owner === providerKey) continue;
        if (owner === "bridge" || providerOrders.get(providerKey) > providerOrders.get(owner)) {
          throw terminal(new Error(`tool name '${name}' from provider '${providerKey}' collides with ${owner === "bridge" ? "a built-in bridge tool" : `provider '${owner}'`}`));
        }
        preempted.push({ name, owner });
      }
      for (const { name, owner } of preempted) {
        providerObjects.get(owner)?.removeToolClaim(name);
        claimed.set(name, providerKey);
      }
      for (const name of names) claimed.set(name, providerKey);
      return { preempted };
    },
    releaseToolName(name, providerKey) {
      if (claimed.get(name) === providerKey) claimed.delete(name);
    },
    notifyToolsChanged: () => onToolsChanged?.(),
    registerProvider(provider, order) {
      providerOrders.set(provider.key, order);
      providerObjects.set(provider.key, provider);
    },
  };

  const providers = new Map();
  let startPromise = null;
  let started = false;

  async function startAll() {
    const configs = await loadRegistry({ inlineJson: registryJson, filePath: registryPath });
    if (configs.length === 0) {
      started = true;
      return;
    }
    await fsp.mkdir(path.join(dataDir, "federation"), { recursive: true, mode: 0o700 });
    // Registered in configuration order BEFORE any of them starts, so listTools()
    // and status() stay in registry order no matter which provider finishes first.
    const pending = configs.map((config, order) => {
      const provider = config.transport === "http" ? new HttpProvider(config, host) : new Provider(config, host);
      providers.set(config.key, provider);
      host.registerProvider(provider, order);
      return { config, provider };
    });
    // CONCURRENTLY. Serial starts made one slow provider everybody's problem:
    // measured, five providers that each took 6s to page through tools/list cost
    // 30.3s of startup, and bridge.mjs awaits federationReady before answering
    // even a native read-only tool. Concurrent starts plus the per-provider
    // wall-clock deadline make the worst case PROVIDER_START_DEADLINE_MS once.
    //
    // Nothing here races: JavaScript is single-threaded and registerTools claims
    // its names synchronously. What does become order-dependent is which of two
    // providers wins a tool-name collision — only reachable when one provider's
    // key plus tool name spells another's, since every name is key-prefixed — and
    // either way exactly one of them is refused at startup.
    const registrationTail = { promise: Promise.resolve(), release: [] };
    for (const [order, entry] of pending.entries()) {
      let release;
      const turn = new Promise((resolve) => { release = resolve; });
      entry.provider.registrationGate = registrationTail.promise;
      entry.provider.registrationOrder = order;
      registrationTail.promise = turn;
      registrationTail.release[order] = release;
    }
    await Promise.all(pending.map(({ config, provider }, order) => startOne(config, provider, order, registrationTail.release)));
    started = true;
  }

  async function startOne(config, provider, order, releaseRegistration) {
    try {
      await provider.start({ firstStart: true });
    } catch (error) {
      provider.lastError = String(error?.message || error);
      stderr(`federation[${config.key}] failed to start: ${provider.lastError}`);
      // Names claimed before the failure are released, so a later provider is
      // not blocked by a dead one.
      if (!provider.firstRegistrationDone) {
        for (const [name, owner] of [...claimed.entries()]) {
          if (owner === config.key) claimed.delete(name);
        }
        provider.advertised = provider.advertised || [];
        provider.toolsByPrefixed = new Map();
      }
      // Stdio retries only a crash: a child that starts and then refuses to speak
      // is a configuration error. HTTP providers are different: an unreachable
      // endpoint is expected to come online later, so they use their own bounded
      // backoff and keep trying without a bridge restart.
      const crashed = provider.everSpawned && !provider.child;
      if (config.transport === "http" && provider.isRetryableStartError(error)) {
        provider.scheduleReconnect(error);
      } else if (crashed && !error?.terminalStart) {
        provider.scheduleRestart();
      } else {
        provider.state = "failed";
        // Set BEFORE stop(). stop() kills the child, and onExit — which lands a
        // tick or two later — recomputes state as
        // `failedTerminally ? "failed" : "stopped"`. Without this the state set
        // one line above was overwritten with "stopped" milliseconds after
        // startup, and call() only surfaces lastError for a FAILED provider, so
        // the reason a provider never came up was hidden from both the operator
        // and the model. Measured with a child that never answers initialize:
        // state=failed immediately after start(), state=stopped 50ms later.
        //
        // "Terminal" is the truth here: this branch is the one that does NOT
        // schedule a restart, so nothing short of operator action brings the
        // provider back.
        provider.failedTerminally = true;
        // Must not leave a child behind, and the bridge itself has to stay
        // healthy: bridge_status keeps answering either way.
        provider.stop();
      }
    } finally {
      releaseRegistration?.[order]?.();
    }
  }

  function start() {
    if (!startPromise) {
      // Eagerly, during startup, before the first tools/list can be answered. A
      // provider that appears later registers its real schemas and emits the
      // standard list-changed notification through the parent transport.
      startPromise = startAll().catch((error) => {
        started = true;
        stderr(`federation startup failed: ${error?.stack || error}`);
      });
    }
    return startPromise;
  }

  function listTools() {
    const tools = [];
    for (const provider of providers.values()) {
      if (provider.advertised) tools.push(...provider.advertised);
    }
    return tools;
  }

  function ownerOf(name) {
    for (const provider of providers.values()) {
      if (provider.toolsByPrefixed.has(name)) return provider;
    }
    return null;
  }

  // Validated against the parent's OWN cached map before dispatch. Measured
  // deviation: chrome-devtools-mcp returns an unknown tool as an isError *result*,
  // not a JSON-RPC error, exactly as it does for input-validation failures and for
  // "Could not connect to Chrome" — so error-channel sniffing cannot distinguish
  // a routing failure from an execution failure.
  function hasTool(name) {
    return typeof name === "string" && ownerOf(name) !== null;
  }

  async function callTool(name, args) {
    const provider = ownerOf(name);
    if (!provider) {
      return textResult(`Unknown federated tool: ${name}`, { tool: name, code: "UNKNOWN_TOOL" });
    }
    try {
      return await provider.call(name, args);
    } catch (error) {
      await audit(name, args, { provider: provider.key, failed: true }, error);
      return textResult(`Call to '${name}' was refused: ${error?.message || error}`, {
        provider: provider.key,
        tool: name,
        code: error?.code || "PROVIDER_ERROR",
        state: provider.state,
      });
    }
  }

  function killAll() {
    const results = [];
    for (const provider of providers.values()) {
      try {
        results.push(provider.killNow());
      } catch (error) {
        results.push({ key: provider.key, groupKilled: false, groupError: String(error?.message || error), containmentVerified: false, groupGone: false, uncontainedPids: null, containmentProbe: "none" });
      }
    }
    return results;
  }

  function status() {
    return {
      started,
      configured: providers.size,
      childServerEnvAllowlist: ENV_ALLOWLIST.slice(),
      childServerEnvDenylist: [...ENV_DENYLIST].sort(),
      childServerEnvDenyPattern: String(ENV_DENY_PATTERN),
      personalApprovalFile: host.approvalFile,
      providers: [...providers.values()].map((provider) => provider.status()),
    };
  }

  function childCount() {
    let live = 0;
    for (const provider of providers.values()) {
      if (provider.child) live += 1;
    }
    return live;
  }

  function pendingCallCount() {
    let total = 0;
    for (const provider of providers.values()) total += provider.pending.size;
    return total;
  }

  return { start, listTools, hasTool, callTool, killAll, status, childCount, pendingCallCount };
}

export const __testing = {
  MAX_PENDING_LINE_BYTES,
  MAX_MAX_RESULT_BYTES,
  ENV_ALLOWLIST,
  ENV_DENYLIST,
  buildChildEnv,
  executeDnsSd,
  normalizeToolAlias,
  resolveBonjourEndpoint,
  copyContent,
  summarizeContent,
  PERSONAL_APPROVAL_MAX_TTL_MS,
  RESTART_MAX_ATTEMPTS,
  PROVIDER_START_DEADLINE_MS,
  MAX_TOOLS_PAGES,
  TOOLS_LIST_TIMEOUT_MS,
};
