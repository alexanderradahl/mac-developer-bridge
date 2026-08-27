// Regression test for the HTTP front end: auth, cross-client id isolation,
// credential scrubbing, and malformed-body handling.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = process.argv[2] || path.join(ROOT, "mcp-http.mjs");
const BRIDGE = path.join(ROOT, "bridge.mjs");

const TOKEN = "test-token-that-is-long-enough-32";
const PORT = Number(process.env.MAC_DEV_BRIDGE_TEST_PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;

// Negative cases first: the token guards are the whole authorization boundary,
// so verify the server refuses to start before testing anything else.
async function verifyRefusesToStart(token, expected, extraEnv = {}) {
  const child = spawn(process.execPath, [TARGET], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MAC_DEV_BRIDGE_HTTP_TOKEN: token,
      MAC_DEV_BRIDGE_HTTP_PORT: String(PORT),
      ...extraEnv,
    },
  });
  let err = "";
  child.stderr.on("data", (d) => {
    err += d.toString();
  });
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 78, `expected exit 78 for token ${JSON.stringify(token)}, got ${code}: ${err}`);
  assert.match(err, expected);
}
await verifyRefusesToStart("", /Refusing to start without auth/);
await verifyRefusesToStart("too-short", /at least 24 bytes/);
await verifyRefusesToStart("ü".repeat(30), /printable ASCII/);
console.log("  PASS  refuses to start without a usable bearer token");

// The token-file path must honour the same exit-78 contract, not surface a raw
// ENOENT stack with exit 1.
const tokenDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mac-developer-bridge-tok-")));
const emptyToken = path.join(tokenDir, "empty");
await fsp.writeFile(emptyToken, "   \n");
await verifyRefusesToStart("", /could not be read/, {
  MAC_DEV_BRIDGE_HTTP_TOKEN_FILE: path.join(tokenDir, "does-not-exist"),
});
await verifyRefusesToStart("", /is empty/, { MAC_DEV_BRIDGE_HTTP_TOKEN_FILE: emptyToken });
await fsp.rm(tokenDir, { recursive: true, force: true });
console.log("  PASS  token file failures exit 78 with a message naming the file");

const dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "mac-developer-bridge-http-")));
await fsp.writeFile(path.join(dataDir, "FULL_ACCESS_ENABLED"), "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS\n");
const chatgptProjectId = "g-p-6a8dee0602b0819184fa43aae5a20ee9";
await fsp.writeFile(
  path.join(dataDir, "chatgpt-runtime.json"),
  `${JSON.stringify({ projectId: chatgptProjectId })}\n`,
  { mode: 0o600 },
);
const chromeSocketPath = path.join("/tmp", `mdb-http-${process.pid}.sock`);
await fsp.rm(chromeSocketPath, { force: true });
const browserCalls = [];
const chromeServer = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline));
    browserCalls.push(request);
    if (request.method === "tabs.chatgptConversationStart" && request.args?.prompt === "__runtime_model_mismatch__") {
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "CHATGPT_RUNTIME_MODEL_MISMATCH",
          message: "The signed-in ChatGPT runtime did not activate the requested model.",
        },
      })}\n`);
      return;
    }
    const responseLine = `${JSON.stringify({
      id: request.id,
      ok: true,
      result: request.method === "host.status"
        ? {
          extensionConnected: true,
          extensionReady: true,
          extension: { profile: { signedIn: true, matchesBinding: true } },
          profileError: null,
        }
        : {
          ok: true,
          complete: true,
          conversation_id: request.args?.conversationId || "http-conversation-test",
          assistant_message_id: "http-assistant-test",
          assistant_text: String(request.args?.prompt || "").startsWith("You are the model backend for a Codex Responses turn.")
            ? String(request.args.prompt).includes("USE_HTTP_TOOL")
              ? '{"kind":"tool_calls","calls":[{"name":"echo","arguments":{"value":"ok"}}]}'
              : '{"kind":"message","text":"HTTP Responses model reply"}'
            : "HTTP bridge stub response",
          model: request.args?.model,
          thinking_effort: request.args?.thinkingEffort,
          max_runtime_seconds: request.args?.maxRuntimeSeconds,
          prompt_bytes: Buffer.byteLength(request.args?.prompt || "", "utf8"),
        },
    })}\n`;
    if (String(request.args?.prompt || "").includes("DELAY_STREAM")) {
      setTimeout(() => socket.end(responseLine), 600);
      return;
    }
    socket.end(responseLine);
  });
});
await new Promise((resolve, reject) => {
  chromeServer.once("error", reject);
  chromeServer.listen(chromeSocketPath, resolve);
});

const server = spawn(process.execPath, [TARGET], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    MAC_DEV_BRIDGE_HTTP_TOKEN: TOKEN,
    MAC_DEV_BRIDGE_HTTP_PORT: String(PORT),
    MAC_DEV_BRIDGE_ENTRY: BRIDGE,
    MAC_DEV_BRIDGE_DATA_DIR: dataDir,
    MAC_DEV_BRIDGE_UNLOCK_FILE: path.join(dataDir, "FULL_ACCESS_ENABLED"),
    MAC_DEV_BRIDGE_CHROME_SOCKET: chromeSocketPath,
    MAC_DEV_BRIDGE_AUDIT_MODE: "off",
  },
});
let stderr = "";
let serverExit = null;
server.stderr.on("data", (d) => {
  stderr += d.toString();
});
server.once("exit", (code) => {
  serverExit = code;
});

async function waitForListen() {
  for (let i = 0; i < 100; i += 1) {
    // EADDRINUSE is an unhandled 'error' on server.listen, so the process dies.
    // Catching it here reports the real cause instead of "never listened".
    if (serverExit !== null) {
      throw new Error(`server exited ${serverExit} before listening. stderr:\n${stderr}`);
    }
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server never listened. stderr:\n${stderr}`);
}

