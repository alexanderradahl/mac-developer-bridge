import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 45_000;
const TRANSPORT_ALLOWANCE_MS = 2_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const GRANTLESS_METHODS = new Set(["status", "extension.reload", "workspace.status", "workspace.init", "workspace.release", "chatgpt.extensionStatus"]);
const SAFE_DIAGNOSTIC_FIELDS = new Set([
  "operationId", "state", "component", "stage", "operationStage", "dispatchState", "dispatched",
  "actionDispatched", "elapsedMs", "deadlineMs", "connectionGeneration",
  "targetTabId", "targetFrameId", "targetDocumentId", "inputStrategy",
  "targetReplaced", "commit", "normalization", "submissionRequested",
  "submissionObserved", "submissionBlocked", "popupObserved", "popupOutcome",
  "clickDispatched", "navigationObserved", "popupObservedCount", "outcomeVerified",
  "tabId", "frameId", "documentId",
  "outcome", "resultAvailable", "reconciled", "retentionMs", "responseBytes",
  "responseSha256", "protocolCategory", "retryable", "complete", "status",
  "conversation_id", "event_count", "parse_failure_count", "poolSize",
  "leased", "waitTimeoutMs", "targetPoolSize", "pendingTabCount", "maxPoolSize",
  "autoGrowStep", "provisioningPending", "canGrow",
  "focusEventFallbackUsed", "blurEventFallbackUsed",
  "pointerDownDispatched", "mouseDownDispatched", "dragStartDispatched",
  "pointerCancelDispatched", "pointerUpDispatched", "mouseUpDispatched",
  "dragStarted", "dropDispatched", "dragEndDispatched",
  "focusAttempted", "focusEventCompletionUsed",
  "keyDownDispatched", "keyUpDispatched", "keyDownDefaultPrevented", "keyUpDefaultPrevented",
  "focusChanged", "keyUpTargetChanged", "keyEvents",
  "pasteDispatched", "pasteDefaultPrevented", "selectionPrepared", "domChanged", "pasteMode", "textGuardNormalization",
  "fileAssigned", "inputEventDispatched", "changeEventDispatched",
  "inputDefaultPrevented", "changeDefaultPrevented", "fileRetained", "fileCount", "fileSize", "fileSha256",
]);

export function safeChromeDiagnostics(source) {
  const output = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return output;
  for (const [key, value] of Object.entries(source)) {
    if (!SAFE_DIAGNOSTIC_FIELDS.has(key)) continue;
    if (key === "keyEvents") {
      if (Array.isArray(value) && value.length <= 4 && value.every(type => ["focus", "focusin", "keydown", "keyup"].includes(type))) output[key] = [...value];
      continue;
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      output[key] = value;
    } else if (typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9_.:-]+$/.test(value)) {
      output[key] = value;
    }
  }
  return output;
}

// Existing ChatGPT handoff errors need a safe conversation locator so the
// caller can reconcile a completed conversation without replaying its prompt.
// This is deliberately separate from generic Chrome diagnostics: no URL or
// assistant message field is accepted for ordinary browser actions.
export function safeChatGPTHandoff(source, method) {
  const output = {};
  if (method !== "tabs.chatgptConversationStart" || !source || typeof source !== "object" || Array.isArray(source)) return output;
  const safeMessageId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
  for (const key of ["conversation_id", "assistant_message_id"]) {
    if (source[key] === null || safeMessageId(source[key])) output[key] = source[key];
  }
  if (typeof source.complete === "boolean") output.complete = source.complete;
  if (typeof source.page_url === "string" && source.page_url.length <= 4000) {
    try {
      const url = new URL(source.page_url);
      const conversationPath = /^\/(?:c|coding-sessions\/c|g\/[A-Za-z0-9_-]{1,160}\/c)\/[A-Za-z0-9][A-Za-z0-9_-]{7,127}\/?$/;
      const pathId = url.pathname.replace(/\/$/, "").split("/").at(-1);
      if (url.origin === "https://chatgpt.com" && !url.username && !url.password && conversationPath.test(url.pathname)
          && (!output.conversation_id || pathId === output.conversation_id)) {
        output.page_url = url.origin + url.pathname;
      }
    } catch {}
  }
  return output;
}

