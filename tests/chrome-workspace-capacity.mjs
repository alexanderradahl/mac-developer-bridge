import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
const helperMatch = workerSource.match(
  /function normalizeWorkspacePoolSize[\s\S]*?\n}\n\n(?=function errorPayload)/,
);
assert.ok(helperMatch, "workspace capacity helper source should be extractable");

const context = vm.createContext({
  DEFAULT_WORKSPACE_POOL_SIZE: 8,
  MAX_WORKSPACE_POOL_SIZE: 32,
  WORKSPACE_AUTO_GROW_STEP: 4,
});
vm.runInContext(helperMatch[0], context);

const normalize = vm.runInContext("normalizeWorkspacePoolSize", context);
const effective = vm.runInContext("effectiveWorkspaceTargetSize", context);
const nextTarget = vm.runInContext("nextWorkspaceAutoGrowTarget", context);
const capacity = vm.runInContext("workspaceCapacityStatus", context);

assert.equal(normalize(undefined), 8);
assert.equal(normalize(null), 8);
assert.equal(normalize("corrupt"), 8);
assert.equal(normalize(0), 8);
assert.equal(normalize(1), 1);
assert.equal(normalize(16), 16);
assert.equal(normalize(32), 32);
assert.equal(normalize(33), 32);
assert.equal(normalize(7.5), 8);
assert.equal(normalize(undefined, 16), 16);
assert.equal(normalize(undefined, 99), 8);

// Provisioning is growth-only: neither an explicit lower request nor stale
// persisted state may close already-created workspace tabs.
assert.equal(effective(6, 8, 8), 8);
assert.equal(effective(16, 8, 8), 16);
assert.equal(effective(8, 16, 8), 16);
assert.equal(effective(1, 8, 12), 12);
assert.equal(effective(null, "corrupt", 4), 8);

// Pressure grows once by four, does not ratchet while the earlier target is
// pending, and caps at the hard maximum.
assert.equal(nextTarget(8, 8), 12);
assert.equal(nextTarget(8, 12), 12);
assert.equal(nextTarget(12, 12), 16);
assert.equal(nextTarget(30, 30), 32);
assert.equal(nextTarget(32, 32), 32);

assert.deepEqual(
  JSON.parse(JSON.stringify(capacity(8, 12))),
  {
    poolSize: 8,
    targetPoolSize: 12,
    maxPoolSize: 32,
    autoGrowStep: 4,
    pendingTabCount: 4,
    provisioningPending: true,
    canGrow: true,
  },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(capacity(32, 32))),
  {
    poolSize: 32,
    targetPoolSize: 32,
    maxPoolSize: 32,
    autoGrowStep: 4,
    pendingTabCount: 0,
    provisioningPending: false,
    canGrow: false,
  },
);

// Persisted targets are migration-safe and growth-only.
const targetHelpersMatch = workerSource.match(
  /async function loadWorkspaceTargetSize[\s\S]*?\n}\n\n(?=async function readTab)/,
);
assert.ok(targetHelpersMatch, "workspace target storage helpers should be extractable");
let storedTarget;
const storageWrites = [];
const storageContext = vm.createContext({
  DEFAULT_WORKSPACE_POOL_SIZE: 8,
  WORKSPACE_TARGET_KEY: "macDeveloperBridgeWorkspaceTarget",
  normalizeWorkspacePoolSize: normalize,
  effectiveWorkspaceTargetSize: effective,
  chrome: {
    storage: {
      local: {
        async get() {
          return storedTarget === undefined
            ? {}
            : { macDeveloperBridgeWorkspaceTarget: storedTarget };
        },
        async set(value) {
          storageWrites.push(value);
          storedTarget = value.macDeveloperBridgeWorkspaceTarget;
        },
      },
    },
  },
});
vm.runInContext(targetHelpersMatch[0], storageContext);
const loadTarget = vm.runInContext("loadWorkspaceTargetSize", storageContext);
const provisionTarget = vm.runInContext("provisionWorkspaceTargetSize", storageContext);
assert.equal(await loadTarget(), 8);
storedTarget = { targetPoolSize: "corrupt" };
assert.equal(await loadTarget(), 8);
storedTarget = { targetPoolSize: 16 };
assert.equal(await loadTarget(), 16);
assert.equal(await provisionTarget(6, 8), 16);
assert.equal(storageWrites.length, 0, "a lower request must not shrink or rewrite the target");
assert.equal(await provisionTarget(20, 8), 20);
assert.equal(storageWrites.at(-1).macDeveloperBridgeWorkspaceTarget.targetPoolSize, 20);

