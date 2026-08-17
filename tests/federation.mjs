// Child-MCP federation tests. Negative cases first.
//
// Never launches a browser and never touches the network: every provider is the
// stub server in tests/fixtures. A suite that needs real Chrome does not get run,
// which is the same as not having a suite.

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { createFederation, parseProviderRegistry, __testing } from "../lib/federation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(here, "..", "bridge.mjs");
const disablePath = path.resolve(here, "..", "scripts", "disable.sh");
const stubPath = path.join(here, "fixtures", "stub-mcp-server.mjs");
// macOS: /var is a symlink to /private/var, so an unresolved temp path and the
// path a child reports back are different strings for the same directory.
const temporaryRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mac-developer-bridge-federation-")));
const FULL_ACCESS_ACK = "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS";

const spawnedPids = new Set();
const federations = [];
const bridges = [];

function noopAudit() {
  return Promise.resolve();
}

function quietStderr() {
  const lines = [];
  const fn = (message) => lines.push(message);
  fn.lines = lines;
  return fn;
}

let caseCounter = 0;

async function makeFederation(providers, { extra = {}, approvalFile = null, audit = noopAudit } = {}) {
  caseCounter += 1;
  const dataDir = path.join(temporaryRoot, `fed-${caseCounter}`);
  const jobDir = path.join(dataDir, "jobs");
  await fsp.mkdir(jobDir, { recursive: true, mode: 0o700 });
  const stderr = quietStderr();
  const federation = createFederation({
    audit,
    stderr,
    dataDir,
    jobDir,
    nowIso: () => new Date().toISOString(),
    writeJobMetadata: async (metadata) => {
      await fsp.writeFile(path.join(jobDir, `${metadata.id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    },
    version: "test",
    approvalFile,
    registryJson: providers === null ? undefined : JSON.stringify({ providers }),
    registryPath: undefined,
    ...extra,
  });
  federation.__stderr = stderr;
  federation.__dataDir = dataDir;
  federation.__jobDir = jobDir;
  federations.push(federation);
  await federation.start();
  for (const provider of federation.status().providers) {
    if (provider.pid) spawnedPids.add(provider.pid);
  }
  return federation;
}

function stubProvider(overrides = {}) {
  const { env = {}, ...rest } = overrides;
  return {
    key: "stub",
    command: process.execPath,
    args: [stubPath],
    env,
    mode: "isolated",
    ...rest,
  };
}

async function poll(predicate, { attempts = 100, delayMs = 100, label = "condition" } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`poll timed out waiting for ${label}`);
}

function textOf(result) {
  return (result.__mcpContent || []).map((block) => block.text || "").join("\n");
}

let bridgeCounter = 0;

async function startBridge({ recheckMs = "400", providerEnv = {} } = {}) {
  bridgeCounter += 1;
  const dataDir = path.join(temporaryRoot, `bridge-${bridgeCounter}`);
  const logDir = path.join(dataDir, "logs");
  await fsp.mkdir(dataDir, { recursive: true });
  const unlockFile = path.join(dataDir, "FULL_ACCESS_ENABLED");
  await fsp.writeFile(unlockFile, FULL_ACCESS_ACK);
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MAC_DEV_BRIDGE_DATA_DIR: dataDir,
      MAC_DEV_BRIDGE_LOG_DIR: logDir,
      MAC_DEV_BRIDGE_UNLOCK_FILE: unlockFile,
      MAC_DEV_BRIDGE_AUDIT_MODE: "metadata",
      MAC_DEV_BRIDGE_MCP_SERVERS_JSON: JSON.stringify({
        providers: [{ key: "stub", command: process.execPath, args: [stubPath], env: providerEnv, mode: "isolated" }],
      }),
      MAC_DEV_BRIDGE_UNLOCK_RECHECK_MS: recheckMs,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  bridges.push(child);
  let bridgeStderr = "";
  child.stderr.on("data", (chunk) => { bridgeStderr += chunk.toString(); });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    entry.resolve(message);
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const request = (method, params = {}, timeoutMs = 20_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bridge request timed out: ${method}; stderr=${bridgeStderr}`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "federation-test", version: "1" }, capabilities: {} });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    child,
    request,
    exited,
    dataDir,
    unlockFile,
    get stderr() { return bridgeStderr; },
  };
}

// The federated child's own process group, read out of bridge_status so the test
// verifies containment by the same predicate the code kills with.
async function federatedChildGroup(bridge) {
  // Poll rather than trust one read.
  //
  // This used to take the first bridge_status answer and assert readiness, which
  // worked only because bridge_status awaited federationReady — i.e. it relied on a
  // native read-only tool being blocked by a slow provider. That coupling was a
  // defect and has been removed, so the helper polls, which is what a real client
  // does anyway.
  let provider = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await bridge.request("tools/call", { name: "bridge_status", arguments: {} });
    provider = response.result.structuredContent.federation.providers[0];
    if (provider && provider.state !== "starting") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(provider.state, "ready", `provider not ready: ${JSON.stringify(provider)}`);
  const pgid = provider.processGroupId;
  assert.ok(Number.isInteger(pgid) && pgid > 1);
  spawnedPids.add(pgid);
  return pgid;
}

function groupGone(pgid) {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// ---------------------------------------------------------------------------

try {
  // --- 1. default empty: a fresh install federates nothing -----------------
  {
    const federation = await makeFederation(null, { extra: { registryJson: undefined, registryPath: undefined } });
    assert.deepEqual(federation.listTools(), [], "an unconfigured registry must advertise no federated tools");
    assert.equal(federation.hasTool("stub__echo"), false);
    assert.equal(federation.childCount(), 0);
    assert.equal(federation.status().configured, 0);
  }

  // --- 2. config validation, at parse time --------------------------------
  {
    assert.deepEqual(parseProviderRegistry("{}"), []);
    assert.deepEqual(parseProviderRegistry('{"providers":[]}'), []);
    assert.throws(() => parseProviderRegistry('{"providers":[{"key":"a","command":"/bin/true"},{"key":"a","command":"/bin/true"}]}'), /duplicate provider key/);
    assert.throws(() => parseProviderRegistry('{"providers":[{"key":"has space","command":"/bin/true"}]}'), /'key' must match/);
    assert.throws(() => parseProviderRegistry('{"providers":[{"key":"a"}]}'), /'command' must be a non-empty string/);
    assert.throws(() => parseProviderRegistry('{"providers":[{"key":"a","command":"/bin/true","mode":"personalish"}]}'), /'mode' must be/);
    assert.throws(() => parseProviderRegistry('{"providers":[{"key":"a","command":"/bin/true","env":{"X":null}}]}'), /nothing to remove/);
    assert.throws(() => parseProviderRegistry("not json"), /not valid JSON/);
  }

  // --- 3. a prefixed name that is too long is rejected at startup ----------
  {
    const federation = await makeFederation([stubProvider({ env: { STUB_LONG_TOOL: "1" } })]);
    const status = federation.status();
    assert.equal(status.providers[0].state, "failed", "a provider with an unportable tool name must be rejected at startup");
    assert.match(status.providers[0].lastError, /not a portable tool name/);
    assert.deepEqual(federation.listTools(), [], "a rejected provider contributes no tools");
    // The bridge must stay healthy: status() still answers.
    assert.equal(status.configured, 1);
  }

  // --- 4. a name that collides with a built-in bridge tool is rejected -----
  {
    const federation = await makeFederation([stubProvider()], { extra: { reservedToolNames: ["stub__echo", "shell_exec"] } });
    const status = federation.status();
    assert.equal(status.providers[0].state, "failed");
    assert.match(status.providers[0].lastError, /collides with a built-in bridge tool/);
    assert.equal(federation.hasTool("stub__echo"), false, "a colliding provider must not shadow the built-in tool");
  }

  // --- 5. child never answers initialize: failed, not hung -----------------
  {
    const startedAt = Date.now();
    const federation = await makeFederation([stubProvider({ env: { STUB_ERA: "never_initialize" } })]);
    const elapsed = Date.now() - startedAt;
    const status = federation.status();
    assert.equal(status.providers[0].state, "failed");
    assert.ok(elapsed < 40_000, `startup must not hang on a silent child (took ${elapsed}ms)`);
    assert.deepEqual(federation.listTools(), []);
    // The state has to SURVIVE the child's exit. startAll sets "failed" and then
    // stops the child; onExit lands a tick or two later and recomputed the state
    // as "stopped", which reads like an orderly shutdown somebody could undo —
    // and call() surfaces lastError only for a FAILED provider, so the reason was
    // hidden from both the operator and the model. Measured: failed at t=0,
    // stopped at t=50ms.
    await poll(() => federation.status().providers[0].pid === null, { attempts: 100, delayMs: 50, label: "the failed provider's child to exit" });
    const settled = federation.status().providers[0];
    assert.equal(settled.state, "failed", "a provider that failed its handshake must stay failed once its child exits, not become 'stopped'");
    assert.match(settled.lastError, /did not answer initialize/);
    const result = await federation.callTool("stub__echo", {});
    assert.equal(result.__isError, true);
    assert.match(textOf(result), /Unknown federated tool/);
  }

  // --- 6. dual-era handshake ----------------------------------------------
  {
    // legacy: discover answered with -32601
    const legacy = await makeFederation([stubProvider()]);
    assert.equal(legacy.status().providers[0].state, "ready");
    assert.equal(legacy.status().providers[0].era, "legacy", "a -32601 to server/discover means legacy");

    // modern: discover answered
    const modern = await makeFederation([stubProvider({ env: { STUB_ERA: "modern" } })]);
    assert.equal(modern.status().providers[0].state, "ready");
    assert.equal(modern.status().providers[0].era, "modern");

    // -32022 with data.supported: stays modern, retries with the offered version
    const negotiated = await makeFederation([stubProvider({ env: { STUB_ERA: "modern_negotiate" } })]);
    assert.equal(negotiated.status().providers[0].era, "modern", "a -32022 with data.supported is a modern negotiation, not a reason to fall back");
    assert.equal(negotiated.status().providers[0].state, "ready");

    // never answers discover at all: legacy by TIMEOUT, proving the fallback is
    // not keyed to any particular error code.
    const silent = await makeFederation([stubProvider({ env: { STUB_ERA: "silent_discover" } })]);
    assert.equal(silent.status().providers[0].era, "legacy");
    assert.equal(silent.status().providers[0].state, "ready");

    // a server that negotiates a version we do not support is a disconnect.
    const badVersion = await makeFederation([stubProvider({ env: { STUB_ERA: "bad_version" } })]);
    assert.equal(badVersion.status().providers[0].state, "failed");
    assert.match(badVersion.status().providers[0].lastError, /unsupported protocol version/);
  }

  // --- 7. unknown prefixed tool is rejected LOCALLY ------------------------
  {
    const federation = await makeFederation([stubProvider()]);
    assert.equal(federation.hasTool("stub__echo"), true);
    assert.equal(federation.hasTool("stub__does_not_exist"), false, "routing must be decided by the parent's own map, never by the child's isError channel");
    const result = await federation.callTool("stub__does_not_exist", {});
    assert.equal(result.__structured.code, "UNKNOWN_TOOL");
    // The measured child deviation: the child returns an unknown tool as an
    // isError RESULT. If routing were decided there, this would be
    // indistinguishable from a genuine execution failure.
    const echoed = await federation.callTool("stub__echo", { text: "hi" });
    assert.equal(echoed.__isError, false);
    assert.equal(textOf(echoed), "echo:hi");
  }

  // --- 8. content passthrough ---------------------------------------------
  {
    const federation = await makeFederation([stubProvider()]);

    const image = await federation.callTool("stub__image", {});
    assert.equal(image.__mcpContent.length, 2, "an image result is TWO blocks; flattening loses the picture");
    assert.equal(image.__mcpContent[0].type, "text");
    assert.equal(image.__mcpContent[1].type, "image");
    assert.equal(image.__mcpContent[1].mimeType, "image/jpeg");
    assert.equal(Buffer.from(image.__mcpContent[1].data, "base64").toString("utf8"), "STUB-IMAGE-BYTES", "base64 must arrive byte-identical");
    assert.deepEqual(image.__mcpContent[1].annotations, { audience: ["user"], priority: 0.5 });

    const blob = await federation.callTool("stub__blobres", {});
    assert.equal(blob.__mcpContent[0].type, "resource");
    assert.equal(blob.__mcpContent[0].resource.blob !== undefined, true, "resource.blob must survive; handling only .text makes binary resources vanish");
    assert.equal(Buffer.from(blob.__mcpContent[0].resource.blob, "base64").toString("utf8"), "STUB-BLOB");
    assert.equal(blob.__mcpContent[0].resource.uri, "file:///stub/blob.bin");

    const structured = await federation.callTool("stub__structured", {});
    assert.equal(structured.__isError, true, "isError must survive");
    assert.deepEqual(structured.__structured, { ok: false, attempts: 2 }, "structuredContent must survive");
    assert.equal(structured.__mcpContent[1].type, "future_block_type", "an unknown content type must be preserved verbatim");
    assert.equal(structured.__mcpContent[1].extraKey, "kept", "unknown keys inside a block must be preserved");
    assert.deepEqual(structured.__mcpContent[1].payload, { nested: true });

    // The schema is forwarded verbatim, including $schema: stripping it silently
    // reclassifies a draft-07 schema as 2020-12.
    const descriptor = federation.listTools().find((tool) => tool.name === "stub__echo");
    assert.equal(descriptor.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.equal(descriptor.description, "Echo the given text back.");
    assert.deepEqual(descriptor.annotations, { readOnlyHint: true, category: "stub" }, "annotations pass through as descriptive metadata, unknown keys included");
    assert.deepEqual(descriptor.execution, { kind: "immediate" }, "unknown top-level fields must be forwarded");
  }

  // --- 9. environment scrub: allowlist, not denylist -----------------------
  {
    // Seeded into THIS process's environment, so the test proves the child does
    // not inherit them rather than proving they happened to be absent.
    const secretKeys = [
      "MAC_DEV_BRIDGE_FULL_ACCESS_ACK", "MAC_DEV_BRIDGE_HTTP_TOKEN", "MAC_DEV_BRIDGE_HTTP_TOKEN_FILE",
      "MAC_DEV_BRIDGE_OAUTH_CLIENT_SECRET", "MAC_DEV_BRIDGE_OAUTH_CLIENT_ID",
      "MAC_DEV_BRIDGE_DATA_DIR", "MAC_DEV_BRIDGE_LOG_DIR", "MAC_DEV_BRIDGE_AUDIT_LOG",
      "MAC_DEV_BRIDGE_UNLOCK_FILE", "CONTROL_PLANE_API_KEY", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "GH_TOKEN",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLOUDFLARE_API_TOKEN", "npm_config_registry",
      // The catch-all pattern, which is what protects against secrets nobody
      // thought to enumerate.
      "SOME_FUTURE_TOKEN", "SOME_FUTURE_SECRET", "SOME_FUTURE_KEY", "DATABASE_PASSWORD",
    ];
    const sentinels = new Map();
    const priorEnv = new Map();
    for (const key of secretKeys) {
      priorEnv.set(key, process.env[key]);
      const sentinel = `SENTINEL-${crypto.randomBytes(8).toString("hex")}`;
      sentinels.set(key, sentinel);
      process.env[key] = sentinel;
    }
    let childEnv;
    let refused;
    try {
      const federation = await makeFederation([stubProvider({
        // A config entry may not re-add a denied key either: deny beats config.
        env: { STUB_MARKER: "kept", GITHUB_TOKEN: "should-be-refused", MY_SECRET: "nope" },
      })]);
      childEnv = JSON.parse(textOf(await federation.callTool("stub__envdump", {})));
      refused = federation.status().providers[0].envKeysRefused;
    } finally {
      for (const [key, value] of priorEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const key of secretKeys) {
      assert.equal(childEnv[key], undefined, `${key} must never reach a child MCP server`);
    }
    assert.equal(childEnv.MY_SECRET, undefined, "a config key matching the deny pattern must be refused, not forwarded");
    const flattened = JSON.stringify(childEnv);
    for (const [key, sentinel] of sentinels) {
      assert.equal(flattened.includes(sentinel), false, `the value of ${key} leaked into the child environment under some other name`);
    }
    assert.equal(childEnv.STUB_MARKER, "kept", "a config-named key that is not denied must be forwarded");
    for (const key of Object.keys(childEnv)) {
      // __CF_USER_TEXT_ENCODING and friends are set by CoreFoundation inside the
      // child itself, not inherited from here: measured, they appear even when the
      // spawn env is exactly the allowlist. Tolerated by prefix so the check stays
      // strict about everything that IS inheritable.
      const allowed = __testing.ENV_ALLOWLIST.includes(key) || key === "STUB_MARKER" || key.startsWith("__CF");
      assert.ok(allowed, `unexpected key '${key}' in the child environment; the base must be {} plus the allowlist`);
    }
    assert.ok(refused.includes("GITHUB_TOKEN") && refused.includes("MY_SECRET"), "refusals are reported, not silent");
  }

  // --- 10. roots/list is answered, so a call does not stall ---------------
  {
    const federation = await makeFederation([stubProvider()]);
    const startedAt = Date.now();
    const result = await federation.callTool("stub__needroots", {});
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5_000, `a call that triggers roots/list must not stall (took ${elapsed}ms)`);
    const roots = JSON.parse(textOf(result));
    assert.equal(roots.length, 1);
    assert.match(roots[0].uri, /^file:\/\/.*\/federation\/stub\/roots$/, "one narrow per-provider root, which also bounds where the child may write");
    const rootsDir = federation.status().providers[0].rootsDir;
    const mode = (await fsp.stat(rootsDir)).mode & 0o777;
    assert.equal(mode, 0o700, `roots dir must be 0700, got ${mode.toString(8)}`);
  }

  // --- 11. cancellation must not leak pending entries ---------------------
  {
    const federation = await makeFederation([stubProvider({ callTimeoutMs: 1_500 })]);
    const call = federation.callTool("stub__slow", {});
    await poll(() => federation.pendingCallCount() === 1, { label: "the call to be in flight", attempts: 30, delayMs: 20 });
    const result = await call;
    assert.equal(result.__isError, true);
    assert.match(textOf(result), /did not answer tools\/call within 1500ms/);
    // The child sends NO response at all after notifications/cancelled — that is
    // spec-correct — so the entry must be deleted at cancel time, not on reply.
    assert.equal(federation.pendingCallCount(), 0, "a cancelled call must not leak a pending id-map entry");
    // And the provider is still usable.
    const echoed = await federation.callTool("stub__echo", { text: "after-cancel" });
    assert.equal(textOf(echoed), "echo:after-cancel");
  }

  // --- 12. child exits mid-call: the waiter settles, nothing hangs --------
  {
    const federation = await makeFederation([stubProvider()]);
    const startedAt = Date.now();
    const result = await federation.callTool("stub__die", {});
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 10_000, `a child that exits mid-call must settle the waiter fast (took ${elapsed}ms)`);
    assert.equal(result.__isError, true);
    assert.match(textOf(result), /exited/);
    assert.equal(federation.pendingCallCount(), 0);
  }

  // --- 13. pagination: both pages are advertised, in the child's order ----
  {
    const federation = await makeFederation([stubProvider({ env: { STUB_PAGINATE: "1" } })]);
    const names = federation.listTools().map((tool) => tool.name);
    assert.ok(names.length > 2, "a nextCursor must be followed, or the tool set is silently truncated");
    assert.deepEqual(names.slice(0, 3), ["stub__echo", "stub__image", "stub__blobres"], "the child's ordering is preserved across pages");
    assert.ok(names.includes("stub__envdump"));
  }

  // --- 14. restart backoff has a terminal state --------------------------
  {
    const spawnLog = path.join(temporaryRoot, "restart-spawns.log");
    await fsp.writeFile(spawnLog, "");
    const federation = await makeFederation([stubProvider({ env: { STUB_EXIT_IMMEDIATELY: "1", STUB_SPAWN_LOG: spawnLog } })]);
    // Immediately after the first failure a call must return, not hang.
    const early = await federation.callTool("stub__echo", {});
    assert.equal(early.__isError, true);
    assert.match(textOf(early), /Unknown federated tool/, "a provider that never became ready advertises nothing, so routing fails locally");

    await poll(() => federation.status().providers[0].state === "failed", { attempts: 300, delayMs: 200, label: "the provider to reach the terminal failed state" });
    const status = federation.status();
    assert.equal(status.providers[0].state, "failed");
    assert.match(status.providers[0].lastError || "", /.+/);
    const spawns = (await fsp.readFile(spawnLog, "utf8")).trim().split("\n").filter(Boolean).length;
    assert.ok(spawns <= 1 + __testing.RESTART_MAX_ATTEMPTS, `unbounded respawn is a self-inflicted DoS; saw ${spawns} spawns`);
    assert.ok(spawns >= 2, `backoff must actually retry; saw ${spawns} spawns`);
  }

  // --- 15. restarting/failed state returns isError immediately, replaying nothing
  {
    // A provider that starts once, is advertised, and is then killed: the tool is
    // in the map, so this exercises the state guard rather than the routing one.
    const federation = await makeFederation([stubProvider()]);
    const pid = federation.status().providers[0].pid;
    assert.ok(Number.isInteger(pid));
    // Never signal a pid we did not spawn: confirm parentage first.
    const ppid = (await new Promise((resolve) => {
      const ps = spawn("ps", ["-o", "ppid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      ps.stdout.on("data", (chunk) => { out += chunk.toString(); });
      ps.once("close", () => resolve(out.trim()));
    }));
    assert.equal(Number(ppid), process.pid, `refusing to signal pid ${pid}: its parent is ${ppid}, not this test (${process.pid})`);
    process.kill(pid, "SIGKILL");
    await poll(() => ["restarting", "failed"].includes(federation.status().providers[0].state), { label: "the provider to notice its child died", attempts: 60, delayMs: 50 });
    // A dead pgid must not be reported as if it were live. macOS recycles pids, so
    // a stale number here is a group kill aimed at whatever now owns it.
    assert.equal(federation.status().providers[0].processGroupId, null, "processGroupId must be null while there is no child, not the dead one");
    assert.equal(federation.status().providers[0].pid, null);
    const startedAt = Date.now();
    const result = await federation.callTool("stub__echo", { text: "during-restart" });
    assert.ok(Date.now() - startedAt < 1_000, "an unavailable provider must answer immediately, never hang and never a bare timeout");
    assert.equal(result.__isError, true);
    assert.equal(result.__structured.stateLost, true, "the model must be told browser state was lost rather than have a call replayed");
    assert.match(textOf(result), /unavailable/);
    // And it recovers.
    await poll(() => federation.status().providers[0].state === "ready", { label: "the provider to recover", attempts: 100, delayMs: 100 });
    const recovered = await federation.callTool("stub__echo", { text: "recovered" });
    assert.equal(textOf(recovered), "echo:recovered");
  }

  // --- 16. oversized results are refused, and audited without the payload -
  {
    const auditRecords = [];
    const federation = await makeFederation(
      [stubProvider({ maxResultBytes: 50_000, env: { STUB_BIG_BYTES: "200000" } })],
      { audit: async (tool, args, summary) => { auditRecords.push({ tool, args, summary }); } },
    );
    const result = await federation.callTool("stub__big", {});
    assert.equal(result.__isError, true);
    assert.equal(result.__structured.code, "RESULT_TOO_LARGE");
    assert.ok(result.__structured.byteLength > 50_000);
    const record = auditRecords.find((entry) => entry.summary?.oversized);
    assert.ok(record, "an oversized result must still be audited");
    assert.deepEqual(record.summary.content, [{ type: "text", byteLength: 200_000 }], "the audit record stores shape and size, never the payload");
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes("BBBBBBBBBB"), false, "the payload must not reach the audit log");

    // And a normal-sized image result is audited by shape, not by base64.
    const okFederation = await makeFederation([stubProvider()], {
      audit: async (tool, args, summary) => { auditRecords.push({ tool, args, summary }); },
    });
    await okFederation.callTool("stub__image", {});
    const imageRecord = auditRecords.find((entry) => entry.tool === "stub__image");
    assert.ok(imageRecord);
    assert.deepEqual(imageRecord.summary.content[1], { type: "image", mimeType: "image/jpeg", byteLength: 24 });
    assert.equal(JSON.stringify(imageRecord).includes("U1RVQi1JTUFHRS1CWVRFUw"), false, "base64 image data must not reach the audit log");
  }

  // --- 17. stdout noise is skipped; one oversized line is DISCARDED, not a kill ----
  {
    const noisy = await makeFederation([stubProvider({ env: { STUB_GARBAGE: "1" } })]);
    assert.equal(noisy.status().providers[0].state, "ready", "non-MCP stdout noise must be skipped, not desync the framer");
    const result = await noisy.callTool("stub__echo", { text: "after-garbage" });
    assert.equal(textOf(result), "echo:after-garbage");
    assert.ok(noisy.__stderr.lines.some((line) => line.includes("skipped unparseable stdout line")), "the skip must be logged");

    // The cap must sit ABOVE the largest result a provider may be configured to
    // return, or the configured ceiling is unreachable by construction and a
    // legitimate large reply is a kill instead of a RESULT_TOO_LARGE.
    assert.ok(
      __testing.MAX_PENDING_LINE_BYTES > __testing.MAX_MAX_RESULT_BYTES,
      "a result at the configured maximum must be deliverable without tripping the line cap",
    );
    const huge = await makeFederation([stubProvider({
      env: { STUB_HUGE_LINE: "1", STUB_HUGE_LINE_BYTES: String(__testing.MAX_PENDING_LINE_BYTES + 1) },
    })]);
    const state = huge.status().providers[0];
    assert.notEqual(state.state, "ready");
    assert.ok(
      huge.__stderr.lines.some((line) => line.includes("exceeded") && line.includes("discarded")),
      `a single stdout line over the cap must be discarded; stderr was ${JSON.stringify(huge.__stderr.lines.slice(0, 5))}`,
    );
    // Discarded, NOT charged to the crash budget. The cap is a payload-size
    // control, and treating it as a crash walked the provider through all five
    // restarts into a permanent state=failed.
    assert.equal(state.restarts, 0, "a stdout-cap discard must not consume a restart attempt");

    // The scenario the cap made unreachable: a result at the size the provider is
    // CONFIGURED to allow. At an 8 MiB line cap a 12 MB reply SIGKILLed the child
    // instead of being delivered, and six such calls — six ordinary requests for a
    // full-page screenshot — failed the provider permanently.
    const big = await makeFederation([stubProvider({
      maxResultBytes: __testing.MAX_MAX_RESULT_BYTES,
      env: { STUB_BIG_BYTES: "12000000" },
    })]);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await big.callTool("stub__big", {});
      assert.equal(result.__isError, false, `call ${attempt} must be delivered, not killed`);
      assert.equal(textOf(result).length, 12_000_000, `call ${attempt} must return the whole result`);
    }
    const bigState = big.status().providers[0];
    assert.equal(bigState.state, "ready");
    assert.equal(bigState.restarts, 0, "delivering a legitimately large result must cost no restart attempts");
  }

  // --- 17c. a provider that crashed before registering still gets its names
  {
    // registerTools was called with `firstStart && !firstRegistrationDone`, and
    // scheduleRestart always passes firstStart:false — so the restart branch ran,
    // claimed nothing, and firstRegistrationDone was set anyway. Measured: after
    // recovery the provider was state=ready with toolCount 0, listTools empty and
    // every call answered "Unknown federated tool", permanently.
    const marker = path.join(temporaryRoot, `stub-first-crash-${caseCounter + 1}`);
    const federation = await makeFederation([stubProvider({ key: "late", env: { STUB_FAIL_FIRST_MARKER: marker } })]);
    await poll(() => federation.status().providers[0].state === "ready", {
      label: "the provider to recover from a crash that preceded its first registration",
    });
    const state = federation.status().providers[0];
    assert.ok(state.toolCount > 0, `a recovered provider must advertise its tools, not sit ready with none; toolCount=${state.toolCount}`);
    assert.ok(federation.listTools().some((tool) => tool.name === "late__echo"), "the tool names must be claimed on the first SUCCESSFUL registration");
    assert.equal(federation.hasTool("late__echo"), true);
    assert.equal(textOf(await federation.callTool("late__echo", { text: "recovered" })), "echo:recovered");
  }

  // --- 18. personal mode: refused by default, then per-use only -----------
  {
    const approvalFile = path.join(temporaryRoot, "PERSONAL_BROWSER_APPROVED");
    const personal = (overrides = {}) => stubProvider({
      key: "browser",
      mode: "personal",
      args: [stubPath, "--isolated"],
      personalArgs: [stubPath, "--autoConnect"],
      flagCheck: { args: [stubPath, "--help"], requireFlags: ["--allowedUrlPattern", "--redactNetworkHeaders"] },
      ...overrides,
    });

    // no approval file at all
    await fsp.rm(approvalFile, { force: true });
    let federation = await makeFederation([personal()], { approvalFile });
    assert.equal(federation.status().providers[0].state, "failed");
    assert.match(federation.status().providers[0].lastError, /Personal-profile browser mode is not approved: no readable approval/);
    // Isolated mode is unaffected and still works.
    const isolated = await makeFederation([stubProvider()], { approvalFile });
    assert.equal(isolated.status().providers[0].state, "ready");

    const writeGrant = async (overrides) => {
      await fsp.writeFile(approvalFile, JSON.stringify({
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        provider: "browser",
        allowedUrlPatterns: ["https://github.com/*"],
        ...overrides,
      }), { mode: 0o600 });
    };

    // malformed
    await fsp.writeFile(approvalFile, "not json", { mode: 0o600 });
    federation = await makeFederation([personal()], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /not valid JSON/);

    // expired
    await writeGrant({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    federation = await makeFederation([personal()], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /grant expired at/);

    // wrong provider
    await writeGrant({ provider: "somethingelse" });
    federation = await makeFederation([personal()], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /names provider 'somethingelse'/);

    // TTL over the 15-minute ceiling
    await writeGrant({ expiresAt: new Date(Date.now() + __testing.PERSONAL_APPROVAL_MAX_TTL_MS + 60_000).toISOString() });
    federation = await makeFederation([personal()], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /exceeds the \d+ms ceiling/);

    // bad nonce
    await writeGrant({ nonce: "short" });
    federation = await makeFederation([personal()], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /'nonce' must be 32 hex/);

    // empty allowlist
    await writeGrant({ allowedUrlPatterns: [] });
    federation = await makeFederation([personal()], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /allowedUrlPatterns/);

    // a valid grant, but the provider cannot verify --allowedUrlPattern exists
    await writeGrant({});
    federation = await makeFederation([personal({ flagCheck: undefined })], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /no 'flagCheck'/, "a flag that cannot be verified to exist is not a security control");
    // The grant was consumed by that attempt, which is the point of single use.
    assert.equal(fs.existsSync(approvalFile), false);

    // a valid grant whose required flag the child does not document
    await writeGrant({});
    federation = await makeFederation([personal({ flagCheck: { args: [stubPath, "--help"], requireFlags: ["--totally-bogus-flag-xyz"] } })], { approvalFile });
    assert.match(federation.status().providers[0].lastError, /does not document the flag\(s\) --totally-bogus-flag-xyz/);

    // finally, the happy path
    const auditRecords = [];
    await writeGrant({});
    const grantNonce = JSON.parse(await fsp.readFile(approvalFile, "utf8")).nonce;
    federation = await makeFederation([personal()], {
      approvalFile,
      audit: async (tool, args, summary) => { auditRecords.push({ tool, summary }); },
    });
    const providerStatus = federation.status().providers[0];
    assert.equal(providerStatus.state, "ready");
    assert.equal(providerStatus.mode, "personal");
    assert.equal(providerStatus.personalGrant.nonce, grantNonce);
    const argv = JSON.parse(textOf(await federation.callTool("browser__argvdump", {})));
    assert.ok(argv.includes("--autoConnect"), "personal mode must use personalArgs");
    assert.equal(argv.includes("--isolated"), false, "--autoConnect and --isolated are mutually exclusive");
    assert.deepEqual(argv.slice(-2), ["--allowedUrlPattern", "https://github.com/*"], "the operator's patterns become --allowedUrlPattern, enforced inside the browser");
    assert.equal(fs.existsSync(approvalFile), false, "a consumed grant must be unlinked so it cannot be replayed");
    const record = auditRecords.find((entry) => entry.tool === "browser__argvdump");
    assert.equal(record.summary.personalApprovalNonce, grantNonce, "the grant must be traceable to the operator action that created it");

    // A second personal session needs a fresh operator action.
    const second = await makeFederation([personal()], { approvalFile });
    assert.equal(second.status().providers[0].state, "failed");
    assert.match(second.status().providers[0].lastError, /no readable approval/);
  }

  // --- 18b. an unreadable registry path fails closed, bridge stays healthy -
  {
    const federation = await makeFederation(null, {
      extra: { registryJson: undefined, registryPath: path.join(temporaryRoot, "no-such-registry.json") },
    });
    assert.deepEqual(federation.listTools(), [], "an unreadable registry must federate nothing rather than throw at startup");
    assert.equal(federation.status().configured, 0);
    assert.ok(federation.__stderr.lines.some((line) => line.includes("federation startup failed")), "the operator must be told why");
  }

  // --- 18c. a grant that expires mid-session stops authorising calls ------
  {
    const approvalFile = path.join(temporaryRoot, "PERSONAL_EXPIRING");
    await fsp.writeFile(approvalFile, JSON.stringify({
      nonce: crypto.randomBytes(16).toString("hex"),
      // Valid when consumed at spawn, expired before the first call. Expiry is
      // re-checked per call, so a long-lived personal session cannot outlive the
      // window the operator actually granted.
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
      provider: "browser",
      allowedUrlPatterns: ["https://example.com/*"],
    }), { mode: 0o600 });
    const federation = await makeFederation([stubProvider({
      key: "browser",
      mode: "personal",
      personalArgs: [stubPath, "--autoConnect"],
      flagCheck: { args: [stubPath, "--help"], requireFlags: ["--allowedUrlPattern"] },
    })], { approvalFile });
    assert.equal(federation.status().providers[0].state, "ready");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const result = await federation.callTool("browser__echo", { text: "too-late" });
    assert.equal(result.__isError, true);
    assert.match(textOf(result), /the grant expired at/);
    assert.equal(federation.status().providers[0].personalGrant, null, "an expired grant must be dropped, not kept for the next call");
  }

  // --- 18d. an expired grant ends the session with no tool call at all ----
  {
    // Nothing armed a timer on expiresAt: the TTL was checked only inside call(),
    // armPing() kept the child from ever idling out, and federated children have
    // no lifetime ceiling. Measured with a 2s grant and zero tool calls: 6s past
    // expiry the child was alive, state was ready, and bridge_status still
    // reported the grant as live. A browser holding every logged-in session on
    // the machine kept running for as long as the model stayed quiet.
    const approvalFile = path.join(temporaryRoot, "PERSONAL_UNATTENDED");
    await fsp.writeFile(approvalFile, JSON.stringify({
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: new Date(Date.now() + 1_500).toISOString(),
      provider: "browser",
      allowedUrlPatterns: ["https://example.com/*"],
    }), { mode: 0o600 });
    const federation = await makeFederation([stubProvider({
      key: "browser",
      mode: "personal",
      personalArgs: [stubPath, "--autoConnect"],
      flagCheck: { args: [stubPath, "--help"], requireFlags: ["--allowedUrlPattern"] },
    })], { approvalFile });
    const pid = federation.status().providers[0].pid;
    assert.ok(Number.isInteger(pid) && pid > 1);
    assert.equal(federation.status().providers[0].personalGrant.expired, false);

    // No calls. The only thing that may end this session is the grant running out.
    await poll(() => {
      const provider = federation.status().providers[0];
      return provider.state !== "ready" && provider.personalGrant === null;
    }, { attempts: 60, delayMs: 100, label: "the grant to expire on its own" });

    await poll(() => {
      try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
    }, { attempts: 60, delayMs: 100, label: "the personal-profile child to be shut down at expiry" });
    const after = federation.status().providers[0];
    assert.equal(after.personalGrant, null, "an expired grant must never be reported as the live grant");
    assert.match(after.lastError, /the grant expired at/);
  }

  // --- 18e. a crashed personal session does not eat the next grant --------
  {
    // personalRefusal() marks a refused grant terminal precisely so it is never
    // retried, but scheduleRestart never read that flag. Measured: with the
    // provider in state=restarting, a NEW grant written by the operator for a
    // future session was consumed 3s later with no tool call and no user action,
    // relaunching the personal-profile browser. One approval became a session
    // nobody asked for.
    const approvalFile = path.join(temporaryRoot, "PERSONAL_NO_RESPAWN");
    const writeGrant = async () => {
      const nonce = crypto.randomBytes(16).toString("hex");
      await fsp.writeFile(approvalFile, JSON.stringify({
        nonce,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        provider: "browser",
        allowedUrlPatterns: ["https://example.com/*"],
      }), { mode: 0o600 });
      return nonce;
    };
    const first = await writeGrant();
    const federation = await makeFederation([stubProvider({
      key: "browser",
      mode: "personal",
      personalArgs: [stubPath, "--autoConnect"],
      flagCheck: { args: [stubPath, "--help"], requireFlags: ["--allowedUrlPattern"] },
    })], { approvalFile });
    assert.equal(federation.status().providers[0].state, "ready");
    assert.equal(federation.status().providers[0].personalGrant.nonce, first);
    assert.equal(fs.existsSync(approvalFile), false, "the first grant is consumed by the session it authorised");

    // The child dies. stub__die exits without answering, so this is an ordinary
    // crash, not a shutdown.
    await federation.callTool("browser__die", {});
    await poll(() => federation.status().providers[0].state === "failed", {
      attempts: 60,
      delayMs: 100,
      label: "a crashed personal provider to fail rather than queue a restart",
    });

    // The operator prepares a future session. Nothing may take it.
    const second = await writeGrant();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(fs.existsSync(approvalFile), true, `a queued restart must not consume the operator's next grant (${second})`);
    const provider = federation.status().providers[0];
    assert.equal(provider.state, "failed");
    assert.equal(provider.personalGrant, null);
    assert.equal(provider.pid, null, "no personal-profile child may be running on a grant nobody spent");
  }

  // --- 19. a nonexistent command fails closed, and does not poison peers --
  {
    const federation = await makeFederation([
      { key: "missing", command: "/nonexistent/mcp-server", args: [], env: {}, mode: "isolated" },
      stubProvider(),
    ]);
    const status = federation.status();
    const missing = status.providers.find((provider) => provider.key === "missing");
    const stub = status.providers.find((provider) => provider.key === "stub");
    assert.equal(missing.state, "failed");
    assert.equal(missing.toolCount, 0);
    assert.equal(stub.state, "ready", "one broken provider must not stop the others");
    assert.equal(textOf(await federation.callTool("stub__echo", { text: "peer-ok" })), "echo:peer-ok");
  }

  // --- 20. a hung-but-alive child is caught by ping, not by process liveness
  {
    const previous = process.env.MAC_DEV_BRIDGE_MCP_PING_IDLE_MS;
    process.env.MAC_DEV_BRIDGE_MCP_PING_IDLE_MS = "300";
    // The module read the interval at import time, so this seam has to be set
    // before the first import; assert that rather than pretend otherwise.
    const { createFederation: freshCreate } = await import(`../lib/federation.mjs?ping=${Date.now()}`);
    const dataDir = path.join(temporaryRoot, "ping-fed");
    const jobDir = path.join(dataDir, "jobs");
    await fsp.mkdir(jobDir, { recursive: true, mode: 0o700 });
    const stderr = quietStderr();
    const federation = freshCreate({
      audit: noopAudit,
      stderr,
      dataDir,
      jobDir,
      nowIso: () => new Date().toISOString(),
      writeJobMetadata: async (metadata) => {
        await fsp.writeFile(path.join(jobDir, `${metadata.id}.json`), JSON.stringify(metadata), { mode: 0o600 });
      },
      version: "test",
      registryJson: JSON.stringify({ providers: [stubProvider({ env: { STUB_DEAF_PING: "1" } })] }),
    });
    federations.push(federation);
    await federation.start();
    const pid = federation.status().providers[0].pid;
    if (pid) spawnedPids.add(pid);
    assert.equal(federation.status().providers[0].state, "ready");
    if (previous === undefined) delete process.env.MAC_DEV_BRIDGE_MCP_PING_IDLE_MS;
    else process.env.MAC_DEV_BRIDGE_MCP_PING_IDLE_MS = previous;

    // The process never dies, so only the protocol-level ping can notice.
    await poll(() => stderr.lines.some((line) => line.includes("ping failed")), {
      attempts: 100, delayMs: 100, label: "the idle ping to catch a hung child",
    });
    await poll(() => federation.status().providers[0].state !== "ready", { attempts: 60, delayMs: 100, label: "the hung child to be restarted" });
  }

  // --- 21. end to end through bridge.mjs ---------------------------------
  {
    const dataDir = path.join(temporaryRoot, "bridge-data");
    const logDir = path.join(temporaryRoot, "bridge-logs");
    await fsp.mkdir(dataDir, { recursive: true });
    const unlockFile = path.join(dataDir, "FULL_ACCESS_ENABLED");
    await fsp.writeFile(unlockFile, FULL_ACCESS_ACK);
    const registry = { providers: [{ key: "stub", command: process.execPath, args: [stubPath], env: {}, mode: "isolated" }] };

    const child = spawn(process.execPath, [bridgePath], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MAC_DEV_BRIDGE_DATA_DIR: dataDir,
        MAC_DEV_BRIDGE_LOG_DIR: logDir,
        MAC_DEV_BRIDGE_UNLOCK_FILE: unlockFile,
        MAC_DEV_BRIDGE_AUDIT_MODE: "metadata",
        MAC_DEV_BRIDGE_MCP_SERVERS_JSON: JSON.stringify(registry),
        MAC_DEV_BRIDGE_UNLOCK_RECHECK_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridges.push(child);
    let bridgeStderr = "";
    child.stderr.on("data", (chunk) => { bridgeStderr += chunk.toString(); });
    const pending = new Map();
    let nextId = 1;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message);
    });
    const request = (method, params = {}, timeoutMs = 20_000) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge request timed out: ${method}; stderr=${bridgeStderr}`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

    const initialized = await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "federation-test", version: "1" }, capabilities: {} });
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    // The child's tools appear prefixed, alongside the bridge's own.
    const listed = await request("tools/list");
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("bridge_status"), "the bridge's own tools are still advertised");
    assert.ok(names.includes("stub__echo"), `federated tools must be advertised; got ${JSON.stringify(names)}`);
    assert.equal(names.includes("echo"), false, "the child's unprefixed name must never be advertised");

    // A proxied call returns the child's result.
    const echoed = await request("tools/call", { name: "stub__echo", arguments: { text: "through-the-bridge" } });
    assert.equal(echoed.result.isError, false);
    assert.equal(echoed.result.content[0].text, "echo:through-the-bridge");

    // An image survives the bridge's own result serialisation verbatim: this is
    // what pins that toolTextResult was bypassed rather than flattening it.
    const image = await request("tools/call", { name: "stub__image", arguments: {} });
    assert.equal(image.result.content.length, 2, `expected two blocks, got ${JSON.stringify(image.result.content).slice(0, 300)}`);
    assert.equal(image.result.content[1].type, "image");
    assert.equal(Buffer.from(image.result.content[1].data, "base64").toString("utf8"), "STUB-IMAGE-BYTES");

    // Unknown federated tool: -32601 from the membership gate, not a child round trip.
    const unknown = await request("tools/call", { name: "stub__nope", arguments: {} });
    assert.equal(unknown.error.code, -32601);

    // bridge_status reports the provider, the env allowlist, and the approval state.
    const statusResponse = await request("tools/call", { name: "bridge_status", arguments: {} });
    const status = statusResponse.result.structuredContent;
    assert.equal(status.federation.providers[0].key, "stub");
    assert.equal(status.federation.providers[0].state, "ready");
    assert.equal(status.federation.providers[0].era, "legacy");
    assert.deepEqual(status.childServerEnvAllowlist, __testing.ENV_ALLOWLIST);
    assert.equal(status.personalBrowserApproved.present, false);
    assert.equal(status.tunnelRuntimeKeyScrubbedFromChildEnvironment, false, "existing bridge_status fields must not be restructured");
    const childPid = status.federation.providers[0].processGroupId;
    assert.ok(Number.isInteger(childPid) && childPid > 1);
    spawnedPids.add(childPid);

    // The child is recorded for the reclaimer, in the format disable.sh parses.
    const jobFiles = await fsp.readdir(path.join(dataDir, "jobs"));
    const mcpJob = jobFiles.find((name) => name.startsWith("mcp-stub-"));
    assert.ok(mcpJob, `expected an mcp-child job entry; saw ${JSON.stringify(jobFiles)}`);
    const metadata = JSON.parse(await fsp.readFile(path.join(dataDir, "jobs", mcpJob), "utf8"));
    assert.equal(metadata.kind, "mcp-child");
    assert.equal(metadata.processGroupId, childPid);
    assert.equal(metadata.pid, childPid);
    // disable.sh strips the fraction and parses with this exact format; an entry
    // it cannot parse is SILENTLY SKIPPED, and the script then prints "Disabled"
    // having signalled nothing.
    const parsedStart = await new Promise((resolve) => {
      const date = spawn("date", ["-j", "-u", "-f", "%Y-%m-%dT%H:%M:%S", metadata.startedAt.split(".")[0], "+%s"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      date.stdout.on("data", (chunk) => { out += chunk.toString(); });
      date.once("close", (code) => resolve(code === 0 ? out.trim() : null));
    });
    assert.ok(parsedStart && Number(parsedStart) > 0, `startedAt '${metadata.startedAt}' must be parseable by disable.sh`);

    // Revocation kills the federated child group, and exit 78 alone is not
    // containment: assert BOTH.
    await fsp.rm(unlockFile, { force: true });
    // Deliberately not awaited: the bridge does not deliver a response on this
    // path. Measured against the pre-federation bridge too, so it is pre-existing
    // and not this change's doing — exitAfterFlush fires on setImmediate while
    // handleMessage's catch is still awaiting its audit append, so process.exit
    // wins the race. Containment is what is asserted here, because exit 78 on its
    // own is not containment.
    request("tools/call", { name: "bridge_status", arguments: {} }, 9_000).catch(() => {});
    const exitCode = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
    assert.equal(exitCode, 78, "a revoked bridge must exit 78");
    await poll(() => {
      try {
        process.kill(-childPid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }, { attempts: 60, delayMs: 100, label: `the federated child group ${childPid} to be gone` });
  }

  // --- 21a. disable.sh reclaims an mcp-child entry ------------------------
  {
    const dataDir = path.join(temporaryRoot, "disable-data");
    const jobDir = path.join(dataDir, "jobs");
    await fsp.mkdir(jobDir, { recursive: true });
    // A process WE spawned, in its own group, standing in for a federated child.
    const victim = spawn("/bin/sh", ["-c", "trap '' HUP; while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
    spawnedPids.add(victim.pid);
    await new Promise((resolve) => victim.once("spawn", resolve));
    await fsp.writeFile(path.join(jobDir, "mcp-stub-disable.json"), JSON.stringify({
      id: "mcp-stub-disable",
      kind: "mcp-child",
      label: "mcp-stub",
      pid: victim.pid,
      processGroupId: victim.pid,
      command: "stub mcp child",
      cwd: dataDir,
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      stdoutPath: null,
      stderrPath: null,
    }, null, 2));

    // Isolate disable.sh from the developer machine running this test. The test
    // is about reclaiming the recorded child, not a real bridge/cloudflared that
    // may happen to be running outside temporaryRoot.
    const fakeBin = path.join(temporaryRoot, "disable-test-bin");
    const disableInstallDir = path.join(temporaryRoot, "disable-install");
    await fsp.mkdir(fakeBin, { recursive: true });
    await fsp.mkdir(disableInstallDir, { recursive: true });
    const realPgrep = "/usr/bin/pgrep";
    const pgrepWrapper = path.join(fakeBin, "pgrep");
    await fsp.writeFile(pgrepWrapper, `#!/bin/sh
if [ "$1" = "-x" ] && [ "$2" = "cloudflared" ]; then exit 1; fi
exec ${realPgrep} "$@"
`, { mode: 0o700 });

    const result = await new Promise((resolve) => {
      const proc = spawn("bash", [disablePath], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`,
          MAC_DEV_BRIDGE_DATA_DIR: dataDir,
          MAC_DEV_BRIDGE_UNLOCK_FILE: path.join(dataDir, "FULL_ACCESS_ENABLED"),
          // Critical isolation: never let disable.sh resolve bridge.mjs or
          // mcp-http.mjs against this repository checkout. Otherwise its
          // fallback process scan can match and signal the live developer MDB.
          MAC_DEV_BRIDGE_INSTALL_DIR: disableInstallDir,
          MAC_DEV_BRIDGE_HTTP_PORT: "65534",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (chunk) => { out += chunk.toString(); });
      proc.stderr.on("data", (chunk) => { out += chunk.toString(); });
      proc.once("close", (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0, `disable.sh must exit 0; output was:\n${result.out}`);
    assert.match(result.out, /child MCP server/i, `disable.sh must name what it reclaimed; output was:\n${result.out}`);
    let gone = false;
    try { process.kill(-victim.pid, 0); } catch (error) { gone = error?.code === "ESRCH"; }
    assert.equal(gone, true, `disable.sh reported success but process group ${victim.pid} is still alive`);
  }

  // --- 21b. a child claiming the bridge's own tool names cannot intercept them
  {
    // Case 4 proves the collision guard rejects a reserved PREFIXED name, but the
    // realistic attack is a child that simply offers `shell_exec` and hopes the
    // gateway registers it flat. That has to be answered by the running bridge,
    // through the same tools/list and tools/call a client uses, because the
    // membership gate and the dispatch switch are two different code paths and
    // only one of them is exercised by a unit-level check.
    const bridge = await startBridge({ providerEnv: { STUB_SHADOW: "1" } });
    const listed = await bridge.request("tools/list");
    const names = listed.result.tools.map((tool) => tool.name);
    const impostors = ["bridge_status", "shell_exec", "audit_tail"];
    for (const name of impostors) {
      assert.equal(names.filter((entry) => entry === name).length, 1, `'${name}' must appear exactly once; the child must not add a second entry`);
      assert.ok(names.includes(`stub__${name}`), `the child's '${name}' must still be reachable under its prefix`);
    }
    // Identity, not just count: the surviving descriptor is the bridge's own.
    const nativeStatus = listed.result.tools.find((tool) => tool.name === "bridge_status");
    assert.equal(nativeStatus.description.includes("Impostor"), false, `the child's descriptor replaced the bridge's: ${nativeStatus.description}`);

    const status = await bridge.request("tools/call", { name: "bridge_status", arguments: {} });
    assert.equal(status.result.isError, false);
    assert.ok(status.result.structuredContent.accessModel, "bridge_status must be answered by the bridge itself");
    assert.equal(JSON.stringify(status.result).includes("IMPOSTOR-RAN"), false, "a federated child answered a native tool call");

    const shell = await bridge.request("tools/call", { name: "shell_exec", arguments: { command: "printf native-shell" } });
    assert.equal(shell.result.structuredContent.stdout, "native-shell", "shell_exec must still be the real shell");

    // And the impostor is reachable only under its prefix, which is what makes the
    // count assertions above meaningful rather than accidental.
    const prefixed = await bridge.request("tools/call", { name: "stub__bridge_status", arguments: {} });
    assert.equal(prefixed.result.content[0].text, "IMPOSTOR-RAN-bridge_status");

    bridge.child.kill("SIGTERM");
    await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  // --- 22. IDLE revocation: no further tool calls at all -----------------
  {
    // This is the case a call-triggered latch cannot cover, and the one that makes
    // "removing the unlock file kills federated children" true rather than true
    // only while the client keeps talking.
    const bridge = await startBridge({ recheckMs: "400" });
    const pgid = await federatedChildGroup(bridge);
    await fsp.rm(bridge.unlockFile, { force: true });
    // Deliberately no further requests.
    const exitCode = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000))]);
    assert.equal(exitCode, 78, `an idle bridge must notice the removed latch and exit 78; stderr=${bridge.stderr}`);
    await poll(() => groupGone(pgid), { attempts: 60, delayMs: 100, label: `child group ${pgid} to be reclaimed on idle revocation` });
  }

  // --- 23. SIGTERM — exactly what scripts/disable.sh sends ---------------
  {
    const bridge = await startBridge();
    const pgid = await federatedChildGroup(bridge);
    bridge.child.kill("SIGTERM");
    const exitCode = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
    assert.equal(exitCode, 0);
    // Without teardownAll reaching federation.killAll(), disable.sh would reclaim
    // the bridge and print its containment verdict while the child MCP server
    // kept running — the script would be structurally incapable of the
    // containment it reports.
    await poll(() => groupGone(pgid), { attempts: 60, delayMs: 100, label: `child group ${pgid} to be reclaimed on SIGTERM` });
  }

  // --- 24. transport close (rl 'close') ----------------------------------
  {
    const bridge = await startBridge();
    const pgid = await federatedChildGroup(bridge);
    bridge.child.stdin.end();
    const exitCode = await Promise.race([bridge.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
    assert.equal(exitCode, 0, `closing the transport must exit promptly; stderr=${bridge.stderr}`);
    await poll(() => groupGone(pgid), { attempts: 60, delayMs: 100, label: `child group ${pgid} to be reclaimed when the transport closes` });
  }

  // --- 25. providers start CONCURRENTLY, not serially --------------------
  {
    // Three providers that each spend ~2.1s paging through tools/list. Serially
    // that is ~6.3s of startup, and bridge.mjs awaits federationReady before
    // answering even a native read-only tool, so the whole tool surface is held
    // for the sum. Concurrently it is the max.
    const slow = (key) => stubProvider({ key, env: { STUB_TOOLS_LIST_DELAY_MS: "700", STUB_TOOLS_LIST_PAGES: "3" } });
    const startedAt = Date.now();
    const federation = await makeFederation([slow("slowa"), slow("slowb"), slow("slowc")]);
    const elapsed = Date.now() - startedAt;
    for (const provider of federation.status().providers) {
      assert.equal(provider.state, "ready", `provider ${provider.key} did not come up: ${provider.lastError}`);
    }
    assert.ok(elapsed < 4_500, `three 2.1s providers must start concurrently, not serially (took ${elapsed}ms; serial would be ~6300ms)`);
    // Registry order survives concurrency: whoever finishes first must not
    // reorder listTools(), which the client caches for 300s.
    assert.deepEqual(federation.status().providers.map((p) => p.key), ["slowa", "slowb", "slowc"]);
    assert.deepEqual(federation.listTools().slice(0, 1).map((t) => t.name), ["slowa__echo"]);
  }

  // --- 26. ONE wall-clock deadline covers the whole of Provider.start() ---
  {
    // A child that answers every page just inside TOOLS_LIST_TIMEOUT_MS never
    // trips a per-request timeout, so before this deadline existed the ceiling
    // was MAX_TOOLS_PAGES x TOOLS_LIST_TIMEOUT_MS = 300s for ONE provider.
    assert.equal(__testing.MAX_TOOLS_PAGES * __testing.TOOLS_LIST_TIMEOUT_MS, 300_000);
    assert.ok(
      __testing.PROVIDER_START_DEADLINE_MS <= 30_000,
      `the start deadline must be a real bound, not a restatement of the 300s worst case (is ${__testing.PROVIDER_START_DEADLINE_MS}ms)`,
    );

    // The deadline is read once, at module load, so the override needs a fresh
    // module instance rather than a fresh process.
    process.env.MAC_DEV_BRIDGE_MCP_START_DEADLINE_MS = "2000";
    const fresh = await import("../lib/federation.mjs?startDeadlineOverride=2000");
    delete process.env.MAC_DEV_BRIDGE_MCP_START_DEADLINE_MS;
    assert.equal(fresh.__testing.PROVIDER_START_DEADLINE_MS, 2_000);

    caseCounter += 1;
    const dataDir = path.join(temporaryRoot, `fed-${caseCounter}-deadline`);
    const jobDir = path.join(dataDir, "jobs");
    await fsp.mkdir(jobDir, { recursive: true, mode: 0o700 });
    const federation = fresh.createFederation({
      audit: noopAudit,
      stderr: quietStderr(),
      dataDir,
      jobDir,
      nowIso: () => new Date().toISOString(),
      writeJobMetadata: async (metadata) => {
        await fsp.writeFile(path.join(jobDir, `${metadata.id}.json`), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      },
      version: "test",
      // 20 pages x 500ms = 10s of paging, every page answered promptly enough
      // that no per-request timeout ever fires.
      registryJson: JSON.stringify({ providers: [stubProvider({ key: "endless", env: { STUB_TOOLS_LIST_DELAY_MS: "500", STUB_TOOLS_LIST_PAGES: "20" } })] }),
      registryPath: undefined,
    });
    federations.push(federation);
    const startedAt = Date.now();
    await federation.start();
    const elapsed = Date.now() - startedAt;
    const provider = federation.status().providers[0];
    if (provider.pid) spawnedPids.add(provider.pid);
    assert.ok(elapsed < 4_000, `the start deadline must cut a slow provider off (took ${elapsed}ms with a 2000ms deadline)`);
    assert.equal(provider.state, "failed");
    assert.match(provider.lastError, /did not finish starting within 2000ms/);
    // Abandoned, not silently truncated: a partial tool set is worse than none.
    assert.deepEqual(federation.listTools(), []);
  }

  // --- 27. killNow reports containment honestly, and names survivors ------
  {
    // A clean kill. Before the bounded retry this was false every single time:
    // the verdict was read one line after the SIGKILL, from
    // process.kill(-pgid, 0), against a child this process is the parent of and
    // never reaps — so a corpse counted as a live group.
    const federation = await makeFederation([stubProvider({ key: "clean" })]);
    const [clean] = federation.killAll();
    assert.equal(clean.containmentVerified, true, `a kill that left nothing behind must say so: ${JSON.stringify(clean)}`);
    assert.deepEqual(clean.uncontainedPids, []);
    assert.equal(clean.containmentProbe, "ps");

    // A real escape: the child spawns a detached (setsid) grandchild, which is
    // in a NEW process group and therefore untouched by the group kill.
    const pidFile = path.join(temporaryRoot, "escapee.pid");
    await fsp.rm(pidFile, { force: true });
    const escaped = await makeFederation([stubProvider({
      key: "escape",
      env: { STUB_ESCAPEE_PID_FILE: pidFile, STUB_ESCAPEE_SECONDS: "943" },
    })]);
    await poll(() => fs.existsSync(pidFile), { attempts: 50, delayMs: 50, label: "the stub to record its escapee pid" });
    const escapee = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(escapee) && escapee > 1);
    spawnedPids.add(escapee);
    const [result] = escaped.killAll();
    assert.equal(result.containmentVerified, false, "a grandchild that outlived the kill must not be reported as contained");
    assert.ok(result.uncontainedPids.includes(escapee), `the survivor must be named, not summarised: ${JSON.stringify(result)}`);
    // And it must really be alive — the report has to be a fact, not a guess.
    assert.equal(groupGone(escapee), false, "the escapee must actually still be running when it is reported as uncontained");
    try { process.kill(escapee, "SIGKILL"); } catch {}
    await poll(() => groupGone(escapee), { attempts: 50, delayMs: 50, label: "the escapee to be reclaimed by the test" });
  }

  console.log("federation test passed");
} finally {
  // A green run that leaks a child MCP server onto the developer's machine is an
  // invisible failure, so reclaim by the same predicate the code uses and only
  // ever against pids this file spawned.
  for (const federation of federations) {
    try { federation.killAll(); } catch {}
  }
  for (const bridge of bridges) {
    try { bridge.kill("SIGKILL"); } catch {}
  }
  for (const pid of spawnedPids) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
