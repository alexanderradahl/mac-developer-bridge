import crypto from "node:crypto";
import fs from "node:fs/promises";
import { safeChromeDiagnostics } from "./chrome-extension-client.mjs";

export const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_RETAINED_OPERATIONS = 5_000;
export const READ_OPERATION_RETENTION_MS = 5 * 60 * 1000;
export const MAX_RETAINED_READ_OPERATIONS = 256;
const MAX_RETAINED_RESULT_BYTES = 8 * 1024 * 1024;
const STATES = new Set(["accepted", "dispatched", "completed", "cancelled_before_dispatch", "outcome_unknown"]);
export const isReadOnlyChromeMethod = (method) => ["status", "tabs.list", "tabs.snapshot"].includes(method);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function operationFingerprint(request) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical({
    method: request.method, args: request.args || {}, allowedUrlPatterns: request.allowedUrlPatterns || [],
  }))).digest("hex");
}

export function operationMetadata(entry) {
  return {
    operationId: entry.id,
    state: entry.state,
    component: "chrome-native-host",
    stage: entry.stage || "operation",
    dispatched: entry.dispatched === true,
    dispatchState: entry.dispatched ? "dispatched" : "not_dispatched",
    outcome: entry.outcome || null,
    targetTabId: entry.targetTabId ?? null,
    deadlineMs: entry.deadlineMs,
    elapsedMs: Math.max(0, (entry.completedAt || Date.now()) - entry.acceptedAt),
    connectionGeneration: entry.connectionGeneration || null,
    reconciled: entry.reconciled === true,
    resultAvailable: Boolean(entry.response),
    retentionMs: entry.readOnly ? READ_OPERATION_RETENTION_MS : OPERATION_RETENTION_MS,
    retryable: false,
  };
}

export class ChromeOperationRegistry {
  constructor(journalPath) {
    this.journalPath = journalPath;
    this.entries = new Map();
    this.writeChain = Promise.resolve();
    this.healthy = true;
  }

  async load() {
    let value;
    try { value = JSON.parse(await fs.readFile(this.journalPath, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error("Chrome operation journal could not be read; refusing to replay uncertain browser work.");
    }
    if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > MAX_RETAINED_OPERATIONS) {
      throw new Error("Chrome operation journal is invalid; refusing to replay uncertain browser work.");
    }
    const now = Date.now();
    for (const saved of value.operations) {
      if (!saved || typeof saved.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(saved.id)
          || typeof saved.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(saved.fingerprint)
          || !STATES.has(saved.state) || !Number.isFinite(saved.acceptedAt) || !Number.isFinite(saved.deadlineMs)) {
        throw new Error("Chrome operation journal contains an invalid entry; refusing uncertain work.");
      }
      if (now - saved.acceptedAt > OPERATION_RETENTION_MS) continue;
      const entry = { ...saved, sockets: new Set(), response: null, timer: null };
      if (entry.state === "accepted") {
        entry.state = "cancelled_before_dispatch";
        entry.stage = "host-restart";
        entry.outcome = "cancelled";
      } else if (entry.state === "dispatched") {
        entry.state = "outcome_unknown";
        entry.stage = "host-restart";
      }
      this.entries.set(entry.id, entry);
    }
  }

  prune() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      const retentionMs = entry.readOnly ? READ_OPERATION_RETENTION_MS : OPERATION_RETENTION_MS;
      if (!entry.sockets.size && now - entry.acceptedAt > retentionMs) {
        clearTimeout(entry.timer);
        this.entries.delete(id);
      }
    }
    // Page snapshots can contain megabytes. Keep status/fingerprints for the
    // complete retention window, but bound optional in-memory replay results.
    let resultBytes = 0;
    for (const entry of [...this.entries.values()].reverse()) {
      if (!entry.response) continue;
      const bytes = Buffer.byteLength(JSON.stringify(entry.response));
      if (resultBytes + bytes > MAX_RETAINED_RESULT_BYTES && !entry.sockets.size) entry.response = null;
      else resultBytes += bytes;
    }
  }

  hasCapacity(readOnly) {
    const matching = [...this.entries.values()].filter((entry) => Boolean(entry.readOnly) === readOnly);
    if (!readOnly) return matching.length < MAX_RETAINED_OPERATIONS;
    // Reads have their own small in-memory budget. They cannot fill the durable
    // write ledger or evict a mutation's no-replay fingerprint.
    while (matching.length >= MAX_RETAINED_READ_OPERATIONS) {
      const index = matching.findIndex((entry) => !entry.sockets.size && !["accepted", "dispatched"].includes(entry.state));
      if (index === -1) return false;
      const [entry] = matching.splice(index, 1);
      this.entries.delete(entry.id);
    }
    return true;
  }

  snapshot() {
    return {
      version: 1,
      retentionMs: OPERATION_RETENTION_MS,
      operations: [...this.entries.values()].filter((entry) => !entry.readOnly).map((entry) => ({
        id: entry.id, fingerprint: entry.fingerprint, method: entry.method,
        state: entry.state, stage: entry.stage, dispatched: entry.dispatched,
        acceptedAt: entry.acceptedAt, deadlineMs: entry.deadlineMs,
        completedAt: entry.completedAt || null, targetTabId: entry.targetTabId ?? null,
        connectionGeneration: entry.connectionGeneration || null,
        outcome: entry.outcome || null, reconciled: entry.reconciled === true,
        error: entry.error ? {
          code: entry.error.code, details: safeChromeDiagnostics(entry.error.details),
        } : null,
      })),
    };
  }

  persist() {
    const write = this.writeChain.then(async () => {
      const temporary = this.journalPath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(temporary, JSON.stringify(this.snapshot()) + "\n", { mode: 0o600, flag: "wx" });
        // Commit durable dispatch metadata before sending any browser action.
        const handle = await fs.open(temporary, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.journalPath);
        this.healthy = true;
      } catch (error) {
        this.healthy = false;
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
    this.writeChain = write.catch(() => {});
    return write;
  }
}