// Long-running ChatGPT conversations must keep their workspace lease active
// without letting a failed renewal replace the conversation result.
const heartbeatIntervalMatch = workerSource.match(
  /const WORKSPACE_LEASE_HEARTBEAT_INTERVAL_MS = ([^;]+);/,
);
assert.ok(heartbeatIntervalMatch, "workspace lease heartbeat interval should be declared");
const heartbeatIntervalMs = vm.runInNewContext(heartbeatIntervalMatch[1]);
assert.ok(heartbeatIntervalMs > 0);
assert.ok(heartbeatIntervalMs < 10 * 60 * 1000);

const heartbeatHelperMatch = workerSource.match(
  /async function startWorkspaceLeaseHeartbeat[\s\S]*?\n}\n\n(?=async function reserveIdleWorkspaceTab)/,
);
assert.ok(heartbeatHelperMatch, "workspace lease heartbeat helper should be extractable");
const heartbeatTimers = [];
let heartbeatClearCalls = 0;
let touchImplementation;
const heartbeatContext = vm.createContext({
  WORKSPACE_LEASE_HEARTBEAT_INTERVAL_MS: heartbeatIntervalMs,
  touchWorkspaceLease: async (tabId) => await touchImplementation(tabId),
  setInterval(callback, delayMs) {
    const timer = { callback, delayMs, cleared: false };
    heartbeatTimers.push(timer);
    return timer;
  },
  clearInterval(timer) {
    heartbeatClearCalls += 1;
    timer.cleared = true;
  },
});
vm.runInContext(heartbeatHelperMatch[0], heartbeatContext);
const startHeartbeat = vm.runInContext("startWorkspaceLeaseHeartbeat", heartbeatContext);

let resolveInitialTouch;
const touchedTabIds = [];
touchImplementation = async (tabId) => {
  touchedTabIds.push(tabId);
  return await new Promise((resolve) => { resolveInitialTouch = resolve; });
};
const pendingNoopStopper = startHeartbeat(71);
assert.deepEqual(touchedTabIds, [71]);
assert.equal(heartbeatTimers.length, 0, "timer must wait for the immediate lease touch");
resolveInitialTouch(false);
const noopStopper = await pendingNoopStopper;
assert.equal(typeof noopStopper, "function");
assert.equal(heartbeatTimers.length, 0, "an inactive lease must not start a timer");
noopStopper();
noopStopper();
assert.equal(heartbeatClearCalls, 0);

let activeTouchCalls = 0;
touchImplementation = async (tabId) => {
  touchedTabIds.push(tabId);
  activeTouchCalls += 1;
  if (activeTouchCalls === 1) return true;
  throw new Error("heartbeat renewal failed");
};
const stopHeartbeat = await startHeartbeat(72);
assert.equal(activeTouchCalls, 1);
assert.equal(heartbeatTimers.length, 1);
assert.equal(heartbeatTimers[0].delayMs, heartbeatIntervalMs);
heartbeatTimers[0].callback();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(activeTouchCalls, 2, "the timer should renew the active lease");
stopHeartbeat();
stopHeartbeat();
assert.equal(heartbeatClearCalls, 1, "the synchronous stopper should be idempotent");
assert.equal(heartbeatTimers[0].cleared, true);

const conversationCase = workerSource.match(
  /case "tabs\.chatgptConversationStart":[\s\S]*?(?=\n    case "tabs\.chatgptRuntimeInventory")/,
)?.[0] || "";
const urlValidationIndex = conversationCase.indexOf("startsWith(\"https://chatgpt.com/\")");
const heartbeatStartIndex = conversationCase.indexOf("await startWorkspaceLeaseHeartbeat(tab.id)");
const firstExecuteIndex = conversationCase.indexOf("await executeInTab(tab.id");
assert.ok(urlValidationIndex >= 0);
assert.ok(heartbeatStartIndex > urlValidationIndex, "heartbeat should start after ChatGPT URL validation");
assert.ok(firstExecuteIndex > heartbeatStartIndex, "heartbeat should start before the first page execution");
assert.match(
  conversationCase,
  /finally \{[\s\S]*?stopWorkspaceLeaseHeartbeat\(\);[\s\S]*?releaseWorkspaceTab\(tab\.id\)/,
  "heartbeat should stop before the existing automatic release",
);

// Provisioning is accepted while Chrome is unfocused, but actual tab creation
// remains structurally deferred until natural focus.
const provisioningMatch = workerSource.match(
  /function workspaceProvisioningResult[\s\S]*?\n}\n\n(?=async function waitForApprovedNavigation)/,
);
assert.ok(provisioningMatch, "workspace provisioning implementation should be extractable");
let createCalls = 0;
const existingState = {
  groupId: 9,
  tabIds: Array.from({ length: 8 }, (_, index) => index + 1),
  leases: {},
  tabs: [{ id: 1, windowId: 7 }],
};
const deferredContext = vm.createContext({
  workspaceCapacityStatus: capacity,
  WORKSPACE_GROUP_TITLE: "MDB",
  WORKSPACE_GROUP_COLOR: "blue",
  workspaceIdleUrl: () => "chrome-extension://test/workspace.html",
  mutateWorkspaceState: async (operation) => await operation(),
  reconcileWorkspaceStateUnlocked: async () => existingState,
  provisionWorkspaceTargetSize: async () => 16,
  setWorkspaceGroupActivity: async () => {},
  saveWorkspaceState: async () => {},
  readTab: async (id) => ({ id, windowId: 7 }),
  chrome: {
    windows: {
      async get() { return { id: 7, focused: false }; },
      async getAll() { return []; },
    },
    tabs: {
      async create() { createCalls += 1; return { id: 100 + createCalls }; },
      async group() { return 9; },
    },
    tabGroups: { async update() {} },
  },
});
vm.runInContext(provisioningMatch[0], deferredContext);
const initializeDeferred = vm.runInContext("initializeWorkspace", deferredContext);
const deferred = await initializeDeferred(16);
assert.equal(deferred.provisioned, true);
assert.equal(deferred.deferred, true);
assert.equal(deferred.pendingForegroundExpansion, true);
assert.equal(deferred.deferredReason, "CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED");
assert.equal(deferred.poolSize, 8);
assert.equal(deferred.targetPoolSize, 16);
assert.equal(deferred.pendingTabCount, 8);
assert.equal(createCalls, 0, "unfocused provisioning must not create any Chrome tab");