function normalizeBackgroundChromeMethod(method) {
  // Stale callers still share the one managed workspace tab-open path.
  return method === "tabs.open" ? "workspace.open" : method;
}

export function backgroundChromeSocketPath(dataDir = null) {
  const root = dataDir || process.env.MAC_DEV_BRIDGE_DATA_DIR
    || path.join(os.homedir(), "Library", "Application Support", "MacDeveloperBridge");
  return process.env.MAC_DEV_BRIDGE_CHROME_SOCKET || path.join(root, "chrome-background.sock");
}

function operationError(code, message, payload, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = safeChromeDiagnostics({
    operationId: payload.id,
    component: "chrome-client",
    state: "outcome_unknown",
    dispatchState: "unknown",
    ...details,
  });
  return error;
}

function requestSocket(payload, { socketPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = socketPath || backgroundChromeSocketPath();
    const socket = net.createConnection(target);
    const startedAt = Date.now();
    let buffer = "";
    let settled = false;
    let requestWritten = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const protocolFailure = (category, line = buffer) => {
      finish(operationError("CHROME_HOST_PROTOCOL_ERROR", "Background Chrome returned an invalid response envelope.", payload, {
        stage: "response-validation", protocolCategory: category,
        responseBytes: Buffer.byteLength(line, "utf8"),
        responseSha256: crypto.createHash("sha256").update(line).digest("hex"),
        elapsedMs: Date.now() - startedAt,
      }));
    };
    const timer = setTimeout(() => {
      finish(operationError("CHROME_HOST_TIMEOUT",
        "Background Chrome transport timed out. The action outcome is unknown; query its operation ID before considering another action.",
        payload, { stage: "response-wait", deadlineMs: payload.deadlineMs, elapsedMs: Date.now() - startedAt }));
    }, Math.max(1, timeoutMs));
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      requestWritten = true;
      socket.write(JSON.stringify(payload) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(operationError("CHROME_HOST_RESPONSE_TOO_LARGE", "Background Chrome response exceeds its size limit.", payload, {
          stage: "response-validation", responseBytes: Buffer.byteLength(buffer, "utf8"),
        }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      let response;
      try { response = JSON.parse(line); } catch { protocolFailure("invalid-json", line); return; }
      if (!response || typeof response !== "object" || Array.isArray(response)
          || typeof response.ok !== "boolean" || response.id !== payload.id
          || (response.ok && !Object.prototype.hasOwnProperty.call(response, "result"))
          || (!response.ok && (!response.error || typeof response.error !== "object" || Array.isArray(response.error)))) {
        protocolFailure(response?.id !== payload.id ? "mismatched-id-or-shape" : "invalid-shape", line);
        return;
      }
      if (!response.ok) {
        const code = typeof response.error.code === "string" && /^(CHROME|CHATGPT)_[A-Z0-9_]{1,100}$/.test(response.error.code)
          ? response.error.code : "CHROME_EXTENSION_ERROR";
        // Error text may originate in a page and contain a form value, URL query,
        // or credential. Only fixed messages and explicitly safe fields cross.
        const message = code === "CHROME_EXTENSION_TIMEOUT"
          ? "Background Chrome exceeded the action deadline. The outcome is unknown; query the operation ID without replaying the action."
          : code === "CHROME_OPERATION_RECONCILIATION_REQUIRED"
            ? "This operation was already dispatched. Its result needs readback; the action was not replayed."
            : "Background Chrome request failed (" + code + ").";
        const operation = safeChromeDiagnostics(response.operation);
        const authoritative = Object.fromEntries([
          "state", "dispatched", "dispatchState", "connectionGeneration", "deadlineMs",
          "targetTabId", "outcome", "reconciled", "resultAvailable", "retentionMs", "retryable",
        ].filter((key) => Object.prototype.hasOwnProperty.call(operation, key)).map((key) => [key, operation[key]]));
        const error = operationError(code, message, payload, {
          ...operation,
          ...safeChromeDiagnostics(response.error),
          ...safeChromeDiagnostics(response.error.details),
          // Keep the failing action stage, while lifecycle fields remain owned
          // by the host. Page errors cannot replace operation identity/state.
          ...authoritative,
          operationId: payload.id,
          ...(operation.stage ? { operationStage: operation.stage } : {}),
          elapsedMs: Date.now() - startedAt,
        });
        Object.assign(error.details, safeChatGPTHandoff({
          ...response.error, ...(response.error.details || {}),
        }, payload.method));
        finish(error);
        return;
      }
      const result = response.result;
      const operation = safeChromeDiagnostics(response.operation);
      finish(null, result && typeof result === "object" && !Array.isArray(result) && Object.keys(operation).length
        ? { ...result, operation } : result);
    });
    socket.on("error", (source) => {
      const unavailable = source?.code === "ENOENT" || source?.code === "ECONNREFUSED";
      finish(operationError(unavailable ? "CHROME_EXTENSION_OFFLINE" : "CHROME_HOST_CONNECTION_FAILED",
        unavailable ? "Background Chrome extension is offline." : "Background Chrome host connection failed.",
        payload, { stage: "socket", state: requestWritten ? "outcome_unknown" : "not_dispatched",
          dispatchState: requestWritten ? "unknown" : "not_dispatched", elapsedMs: Date.now() - startedAt }));
    });
    socket.on("end", () => {
      if (settled) return;
      if (buffer.length) protocolFailure("incomplete-frame");
      else finish(operationError("CHROME_HOST_CLOSED", "Background Chrome closed before returning an outcome.", payload, {
        stage: "response-wait", elapsedMs: Date.now() - startedAt,
      }));
    });
    socket.on("close", () => {
      if (!settled) finish(operationError("CHROME_HOST_CLOSED", "Background Chrome connection closed before returning an outcome.", payload, {
        stage: "response-wait", elapsedMs: Date.now() - startedAt,
      }));
    });
  });
}

