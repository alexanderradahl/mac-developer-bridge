#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// A normal public MCP client for local tooling when a connector catalogue is
// stale. Uses the configured transport credential in-process; never discovers
// browser credentials, calls extension sockets, or changes bridge approvals.
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
let request;
try {
  const chunks = [];
  let requestBytes = 0;
  for await (const chunk of process.stdin) {
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BYTES) throw new Error("INPUT_LIMIT");
    chunks.push(chunk);
  }
  request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!request || typeof request !== "object" || Array.isArray(request)
      || request.jsonrpc !== "2.0" || !["tools/list", "tools/call"].includes(request.method)
      || !["string", "number"].includes(typeof request.id)) throw new Error("INVALID_REQUEST");
  if (request.method === "tools/call" && (!request.params || typeof request.params.name !== "string"
      || !/^[A-Za-z0-9_]{1,128}$/.test(request.params.name)
      || !request.params.arguments || typeof request.params.arguments !== "object" || Array.isArray(request.params.arguments))) {
    throw new Error("INVALID_TOOL_CALL");
  }
  const port = Number(process.env.MAC_DEV_BRIDGE_HTTP_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_LOCAL_PORT");
  const tokenPath = process.env.MAC_DEV_BRIDGE_HTTP_TOKEN_FILE
    || path.join(process.env.MAC_DEV_BRIDGE_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "MacDeveloperBridge"), "http-token");
  const tokenStat = await fs.lstat(tokenPath);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o077) !== 0
      || process.getuid && tokenStat.uid !== process.getuid()) throw new Error("TRANSPORT_CREDENTIAL_UNAVAILABLE");
  const token = (await fs.readFile(tokenPath, "utf8")).trim();
  if (!token || token.length > 10000 || /[\r\n]/.test(token)) throw new Error("TRANSPORT_CREDENTIAL_UNAVAILABLE");
  const response = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: {
      code: -32000, message: "The local MCP endpoint returned HTTP " + response.status + ". No retry was performed.",
      data: { httpStatus: response.status, operationId: request.params?.arguments?.operation_id || null },
    } }) + "\n");
    process.exitCode = 1;
  } else {
    const chunks = [];
    let responseBytes = 0;
    for await (const chunk of response.body) {
      responseBytes += chunk.length;
      if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_LIMIT");
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== request.id) throw new Error("INVALID_RESPONSE");
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (payload.error || payload.result?.isError) process.exitCode = 1;
  }
} catch (error) {
  const known = new Set(["INPUT_LIMIT", "INVALID_REQUEST", "INVALID_TOOL_CALL", "INVALID_LOCAL_PORT", "TRANSPORT_CREDENTIAL_UNAVAILABLE", "RESPONSE_LIMIT", "INVALID_RESPONSE"]);
  const category = known.has(error?.message) ? error.message : error?.name === "TimeoutError" ? "TIMEOUT" : "CLIENT_FAILURE";
  // Original error text can include configured local paths. Print fixed
  // metadata only; an uncertain tool outcome must be reconciled, not replayed.
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? crypto.randomUUID(), error: {
    code: -32000, message: "Local MCP client failed (" + category + "). No retry was performed.",
    data: { category, operationId: request?.params?.arguments?.operation_id || null },
  } }) + "\n");
  process.exitCode = 1;
}
