import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.HTTP_MCP_PORT || 0);
const COLLIDE = process.env.HTTP_MCP_COLLIDE === "1";
const SSE = process.env.HTTP_MCP_SSE === "1";
const MULTI_SSE = process.env.HTTP_MCP_MULTI_SSE === "1";
const STALE_SESSION = process.env.HTTP_MCP_STALE_SESSION === "1";
const REQUIRE_INITIALIZED_NOTIFICATION = process.env.HTTP_MCP_REQUIRE_INITIALIZED_NOTIFICATION === "1";
const FAIL_INITIALIZED_NOTIFICATION = process.env.HTTP_MCP_FAIL_INITIALIZED_NOTIFICATION === "1";
const SERVER_REQUEST = process.env.HTTP_MCP_SERVER_REQUEST === "1";
const WAIT_FOR_SERVER_REQUEST_REPLY = process.env.HTTP_MCP_WAIT_FOR_SERVER_REQUEST_REPLY === "1";
const REFRESH_ON_CALL = process.env.HTTP_MCP_REFRESH_ON_CALL === "1";
const HEADERS_FILE = process.env.HTTP_MCP_HEADERS_FILE || "";
const BIG_BYTES = Number(process.env.HTTP_MCP_BIG_BYTES || 0);
const DEFAULT_TOOLS = [
  { name: "media.search", description: "Find matching media.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "media_search", description: "Ambiguous with the dotted name after aliasing.", inputSchema: { type: "object" } },
  { name: "plain", description: "Return a deterministic value.", inputSchema: { type: "object" } },
];
if (!COLLIDE) DEFAULT_TOOLS.splice(1, 1);
const customToolNames = (process.env.HTTP_MCP_TOOLS || "").split(",").map((name) => name.trim()).filter(Boolean);
const refreshToolNames = (process.env.HTTP_MCP_REFRESH_TOOLS || "").split(",").map((name) => name.trim()).filter(Boolean);
const customTools = (names) => names.map((name) => ({ name, description: "Configured test tool.", inputSchema: { type: "object" } }));
const TOOLS = customToolNames.length > 0 ? customTools(customToolNames) : DEFAULT_TOOLS;
const REFRESH_TOOLS = refreshToolNames.length > 0 ? customTools(refreshToolNames) : null;

let initialized = false;
let initializedNotification = false;
let staleTriggered = false;
let currentSession;
let pendingServerRequestReply = null;
let refreshRequested = false;

function recordHeaders(message, headers) {
  if (!HEADERS_FILE) return;
  fs.appendFileSync(HEADERS_FILE, `${JSON.stringify({ method: message.method, headers: { ...headers } })}\n`);
}

function sseFrame(message, multiline = false) {
  const serialized = JSON.stringify(message);
  if (!multiline || serialized.length < 4) return `event: message\ndata: ${serialized}\n\n`;
  const cut = Math.max(1, serialized.indexOf(',"id"') > 0 ? serialized.indexOf(',"id"') + 1 : serialized.indexOf(',"method"') > 0 ? serialized.indexOf(',"method"') + 1 : Math.floor(serialized.length / 2));
  return `event: message\ndata: ${serialized.slice(0, cut)}\ndata: ${serialized.slice(cut)}\n\n`;
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    if (currentSession) response.setHeader("Mcp-Session-Id", currentSession);
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    recordHeaders(message, request.headers);
    if (message.id === 700 && message.method === "ping" && pendingServerRequestReply) {
      const resolve = pendingServerRequestReply;
      pendingServerRequestReply = null;
      response.writeHead(202).end();
      resolve();
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (currentSession && message.method !== "initialize" && request.headers["mcp-session-id"] !== currentSession) {
      response.writeHead(404).end();
      return;
    }
    if (STALE_SESSION && message.method !== "initialize" && !staleTriggered) {
      staleTriggered = true;
      response.writeHead(404).end();
      return;
    }
    const writeJson = (body) => {
      if (currentSession) response.setHeader("Mcp-Session-Id", currentSession);
      if (SSE) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(sseFrame(body, MULTI_SSE));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      }
    };
    const writeResult = (result) => writeJson({ jsonrpc: "2.0", id: message.id, result });
    const writeError = (error) => writeJson({ jsonrpc: "2.0", id: message.id, error });
    if (message.method === "initialize") {
      initialized = true;
      initializedNotification = false;
      currentSession = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      writeResult({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-stub", version: "0.0.1" } });
      return;
    }
    if (message.method === "notifications/initialized") {
      if (FAIL_INITIALIZED_NOTIFICATION) {
        response.writeHead(500).end();
        return;
      }
      initializedNotification = true;
      response.writeHead(202).end();
      return;
    }
    if (!initialized) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "not initialized" },
      }));
      return;
    }
    if (REQUIRE_INITIALIZED_NOTIFICATION && !initializedNotification) {
      writeError({ code: -32000, message: "notifications/initialized was not received" });
      return;
    }
    if (message.method === "tools/list") {
      writeResult({ tools: refreshRequested && REFRESH_TOOLS ? REFRESH_TOOLS : TOOLS });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const result = { content: [{ type: "text", text: BIG_BYTES > 0 ? "B".repeat(BIG_BYTES) : (name === "media.search" ? `search:${message.params.arguments?.query}` : `called:${name}`) }] };
      if (SSE && (MULTI_SSE || SERVER_REQUEST || REFRESH_ON_CALL)) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (MULTI_SSE) response.write(sseFrame({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "fixture", progress: 1 } }, true));
        if (SERVER_REQUEST) {
          response.write(sseFrame({ jsonrpc: "2.0", id: 700, method: "ping", params: {} }, true));
          if (WAIT_FOR_SERVER_REQUEST_REPLY) {
            await new Promise((resolve) => {
              pendingServerRequestReply = resolve;
              setTimeout(resolve, 5_000).unref();
            });
          }
        }
        if (REFRESH_ON_CALL) {
          refreshRequested = true;
          response.write(sseFrame({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, true));
        }
        response.end(sseFrame({ jsonrpc: "2.0", id: message.id, result }, true));
      } else {
        writeResult(result);
      }
      return;
    }
    writeError({ code: -32601, message: `Method not found: ${message.method}` });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const { address, port } = server.address();
  assert.equal(address, "127.0.0.1");
  if (process.env.HTTP_MCP_PORT_FILE) {
    fs.writeFileSync(process.env.HTTP_MCP_PORT_FILE, `${port}\n`, { mode: 0o600 });
  }
});

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