let nextTabId = 100;
const createdTabs = [];
const groupedTabs = [];
let savedState = null;
const focusedContext = vm.createContext({
  workspaceCapacityStatus: capacity,
  WORKSPACE_GROUP_TITLE: "MDB",
  WORKSPACE_GROUP_COLOR: "blue",
  workspaceIdleUrl: () => "chrome-extension://test/workspace.html",
  mutateWorkspaceState: async (operation) => await operation(),
  reconcileWorkspaceStateUnlocked: async () => existingState,
  provisionWorkspaceTargetSize: async () => 12,
  setWorkspaceGroupActivity: async () => {},
  saveWorkspaceState: async (value) => { savedState = value; },
  readTab: async (id) => ({ id, windowId: 7 }),
  chrome: {
    windows: {
      async get() { return { id: 7, focused: true }; },
      async getAll() { return []; },
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
        nextTabId += 1;
        return { id: nextTabId, windowId: 7 };
      },
      async group(options) { groupedTabs.push(options); return 9; },
    },
    tabGroups: { async update() {} },
  },
});
vm.runInContext(provisioningMatch[0], focusedContext);
const initializeFocused = vm.runInContext("initializeWorkspace", focusedContext);
const expanded = await initializeFocused(12);
assert.equal(expanded.deferred, false);
assert.equal(expanded.created, true);
assert.equal(expanded.poolSize, 12);
assert.equal(expanded.targetPoolSize, 12);
assert.equal(expanded.pendingTabCount, 0);
assert.equal(createdTabs.length, 4);
assert.ok(createdTabs.every((options) => options.active === false));
assert.equal(groupedTabs.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(groupedTabs[0].tabIds)), [101, 102, 103, 104]);
assert.equal(savedState.tabIds.length, 12);

const errorPayloadMatch = workerSource.match(
  /function errorPayload[\s\S]*?\n}\n\n(?=function mutateWorkspaceState)/,
);
assert.ok(errorPayloadMatch, "safe error payload helper should be extractable");
const errorContext = vm.createContext({});
vm.runInContext(errorPayloadMatch[0], errorContext);
const safeErrorPayload = vm.runInContext("errorPayload", errorContext);
const exhaustionError = new Error("pool exhausted");
exhaustionError.code = "CHROME_WORKSPACE_EXHAUSTED";
exhaustionError.details = {
  poolSize: 8,
  leased: 8,
  waitTimeoutMs: 20000,
  targetPoolSize: 12,
  pendingTabCount: 4,
  maxPoolSize: 32,
  autoGrowStep: 4,
  provisioningPending: true,
  canGrow: true,
  secret: "must-not-cross-boundary",
};
assert.deepEqual(
  JSON.parse(JSON.stringify(safeErrorPayload(exhaustionError))),
  {
    code: "CHROME_WORKSPACE_EXHAUSTED",
    message: "pool exhausted",
    details: {
      poolSize: 8,
      leased: 8,
      waitTimeoutMs: 20000,
      targetPoolSize: 12,
      pendingTabCount: 4,
      maxPoolSize: 32,
      autoGrowStep: 4,
      provisioningPending: true,
      canGrow: true,
    },
  },
);

console.log(JSON.stringify({
  passed: true,
  defaultPoolSize: 8,
  maxPoolSize: 32,
  autoGrowStep: 4,
  pressureSequence: [nextTarget(8, 8), nextTarget(8, 12), nextTarget(12, 12)],
}));