export async function backgroundChromeStatus({ dataDir, socketPath, timeoutMs = 1_000 } = {}) {
  try {
    return await requestSocket({ id: crypto.randomUUID(), method: "host.status" }, {
      socketPath: socketPath || backgroundChromeSocketPath(dataDir), timeoutMs,
    });
  } catch (error) {
    return { extensionReady: false, error: { code: error.code || "CHROME_EXTENSION_OFFLINE", message: error.message, details: error.details } };
  }
}

export async function backgroundChromeOperationStatus(operationId, { dataDir, socketPath, timeoutMs = 2_000 } = {}) {
  return await requestSocket({ id: crypto.randomUUID(), method: "host.operationStatus", args: { operationId } }, {
    socketPath: socketPath || backgroundChromeSocketPath(dataDir), timeoutMs,
  });
}

export async function backgroundChromeCall(method, args, allowedUrlPatterns, {
  dataDir, socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, operationId = crypto.randomUUID(),
  deadlineMs, transportAllowanceMs = TRANSPORT_ALLOWANCE_MS,
} = {}) {
  const routedMethod = normalizeBackgroundChromeMethod(method);
  const grantless = GRANTLESS_METHODS.has(routedMethod);
  if (!grantless && (!Array.isArray(allowedUrlPatterns) || allowedUrlPatterns.length === 0)) {
    const error = new Error("Background Chrome calls require a non-empty personal-browser URL grant.");
    error.code = "CHROME_NO_URL_GRANT";
    throw error;
  }
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) {
    const error = new Error("operationId must be a non-empty safe identifier of at most 128 characters.");
    error.code = "CHROME_OPERATION_ID_INVALID";
    throw error;
  }
  const actionDeadline = Number.isFinite(deadlineMs) ? Math.floor(deadlineMs) : Date.now() + Math.max(1, timeoutMs);
  return await requestSocket({
    id: operationId, method: routedMethod, args: args || {},
    allowedUrlPatterns: Array.isArray(allowedUrlPatterns) ? allowedUrlPatterns : [],
    timeoutMs, deadlineMs: actionDeadline,
  }, {
    socketPath: socketPath || backgroundChromeSocketPath(dataDir),
    timeoutMs: Math.max(1, actionDeadline - Date.now()) + Math.max(250, transportAllowanceMs),
  });
}