function rpc(body, token = TOKEN) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    // Without this, an id-collision regression manifests as a 600-second hang
    // rather than a failure, because the overwritten waiter never settles.
    signal: AbortSignal.timeout(15_000),
  });
}

function experimentalConversation(body, token = TOKEN, extraHeaders = {}) {
  return fetch(`${BASE}/experimental/chatgpt/conversation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

function responsesRequest(body, token = TOKEN, extraHeaders = {}) {
  return fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

const results = [];
const ok = (name) => {
  results.push(`  PASS  ${name}`);
};

try {
  await waitForListen();

  // --- auth -----------------------------------------------------------------
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "")).status, 401);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-token-long-enough-here")).status, 401);
  ok("401 on missing and wrong bearer token");

  assert.equal((await experimentalConversation({ prompt: "x" }, "")).status, 401);
  assert.equal((await experimentalConversation({ prompt: "x" }, "wrong-token-long-enough-here")).status, 401);
  assert.equal((await experimentalConversation({ prompt: "x" }, TOKEN, { "x-forwarded-for": "203.0.113.10" })).status, 403);
  ok("experimental ChatGPT route requires direct loopback plus static bearer");

  assert.equal((await responsesRequest({ model: "chatgpt-browser", input: "x" }, "")).status, 401);
  assert.equal((await responsesRequest({ model: "chatgpt-browser", input: "x" }, "wrong-token-long-enough-here")).status, 401);
  assert.equal((await responsesRequest(
    { model: "chatgpt-browser", input: "x" },
    TOKEN,
    { "x-forwarded-for": "203.0.113.10" },
  )).status, 403);
  ok("Responses model route requires direct loopback plus static bearer");

  // --- handshake ------------------------------------------------------------
  const init = await (
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    })
  ).json();
  assert.equal(init.id, 1);
  assert.ok(init.result?.serverInfo?.name);
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  ok("initialize + initialized notification");

  assert.equal((await experimentalConversation("not-json")).status, 400);
  assert.equal((await experimentalConversation([])).status, 400);
  const beforeSecurityRefusal = browserCalls.length;
  const refused = await experimentalConversation({ prompt: "safe", sentinel_token: "copied-proof" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "CHATGPT_SECURITY_FIELDS_REFUSED");
  assert.equal(browserCalls.length, beforeSecurityRefusal, "security fields must be refused before Chrome dispatch");

  const started = await experimentalConversation({
    prompt: "start through HTTP",
    model: "gpt-5-6-pro",
    thinking_effort: "standard",
    max_runtime_seconds: 3300,
  });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get("cache-control"), "no-store");
  const startedBody = await started.json();
  assert.equal(startedBody.complete, true);
  assert.equal(startedBody.conversation_id, "http-conversation-test");
  assert.equal(startedBody.assistant_text, "HTTP bridge stub response");
  assert.equal(browserCalls.at(-1).method, "tabs.chatgptConversationStart");
  assert.equal(browserCalls.at(-1).args.prompt, "start through HTTP");
  assert.equal(browserCalls.at(-1).args.transport, "runtime");
  assert.equal(browserCalls.at(-1).args.continueInWork, true);
  assert.equal(browserCalls.at(-1).args.maxRuntimeSeconds, 3300);
  ok("experimental ChatGPT route normalizes the bridge result");

  const beforeResponsesRefusal = browserCalls.length;
  assert.equal((await responsesRequest({ model: "missing", input: "x" })).status, 404);
  assert.equal((await responsesRequest({
    model: "chatgpt-browser",
    input: "x",
    tools: [{ type: "computer_use_preview" }],
  })).status, 400);
  assert.equal(browserCalls.length, beforeResponsesRefusal, "invalid Responses requests must fail before Chrome dispatch");

  const modelReply = await responsesRequest({
    model: "chatgpt-browser",
    instructions: "Reply once.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  });
  assert.equal(modelReply.status, 200);
  assert.equal(modelReply.headers.get("cache-control"), "no-store");
  const modelReplyBody = await modelReply.json();
  assert.equal(modelReplyBody.object, "response");
  assert.equal(modelReplyBody.output[0].content[0].text, "HTTP Responses model reply");
  assert.equal(browserCalls.at(-1).args.transport, "runtime");
  assert.equal(browserCalls.at(-1).args.continueInWork, false);
  assert.equal(browserCalls.at(-1).args.thinkingEffort, "standard");
  assert.equal(browserCalls.at(-1).args.projectId, chatgptProjectId);
  ok("Responses model route returns a non-streaming assistant response");

  const solReply = await responsesRequest({
    model: "chatgpt-sol",
    reasoning: { effort: "xhigh" },
    input: "Reply from the Sol runtime.",
  });
  assert.equal(solReply.status, 200);
  assert.equal((await solReply.json()).model, "chatgpt-sol");
  assert.equal(browserCalls.at(-1).args.model, "gpt-5-6-thinking");
  assert.equal(browserCalls.at(-1).args.thinkingEffort, "max");
  assert.equal(browserCalls.at(-1).args.projectId, chatgptProjectId);
  ok("Responses Sol model maps reasoning effort and binds the configured Project");

  const toolReply = await responsesRequest({
    model: "chatgpt-browser",
    stream: true,
    input: "USE_HTTP_TOOL",
    tools: [{
      type: "function",
      name: "echo",
      description: "Echo a value",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    }],
  });
  assert.equal(toolReply.status, 200);
  assert.match(toolReply.headers.get("content-type") || "", /text\/event-stream/);
  const toolSse = await toolReply.text();
  assert.match(toolSse, /"type":"function_call"/);
  assert.match(toolSse, /"name":"echo"/);
  assert.match(toolSse, /data: \[DONE\]/);
  ok("Responses model route emits a streaming function call");

  const delayedStreamRequest = responsesRequest({
    model: "chatgpt-browser",
    stream: true,
    input: "DELAY_STREAM",
  });
  const delayedStream = await Promise.race([
    delayedStreamRequest,
    new Promise((resolve) => setTimeout(() => resolve(null), 200)),
  ]);
  assert.ok(delayedStream, "streaming response headers waited for the browser model to finish");
  assert.equal(delayedStream.status, 200);
  const delayedReader = delayedStream.body.getReader();
  const firstFrame = await Promise.race([
    delayedReader.read(),
    new Promise((resolve) => setTimeout(() => resolve(null), 200)),
  ]);
  assert.ok(firstFrame && !firstFrame.done, "response.created was not emitted while the browser model was still running");
  assert.match(new TextDecoder().decode(firstFrame.value), /"type":"response.created"/);
  let delayedTail = "";
  for (;;) {
    const { value, done } = await delayedReader.read();
    if (done) break;
    delayedTail += new TextDecoder().decode(value);
  }
  assert.match(delayedTail, /"type":"response.completed"/);
  assert.match(delayedTail, /data: \[DONE\]/);
  ok("Responses streaming opens before the browser model completes");

  const continued = await experimentalConversation({
    prompt: "continue through HTTP",
    conversation_id: "http-conversation-test",
  });
  assert.equal(continued.status, 200);
  const continuedBody = await continued.json();
  assert.equal(continuedBody.conversation_id, "http-conversation-test");
  assert.equal(browserCalls.at(-1).args.conversationId, "http-conversation-test");
  ok("experimental ChatGPT route continues one exact conversation");

  const rawStarted = await experimentalConversation({ prompt: "raw diagnostic", transport: "raw" });
  assert.equal(rawStarted.status, 200);
  assert.equal(browserCalls.at(-1).args.transport, "raw");
  const beforeInvalidTransport = browserCalls.length;
  const invalidTransport = await experimentalConversation({ prompt: "invalid", transport: "auto" });
  assert.equal(invalidTransport.status, 400);
  assert.equal(browserCalls.length, beforeInvalidTransport);
  const modelMismatch = await experimentalConversation({
    prompt: "__runtime_model_mismatch__",
    transport: "runtime",
  });
  assert.equal(modelMismatch.status, 409);
  ok("experimental ChatGPT route defaults to runtime and preserves explicit raw diagnostics");

  // --- DEFECT 1: concurrent identical client ids must not cross ------------
  // Two callers both use id:1. Each must get its own result back, with id:1.
  const [a, b] = await Promise.all([
    rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "sleep 0.4; printf CALLER_A_SECRET" } },
    }).then((r) => r.json()),
    rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "printf CALLER_B_ONLY" } },
    }).then((r) => r.json()),
  ]);
  const aText = JSON.stringify(a);
  const bText = JSON.stringify(b);
  assert.equal(a.id, 1, "caller A must get its own id back");
  assert.equal(b.id, 1, "caller B must get its own id back");
  assert.ok(aText.includes("CALLER_A_SECRET"), `A got wrong result: ${aText.slice(0, 300)}`);
  assert.ok(bText.includes("CALLER_B_ONLY"), `B got wrong result: ${bText.slice(0, 300)}`);
  assert.ok(!aText.includes("CALLER_B_ONLY"), "A leaked B's result");
  assert.ok(!bText.includes("CALLER_A_SECRET"), "B leaked A's result");
  ok("concurrent duplicate ids do not cross responses");

  // --- DEFECT 2: bearer token must not be visible to shell commands -------
  const envProbe = await (
    await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "shell_exec", arguments: { command: "env | grep -c MAC_DEV_BRIDGE_HTTP_TOKEN || true" } },
    })
  ).json();
  const probeText = JSON.stringify(envProbe);
  assert.ok(!probeText.includes(TOKEN), "the token itself appeared in shell output");
  assert.ok(/"stdout":"0/.test(probeText), `token still in child env: ${probeText.slice(0, 400)}`);
  ok("bearer token scrubbed from shell_exec environment");

  // --- DEFECT 3: malformed bodies must not kill the process ---------------
  for (const body of ["null", '"hello"', "5", "true", "[]", "{oops"]) {
    const r = await rpc(body);
    assert.ok(r.status === 400, `body ${body} should be 400, got ${r.status}`);
  }
  // Server must still be alive and functional afterwards.
  const stillAlive = await (await rpc({ jsonrpc: "2.0", id: 3, method: "ping" })).json();
  assert.equal(stillAlive.id, 3, "server died after malformed bodies");
  ok("null/scalar/array/invalid bodies rejected without killing the server");

  // --- malformed request targets must not kill the process -----------------
  // Node's parser accepts targets `new URL` rejects. Unauthenticated, one packet.
  async function rawRequest(raw) {
    const { Socket } = await import("node:net");
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      let buf = "";
      sock.setTimeout(4000, () => {
        sock.destroy();
        reject(new Error("raw request timed out"));
      });
      sock.connect(PORT, "127.0.0.1", () => sock.write(raw));
      sock.on("data", (d) => {
        buf += d.toString();
        // Keep-alive means 'close' may never fire; the status line is enough.
        if (buf.includes("\r\n")) {
          sock.destroy();
          resolve(buf);
        }
      });
      sock.on("close", () => resolve(buf));
      sock.on("error", reject);
    });
  }
  for (const raw of [
    "GET //[/mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
    "GET /mcp HTTP/1.1\r\nHost: [\r\n\r\n",
    "GET http://[/mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
  ]) {
    const reply = await rawRequest(raw);
    assert.match(reply, /^HTTP\/1\.1 400 /, `expected 400 for ${JSON.stringify(raw.split("\r\n")[0])}, got: ${reply.slice(0, 80)}`);
  }
  const survived = await (await rpc({ jsonrpc: "2.0", id: 6, method: "ping" })).json();
  assert.equal(survived.id, 6, "server died after malformed request targets");
  ok("malformed request targets rejected without killing the server");

  // --- misc ---------------------------------------------------------------
  assert.equal((await fetch(`${BASE}/nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/mcp`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  ok("404 off-path, 405 on GET /mcp");

  // --- handshake replay: kill the child, next call must still work ----------
  // Pins the notifications/initialized replay: without it bridge.mjs answers
  // -32002 "Server not initialized" on every call after a child restart.
  const pidBefore = await (
    await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shell_exec", arguments: { command: "echo $PPID" } } })
  ).json();
  // Read the value structurally, and take the LAST line: `shell_exec` uses a
  // login shell, so profile banners can precede the pid on stdout. A regex
  // anchored to the start of stdout would capture the banner instead — a
  // digit-leading banner would make this SIGKILL an unrelated process.
  const stdout = pidBefore?.result?.structuredContent?.stdout;
  assert.equal(typeof stdout, "string", `no stdout in reply: ${JSON.stringify(pidBefore).slice(0, 300)}`);
  const lastLine = stdout.trim().split("\n").pop().trim();
  assert.match(lastLine, /^\d+$/, `expected a bare pid, got ${JSON.stringify(lastLine)}`);
  const bridgePid = Number(lastLine);

  // Refuse to signal anything that is not our own bridge child.
  const { execFileSync } = await import("node:child_process");
  const actualParent = execFileSync("ps", ["-o", "ppid=", "-p", String(bridgePid)], { encoding: "utf8" }).trim();
  assert.equal(
    actualParent,
    String(server.pid),
    `pid ${bridgePid} is not a child of the server under test (parent ${actualParent}, expected ${server.pid}); refusing to kill`,
  );
  process.kill(bridgePid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 2400)); // clear RESPAWN_BACKOFF_MS
  const afterKill = await (
    await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "shell_exec", arguments: { command: "printf survived" } } })
  ).json();
  const afterText = JSON.stringify(afterKill);
  assert.ok(!afterText.includes("-32002"), `handshake was not replayed after respawn: ${afterText.slice(0, 300)}`);
  assert.ok(afterText.includes("survived"), `call after respawn failed: ${afterText.slice(0, 300)}`);
  ok("bridge respawn replays handshake; client needs no re-initialize");

  // SSE-only client must still get a usable body.
  const sse = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
  });
  const sseBody = await sse.text();
  assert.ok(sse.headers.get("content-type")?.includes("text/event-stream"), "expected SSE content-type");
  assert.ok(sseBody.includes('"id":9'), `SSE frame missing payload: ${sseBody}`);
  ok("SSE-only Accept receives a single event frame");

  console.log(results.join("\n"));
  console.log("http test passed");
} catch (e) {
  console.log(results.join("\n"));
  console.log(`\n  FAIL  ${e.message}`);
  console.log(`--- server stderr ---\n${stderr}`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => chromeServer.close(resolve));
  await fsp.rm(chromeSocketPath, { force: true });
  await fsp.rm(dataDir, { recursive: true, force: true });
}
