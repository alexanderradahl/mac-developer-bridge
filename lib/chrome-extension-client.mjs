import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const GRANTLESS_METHODS = new Set(["status", "workspace.status", "workspace.init"]);

export function backgroundChromeSocketPath(dataDir = null) {
  const root = dataDir || process.env.MAC_DEV_BRIDGE_DATA_DIR
    || path.join(os.homedir(), "Library", "Application Support", "MacDeveloperBridge");
  return process.env.MAC_DEV_BRIDGE_CHROME_SOCKET || path.join(root, "chrome-background.sock");
}

function requestSocket(payload, { socketPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = socketPath || backgroundChromeSocketPath();
    const socket = net.createConnection(target);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Background Chrome host did not answer within ${timeoutMs}ms.`);
      error.code = "CHROME_HOST_TIMEOUT";
      finish(error);
    }, timeoutMs);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        const error = new Error(`Background Chrome host response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
        error.code = "CHROME_HOST_RESPONSE_TOO_LARGE";
        finish(error);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      let response;
      try {
        response = JSON.parse(line);
      } catch (parseError) {
        const error = new Error(`Background Chrome host returned invalid JSON: ${line.slice(0, 500)}`);
        error.code = "CHROME_HOST_PROTOCOL_ERROR";
        error.cause = parseError;
        finish(error);
        return;
      }
      if (!response.ok) {
        const error = new Error(response?.error?.message || "Background Chrome request failed.");
        error.code = response?.error?.code || "CHROME_EXTENSION_ERROR";
        error.details = response?.error || null;
        finish(error);
        return;
      }
      finish(null, response.result);
    });
    socket.on("error", (source) => {
      const error = new Error(source?.code === "ENOENT" || source?.code === "ECONNREFUSED"
        ? "Background Chrome extension is offline. Run scripts/install-background-chrome.sh and load chrome-extension/ once in Chrome."
        : `Background Chrome host connection failed: ${source?.message || source}`);
      error.code = source?.code === "ENOENT" || source?.code === "ECONNREFUSED" ? "CHROME_EXTENSION_OFFLINE" : "CHROME_HOST_CONNECTION_FAILED";
      error.cause = source;
      finish(error);
    });
    socket.on("end", () => {
      if (!settled && buffer.trim().length === 0) {
        const error = new Error("Background Chrome host closed the connection without a response.");
        error.code = "CHROME_HOST_CLOSED";
        finish(error);
      }
    });
  });
}

export async function backgroundChromeStatus({ dataDir, socketPath, timeoutMs = 1_000 } = {}) {
  try {
    return await requestSocket({ id: crypto.randomUUID(), method: "host.status" }, {
      socketPath: socketPath || backgroundChromeSocketPath(dataDir),
      timeoutMs,
    });
  } catch (error) {
    return { extensionReady: false, error: { code: error.code || "CHROME_EXTENSION_OFFLINE", message: error.message } };
  }
}

export async function backgroundChromeCall(method, args, allowedUrlPatterns, {
  dataDir,
  socketPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const grantless = GRANTLESS_METHODS.has(method);
  if (!grantless && (!Array.isArray(allowedUrlPatterns) || allowedUrlPatterns.length === 0)) {
    const error = new Error("Background Chrome calls require a non-empty personal-browser URL grant.");
    error.code = "CHROME_NO_URL_GRANT";
    throw error;
  }
  return await requestSocket({
    id: crypto.randomUUID(),
    method,
    args: args || {},
    allowedUrlPatterns: Array.isArray(allowedUrlPatterns) ? allowedUrlPatterns : [],
  }, {
    socketPath: socketPath || backgroundChromeSocketPath(dataDir),
    timeoutMs,
  });
}
