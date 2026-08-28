const NATIVE_HOST = "io.github.alexanderradahl.mac_developer_bridge";
const VERSION = "0.2.10";
const WORKSPACE_KEY = "macDeveloperBridgeWorkspace";
const WORKSPACE_TARGET_KEY = "macDeveloperBridgeWorkspaceTarget";
const WORKSPACE_GROUP_TITLE = "MDB";
const WORKSPACE_GROUP_COLOR = "blue";
const WORKSPACE_LEASE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const WORKSPACE_LEASE_WAIT_TIMEOUT_MS = 20_000;
const WORKSPACE_LEASE_WAIT_POLL_MS = 250;
const WORKSPACE_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_WORKSPACE_POOL_SIZE = 8;
const MAX_WORKSPACE_POOL_SIZE = 32;
const WORKSPACE_AUTO_GROW_STEP = 4;
const CHATGPT_EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const CHATGPT_STATUS_REQUEST_EVENT = "chatgpt-extension-request-status";
const CHATGPT_STATUS_RESPONSE_EVENT = "chatgpt-extension-status";
const CHATGPT_STATUS_ATTRIBUTE = "data-chatgpt-extension-status";
const CHATGPT_SIDE_PANEL_ATTRIBUTE = "data-chatgpt-extension-side-panel";
let port = null;
let reconnectTimer = null;
let workspaceMutationQueue = Promise.resolve();

function normalizeWorkspacePoolSize(value, fallback = DEFAULT_WORKSPACE_POOL_SIZE) {
  const safeFallback = Number.isInteger(Number(fallback))
    && Number(fallback) >= 1
    && Number(fallback) <= MAX_WORKSPACE_POOL_SIZE
    ? Number(fallback)
    : DEFAULT_WORKSPACE_POOL_SIZE;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return safeFallback;
  return Math.min(MAX_WORKSPACE_POOL_SIZE, numeric);
}

function normalizeCurrentWorkspacePoolSize(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return 0;
  return Math.min(MAX_WORKSPACE_POOL_SIZE, numeric);
}

function effectiveWorkspaceTargetSize(requested, storedTarget, currentPoolSize = 0) {
  const current = normalizeCurrentWorkspacePoolSize(currentPoolSize);
  const stored = normalizeWorkspacePoolSize(storedTarget, DEFAULT_WORKSPACE_POOL_SIZE);
  const requestedTarget = requested === undefined || requested === null
    ? stored
    : normalizeWorkspacePoolSize(requested, stored);
  return Math.max(current, stored, requestedTarget);
}

function nextWorkspaceAutoGrowTarget(currentPoolSize, targetPoolSize) {
  const current = normalizeCurrentWorkspacePoolSize(currentPoolSize);
  const target = Math.max(current, normalizeWorkspacePoolSize(targetPoolSize, DEFAULT_WORKSPACE_POOL_SIZE));
  if (target > current || current >= MAX_WORKSPACE_POOL_SIZE) return target;
  return Math.min(MAX_WORKSPACE_POOL_SIZE, current + WORKSPACE_AUTO_GROW_STEP);
}

function workspaceCapacityStatus(currentPoolSize, targetPoolSize) {
  const poolSize = normalizeCurrentWorkspacePoolSize(currentPoolSize);
  const targetPoolSizeSafe = Math.max(
    poolSize,
    normalizeWorkspacePoolSize(targetPoolSize, DEFAULT_WORKSPACE_POOL_SIZE),
  );
  const pendingTabCount = Math.max(0, targetPoolSizeSafe - poolSize);
  return {
    poolSize,
    targetPoolSize: targetPoolSizeSafe,
    maxPoolSize: MAX_WORKSPACE_POOL_SIZE,
    autoGrowStep: WORKSPACE_AUTO_GROW_STEP,
    pendingTabCount,
    provisioningPending: pendingTabCount > 0,
    canGrow: targetPoolSizeSafe < MAX_WORKSPACE_POOL_SIZE || poolSize < MAX_WORKSPACE_POOL_SIZE,
  };
}

function errorPayload(error, code = "CHROME_EXTENSION_ERROR") {
  const sourceDetails = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : null;
  const details = sourceDetails
    ? Object.fromEntries(Object.entries(sourceDetails).filter(([key, value]) =>
      [
        "status",
        "complete",
        "conversation_id",
        "event_count",
        "parse_failure_count",
        "action_error_name",
        "action_error_message",
        "action_error_stack",
        "poolSize",
        "leased",
        "waitTimeoutMs",
        "targetPoolSize",
        "pendingTabCount",
        "maxPoolSize",
        "autoGrowStep",
        "provisioningPending",
        "canGrow",
      ].includes(key)
      && (["string", "number", "boolean"].includes(typeof value) || value === null)))
    : null;
  return {
    code: error?.code || code,
    message: String(error?.message || error),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function mutateWorkspaceState(operation) {
  const run = workspaceMutationQueue.then(operation, operation);
  workspaceMutationQueue = run.then(() => {}, () => {});
  return run;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    const error = new Error("No approved URL patterns were supplied by Mac Developer Bridge.");
    error.code = "CHROME_NO_URL_GRANT";
    throw error;
  }
  return patterns.map((pattern) => {
    try {
      return { source: pattern, pattern: new URLPattern(pattern) };
    } catch (error) {
      const wrapped = new Error(`Invalid approved URL pattern '${pattern}': ${error.message}`);
      wrapped.code = "CHROME_INVALID_URL_PATTERN";
      throw wrapped;
    }
  });
}

function urlAllowed(url, compiled) {
  if (typeof url !== "string" || !url) return false;
  return compiled.some(({ pattern }) => pattern.test(url));
}

function assertUrlAllowed(url, compiled) {
  if (!urlAllowed(url, compiled)) {
    const error = new Error(`The tab URL is outside the current personal-browser grant: ${url || "<empty>"}`);
    error.code = "CHROME_URL_NOT_APPROVED";
    throw error;
  }
}

function workspaceIdleUrl() {
  return chrome.runtime.getURL("workspace.html");
}

async function loadWorkspaceState() {
  const stored = (await chrome.storage.local.get(WORKSPACE_KEY))?.[WORKSPACE_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const groupId = Number(stored.groupId);
  const tabIds = Array.isArray(stored.tabIds)
    ? stored.tabIds.map(Number).filter((id) => Number.isInteger(id) && id >= 0)
    : [];
  const leases = stored.leases && typeof stored.leases === "object" && !Array.isArray(stored.leases)
    ? stored.leases
    : {};
  if (!Number.isInteger(groupId) || groupId < 0 || tabIds.length === 0) return null;
  return { groupId, tabIds: [...new Set(tabIds)], leases };
}

async function saveWorkspaceState(state) {
  await chrome.storage.local.set({ [WORKSPACE_KEY]: state });
}

async function clearWorkspaceState() {
  await chrome.storage.local.remove(WORKSPACE_KEY);
}

async function loadWorkspaceTargetSize() {
  try {
    const stored = (await chrome.storage.local.get(WORKSPACE_TARGET_KEY))?.[WORKSPACE_TARGET_KEY];
    const raw = stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored.targetPoolSize
      : stored;
    return normalizeWorkspacePoolSize(raw, DEFAULT_WORKSPACE_POOL_SIZE);
  } catch {
    return DEFAULT_WORKSPACE_POOL_SIZE;
  }
}

async function saveWorkspaceTargetSize(targetPoolSize) {
  const normalized = normalizeWorkspacePoolSize(targetPoolSize, DEFAULT_WORKSPACE_POOL_SIZE);
  await chrome.storage.local.set({
    [WORKSPACE_TARGET_KEY]: {
      targetPoolSize: normalized,
    },
  });
  return normalized;
}

async function provisionWorkspaceTargetSize(requestedPoolSize, currentPoolSize = 0) {
  const storedTarget = await loadWorkspaceTargetSize();
  const targetPoolSize = effectiveWorkspaceTargetSize(
    requestedPoolSize,
    storedTarget,
    currentPoolSize,
  );
  if (targetPoolSize !== storedTarget) await saveWorkspaceTargetSize(targetPoolSize);
  return targetPoolSize;
}

async function readTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

async function readGroup(groupId) {
  try { return await chrome.tabGroups.get(groupId); } catch { return null; }
}

async function discoverWorkspaceState() {
  try {
    const groups = await chrome.tabGroups.query({
      title: WORKSPACE_GROUP_TITLE,
      color: WORKSPACE_GROUP_COLOR,
    });
    for (const group of groups) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length === 0) continue;
      // Avoid adopting a user-created group that happens to share our title/color.
      // A healthy idle pool always has at least one extension-owned workspace page.
      const hasWorkspacePage = tabs.some((tab) => tab.url === workspaceIdleUrl());
      if (!hasWorkspacePage) continue;
      const state = { groupId: group.id, tabIds: tabs.map((tab) => tab.id), leases: {} };
      await saveWorkspaceState(state);
      return { ...state, group, tabs };
    }
  } catch {}
  return null;
}

async function reconcileWorkspaceStateUnlocked({ releaseStale = true } = {}) {
  let state = await loadWorkspaceState();
  if (!state) return await discoverWorkspaceState();
  let group = await readGroup(state.groupId);
  if (!group) {
    await clearWorkspaceState();
    return await discoverWorkspaceState();
  }

  const tabs = [];
  for (const tabId of state.tabIds) {
    const tab = await readTab(tabId);
    if (tab?.groupId === state.groupId) tabs.push(tab);
  }
  if (tabs.length === 0) {
    await clearWorkspaceState();
    return null;
  }

  const now = Date.now();
  const leases = {};
  const staleTabIds = [];
  for (const tab of tabs) {
    const lease = state.leases?.[String(tab.id)];
    if (!lease || typeof lease !== "object") continue;
    const leasedAt = Number(lease.leasedAt || 0);
    const hasActivityTimestamp = Number.isFinite(Number(lease.lastActivityAt)) && Number(lease.lastActivityAt) > 0;
    // v0.2.3 stored only leasedAt. On first v0.2.4 reconciliation, migrate
    // those live leases with a fresh heartbeat instead of interpreting their
    // original creation time as 10 minutes of inactivity.
    const lastActivityAt = hasActivityTimestamp ? Number(lease.lastActivityAt) : now;
    const invalid = !Number.isFinite(leasedAt) || !Number.isFinite(lastActivityAt) || leasedAt <= 0 || lastActivityAt <= 0;
    const idleExpired = now - lastActivityAt > WORKSPACE_LEASE_IDLE_TIMEOUT_MS;
    if (releaseStale && (invalid || idleExpired)) {
      staleTabIds.push(tab.id);
      continue;
    }
    leases[String(tab.id)] = { leasedAt, lastActivityAt };
  }

  const next = { groupId: state.groupId, tabIds: tabs.map((tab) => tab.id), leases };
  await saveWorkspaceState(next);
  for (const tabId of staleTabIds) {
    try { await chrome.tabs.update(tabId, { url: workspaceIdleUrl(), active: false }); } catch {}
  }
  return { ...next, group, tabs, staleReleasedTabIds: staleTabIds };
}

async function reconcileWorkspaceState(options = {}) {
  return await mutateWorkspaceState(() => reconcileWorkspaceStateUnlocked(options));
}

async function setWorkspaceGroupActivity(state) {
  const hasActiveLease = Object.keys(state?.leases || {}).length > 0;
  try {
    await chrome.tabGroups.update(state.groupId, {
      title: WORKSPACE_GROUP_TITLE,
      color: WORKSPACE_GROUP_COLOR,
      collapsed: !hasActiveLease,
    });
  } catch {}
}

function workspaceProvisioningResult(state, targetPoolSize, {
  created = false,
  deferred = false,
} = {}) {
  const capacity = workspaceCapacityStatus(state?.tabIds?.length || 0, targetPoolSize);
  return {
    initialized: Boolean(state),
    provisioned: true,
    created,
    deferred,
    deferredReason: deferred ? "CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED" : null,
    pendingForegroundExpansion: deferred && capacity.provisioningPending,
    groupId: state?.groupId ?? null,
    tabIds: state?.tabIds || [],
    ...capacity,
    title: WORKSPACE_GROUP_TITLE,
    color: WORKSPACE_GROUP_COLOR,
    foregroundSetupMayBeRequired: capacity.provisioningPending,
  };
}

async function initializeWorkspace(poolSize) {
  return await mutateWorkspaceState(async () => {
    let state = await reconcileWorkspaceStateUnlocked();
    const targetPoolSize = await provisionWorkspaceTargetSize(
      poolSize,
      state?.tabIds?.length || 0,
    );
    if (state && state.tabIds.length >= targetPoolSize) {
      await setWorkspaceGroupActivity(state);
      return workspaceProvisioningResult(state, targetPoolSize);
    }

    let windowId = state?.tabs?.[0]?.windowId;
    let targetWindow = null;
    if (Number.isInteger(windowId)) {
      try { targetWindow = await chrome.windows.get(windowId); } catch {}
    } else {
      const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
      targetWindow = windows.find((win) => win.focused) || null;
      windowId = targetWindow?.id;
    }

    // Measured on Chrome/macOS: even tabs.create({active:false}) can bring Chrome
    // to the foreground. Provisioning the desired capacity is always safe and is
    // persisted above, but actual tab creation remains deferred until the target
    // Chrome window is already naturally focused. MDB never activates Chrome.
    if (!targetWindow || !Number.isInteger(windowId) || targetWindow.focused !== true) {
      return workspaceProvisioningResult(state, targetPoolSize, { deferred: true });
    }

    const existingTabIds = state?.tabIds || [];
    const tabIds = [...existingTabIds];
    while (tabIds.length < targetPoolSize) {
      const tab = await chrome.tabs.create({ windowId, url: workspaceIdleUrl(), active: false });
      if (!Number.isInteger(tab.id)) throw new Error("Chrome did not return a tab id during workspace setup.");
      tabIds.push(tab.id);
    }

    let groupId = state?.groupId;
    if (!Number.isInteger(groupId)) {
      groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    } else {
      const newlyCreated = tabIds.filter((id) => !existingTabIds.includes(id));
      if (newlyCreated.length) await chrome.tabs.group({ tabIds: newlyCreated, groupId });
    }

    const next = { groupId, tabIds, leases: state?.leases || {} };
    await saveWorkspaceState(next);
    await chrome.tabGroups.update(groupId, {
      title: WORKSPACE_GROUP_TITLE,
      color: WORKSPACE_GROUP_COLOR,
      collapsed: Object.keys(next.leases).length === 0,
    });
    state = { ...next, tabs: await Promise.all(tabIds.map(readTab)) };
    return workspaceProvisioningResult(state, targetPoolSize, {
      created: tabIds.length > existingTabIds.length,
    });
  });
}

async function waitForApprovedNavigation(tabId, compiled, {
  previousUrl = "",
  requestedUrl = "",
  timeoutMs = WORKSPACE_NAVIGATION_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = previousUrl;
  for (;;) {
    const tab = await readTab(tabId);
    if (!tab) {
      const error = new Error(`Chrome tab ${tabId} disappeared while navigation was committing.`);
      error.code = "CHROME_TAB_GONE";
      throw error;
    }
    const currentUrl = String(tab.url || "");
    const pendingUrl = String(tab.pendingUrl || "");
    lastUrl = currentUrl || pendingUrl || lastUrl;

    const changed = currentUrl && currentUrl !== previousUrl;
    const sameRequestedPage = currentUrl && currentUrl === previousUrl && requestedUrl === previousUrl;
    if (changed || sameRequestedPage) {
      if (!urlAllowed(currentUrl, compiled)) {
        const error = new Error(`Navigation left the approved URL scope: ${currentUrl || "<empty>"}`);
        error.code = "CHROME_URL_NOT_APPROVED";
        throw error;
      }
      // A committed but still-loading page is not ready for snapshot/click/fill.
      // Waiting here makes chrome_open/chrome_navigate a reliable hand-off point.
      if (tab.status === "complete" || !tab.status) return tab;
    }

    if (Date.now() >= deadline) {
      const error = new Error(`Chrome navigation did not settle on an approved page within ${timeoutMs}ms (requested ${requestedUrl || "<unknown>"}, last ${lastUrl || "<empty>"}).`);
      error.code = "CHROME_NAVIGATION_TIMEOUT";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function initializeWorkspaceIfChromeFocused() {
  let state = await reconcileWorkspaceState();
  const targetPoolSize = effectiveWorkspaceTargetSize(
    null,
    await loadWorkspaceTargetSize(),
    state?.tabIds?.length || 0,
  );
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find((win) => win.focused === true);
  if (!focused) return state;
  if (!state || state.tabIds.length < targetPoolSize) {
    await initializeWorkspace(targetPoolSize);
    state = await reconcileWorkspaceState();
  }
  return state;
}

async function autoProvisionWorkspaceForPressure(state) {
  const currentPoolSize = state?.tabIds?.length || 0;
  const storedTarget = await loadWorkspaceTargetSize();
  const targetPoolSize = nextWorkspaceAutoGrowTarget(currentPoolSize, storedTarget);
  if (targetPoolSize > storedTarget) await saveWorkspaceTargetSize(targetPoolSize);
  if (targetPoolSize > currentPoolSize) {
    await initializeWorkspaceIfChromeFocused();
  }
  const refreshed = await reconcileWorkspaceState();
  return {
    state: refreshed,
    ...workspaceCapacityStatus(refreshed?.tabIds?.length || currentPoolSize, targetPoolSize),
  };
}

async function touchWorkspaceLease(tabId) {
  const wanted = numericTabId(tabId);
  return await mutateWorkspaceState(async () => {
    const state = await reconcileWorkspaceStateUnlocked({ releaseStale: false });
    if (!state) return false;
    const lease = state.leases?.[String(wanted)];
    if (!lease) return false;
    state.leases[String(wanted)] = {
      leasedAt: Number(lease.leasedAt || Date.now()),
      lastActivityAt: Date.now(),
    };
    await saveWorkspaceState({ groupId: state.groupId, tabIds: state.tabIds, leases: state.leases });
    return true;
  });
}

async function reserveIdleWorkspaceTab() {
  return await mutateWorkspaceState(async () => {
    const state = await reconcileWorkspaceStateUnlocked({ releaseStale: true });
    if (!state) return { state: null, tab: null };
    const leasedIds = new Set(Object.keys(state.leases).map(Number));
    const tab = state.tabs.find((candidate) => !leasedIds.has(candidate.id)) || null;
    if (!tab) return { state, tab: null };
    const now = Date.now();
    state.leases[String(tab.id)] = { leasedAt: now, lastActivityAt: now };
    await saveWorkspaceState({ groupId: state.groupId, tabIds: state.tabIds, leases: state.leases });
    return { state, tab };
  });
}

async function leaseWorkspaceTab(url, compiled) {
  assertUrlAllowed(url, compiled);
  let state = await reconcileWorkspaceState();
  const configuredTarget = effectiveWorkspaceTargetSize(
    null,
    await loadWorkspaceTargetSize(),
    state?.tabIds?.length || 0,
  );
  if (!state || state.tabIds.length < configuredTarget) {
    state = await initializeWorkspaceIfChromeFocused();
  }
  if (!state) {
    const targetPoolSize = await loadWorkspaceTargetSize();
    const capacity = workspaceCapacityStatus(0, targetPoolSize);
    const error = new Error(`The Mac Developer Bridge Chrome tab group is missing. MDB has provisioned a ${capacity.targetPoolSize}-tab target and will create it the next time Chrome is naturally foreground; browser work refuses to create a loose fallback tab in the meantime.`);
    error.code = "CHROME_WORKSPACE_MISSING";
    error.details = capacity;
    throw error;
  }

  const waitStartedAt = Date.now();
  const deadline = waitStartedAt + WORKSPACE_LEASE_WAIT_TIMEOUT_MS;
  let reservation = null;
  let pressureProvisioned = false;
  for (;;) {
    reservation = await reserveIdleWorkspaceTab();
    if (reservation.tab) break;
    if (!pressureProvisioned) {
      const pressure = await autoProvisionWorkspaceForPressure(reservation.state || state);
      pressureProvisioned = true;
      state = pressure.state || state;
      continue;
    }
    if (Date.now() >= deadline) {
      const current = reservation.state || await reconcileWorkspaceState();
      const leased = Object.keys(current?.leases || {}).length;
      const poolSize = current?.tabIds?.length || 0;
      const targetPoolSize = effectiveWorkspaceTargetSize(
        null,
        await loadWorkspaceTargetSize(),
        poolSize,
      );
      const capacity = workspaceCapacityStatus(poolSize, targetPoolSize);
      const expansion = capacity.provisioningPending
        ? ` Another ${capacity.pendingTabCount} tabs are provisioned and will be created the next time the MDB Chrome window is naturally focused.`
        : capacity.canGrow
          ? ` MDB can provision another ${WORKSPACE_AUTO_GROW_STEP} tabs on the next pressure event, up to ${MAX_WORKSPACE_POOL_SIZE}.`
          : " The pool is already at its configured maximum."
      const error = new Error(`All ${poolSize} Mac Developer Bridge background tabs remained in use for ${WORKSPACE_LEASE_WAIT_TIMEOUT_MS}ms. MDB waited for a release instead of failing immediately.${expansion}`);
      error.code = "CHROME_WORKSPACE_EXHAUSTED";
      error.details = {
        poolSize,
        leased,
        waitTimeoutMs: WORKSPACE_LEASE_WAIT_TIMEOUT_MS,
        targetPoolSize: capacity.targetPoolSize,
        pendingTabCount: capacity.pendingTabCount,
        maxPoolSize: capacity.maxPoolSize,
        autoGrowStep: capacity.autoGrowStep,
        provisioningPending: capacity.provisioningPending,
        canGrow: capacity.canGrow,
      };
      throw error;
    }
    await delay(WORKSPACE_LEASE_WAIT_POLL_MS);
  }

  state = reservation.state;
  const tab = reservation.tab;
  await setWorkspaceGroupActivity(state);
  try {
    const previousUrl = String(tab.url || "");
    await chrome.tabs.update(tab.id, { url, active: false });
    const settled = await waitForApprovedNavigation(tab.id, compiled, { previousUrl, requestedUrl: url });
    await touchWorkspaceLease(tab.id);
    const targetPoolSize = effectiveWorkspaceTargetSize(
      null,
      await loadWorkspaceTargetSize(),
      state.tabIds.length,
    );
    return {
      workspace: true,
      groupId: state.groupId,
      tabId: settled.id,
      windowId: settled.windowId,
      active: Boolean(settled.active),
      title: settled.title || "",
      url: settled.url || url,
      ...workspaceCapacityStatus(state.tabIds.length, targetPoolSize),
      waitedForSlotMs: Math.max(0, Date.now() - waitStartedAt),
    };
  } catch (error) {
    try { await chrome.tabs.update(tab.id, { url: workspaceIdleUrl(), active: false }); } catch {}
    await releaseWorkspaceTab(tab.id, { resetUrl: false }).catch(() => {});
    throw error;
  }
}

async function releaseWorkspaceTab(tabId, { resetUrl = true } = {}) {
  const wanted = numericTabId(tabId);
  const result = await mutateWorkspaceState(async () => {
    const state = await reconcileWorkspaceStateUnlocked({ releaseStale: false });
    if (!state || !state.tabIds.includes(wanted)) return null;
    const lease = state.leases[String(wanted)] || null;
    let updated = await readTab(wanted);
    // Reset while the lease is still reserved. Only after chrome.tabs.update
    // resolves do we remove the lease, so a waiting opener cannot reserve this
    // tab and then have its navigation overwritten by a late cleanup update.
    if (resetUrl && updated) {
      try { updated = await chrome.tabs.update(wanted, { url: workspaceIdleUrl(), active: false }); } catch {}
    }
    delete state.leases[String(wanted)];
    await saveWorkspaceState({ groupId: state.groupId, tabIds: state.tabIds, leases: state.leases });
    return { state, lease, updated };
  });
  if (!result) return null;
  await setWorkspaceGroupActivity(result.state);
  return {
    workspace: true,
    released: true,
    closed: false,
    groupId: result.state.groupId,
    tabId: wanted,
    wasActive: Boolean(result.updated?.active),
  };
}

async function workspaceStatus() {
  const state = await reconcileWorkspaceState();
  const targetPoolSize = effectiveWorkspaceTargetSize(
    null,
    await loadWorkspaceTargetSize(),
    state?.tabIds?.length || 0,
  );
  const capacity = workspaceCapacityStatus(state?.tabIds?.length || 0, targetPoolSize);
  if (!state) return {
    initialized: false,
    ...capacity,
    title: WORKSPACE_GROUP_TITLE,
    color: WORKSPACE_GROUP_COLOR,
    leaseIdleTimeoutMs: WORKSPACE_LEASE_IDLE_TIMEOUT_MS,
    leaseWaitTimeoutMs: WORKSPACE_LEASE_WAIT_TIMEOUT_MS,
  };
  const now = Date.now();
  const leaseDetails = Object.entries(state.leases).map(([tabId, lease]) => ({
    tabId: Number(tabId),
    leasedAt: Number(lease.leasedAt || 0),
    lastActivityAt: Number(lease.lastActivityAt || lease.leasedAt || 0),
    ageMs: Math.max(0, now - Number(lease.leasedAt || now)),
    idleForMs: Math.max(0, now - Number(lease.lastActivityAt || lease.leasedAt || now)),
  }));
  return {
    initialized: true,
    groupId: state.groupId,
    tabIds: state.tabIds,
    ...capacity,
    leasedTabIds: Object.keys(state.leases).map(Number),
    idleTabIds: state.tabIds.filter((id) => !state.leases[String(id)]),
    leaseDetails,
    leaseIdleTimeoutMs: WORKSPACE_LEASE_IDLE_TIMEOUT_MS,
    leaseWaitTimeoutMs: WORKSPACE_LEASE_WAIT_TIMEOUT_MS,
    title: WORKSPACE_GROUP_TITLE,
    color: WORKSPACE_GROUP_COLOR,
    collapsed: Boolean(state.group?.collapsed),
  };
}

function numericTabId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) {
    const error = new Error("tabId must be a Chrome tab id returned by chrome_tabs or chrome_open.");
    error.code = "CHROME_INVALID_TAB_ID";
    throw error;
  }
  return id;
}

async function getApprovedTab(tabId, compiled) {
  const id = numericTabId(tabId);
  const tab = await chrome.tabs.get(id);
  assertUrlAllowed(tab.url, compiled);
  await touchWorkspaceLease(id);
  return tab;
}

async function chatgptExtensionStatus() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  if (tabs.length === 0) {
    return {
      available: false,
      extensionId: CHATGPT_EXTENSION_ID,
      reason: "no-chatgpt-tab",
      pageBridgeAvailable: false,
    };
  }
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: async (requestEvent, responseEvent, statusAttribute, sidePanelAttribute) => {
          const root = document.documentElement;
          const pageBridgeAvailable = root.getAttribute(sidePanelAttribute) === "available";
          return await new Promise((resolve) => {
            let settled = false;
            const finish = (payload) => {
              if (settled) return;
              settled = true;
              window.removeEventListener(responseEvent, onResponse);
              resolve(payload);
            };
            const readState = () => {
              const raw = root.getAttribute(statusAttribute);
              if (!raw) return null;
              try { return JSON.parse(raw); } catch { return { raw }; }
            };
            const onResponse = () => finish({ available: true, pageBridgeAvailable, state: readState() });
            window.addEventListener(responseEvent, onResponse, { once: true });
            window.dispatchEvent(new Event(requestEvent));
            setTimeout(() => finish({ available: pageBridgeAvailable, pageBridgeAvailable, state: readState(), timedOut: true }), 1200);
          });
        },
        args: [CHATGPT_STATUS_REQUEST_EVENT, CHATGPT_STATUS_RESPONSE_EVENT, CHATGPT_STATUS_ATTRIBUTE, CHATGPT_SIDE_PANEL_ATTRIBUTE],
      });
      const value = result?.[0]?.result;
      if (value?.available || value?.pageBridgeAvailable) {
        return {
          ...value,
          extensionId: CHATGPT_EXTENSION_ID,
          tabId: tab.id,
          windowId: tab.windowId,
          tabActive: Boolean(tab.active),
          tabGroupId: Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null,
          url: tab.url || "",
        };
      }
    } catch {}
  }
  return {
    available: false,
    extensionId: CHATGPT_EXTENSION_ID,
    reason: "page-bridge-unavailable",
    pageBridgeAvailable: false,
    candidateTabs: tabs.length,
  };
}

async function pageInstallTaskMutationProbe() {
  const key = "__mdbTaskMutationProbeV1";
  if (window[key]?.installed) return { installed: true, alreadyInstalled: true };

  const state = {
    installed: true,
    records: [],
    originalFetch: window.fetch,
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
  };
  const sha256 = async (value) => {
    const text = String(value ?? "");
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes: bytes.length,
      sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
  };
  const sanitize = async (value, keyName = "root", depth = 0) => {
    if (depth > 10) return "<depth-limit>";
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/prompt|instruction|message|content/i.test(keyName)) return { value: "<redacted>", ...(await sha256(value)) };
      if (/cookie|token|authorization|credential|password|secret|email/i.test(keyName)) return "<redacted>";
      if (value.length > 1000) return { value: "<redacted-long>", ...(await sha256(value)) };
      return value;
    }
    if (Array.isArray(value)) {
      const out = [];
      for (let index = 0; index < Math.min(value.length, 100); index += 1) out.push(await sanitize(value[index], String(index), depth + 1));
      return out;
    }
    if (typeof value === "object") {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value).slice(0, 300)) {
        out[childKey] = await sanitize(childValue, childKey, depth + 1);
      }
      return out;
    }
    return `<${typeof value}>`;
  };
  const bodyText = async (input, init) => {
    if (typeof init?.body === "string") return init.body;
    if (init?.body instanceof URLSearchParams) return init.body.toString();
    if (init?.body instanceof Blob) return await init.body.text();
    if (input instanceof Request) {
      try { return await input.clone().text(); } catch {}
    }
    return "";
  };
  const capture = async (channel, url, method, rawBody) => {
    let parsed = rawBody;
    try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch {}
    const record = {
      channel,
      url: String(url),
      method: String(method || "GET").toUpperCase(),
      captured_at: new Date().toISOString(),
      body: await sanitize(parsed, "body"),
      body_digest: await sha256(rawBody || ""),
    };
    state.records.push(record);
    return record;
  };
  const shouldBlock = (url, method) => {
    const normalized = String(url || "");
    const verb = String(method || "GET").toUpperCase();
    return verb !== "GET" && /automation|scheduled|task/i.test(normalized);
  };

  window.fetch = async function(input, init = {}) {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method || (input instanceof Request ? input.method : "GET");
    if (shouldBlock(url, method)) {
      await capture("fetch", url, method, await bodyText(input, init));
      throw new Error("MDB_TASK_MUTATION_PROBE_BLOCKED");
    }
    return state.originalFetch.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__mdbTaskProbeRequest = { method, url };
    return state.originalXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = this.__mdbTaskProbeRequest || {};
    if (shouldBlock(request.url, request.method)) {
      void capture("xhr", request.url, request.method, typeof body === "string" ? body : "");
      queueMicrotask(() => {
        try { this.abort(); } catch {}
        try { this.dispatchEvent(new Event("error")); } catch {}
      });
      return;
    }
    return state.originalXhrSend.apply(this, arguments);
  };
  window[key] = state;
  return { installed: true, alreadyInstalled: false };
}

function pageReadTaskMutationProbe() {
  const state = window.__mdbTaskMutationProbeV1;
  return { installed: Boolean(state?.installed), records: state?.records || [] };
}

function pageRemoveTaskMutationProbe() {
  const key = "__mdbTaskMutationProbeV1";
  const state = window[key];
  if (!state?.installed) return { removed: false };
  window.fetch = state.originalFetch;
  XMLHttpRequest.prototype.open = state.originalXhrOpen;
  XMLHttpRequest.prototype.send = state.originalXhrSend;
  delete window[key];
  return { removed: true };
}



async function pagePrepareExactTaskEditor(expected, proposed) {
  const sha256 = async (value) => {
    const bytes = new TextEncoder().encode(String(value ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes: bytes.length,
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  };
  const findTask = (value, taskId, seen = new WeakSet(), depth = 0) => {
    if (depth > 14 || value == null || (typeof value !== "object" && typeof value !== "function")) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      if (String(value.id || value.task_id || value.automation_id || "") === taskId && typeof value.schedule === "string") {
        return value;
      }
    } catch {}
    let keys;
    try { keys = Reflect.ownKeys(value).filter((key) => typeof key === "string"); } catch { return null; }
    for (const key of keys.slice(0, 500)) {
      if (/cookie|token|authorization|credential|password|secret|email/i.test(key)) continue;
      let child;
      try { child = value[key]; } catch { continue; }
      const found = findTask(child, taskId, seen, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const titleField = document.querySelector('textarea[aria-label="Title"]');
  const promptField = document.querySelector('textarea[aria-label="Instructions"]');
  const repeatButton = document.querySelector('button[aria-label="Repeat"]');
  const endRepeatButton = document.querySelector('button[aria-label="End repeat"]');
  const saveButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === "Save");
  if (!(titleField instanceof HTMLTextAreaElement) || !(promptField instanceof HTMLTextAreaElement) || !repeatButton || !saveButton) {
    return { prepared: false, code: "task_editor_controls_missing" };
  }
  const roots = [titleField, promptField, repeatButton, endRepeatButton, document.body].filter(Boolean);
  let current = null;
  for (const root of roots) {
    for (const key of Object.keys(root)) {
      if (key.startsWith("__reactProps$") || key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) {
        current = findTask(root[key], expected.stable_id);
        if (current) break;
      }
    }
    if (current) break;
  }
  if (!current) return { prepared: false, code: "stable_task_not_found_in_editor" };
  const currentPromptDigest = await sha256(current.prompt || "");
  const identityChecks = {
    stable_id: String(current.id || current.task_id || current.automation_id || "") === expected.stable_id,
    conversation_id: String(current.conversation_id || "") === expected.conversation_id,
    title: current.title === expected.title,
    enabled: current.is_enabled === expected.enabled,
    executor: current.executor === expected.executor,
    timezone: current.default_timezone === expected.timezone,
    timing_mode: current.timing_mode === expected.timing_mode,
    work_mode: current.source_conversation_is_work_mode === expected.source_conversation_is_work_mode,
    prompt_bytes: currentPromptDigest.bytes === expected.prompt_bytes,
    prompt_sha256: currentPromptDigest.sha256 === expected.prompt_sha256,
    schedule: current.schedule === expected.schedule,
    last_run_time: current.last_run_time === expected.last_run_time,
  };
  const failedIdentityChecks = Object.entries(identityChecks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failedIdentityChecks.length > 0) {
    return { prepared: false, code: "identity_drift", failed_checks: failedIdentityChecks };
  }
  const proposedPromptDigest = await sha256(proposed.prompt || "");
  if (proposedPromptDigest.bytes !== proposed.prompt_bytes || proposedPromptDigest.sha256 !== proposed.prompt_sha256) {
    return { prepared: false, code: "proposed_prompt_digest_mismatch", proposed_prompt_digest: proposedPromptDigest };
  }
  if ((repeatButton.textContent || "").trim() !== proposed.native_repeat_label) {
    return {
      prepared: false,
      code: "native_repeat_not_ready",
      current_repeat_label: (repeatButton.textContent || "").trim(),
    };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return { prepared: false, code: "textarea_setter_missing" };
  const setReactTextarea = (element, value) => {
    setter.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  setReactTextarea(titleField, proposed.title);
  setReactTextarea(promptField, proposed.prompt);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const preparedTitleDigest = await sha256(titleField.value);
  const preparedPromptDigest = await sha256(promptField.value);
  const prepared =
    titleField.value === proposed.title &&
    preparedPromptDigest.bytes === proposed.prompt_bytes &&
    preparedPromptDigest.sha256 === proposed.prompt_sha256 &&
    (repeatButton.textContent || "").trim() === proposed.native_repeat_label &&
    (endRepeatButton?.textContent || "").trim() === "Never" &&
    !saveButton.disabled;
  return {
    prepared,
    code: prepared ? "ready" : "editor_state_mismatch",
    stable_id: expected.stable_id,
    conversation_id: expected.conversation_id,
    title_digest: preparedTitleDigest,
    prompt_digest: preparedPromptDigest,
    repeat_label: (repeatButton.textContent || "").trim(),
    end_repeat_label: (endRepeatButton?.textContent || "").trim(),
    save_enabled: !saveButton.disabled,
  };
}

async function pageInstallExactTaskSaveRewrite(expected, proposed) {
  const key = "__mdbExactTaskSaveRewriteV1";
  if (window[key]?.installed) {
    return { installed: true, already_installed: true, records: window[key].records || [] };
  }
  if (window.__mdbTaskMutationProbeV1?.installed) {
    return { installed: false, code: "mutation_probe_still_installed" };
  }
  const sha256 = async (value) => {
    const bytes = new TextEncoder().encode(String(value ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes: bytes.length,
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  };
  const state = {
    installed: true,
    installed_at: new Date().toISOString(),
    records: [],
    submission_seen: false,
    originalFetch: window.fetch,
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
  };
  const matchesEndpoint = (url, method) =>
    String(method || "GET").toUpperCase() === "POST" &&
    /\/backend-api\/automations\/save(?:\?|$)/.test(String(url || ""));
  const validateAndRewrite = async (rawBody, channel) => {
    if (state.submission_seen) {
      const record = { channel, at: new Date().toISOString(), submitted: false, code: "duplicate_submission_attempt" };
      state.records.push(record);
      return { ok: false, record };
    }
    let body;
    try { body = JSON.parse(String(rawBody || "")); } catch {
      const record = { channel, at: new Date().toISOString(), submitted: false, code: "invalid_json_body", body_digest: await sha256(rawBody || "") };
      state.records.push(record);
      return { ok: false, record };
    }
    const promptDigest = await sha256(body.prompt || "");
    const checks = {
      stable_id: body.jawbone_id === expected.stable_id,
      title: body.title === proposed.title,
      prompt_bytes: promptDigest.bytes === proposed.prompt_bytes,
      prompt_sha256: promptDigest.sha256 === proposed.prompt_sha256,
      native_schedule: body.schedule === proposed.native_schedule,
      timezone: body.default_timezone === expected.timezone,
      enabled: body.is_enabled === true,
      last_run_time: body.last_run_time === expected.last_run_time,
      timing_mode: body.timing_mode === 0,
    };
    const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failedChecks.length > 0) {
      const record = {
        channel,
        at: new Date().toISOString(),
        submitted: false,
        code: "native_payload_mismatch",
        failed_checks: failedChecks,
        body_digest: await sha256(rawBody || ""),
        prompt_digest: promptDigest,
        schedule_digest: await sha256(body.schedule || ""),
      };
      state.records.push(record);
      return { ok: false, record };
    }
    body.schedule = proposed.schedule;
    const rewrittenBody = JSON.stringify(body);
    const rewrittenScheduleDigest = await sha256(body.schedule);
    if (
      rewrittenScheduleDigest.bytes !== proposed.schedule_bytes ||
      rewrittenScheduleDigest.sha256 !== proposed.schedule_sha256
    ) {
      const record = {
        channel,
        at: new Date().toISOString(),
        submitted: false,
        code: "rewritten_schedule_digest_mismatch",
        schedule_digest: rewrittenScheduleDigest,
      };
      state.records.push(record);
      return { ok: false, record };
    }
    state.submission_seen = true;
    const record = {
      channel,
      at: new Date().toISOString(),
      submitted: true,
      code: "submitted_once",
      original_request_digest: await sha256(rawBody || ""),
      rewritten_request_digest: await sha256(rewrittenBody),
      prompt_digest: promptDigest,
      schedule_digest: rewrittenScheduleDigest,
      response: null,
    };
    state.records.push(record);
    return { ok: true, rewrittenBody, record };
  };
  const captureResponse = async (record, response) => {
    try {
      const clone = response.clone();
      const text = await clone.text();
      record.response = {
        status: response.status,
        ok: response.ok,
        digest: await sha256(text),
      };
    } catch (error) {
      record.response = { status: response?.status ?? null, ok: response?.ok ?? false, error: String(error?.message || error) };
    }
  };
  window.fetch = async function(input, init = {}) {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method || (input instanceof Request ? input.method : "GET");
    if (!matchesEndpoint(url, method)) return state.originalFetch.apply(this, arguments);
    let rawBody = "";
    if (typeof init.body === "string") rawBody = init.body;
    else if (input instanceof Request) {
      try { rawBody = await input.clone().text(); } catch {}
    }
    const checked = await validateAndRewrite(rawBody, "fetch");
    if (!checked.ok) throw new Error(`MDB_EXACT_TASK_SAVE_BLOCKED:${checked.record.code}`);
    let response;
    if (input instanceof Request) {
      const request = new Request(input, { ...init, body: checked.rewrittenBody });
      response = await state.originalFetch.call(this, request);
    } else {
      response = await state.originalFetch.call(this, input, { ...init, body: checked.rewrittenBody });
    }
    void captureResponse(checked.record, response);
    return response;
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__mdbExactTaskSaveRequest = { method, url };
    return state.originalXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = this.__mdbExactTaskSaveRequest || {};
    if (!matchesEndpoint(request.url, request.method)) return state.originalXhrSend.apply(this, arguments);
    void (async () => {
      const checked = await validateAndRewrite(typeof body === "string" ? body : "", "xhr");
      if (!checked.ok) {
        try { this.abort(); } catch {}
        try { this.dispatchEvent(new Event("error")); } catch {}
        return;
      }
      this.addEventListener("loadend", async () => {
        checked.record.response = {
          status: this.status,
          ok: this.status >= 200 && this.status < 300,
          digest: await sha256(this.responseText || ""),
        };
      }, { once: true });
      state.originalXhrSend.call(this, checked.rewrittenBody);
    })();
  };
  window[key] = state;
  return { installed: true, already_installed: false, installed_at: state.installed_at };
}

function pageReadExactTaskSaveRewrite() {
  const state = window.__mdbExactTaskSaveRewriteV1;
  if (!state?.installed) return { installed: false, records: [] };
  return {
    installed: true,
    installed_at: state.installed_at,
    submission_seen: Boolean(state.submission_seen),
    records: state.records || [],
  };
}

function pageRemoveExactTaskSaveRewrite() {
  const key = "__mdbExactTaskSaveRewriteV1";
  const state = window[key];
  if (!state?.installed) return { removed: false };
  window.fetch = state.originalFetch;
  XMLHttpRequest.prototype.open = state.originalXhrOpen;
  XMLHttpRequest.prototype.send = state.originalXhrSend;
  delete window[key];
  return { removed: true };
}

async function pageExactTaskSave(expected, proposed) {
  if (window.__mdbTaskMutationProbeV1?.installed) {
    return { submitted: false, code: "mutation_probe_still_installed" };
  }
  const sha256 = async (value) => {
    const bytes = new TextEncoder().encode(String(value ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      bytes: bytes.length,
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  };
  const sanitize = async (value, key = "root", depth = 0) => {
    if (depth > 8) return "<depth-limit>";
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/prompt|instruction|message|content/i.test(key)) {
        return { value: "<redacted>", ...(await sha256(value)) };
      }
      if (/cookie|token|authorization|credential|password|secret|email|user|account/i.test(key)) {
        return "<redacted>";
      }
      if (value.length > 500) return { value: "<redacted-long>", ...(await sha256(value)) };
      return value;
    }
    if (Array.isArray(value)) {
      const out = [];
      for (let index = 0; index < Math.min(value.length, 100); index += 1) {
        out.push(await sanitize(value[index], String(index), depth + 1));
      }
      return out;
    }
    if (typeof value === "object") {
      const out = {};
      for (const [childKey, child] of Object.entries(value).slice(0, 300)) {
        out[childKey] = await sanitize(child, childKey, depth + 1);
      }
      return out;
    }
    return `<${typeof value}>`;
  };
  const findTask = (value, taskId, seen = new WeakSet(), depth = 0) => {
    if (depth > 14 || value == null || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (String(value.id || value.task_id || value.automation_id || "") === taskId && typeof value.schedule === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 500)) {
        const found = findTask(child, taskId, seen, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value).slice(0, 500)) {
      if (/cookie|token|authorization|credential|password|secret|email/i.test(key)) continue;
      const found = findTask(child, taskId, seen, depth + 1);
      if (found) return found;
    }
    return null;
  };

  let inventoryResponse;
  let inventoryText;
  let inventory;
  try {
    inventoryResponse = await fetch("/backend-api/automations?filter=scheduled", {
      credentials: "same-origin",
      cache: "no-store",
    });
    inventoryText = await inventoryResponse.text();
    inventory = JSON.parse(inventoryText);
  } catch (error) {
    return {
      submitted: false,
      code: "read_only_inventory_failed",
      error: String(error?.message || error),
    };
  }
  if (!inventoryResponse.ok) {
    return {
      submitted: false,
      code: "read_only_inventory_http_error",
      inventory_status: inventoryResponse.status,
      inventory_digest: await sha256(inventoryText || ""),
    };
  }
  const current = findTask(inventory, expected.stable_id);
  if (!current) {
    return {
      submitted: false,
      code: "stable_task_not_found",
      inventory_digest: await sha256(inventoryText || ""),
    };
  }
  const currentPromptDigest = await sha256(current.prompt || "");
  const checks = {
    stable_id: String(current.id || current.task_id || current.automation_id || "") === expected.stable_id,
    conversation_id: String(current.conversation_id || "") === expected.conversation_id,
    title: current.title === expected.title,
    enabled: current.is_enabled === expected.enabled,
    executor: current.executor === expected.executor,
    timezone: current.default_timezone === expected.timezone,
    timing_mode: current.timing_mode === expected.timing_mode,
    work_mode: current.source_conversation_is_work_mode === expected.source_conversation_is_work_mode,
    prompt_bytes: currentPromptDigest.bytes === expected.prompt_bytes,
    prompt_sha256: currentPromptDigest.sha256 === expected.prompt_sha256,
    schedule: current.schedule === expected.schedule,
    last_run_time: current.last_run_time === expected.last_run_time,
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failedChecks.length > 0) {
    return {
      submitted: false,
      code: "identity_drift",
      failed_checks: failedChecks,
      current: {
        stable_id: String(current.id || current.task_id || current.automation_id || ""),
        conversation_id: current.conversation_id || null,
        title: current.title || null,
        enabled: current.is_enabled,
        executor: current.executor || null,
        timezone: current.default_timezone || null,
        timing_mode: current.timing_mode || null,
        source_conversation_is_work_mode: current.source_conversation_is_work_mode,
        prompt_digest: currentPromptDigest,
        schedule_digest: await sha256(current.schedule || ""),
        last_run_time: current.last_run_time || null,
      },
    };
  }
  const proposedPromptDigest = await sha256(proposed.prompt || "");
  if (
    proposedPromptDigest.bytes !== proposed.prompt_bytes ||
    proposedPromptDigest.sha256 !== proposed.prompt_sha256
  ) {
    return {
      submitted: false,
      code: "proposed_prompt_digest_mismatch",
      proposed_prompt_digest: proposedPromptDigest,
    };
  }
  const proposedScheduleDigest = await sha256(proposed.schedule || "");
  if (
    proposedScheduleDigest.bytes !== proposed.schedule_bytes ||
    proposedScheduleDigest.sha256 !== proposed.schedule_sha256
  ) {
    return {
      submitted: false,
      code: "proposed_schedule_digest_mismatch",
      proposed_schedule_digest: proposedScheduleDigest,
    };
  }
  const payload = {
    default_timezone: expected.timezone,
    email_enabled: Boolean(current.email_enabled),
    is_enabled: true,
    jawbone_id: expected.stable_id,
    last_run_time: expected.last_run_time,
    notifications_enabled: Boolean(current.notifications_enabled),
    prompt: proposed.prompt,
    schedule: proposed.schedule,
    timing_mode: 0,
    title: proposed.title,
  };
  const requestBody = JSON.stringify(payload);
  const requestDigest = await sha256(requestBody);
  const submittedAt = new Date().toISOString();
  let response;
  try {
    response = await fetch("/backend-api/automations/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
  } catch (error) {
    return {
      submitted: true,
      reconciled: false,
      uncertain: true,
      code: "save_transport_uncertain",
      submitted_at: submittedAt,
      request_digest: requestDigest,
      error: String(error?.message || error),
    };
  }
  const responseText = await response.text();
  let responseJson = null;
  try { responseJson = JSON.parse(responseText); } catch {}
  return {
    submitted: true,
    reconciled: false,
    uncertain: false,
    submitted_at: submittedAt,
    endpoint: "/backend-api/automations/save",
    response_status: response.status,
    response_ok: response.ok,
    request_digest: requestDigest,
    response_digest: await sha256(responseText),
    response: responseJson == null ? null : await sanitize(responseJson),
  };
}

async function pageTaskAudit() {
  const result = {
    title: document.title,
    url: location.href,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scripts: [...document.scripts].map((script) => script.src).filter(Boolean).slice(0, 200),
    resources: performance.getEntriesByType("resource")
      .map((entry) => String(entry.name || ""))
      .filter((name) => /task|sched|backend-api|conversation|rrule|recurr/i.test(name))
      .slice(-300),
    dialogs: [],
    taskScalars: [],
  };

  const redactText = (value) => {
    const text = String(value ?? "");
    if (text.length > 180 || /Run the four-week ChatGPT shadow review/i.test(text)) {
      return `<redacted:${new TextEncoder().encode(text).length}-bytes>`;
    }
    return text;
  };

  for (const dialog of document.querySelectorAll('[role="dialog"], [data-radix-dialog-content], form')) {
    const rect = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
    result.dialogs.push({
      tag: dialog.tagName.toLowerCase(),
      role: dialog.getAttribute("role"),
      attrs: Object.fromEntries([...dialog.attributes]
        .filter((attr) => /^(aria-|data-|id$|name$|role$)/.test(attr.name))
        .map((attr) => [attr.name, redactText(attr.value)])),
      controls: [...dialog.querySelectorAll('input,textarea,select,button,[role],[data-state],[data-radix-collection-item]')]
        .slice(0, 500)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          ariaControls: el.getAttribute('aria-controls'),
          dataState: el.getAttribute('data-state'),
          dataValue: el.getAttribute('data-value'),
          name: el.getAttribute('name'),
          type: el.getAttribute('type'),
          value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
            ? (/password/i.test(el.type || '') ? '<redacted>' : redactText(el.value))
            : null,
          text: redactText((el.innerText || el.textContent || '').trim()),
          attrs: Object.fromEntries([...el.attributes]
            .filter((attr) => /^(aria-|data-|id$|name$|role$|type$|value$)/.test(attr.name))
            .map((attr) => [attr.name, redactText(attr.value)])),
        })),
    });
  }

  const roots = [
    document.querySelector('textarea[aria-label="Title"]'),
    document.querySelector('textarea[aria-label="Instructions"]'),
    document.querySelector('button[aria-label="Repeat"]'),
    document.querySelector('button[aria-label="End repeat"]'),
    document.body,
  ].filter(Boolean);
  const seen = new WeakSet();
  const matches = [];
  const scalarPattern = /^(id|taskId|task_id|title|enabled|isEnabled|status|timezone|timeZone|dtstart|dtStart|rrule|recurrence|schedule|frequency|nextRun|next_run|nextRunAt|next_run_at|lastRun|last_run|lastRunAt|last_run_at|model|effort|reasoning|conversationId|conversation_id|promptHash|prompt_hash)$/i;
  const valuePattern = /(RRULE:|DTSTART|FREQ=|America\/Los_Angeles|6a6d78b3cc4481918c46a00c9f8c1e63|6a6d7525-d190-83e8-acb0-53e73384fb54|Mato Strategy Review|Sep 4)/i;
  const walk = (value, path, depth) => {
    if (matches.length >= 1000 || depth > 10 || value == null) return;
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
      const key = path.split('.').pop() || '';
      const text = String(value);
      if (scalarPattern.test(key) || valuePattern.test(text)) {
        matches.push({ path, value: redactText(text) });
      }
      return;
    }
    if ((kind !== 'object' && kind !== 'function') || seen.has(value)) return;
    seen.add(value);
    let keys;
    try { keys = Reflect.ownKeys(value).filter((key) => typeof key === 'string'); } catch { return; }
    for (const key of keys.slice(0, 300)) {
      if (/cookie|token|authorization|credential|password|secret|email|prompt|instruction|message|content/i.test(key)) continue;
      let next;
      try { next = value[key]; } catch { continue; }
      walk(next, `${path}.${key}`, depth + 1);
    }
  };
  for (const root of roots) {
    for (const key of Object.keys(root)) {
      if (key.startsWith('__reactProps$') || key.startsWith('__reactFiber$') || key.startsWith('__reactContainer$')) {
        walk(root[key], `react.${key}`, 0);
      }
    }
  }
  result.menus = [...document.querySelectorAll('[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="listbox"]')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    text: (el.innerText || el.textContent || '').trim(),
    id: el.id || null,
    ariaLabel: el.getAttribute('aria-label'),
    ariaChecked: el.getAttribute('aria-checked'),
    dataState: el.getAttribute('data-state'),
    dataValue: el.getAttribute('data-value'),
    rect: (() => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })(),
  }));

  result.taskScalars = matches;

  const sha256 = async (text) => {
    const bytes = new TextEncoder().encode(String(text ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { bytes: bytes.length, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
  };
  const sensitiveKey = /cookie|token|authorization|credential|password|secret|email|user|account|prompt|instruction|message|content/i;
  const safeScalarKey = /^(id|task_id|automation_id|title|enabled|is_enabled|status|state|timezone|default_timezone|schedule|rrule|dtstart|conversation_id|created_at|updated_at|next_run|next_run_at|next_execution|next_execution_at|last_run|last_run_at|last_execution|last_execution_at|model|model_slug|effort|reasoning_effort|is_recurring|finished|paused)$/i;
  const summarize = async (value, path = "root", depth = 0, out = []) => {
    if (out.length >= 2000 || depth > 10 || value == null) return out;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const key = path.split('.').pop() || '';
      const text = String(value);
      if (/prompt|instruction|message|content/i.test(key)) {
        out.push({ path, ...(await sha256(text)), value: "<redacted>" });
      } else if (safeScalarKey.test(key) || valuePattern.test(text)) {
        out.push({ path, value: redactText(text) });
      }
      return out;
    }
    if (typeof value !== "object") return out;
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 200); i += 1) await summarize(value[i], `${path}.${i}`, depth + 1, out);
      return out;
    }
    for (const [key, next] of Object.entries(value).slice(0, 400)) {
      if (sensitiveKey.test(key) && !/prompt|instruction|message|content/i.test(key)) continue;
      await summarize(next, `${path}.${key}`, depth + 1, out);
    }
    return out;
  };
  result.api = [];
  for (const endpoint of [
    "/backend-api/automation/6a6d78b3cc4481918c46a00c9f8c1e63",
    "/backend-api/automations?filter=scheduled",
  ]) {
    try {
      const response = await fetch(endpoint, { credentials: "same-origin" });
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      result.api.push({
        endpoint,
        status: response.status,
        ok: response.ok,
        responseBytes: new TextEncoder().encode(text).length,
        topLevelKeys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 200) : null,
        safeScalars: parsed == null ? [] : await summarize(parsed),
      });
    } catch (error) {
      result.api.push({ endpoint, error: String(error?.message || error) });
    }
  }
  const taskId = "6a6d78b3cc4481918c46a00c9f8c1e63";
  let taskObject = null;
  const findSeen = new WeakSet();
  const findTask = (value, depth = 0) => {
    if (taskObject || depth > 14 || value == null || (typeof value !== "object" && typeof value !== "function")) return;
    if (findSeen.has(value)) return;
    findSeen.add(value);
    try {
      if (String(value.id || value.task_id || value.automation_id || "") === taskId && typeof value.schedule === "string") {
        taskObject = value;
        return;
      }
    } catch {}
    let keys;
    try { keys = Reflect.ownKeys(value).filter((key) => typeof key === "string"); } catch { return; }
    for (const key of keys.slice(0, 500)) {
      if (/cookie|token|authorization|credential|password|secret|email/i.test(key)) continue;
      let next;
      try { next = value[key]; } catch { continue; }
      findTask(next, depth + 1);
      if (taskObject) return;
    }
  };
  for (const root of roots) {
    for (const key of Object.keys(root)) {
      if (key.startsWith("__reactProps$") || key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) {
        findTask(root[key]);
      }
    }
  }
  const sanitizeTask = async (value, key = "root", depth = 0, localSeen = new WeakSet()) => {
    if (depth > 8 || value == null) return value == null ? null : `<depth:${depth}>`;
    const kind = typeof value;
    if (kind === "string") {
      if (/prompt|instruction|message|content/i.test(key)) return { value: "<redacted>", ...(await sha256(value)) };
      if (value.length > 500) return { value: "<redacted-long>", ...(await sha256(value)) };
      return value;
    }
    if (kind === "number" || kind === "boolean") return value;
    if (kind !== "object") return `<${kind}>`;
    if (localSeen.has(value)) return "<cycle>";
    localSeen.add(value);
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < Math.min(value.length, 100); i += 1) out.push(await sanitizeTask(value[i], String(i), depth + 1, localSeen));
      return out;
    }
    const out = {};
    for (const [childKey, child] of Object.entries(value).slice(0, 300)) {
      if (/cookie|token|authorization|credential|password|secret|email|user|account/i.test(childKey)) continue;
      out[childKey] = await sanitizeTask(child, childKey, depth + 1, localSeen);
    }
    return out;
  };
  result.automationObjectFound = Boolean(taskObject);
  result.automationObjectKeys = taskObject ? Object.keys(taskObject) : [];
  result.automationObject = taskObject ? await sanitizeTask(taskObject) : null;
  return result;
}

async function pageChatgptRuntimeInventory() {
  const MAX_CANDIDATES = 300;
  const MAX_MODULES = 30_000;
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  if (location.origin !== "https://chatgpt.com") {
    return fail("CHATGPT_TAB_UNAVAILABLE", "The selected tab is not a chatgpt.com page.");
  }

  const sha256 = async (value) => {
    const bytes = new TextEncoder().encode(String(value ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const actionNamePattern = /send|submit|start|create|continue|conversation|message|prompt|turn|completion|dispatch|mutate/i;
  const sourceSignalPatterns = [
    ["conversation-endpoint", /backend-api\/(?:f\/)?conversation/i],
    ["chat-requirements", /chat[-_/]?requirements|sentinel|turnstile|arkose/i],
    ["conversation-action", /conversation|parent_message_id|thinking_effort|client_prepare_state/i],
    ["submit-action", /submit|sendMessage|send_message|createConversation|create_conversation/i],
  ];
  const sensitiveKey = /cookie|token|authorization|credential|password|secret|email|account|access.?token|device.?id/i;
  const candidates = [];
  const seenFunctions = new WeakSet();

  const addFunction = async (kind, moduleId, path, value) => {
    if (candidates.length >= MAX_CANDIDATES || typeof value !== "function" || seenFunctions.has(value)) return;
    seenFunctions.add(value);
    let source = "";
    try { source = Function.prototype.toString.call(value); } catch {}
    const signals = sourceSignalPatterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
    if (!actionNamePattern.test(path) && signals.length === 0) return;
    const sourcePreview = source
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .slice(0, signals.length > 0 ? 1200 : 360);
    candidates.push({
      kind,
      module_id: moduleId == null ? null : String(moduleId),
      path: String(path).slice(0, 500),
      name: String(value.name || "").slice(0, 200),
      arity: Number(value.length || 0),
      signals,
      source_sha256: await sha256(source),
      source_preview: sourcePreview,
    });
  };

  const walk = async (kind, moduleId, root, rootPath, maxDepth = 4) => {
    const seen = new WeakSet();
    const visit = async (value, path, depth) => {
      if (candidates.length >= MAX_CANDIDATES || value == null || depth > maxDepth) return;
      if (typeof value === "function") await addFunction(kind, moduleId, path, value);
      if ((typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
      seen.add(value);
      let descriptors;
      try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return; }
      for (const [key, descriptor] of Object.entries(descriptors).slice(0, 250)) {
        if (sensitiveKey.test(key) || !("value" in descriptor)) continue;
        await visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    };
    await visit(root, rootPath, 0);
  };

  const bundlers = [];
  let webpackRequire = null;
  for (const key of Object.getOwnPropertyNames(globalThis).filter((name) => /webpack.*chunk|chunk.*webpack/i.test(name)).slice(0, 20)) {
    const chunkArray = globalThis[key];
    if (!Array.isArray(chunkArray) || typeof chunkArray.push !== "function") continue;
    const entry = { global: key, chunks: chunkArray.length, runtime_acquired: false };
    if (!webpackRequire) {
      try {
        const syntheticId = `mdb-runtime-inventory-${crypto.randomUUID()}`;
        chunkArray.push([[syntheticId], {}, (runtime) => { webpackRequire = runtime; }]);
        entry.runtime_acquired = typeof webpackRequire === "function" || typeof webpackRequire === "object";
      } catch (error) {
        entry.error = String(error?.message || error).slice(0, 300);
      }
    }
    bundlers.push(entry);
  }

  let cachedModuleCount = 0;
  let factoryModuleCount = 0;
  const factoryCandidates = [];
  if (webpackRequire) {
    const cache = webpackRequire.c && typeof webpackRequire.c === "object" ? webpackRequire.c : {};
    const cacheEntries = Object.entries(cache).slice(0, MAX_MODULES);
    cachedModuleCount = cacheEntries.length;
    for (const [moduleId, moduleRecord] of cacheEntries) {
      if (candidates.length >= MAX_CANDIDATES) break;
      await walk("webpack-export", moduleId, moduleRecord?.exports, `module.${moduleId}.exports`);
    }

    const factories = webpackRequire.m && typeof webpackRequire.m === "object" ? webpackRequire.m : {};
    const factoryEntries = Object.entries(factories).slice(0, MAX_MODULES);
    factoryModuleCount = factoryEntries.length;
    for (const [moduleId, factory] of factoryEntries) {
      if (factoryCandidates.length >= 200 || typeof factory !== "function") break;
      let source = "";
      try { source = Function.prototype.toString.call(factory); } catch {}
      const signals = sourceSignalPatterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
      if (signals.length === 0) continue;
      factoryCandidates.push({
        module_id: String(moduleId),
        signals,
        source_sha256: await sha256(source),
        source_preview: source.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").slice(0, 1400),
      });
    }
  }

  const reactRoots = [
    document.querySelector("#prompt-textarea"),
    document.querySelector('[contenteditable="true"][data-testid*="composer"]'),
    document.querySelector('form textarea'),
    document.querySelector('main'),
    document.body,
  ].filter(Boolean);
  for (const [index, root] of reactRoots.entries()) {
    for (const key of Object.keys(root)) {
      if (!key.startsWith("__reactProps$") && !key.startsWith("__reactFiber$") && !key.startsWith("__reactContainer$")) continue;
      await walk("react-runtime", null, root[key], `react.${index}.${key}`, 8);
    }
  }

  const fiberChain = [];
  const composerRoot = reactRoots.find((root) => Object.keys(root)
    .some((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"))) || null;
  const composerFiberKey = composerRoot
    ? Object.keys(composerRoot).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"))
    : null;
  let fiber = composerFiberKey ? composerRoot[composerFiberKey] : null;
  let rootFiber = fiber;
  for (let depth = 0; fiber && depth < 120; depth += 1, fiber = fiber.return) {
    rootFiber = fiber;
    const type = fiber.elementType || fiber.type;
    const typeName = typeof type === "function"
      ? String(type.displayName || type.name || "")
      : typeof type === "string"
        ? type
        : "";
    const props = fiber.memoizedProps && typeof fiber.memoizedProps === "object" ? fiber.memoizedProps : null;
    const propKeys = props ? Object.keys(props).filter((key) => !sensitiveKey.test(key)).slice(0, 250) : [];
    const safeProps = {};
    if (props) {
      for (const key of ["currentModelId", "isNewThread", "isCompletionInProgress", "submitPending", "disabled", "commitComposerStateOnSubmit"]) {
        const value = Object.getOwnPropertyDescriptor(props, key)?.value;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) safeProps[key] = value;
      }
    }
    const actionProps = [];
    if (props) {
      for (const key of propKeys) {
        if (!actionNamePattern.test(key)) continue;
        const value = Object.getOwnPropertyDescriptor(props, key)?.value;
        if (typeof value !== "function") continue;
        let source = "";
        try { source = Function.prototype.toString.call(value); } catch {}
        actionProps.push({
          key,
          name: String(value.name || "").slice(0, 200),
          arity: Number(value.length || 0),
          source_sha256: await sha256(source),
          source_preview: source.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").slice(0, 1600),
        });
        await addFunction("react-prop", null, `fiber.${depth}.memoizedProps.${key}`, value);
      }
    }
    const hookCandidates = [];
    let hook = fiber.memoizedState;
    for (let hookIndex = 0; hook && hookIndex < 180; hookIndex += 1, hook = hook.next) {
      for (const [slot, value] of [["memoizedState", hook.memoizedState], ["baseState", hook.baseState]]) {
        if (typeof value === "function") {
          let source = "";
          try { source = Function.prototype.toString.call(value); } catch {}
          const signals = sourceSignalPatterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
          if (signals.length > 0 || actionNamePattern.test(String(value.name || ""))) {
            hookCandidates.push({
              hook_index: hookIndex,
              slot,
              name: String(value.name || "").slice(0, 200),
              arity: Number(value.length || 0),
              signals,
              source_sha256: await sha256(source),
              source_preview: source.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").slice(0, 1600),
            });
          }
        }
      }
    }
    let typeSourceSha256 = null;
    const typeSourceExcerpts = [];
    if (typeof type === "function" && propKeys.some((key) => actionNamePattern.test(key))) {
      let typeSource = "";
      try { typeSource = Function.prototype.toString.call(type); } catch {}
      typeSourceSha256 = await sha256(typeSource);
      for (const needle of ["onRequestCompletion", "onCreateNewCompletion", "onComposerSubmit", "commitComposerStateOnSubmit", "onSubmit", "timeStamp"]) {
        const index = typeSource.indexOf(needle);
        if (index < 0) continue;
        typeSourceExcerpts.push({
          needle,
          excerpt: typeSource
            .slice(Math.max(0, index - 900), Math.min(typeSource.length, index + needle.length + 1800))
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s{2,}/g, " ")
            .slice(0, 2800),
        });
      }
    }
    fiberChain.push({
      depth,
      tag: Number(fiber.tag),
      key: fiber.key == null ? null : String(fiber.key).slice(0, 200),
      type_name: typeName.slice(0, 200),
      prop_keys: propKeys,
      safe_props: safeProps,
      action_props: actionProps,
      hook_candidates: hookCandidates,
      type_source_sha256: typeSourceSha256,
      type_source_excerpts: typeSourceExcerpts,
    });
  }

  const submitCandidates = [];
  const seenSubmitFunctions = new WeakSet();
  const addSubmitCandidate = async (value, path, typeName, sharedPropsKeys = []) => {
    if (typeof value !== "function" || seenSubmitFunctions.has(value) || submitCandidates.length >= 50) return;
    seenSubmitFunctions.add(value);
    let source = "";
    try { source = Function.prototype.toString.call(value); } catch {}
    submitCandidates.push({
      path: String(path).slice(0, 700),
      owner_type_name: String(typeName || "").slice(0, 200),
      name: String(value.name || "").slice(0, 200),
      arity: Number(value.length || 0),
      shared_props_keys: sharedPropsKeys.filter((key) => !sensitiveKey.test(key)).slice(0, 250),
      source_sha256: await sha256(source),
      source_preview: source.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").slice(0, 1800),
    });
  };
  const inspectedContainers = new WeakSet();
  const inspectContainer = async (value, path, typeName, depth = 0) => {
    if (value == null || depth > 5 || (typeof value !== "object" && typeof value !== "function") || inspectedContainers.has(value)) return;
    inspectedContainers.add(value);
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return; }
    for (const [key, descriptor] of Object.entries(descriptors).slice(0, 300)) {
      if (sensitiveKey.test(key) || !("value" in descriptor)) continue;
      const child = descriptor.value;
      if (key === "submitComposer" && typeof child === "function") {
        await addSubmitCandidate(child, `${path}.submitComposer`, typeName);
        continue;
      }
      if (key === "getSharedProps" && typeof child === "function") {
        try {
          const shared = child.call(value);
          if (shared && typeof shared === "object") {
            const submit = Object.getOwnPropertyDescriptor(shared, "submitComposer")?.value;
            if (typeof submit === "function") {
              await addSubmitCandidate(submit, `${path}.getSharedProps().submitComposer`, typeName, Object.keys(shared));
            }
          }
        } catch {}
        continue;
      }
      if (depth < 5 && /store|composer|bridge|shared|controller|state|current/i.test(key)) {
        await inspectContainer(child, `${path}.${key}`, typeName, depth + 1);
      }
    }
  };
  const seenFibers = new Set();
  const fiberStack = rootFiber ? [rootFiber] : [];
  let traversedFiberCount = 0;
  while (fiberStack.length > 0 && traversedFiberCount < 50_000 && submitCandidates.length < 50) {
    const current = fiberStack.pop();
    if (!current || seenFibers.has(current)) continue;
    seenFibers.add(current);
    traversedFiberCount += 1;
    const type = current.elementType || current.type;
    const typeName = typeof type === "function"
      ? String(type.displayName || type.name || "")
      : typeof type === "string"
        ? type
        : "";
    await inspectContainer(current.memoizedProps, `fiberTree.${traversedFiberCount}.memoizedProps`, typeName);
    let hook = current.memoizedState;
    for (let hookIndex = 0; hook && hookIndex < 200; hookIndex += 1, hook = hook.next) {
      await inspectContainer(hook.memoizedState, `fiberTree.${traversedFiberCount}.hook.${hookIndex}.memoizedState`, typeName);
      await inspectContainer(hook.baseState, `fiberTree.${traversedFiberCount}.hook.${hookIndex}.baseState`, typeName);
    }
    if (current.sibling) fiberStack.push(current.sibling);
    if (current.child) fiberStack.push(current.child);
  }

  return {
    ok: true,
    title: document.title,
    url: location.href,
    scripts: [...document.scripts].map((script) => String(script.src || "")).filter(Boolean).slice(-250),
    bundlers,
    cached_module_count: cachedModuleCount,
    factory_module_count: factoryModuleCount,
    candidates,
    factory_candidates: factoryCandidates,
    fiber_chain: fiberChain,
    traversed_fiber_count: traversedFiberCount,
    submit_candidates: submitCandidates,
    rendered_assistant_messages: [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .slice(-20)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        class_name: String(element.className || "").slice(0, 500),
        data_testid: element.getAttribute("data-testid"),
        text: String(element.innerText || element.textContent || "").trim().slice(0, 100_000),
      })),
  };
}

async function pageChatgptPersistedAssistantRead(input) {
  const MAX_ASSISTANT_TEXT_CHARS = 100_000;
  const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
  const conversationId = String(input?.conversationId || "");
  const assistantMessageId = input?.assistantMessageId == null ? null : String(input.assistantMessageId);
  const timeoutMs = Math.max(1_000, Math.min(30_000, Number(input?.timeoutMs || 15_000)));
  if (location.origin !== "https://chatgpt.com") {
    return fail("CHATGPT_TAB_UNAVAILABLE", "The selected tab is not a chatgpt.com page.");
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(conversationId)) {
    return fail("CHATGPT_CONVERSATION_ID_INVALID", "The ChatGPT conversation id is invalid.");
  }
  const currentConversationMatch = location.pathname.match(/^\/c\/([^/?#]+)/)
    || location.pathname.match(/^\/g\/[^/]+\/c\/([^/?#]+)/);
  if (currentConversationMatch?.[1] !== conversationId) {
    return fail(
      "CHATGPT_RUNTIME_CONVERSATION_MISMATCH",
      "The reloaded ChatGPT page does not match the completed conversation.",
      { expected_conversation_id: conversationId, current_conversation_id: currentConversationMatch?.[1] || null },
    );
  }

  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableReads = 0;
  while (Date.now() < deadline) {
    const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const latest = assistantMessageId === null
      ? assistantNodes.at(-1)
      : assistantNodes.find((node) => node.closest?.('[data-message-id]')?.getAttribute?.("data-message-id") === assistantMessageId);
    const currentMessageId = latest?.closest?.('[data-message-id]')?.getAttribute?.("data-message-id") || null;
    const assistantText = String(latest?.innerText || latest?.textContent || "").trim();
    if (assistantText.length > MAX_ASSISTANT_TEXT_CHARS) {
      return fail("CHATGPT_CONVERSATION_OUTPUT_LIMIT", "The persisted assistant response exceeded the configured output limit.");
    }
    if (assistantText && assistantText === lastText) stableReads += 1;
    else {
      lastText = assistantText;
      stableReads = assistantText ? 1 : 0;
    }
    const generating = [...document.querySelectorAll(
      'button[data-testid*="stop"], button[aria-label*="Stop generating"], button[aria-label*="Stop streaming"]',
    )].some((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (document.readyState === "complete" && assistantText && stableReads >= 2 && !generating) {
      return {
        ok: true,
        complete: true,
        conversation_id: conversationId,
        assistant_message_id: currentMessageId,
        assistant_text: assistantText,
        persisted_response_bytes: new TextEncoder().encode(assistantText).length,
        observation_source: "persisted-conversation",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return fail(
    "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN",
    "The completed ChatGPT conversation did not expose its persisted assistant message after reload.",
    { conversation_id: conversationId, assistant_message_id: assistantMessageId },
  );
}

async function pageChatgptRuntimeConversationStart(input) {
  const MAX_PROMPT_BYTES = 4_000_000;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_EVENTS = 2_000;
  const MAX_ASSISTANT_TEXT_CHARS = 100_000;
  const maxRuntimeSeconds = Math.max(30, Math.min(3600, Number(input?.maxRuntimeSeconds || 600)));
  const REQUEST_TIMEOUT_MS = maxRuntimeSeconds * 1000;
  const RUNTIME_READY_TIMEOUT_MS = 20_000;
  const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
  const prompt = String(input?.prompt || "");
  const model = String(input?.model || "gpt-5-6-pro");
  const thinkingEffort = String(input?.thinkingEffort || "standard");
  const projectId = input?.projectId == null ? null : String(input.projectId);
  const expectedConversationId = input?.conversationId == null ? null : String(input.conversationId);
  const promptBytes = new TextEncoder().encode(prompt).length;

  if (location.origin !== "https://chatgpt.com") {
    return fail("CHATGPT_TAB_UNAVAILABLE", "The selected tab is not a chatgpt.com page.");
  }
  if (!prompt || promptBytes > MAX_PROMPT_BYTES) {
    return fail("CHATGPT_PROMPT_INVALID", `The prompt must be between 1 and ${MAX_PROMPT_BYTES} UTF-8 bytes.`);
  }
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
    return fail("CHATGPT_MODEL_INVALID", "The model id contains unsupported characters.");
  }
  if (!['minimal', 'low', 'standard', 'high', 'max'].includes(thinkingEffort)) {
    return fail("CHATGPT_THINKING_EFFORT_INVALID", "The thinking effort is not supported by this experimental bridge.");
  }
  if (projectId !== null && !/^g-p-[A-Za-z0-9_-]{8,128}$/.test(projectId)) {
    return fail("CHATGPT_PROJECT_ID_INVALID", "The ChatGPT Project id is invalid.");
  }
  if (expectedConversationId !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(expectedConversationId)) {
    return fail("CHATGPT_CONVERSATION_ID_INVALID", "The existing ChatGPT conversation id is invalid.");
  }
  if (model === "gpt-5-6-thinking") {
    const activeThinkingEffort = new URL(location.href).searchParams.get("thinking_effort");
    // ChatGPT may consume and remove the route query after activating the model.
    // A present, conflicting value is authoritative and must fail closed; an
    // absent value is not evidence of a mismatch because the first-party
    // conversation request below still binds the requested effort explicitly.
    if (activeThinkingEffort !== null && activeThinkingEffort !== thinkingEffort) {
      return fail(
        "CHATGPT_RUNTIME_THINKING_EFFORT_MISMATCH",
        "The signed-in ChatGPT runtime did not activate the requested thinking effort.",
        { requested_thinking_effort: thinkingEffort, active_thinking_effort: activeThinkingEffort },
      );
    }
  }

  const findComposerRuntime = () => {
    const roots = [
      document.querySelector("#prompt-textarea"),
      document.querySelector('[contenteditable="true"][data-testid*="composer"]'),
      document.querySelector('form textarea'),
    ].filter(Boolean);
    for (const root of roots) {
      const key = Object.keys(root).find((candidate) => candidate.startsWith("__reactFiber$") || candidate.startsWith("__reactInternalInstance$"));
      if (key) return { root, key };
    }
    return null;
  };
  let composerRuntime = findComposerRuntime();
  const runtimeReadyDeadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  while (!composerRuntime && Date.now() < runtimeReadyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    composerRuntime = findComposerRuntime();
  }
  const composerRoot = composerRuntime?.root || null;
  const fiberKey = composerRuntime?.key || null;
  if (!composerRoot || !fiberKey) {
    return fail("CHATGPT_RUNTIME_CONTRACT_CHANGED", "ChatGPT's mounted composer runtime could not be located. UI automation was not attempted.");
  }

  const modelCandidates = [];
  let fiber = composerRoot[fiberKey];
  let rootFiber = fiber;
  for (let depth = 0; fiber && depth < 120; depth += 1, fiber = fiber.return) {
    rootFiber = fiber;
    const props = fiber.memoizedProps && typeof fiber.memoizedProps === "object" ? fiber.memoizedProps : null;
    const action = Object.getOwnPropertyDescriptor(props || {}, "onCreateNewCompletion")?.value;
    if (typeof action !== "function") continue;
    let source = "";
    try { source = Function.prototype.toString.call(action); } catch {}
    const currentModelId = Object.getOwnPropertyDescriptor(props, "currentModelId")?.value;
    const semanticMatch = action.length === 1
      && /typeof\s+[A-Za-z_$][\w$]*\.content/.test(source)
      && /\.content\.length/.test(source)
      && typeof currentModelId === "string"
      && Object.prototype.hasOwnProperty.call(props, "currentModelConfig")
      && Object.prototype.hasOwnProperty.call(props, "conversation")
      && Object.prototype.hasOwnProperty.call(props, "isNewThread");
    if (semanticMatch) modelCandidates.push({ props, source, depth });
  }
  if (modelCandidates.length !== 1) {
    return fail(
      "CHATGPT_RUNTIME_CONTRACT_CHANGED",
      `Expected exactly one validated ChatGPT model context but found ${modelCandidates.length}. UI automation was not attempted.`,
    );
  }

  const modelContext = modelCandidates[0];
  const currentModelId = modelContext.props.currentModelId;
  if (currentModelId !== model) {
    return fail(
      "CHATGPT_RUNTIME_MODEL_MISMATCH",
      "The signed-in ChatGPT runtime did not activate the requested model.",
      { requested_model: model, active_model: currentModelId },
    );
  }
  if (projectId !== null && expectedConversationId === null && location.pathname !== `/g/${projectId}/project`) {
    return fail(
      "CHATGPT_RUNTIME_PROJECT_MISMATCH",
      "The loaded ChatGPT page does not match the configured Project. No submission was attempted.",
    );
  }
  const currentConversationMatch = location.pathname.match(/^\/c\/([^/?#]+)/)
    || location.pathname.match(/^\/g\/[^/]+\/c\/([^/?#]+)/);
  const currentConversationId = currentConversationMatch?.[1] || null;
  if (expectedConversationId === null) {
    if (modelContext.props.isNewThread !== true || currentConversationId !== null) {
      return fail("CHATGPT_RUNTIME_NOT_NEW_THREAD", "Runtime-native start requires a fresh ChatGPT thread. No submission was attempted.");
    }
  } else {
    if (modelContext.props.isNewThread !== false || currentConversationId !== expectedConversationId) {
      return fail(
        "CHATGPT_RUNTIME_CONVERSATION_MISMATCH",
        "The loaded ChatGPT runtime does not match the requested existing conversation. No submission was attempted.",
        { expected_conversation_id: expectedConversationId, current_conversation_id: currentConversationId },
      );
    }
  }
  if (modelContext.props.disabled === true || modelContext.props.submitPending === true || modelContext.props.isCompletionInProgress === true) {
    return fail("CHATGPT_RUNTIME_NOT_READY", "The ChatGPT runtime is not ready to accept a completion.");
  }

  const submitCandidates = [];
  const seenSubmitFunctions = new WeakSet();
  const inspectedContainers = new WeakSet();
  const addSubmitCandidate = (submitComposer, sharedProps) => {
    if (typeof submitComposer !== "function" || seenSubmitFunctions.has(submitComposer)) return;
    const requiredKeys = [
      "isComposerSubmissionReady",
      "conversation",
      "composerController",
      "isNewThread",
      "submitComposer",
      "conversationMode",
      "availableSystemHints",
    ];
    if (!requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(sharedProps, key))) return;
    seenSubmitFunctions.add(submitComposer);
    submitCandidates.push({ submitComposer, sharedProps });
  };
  const inspectContainer = (value, depth = 0) => {
    if (value == null || depth > 5 || (typeof value !== "object" && typeof value !== "function") || inspectedContainers.has(value)) return;
    inspectedContainers.add(value);
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return; }
    for (const [key, descriptor] of Object.entries(descriptors).slice(0, 300)) {
      if (!("value" in descriptor) || /cookie|token|authorization|credential|password|secret|email|account|access.?token|device.?id/i.test(key)) continue;
      const child = descriptor.value;
      if (key === "getSharedProps" && typeof child === "function") {
        try {
          const sharedProps = child.call(value);
          if (sharedProps && typeof sharedProps === "object") {
            addSubmitCandidate(Object.getOwnPropertyDescriptor(sharedProps, "submitComposer")?.value, sharedProps);
          }
        } catch {}
        continue;
      }
      if (depth < 5 && /store|composer|bridge|shared|controller|state|current/i.test(key)) inspectContainer(child, depth + 1);
    }
  };
  const seenFibers = new Set();
  const fiberStack = rootFiber ? [rootFiber] : [];
  let traversedFiberCount = 0;
  while (fiberStack.length > 0 && traversedFiberCount < 50_000 && submitCandidates.length < 10) {
    const current = fiberStack.pop();
    if (!current || seenFibers.has(current)) continue;
    seenFibers.add(current);
    traversedFiberCount += 1;
    inspectContainer(current.memoizedProps);
    let hook = current.memoizedState;
    for (let hookIndex = 0; hook && hookIndex < 200; hookIndex += 1, hook = hook.next) {
      inspectContainer(hook.memoizedState);
      inspectContainer(hook.baseState);
    }
    if (current.sibling) fiberStack.push(current.sibling);
    if (current.child) fiberStack.push(current.child);
  }
  if (submitCandidates.length !== 1) {
    return fail(
      "CHATGPT_RUNTIME_CONTRACT_CHANGED",
      `Expected exactly one validated ChatGPT submitComposer action but found ${submitCandidates.length}. UI automation was not attempted.`,
    );
  }
  const submitCandidate = submitCandidates[0];
  if (Boolean(submitCandidate.sharedProps.isNewThread) !== (expectedConversationId === null)) {
    return fail("CHATGPT_RUNTIME_CONVERSATION_MISMATCH", "ChatGPT's shared composer state does not match the requested conversation mode. No submission was attempted.");
  }
  if (submitCandidate.sharedProps.isComposerSubmissionReady !== true || submitCandidate.sharedProps.isDisabled === true) {
    return fail("CHATGPT_RUNTIME_NOT_READY", "ChatGPT's shared composer store is not ready to accept a submission.");
  }
  if (projectId !== null) {
    const conversationMode = submitCandidate.sharedProps.conversationMode;
    if (
      !conversationMode
      || conversationMode.kind !== "gizmo_interaction"
      || conversationMode.gizmo_id !== projectId
    ) {
      return fail(
        "CHATGPT_RUNTIME_PROJECT_MISMATCH",
        "ChatGPT's mounted composer state does not match the configured Project. No submission was attempted.",
      );
    }
  }
  let submitSource = "";
  try { submitSource = Function.prototype.toString.call(submitCandidate.submitComposer); } catch {}
  const fingerprintMaterial = `${Object.keys(submitCandidate.sharedProps).sort().join("\n")}\n${submitSource}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintMaterial));
  const actionFingerprint = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  const enrichResult = (result) => ({
    ...result,
    transport: "runtime",
    runtime_action: "submitComposer:text_action",
    runtime_fingerprint: actionFingerprint,
    model: currentModelId,
    thinking_effort: thinkingEffort,
    ...(projectId === null ? {} : { project_id: projectId }),
    max_runtime_seconds: maxRuntimeSeconds,
    prompt_bytes: promptBytes,
    page_url: location.href,
    operation: expectedConversationId === null ? "start" : "continue",
  });

  const parseResponse = async (response) => {
    if (!response.ok) {
      let errorText = "";
      try { errorText = (await response.text()).slice(0, 16_384); } catch {}
      const requirementsMissing = response.status === 403
        || /sentinel|turnstile|arkose|proof|challenge|chat.?requirements/i.test(errorText);
      const code = response.status === 401
        ? "CHATGPT_SESSION_UNAVAILABLE"
        : response.status === 404
          ? "CHATGPT_CONVERSATION_PROTOCOL_CHANGED"
          : response.status === 429
            ? "CHATGPT_CONVERSATION_RATE_LIMITED"
            : requirementsMissing
              ? "CHATGPT_CONVERSATION_REQUIREMENTS_UNAVAILABLE"
              : "CHATGPT_CONVERSATION_REJECTED";
      return fail(
        code,
        requirementsMissing
          ? "ChatGPT's first-party runtime could not satisfy the current conversation requirements."
          : "ChatGPT rejected the first-party conversation request.",
        { status: response.status },
      );
    }
    if (!response.body) {
      return fail("CHATGPT_CONVERSATION_PROTOCOL_CHANGED", "ChatGPT returned no event stream.", { status: response.status });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let responseBytes = 0;
    let eventCount = 0;
    let parsedEventCount = 0;
    let parseFailureCount = 0;
    let conversationId = expectedConversationId;
    let assistantMessageId = null;
    let assistantText = "";
    let complete = false;
    const eventTypes = new Set();

    const appendText = (value, replace = false) => {
      if (typeof value !== "string" || !value) return;
      assistantText = replace ? value : `${assistantText}${value}`;
      if (assistantText.length > MAX_ASSISTANT_TEXT_CHARS) {
        const error = new Error("assistant text limit exceeded");
        error.code = "CHATGPT_CONVERSATION_OUTPUT_LIMIT";
        throw error;
      }
    };
    const messageText = (message) => {
      const content = message?.content;
      if (!content) return "";
      if (typeof content === "string") return content;
      if (typeof content.text === "string") return content.text;
      if (!Array.isArray(content.parts)) return "";
      return content.parts.map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      }).join("");
    };
    const consumeEvent = (raw) => {
      const data = raw.trim();
      if (!data) return;
      eventCount += 1;
      if (eventCount > MAX_EVENTS) {
        const error = new Error("event count limit exceeded");
        error.code = "CHATGPT_CONVERSATION_EVENT_LIMIT";
        throw error;
      }
      if (data === "[DONE]") {
        complete = true;
        eventTypes.add("done");
        return;
      }
      let event;
      try {
        event = JSON.parse(data);
        parsedEventCount += 1;
      } catch {
        parseFailureCount += 1;
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const eventType = typeof event.type === "string"
        ? event.type
        : typeof event.event === "string"
          ? event.event
          : null;
      if (eventType && eventType.length <= 100) eventTypes.add(eventType);
      conversationId = typeof event.conversation_id === "string" ? event.conversation_id
        : typeof event.conversationId === "string" ? event.conversationId
          : conversationId;
      const message = event.message && typeof event.message === "object" ? event.message : null;
      if (message?.author?.role === "assistant") {
        if (typeof message.id === "string") assistantMessageId = message.id;
        const text = messageText(message);
        if (text) appendText(text, true);
        if (message.status === "finished_successfully") complete = true;
      }
      if (typeof event.message_id === "string") assistantMessageId = event.message_id;
      if (typeof event.output_text === "string") appendText(event.output_text, true);
      if (typeof event.delta === "string") appendText(event.delta);
      if (typeof event.text === "string" && /delta|text/i.test(eventType || "")) appendText(event.text);
      const choiceDelta = event.choices?.[0]?.delta?.content;
      if (typeof choiceDelta === "string") appendText(choiceDelta);
      if (eventType && /(?:^|[._-])(done|completed|finished)(?:$|[._-])/i.test(eventType)) complete = true;
    };
    const consumeFrames = (flush = false) => {
      const normalized = buffered.replace(/\r\n/g, "\n");
      const frames = normalized.split("\n\n");
      const trailing = frames.pop() || "";
      const consumeFrame = (frame) => {
        const dataLines = frame.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""));
        if (dataLines.length > 0) consumeEvent(dataLines.join("\n"));
      };
      for (const frame of frames) consumeFrame(frame);
      if (flush) {
        buffered = "";
        if (trailing.trim()) consumeFrame(trailing);
      } else {
        buffered = trailing;
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          const error = new Error("response byte limit exceeded");
          error.code = "CHATGPT_CONVERSATION_RESPONSE_LIMIT";
          throw error;
        }
        buffered += decoder.decode(value, { stream: true });
        consumeFrames(false);
      }
      buffered += decoder.decode();
      consumeFrames(true);
    } catch (error) {
      try { await reader.cancel(); } catch {}
      return fail(error?.code || "CHATGPT_CONVERSATION_STREAM_ERROR", "The ChatGPT event stream exceeded a safety bound or ended unexpectedly.", {
        conversation_id: conversationId,
        complete: false,
      });
    }

    if (parsedEventCount === 0 && responseBytes > 0) {
      return fail("CHATGPT_CONVERSATION_PROTOCOL_CHANGED", "ChatGPT returned an event encoding this bridge does not recognize.", {
        status: response.status,
        event_count: eventCount,
        parse_failure_count: parseFailureCount,
      });
    }
    return {
      ok: true,
      complete,
      conversation_id: conversationId,
      assistant_message_id: assistantMessageId,
      assistant_text: assistantText,
      response_bytes: responseBytes,
      event_count: eventCount,
      parsed_event_count: parsedEventCount,
      parse_failure_count: parseFailureCount,
      event_types: [...eventTypes].slice(0, 50),
      endpoint: "/backend-api/f/conversation",
    };
  };

  const originalFetch = globalThis.fetch;
  let observedConversationRequest = false;
  let resolveObservedResponse;
  const observedResponse = new Promise((resolve) => { resolveObservedResponse = resolve; });
  let observedResponseSettled = false;
  let observedResponseValue = null;
  observedResponse.then(
    (value) => {
      observedResponseValue = value;
      observedResponseSettled = true;
    },
    () => {
      observedResponseValue = fail("CHATGPT_CONVERSATION_STREAM_ERROR", "The observed ChatGPT event stream failed unexpectedly.");
      observedResponseSettled = true;
    },
  );
  const patchedFetch = async function (...args) {
    let requestUrl = "";
    try {
      const request = args[0];
      requestUrl = typeof request === "string" || request instanceof URL
        ? String(request)
        : request instanceof Request
          ? request.url
          : "";
    } catch {}
    let matchesConversation = false;
    try {
      matchesConversation = new URL(requestUrl, location.href).pathname === "/backend-api/f/conversation";
    } catch {}
    try {
      const response = await originalFetch.apply(this, args);
      if (matchesConversation && !observedConversationRequest) {
        observedConversationRequest = true;
        resolveObservedResponse(parseResponse(response.clone()));
      }
      return response;
    } catch (error) {
      if (matchesConversation && !observedConversationRequest) {
        observedConversationRequest = true;
        resolveObservedResponse(fail("CHATGPT_CONVERSATION_NETWORK_ERROR", "The first-party ChatGPT request failed before a response was received."));
      }
      throw error;
    }
  };

  let actionSettled = false;
  let actionError = null;
  let actionCompletionValue;
  const initialAssistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
  globalThis.fetch = patchedFetch;
  try {
    let actionPromise;
    try {
      const dispatchResult = submitCandidate.submitComposer(
        new Event("submit"),
        { kind: "text_action", text: prompt },
      );
      if (!dispatchResult || dispatchResult.accepted !== true) {
        return fail("CHATGPT_RUNTIME_NOT_READY", "ChatGPT's submitComposer action did not accept the prompt.", { complete: false });
      }
      actionPromise = Promise.resolve(dispatchResult.completion)
        .then((value) => { actionCompletionValue = value; return value; })
        .catch((error) => { actionError = error; })
        .finally(() => { actionSettled = true; });
    } catch (error) {
      actionError = error;
      actionSettled = true;
      actionPromise = Promise.resolve();
    }

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let lastAssistantText = "";
    let stableAssistantReads = 0;
    let observedConversationId = expectedConversationId;
    let observedAssistantMessageId = null;
    let networkObservationHandled = false;
    let networkResult = null;
    while (Date.now() < deadline) {
      if (observedConversationRequest && observedResponseSettled && !networkObservationHandled) {
        networkResult = observedResponseValue;
        networkObservationHandled = true;
        if (networkResult?.ok === false) return enrichResult(networkResult);
        if (networkResult?.conversation_id) observedConversationId = networkResult.conversation_id;
      }
      if (actionSettled && networkResult?.complete === true && networkResult?.assistant_text) {
        return enrichResult(networkResult);
      }

      const conversationMatch = location.pathname.match(/^\/c\/([^/?#]+)/)
        || location.pathname.match(/^\/g\/[^/]+\/c\/([^/?#]+)/);
      if (conversationMatch) observedConversationId = conversationMatch[1];
      const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      if (assistantNodes.length > initialAssistantCount) {
        const latest = assistantNodes.at(-1);
        const assistantText = String(latest?.innerText || latest?.textContent || "").trim();
        if (assistantText.length > MAX_ASSISTANT_TEXT_CHARS) {
          return fail("CHATGPT_CONVERSATION_OUTPUT_LIMIT", "The rendered assistant response exceeded the configured output limit.", {
            conversation_id: observedConversationId,
            complete: false,
          });
        }
        observedAssistantMessageId = latest?.closest?.('[data-message-id]')?.getAttribute?.("data-message-id") || null;
        if (assistantText && assistantText === lastAssistantText) stableAssistantReads += 1;
        else {
          lastAssistantText = assistantText;
          stableAssistantReads = assistantText ? 1 : 0;
        }
        const generating = [...document.querySelectorAll(
          'button[data-testid*="stop"], button[aria-label*="Stop generating"], button[aria-label*="Stop streaming"]',
        )].some((button) => {
          const rect = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (actionSettled && assistantText && stableAssistantReads >= 4 && !generating) {
          return enrichResult({
            ok: true,
            complete: true,
            conversation_id: observedConversationId,
            assistant_message_id: observedAssistantMessageId,
            assistant_text: assistantText,
            response_bytes: networkResult?.response_bytes ?? new TextEncoder().encode(assistantText).length,
            event_count: networkResult?.event_count ?? 0,
            parsed_event_count: networkResult?.parsed_event_count ?? 0,
            parse_failure_count: networkResult?.parse_failure_count ?? 0,
            event_types: networkResult?.event_types ?? [],
            endpoint: "/backend-api/f/conversation",
            observation_source: networkResult ? "runtime-stream+rendered-runtime" : "rendered-runtime",
          });
        }
      }

      if (actionSettled && actionError && assistantNodes.length <= initialAssistantCount) {
        const actionErrorName = String(actionError?.name || "Error").slice(0, 100);
        const actionErrorMessage = String(actionError?.message || "")
          .split(prompt).join("<prompt-redacted>")
          .slice(0, 500);
        const actionErrorStack = String(actionError?.stack || "")
          .split(prompt).join("<prompt-redacted>")
          .slice(0, 3_000);
        return fail(
          "CHATGPT_RUNTIME_INVOCATION_REJECTED",
          "ChatGPT's first-party runtime rejected the completion action before producing a new assistant response.",
          {
            complete: false,
            action_error_name: actionErrorName,
            action_error_message: actionErrorMessage,
            action_error_stack: actionErrorStack,
          },
        );
      }
      if (actionSettled && actionCompletionValue === false && assistantNodes.length <= initialAssistantCount) {
        return fail("CHATGPT_RUNTIME_INVOCATION_REJECTED", "ChatGPT's first-party runtime did not accept the completion after dispatch.", { complete: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return fail(
      "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN",
      `ChatGPT's first-party runtime did not expose a complete result within ${REQUEST_TIMEOUT_MS}ms. No retry was attempted.`,
      { conversation_id: observedConversationId, complete: false },
    );
  } finally {
    if (globalThis.fetch === patchedFetch) globalThis.fetch = originalFetch;
  }
}

async function pageChatgptConversationStart(input) {
  const MAX_PROMPT_BYTES = 4_000_000;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_EVENTS = 2_000;
  const MAX_ASSISTANT_TEXT_CHARS = 100_000;
  const REQUEST_TIMEOUT_MS = 180_000;

  const fail = (code, message, details = {}) => ({
    ok: false,
    error: { code, message, ...details },
  });
  const prompt = String(input?.prompt || "");
  const model = String(input?.model || "gpt-5-6-pro");
  const thinkingEffort = String(input?.thinkingEffort || "standard");
  const projectId = input?.projectId == null ? null : String(input.projectId);
  const continueInWork = input?.continueInWork !== false;
  const promptBytes = new TextEncoder().encode(prompt).length;

  if (location.origin !== "https://chatgpt.com") {
    return fail("CHATGPT_TAB_UNAVAILABLE", "The selected tab is not a chatgpt.com page.");
  }
  if (!prompt || promptBytes > MAX_PROMPT_BYTES) {
    return fail("CHATGPT_PROMPT_INVALID", `The prompt must be between 1 and ${MAX_PROMPT_BYTES} UTF-8 bytes.`);
  }
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
    return fail("CHATGPT_MODEL_INVALID", "The model id contains unsupported characters.");
  }
  if (!["minimal", "low", "standard", "high", "max"].includes(thinkingEffort)) {
    return fail("CHATGPT_THINKING_EFFORT_INVALID", "The thinking effort is not supported by this experimental bridge.");
  }
  if (projectId !== null && !/^g-p-[A-Za-z0-9_-]{8,128}$/.test(projectId)) {
    return fail("CHATGPT_PROJECT_ID_INVALID", "The ChatGPT Project id is invalid.");
  }

  let accessToken;
  try {
    const sessionResponse = await fetch("/api/auth/session", {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!sessionResponse.ok) {
      return fail("CHATGPT_SESSION_UNAVAILABLE", "ChatGPT did not return an authenticated browser session.", { status: sessionResponse.status });
    }
    const session = await sessionResponse.json();
    accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
  } catch {
    return fail("CHATGPT_SESSION_UNAVAILABLE", "The browser could not read the current ChatGPT session.");
  }
  if (!accessToken) {
    return fail("CHATGPT_SESSION_UNAVAILABLE", "The open ChatGPT tab is not authenticated.");
  }

  const messageId = crypto.randomUUID();
  const requestBody = {
    action: "next",
    messages: [{
      id: messageId,
      author: { role: "user" },
      create_time: Date.now() / 1000,
      content: { content_type: "text", parts: [prompt] },
      metadata: {
        selected_sources: [],
        serialization_metadata: { custom_symbol_offsets: [] },
      },
    }],
    parent_message_id: "client-created-root",
    model,
    client_prepare_state: "success",
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    conversation_mode: projectId === null
      ? { kind: "primary_assistant" }
      : { kind: "gizmo_interaction", gizmo_id: projectId },
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: [],
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
    thinking_effort: thinkingEffort,
    local_function_names: continueInWork ? ["local.continue_in_work"] : [],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("/backend-api/f/conversation", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "oai-language": document.documentElement.lang || "en-US",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      return fail("CHATGPT_CONVERSATION_TIMEOUT", `ChatGPT did not answer within ${REQUEST_TIMEOUT_MS}ms.`);
    }
    return fail("CHATGPT_CONVERSATION_NETWORK_ERROR", "The ChatGPT conversation request failed before a response was received.");
  } finally {
    accessToken = "";
  }

  if (!response.ok) {
    clearTimeout(timeout);
    let errorText = "";
    try { errorText = (await response.text()).slice(0, 16_384); } catch {}
    const requirementsMissing = response.status === 403
      || /sentinel|turnstile|arkose|proof|challenge|chat.?requirements/i.test(errorText);
    const code = response.status === 401
      ? "CHATGPT_SESSION_UNAVAILABLE"
      : response.status === 404
        ? "CHATGPT_CONVERSATION_PROTOCOL_CHANGED"
        : response.status === 429
          ? "CHATGPT_CONVERSATION_RATE_LIMITED"
          : requirementsMissing
            ? "CHATGPT_CONVERSATION_REQUIREMENTS_UNAVAILABLE"
            : "CHATGPT_CONVERSATION_REJECTED";
    return fail(
      code,
      requirementsMissing
        ? "ChatGPT requires browser-generated session or anti-abuse proof material that this bridge will not synthesize or replay."
        : "ChatGPT rejected the conversation request.",
      { status: response.status },
    );
  }
  if (!response.body) {
    clearTimeout(timeout);
    return fail("CHATGPT_CONVERSATION_PROTOCOL_CHANGED", "ChatGPT returned no event stream.", { status: response.status });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let responseBytes = 0;
  let eventCount = 0;
  let parsedEventCount = 0;
  let parseFailureCount = 0;
  let conversationId = null;
  let assistantMessageId = null;
  let assistantText = "";
  let complete = false;
  const eventTypes = new Set();

  const appendText = (value, replace = false) => {
    if (typeof value !== "string" || !value) return;
    assistantText = replace ? value : `${assistantText}${value}`;
    if (assistantText.length > MAX_ASSISTANT_TEXT_CHARS) {
      const error = new Error("assistant text limit exceeded");
      error.code = "CHATGPT_CONVERSATION_OUTPUT_LIMIT";
      throw error;
    }
  };
  const messageText = (message) => {
    const content = message?.content;
    if (!content) return "";
    if (typeof content === "string") return content;
    if (typeof content.text === "string") return content.text;
    if (!Array.isArray(content.parts)) return "";
    return content.parts.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).join("");
  };
  const consumeEvent = (raw) => {
    const data = raw.trim();
    if (!data) return;
    eventCount += 1;
    if (eventCount > MAX_EVENTS) {
      const error = new Error("event count limit exceeded");
      error.code = "CHATGPT_CONVERSATION_EVENT_LIMIT";
      throw error;
    }
    if (data === "[DONE]") {
      complete = true;
      eventTypes.add("done");
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
      parsedEventCount += 1;
    } catch {
      parseFailureCount += 1;
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const eventType = typeof event.type === "string"
      ? event.type
      : typeof event.event === "string"
        ? event.event
        : null;
    if (eventType && eventType.length <= 100) eventTypes.add(eventType);
    conversationId = typeof event.conversation_id === "string" ? event.conversation_id
      : typeof event.conversationId === "string" ? event.conversationId
        : conversationId;

    const message = event.message && typeof event.message === "object" ? event.message : null;
    if (message?.author?.role === "assistant") {
      if (typeof message.id === "string") assistantMessageId = message.id;
      const text = messageText(message);
      if (text) appendText(text, true);
      if (message.status === "finished_successfully") complete = true;
    }
    if (typeof event.message_id === "string") assistantMessageId = event.message_id;
    if (typeof event.output_text === "string") appendText(event.output_text, true);
    if (typeof event.delta === "string") appendText(event.delta);
    if (typeof event.text === "string" && /delta|text/i.test(eventType || "")) appendText(event.text);
    const choiceDelta = event.choices?.[0]?.delta?.content;
    if (typeof choiceDelta === "string") appendText(choiceDelta);
    if (eventType && /(?:^|[._-])(done|completed|finished)(?:$|[._-])/i.test(eventType)) complete = true;
  };
  const consumeFrames = (flush = false) => {
    const normalized = buffered.replace(/\r\n/g, "\n");
    const frames = normalized.split("\n\n");
    const trailing = frames.pop() || "";
    const consumeFrame = (frame) => {
      const dataLines = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (dataLines.length > 0) consumeEvent(dataLines.join("\n"));
    };
    for (const frame of frames) consumeFrame(frame);
    if (flush) {
      buffered = "";
      if (trailing.trim()) consumeFrame(trailing);
    } else {
      buffered = trailing;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        const error = new Error("response byte limit exceeded");
        error.code = "CHATGPT_CONVERSATION_RESPONSE_LIMIT";
        throw error;
      }
      buffered += decoder.decode(value, { stream: true });
      consumeFrames(false);
    }
    buffered += decoder.decode();
    consumeFrames(true);
  } catch (error) {
    try { await reader.cancel(); } catch {}
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      return fail("CHATGPT_CONVERSATION_TIMEOUT", `ChatGPT did not finish within ${REQUEST_TIMEOUT_MS}ms.`, {
        conversation_id: conversationId,
        complete: false,
      });
    }
    return fail(error?.code || "CHATGPT_CONVERSATION_STREAM_ERROR", "The ChatGPT event stream exceeded a safety bound or ended unexpectedly.", {
      conversation_id: conversationId,
      complete: false,
    });
  }
  clearTimeout(timeout);

  if (parsedEventCount === 0 && responseBytes > 0) {
    return fail("CHATGPT_CONVERSATION_PROTOCOL_CHANGED", "ChatGPT returned an event encoding this bridge does not recognize.", {
      status: response.status,
      event_count: eventCount,
      parse_failure_count: parseFailureCount,
    });
  }

  return {
    ok: true,
    complete,
    conversation_id: conversationId,
    assistant_message_id: assistantMessageId,
    assistant_text: assistantText,
    model,
    thinking_effort: thinkingEffort,
    ...(projectId === null ? {} : { project_id: projectId }),
    prompt_bytes: promptBytes,
    response_bytes: responseBytes,
    event_count: eventCount,
    parsed_event_count: parsedEventCount,
    parse_failure_count: parseFailureCount,
    event_types: [...eventTypes].slice(0, 50),
    endpoint: "/backend-api/f/conversation",
  };
}

function pageSnapshot(maxTextChars, maxElements) {
  function selectorFor(element) {
    if (!(element instanceof Element)) return null;
    const unique = (candidate) => {
      try { return document.querySelectorAll(candidate).length === 1; } catch { return false; }
    };
    if (element.id) {
      const candidate = `#${CSS.escape(element.id)}`;
      if (unique(candidate)) return candidate;
    }
    const attrs = ["data-testid", "data-test", "data-qa", "name", "aria-label"];
    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const candidate = `${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
      if (unique(candidate)) return candidate;
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 32; depth += 1) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current === document.documentElement) break;
      current = parent;
    }
    // A root-anchored nth-of-type path is deterministic without running a
    // full-document query for every visible interactive element. This keeps
    // snapshots bounded on pages with very large navigation DOMs.
    return parts.join(" > ") || null;
  }

  const bodyText = (document.body?.innerText || "").slice(0, maxTextChars);
  const candidates = [...document.querySelectorAll(
    "a[href],button,input,textarea,select,[contenteditable=true],[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option]",
  )];
  const elements = [];
  for (const element of candidates) {
    if (elements.length >= maxElements) break;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    if (!visible) continue;
    const type = element instanceof HTMLInputElement ? element.type : null;
    let value = null;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      value = type === "password" ? "<redacted>" : String(element.value || "").slice(0, 20000);
    }
    elements.push({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      type,
      role: element.getAttribute("role"),
      text: String(element.innerText || element.textContent || "").trim().slice(0, 500),
      ariaLabel: element.getAttribute("aria-label"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaHasPopup: element.getAttribute("aria-haspopup"),
      ariaControls: element.getAttribute("aria-controls"),
      dataState: element.getAttribute("data-state"),
      name: element.getAttribute("name"),
      placeholder: element.getAttribute("placeholder"),
      href: element instanceof HTMLAnchorElement ? element.href : null,
      disabled: Boolean(element.disabled),
      checked: "checked" in element ? Boolean(element.checked) : null,
      required: "required" in element ? Boolean(element.required) : null,
      valid: typeof element.checkValidity === "function" ? Boolean(element.checkValidity()) : null,
      selectedOptionText:
        element instanceof HTMLSelectElement
          ? String(element.selectedOptions?.[0]?.textContent || "").trim().slice(0, 500)
          : null,
      value,
    });
  }
  return {
    title: document.title,
    url: location.href,
    bodyText,
    bodyTextTruncated: (document.body?.innerText || "").length > maxTextChars,
    elements,
    elementsTruncated: candidates.length > maxElements,
  };
}

async function pageClick(selector) {
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    const error = new Error(`No element matches selector: ${selector}`);
    error.code = "CHROME_ELEMENT_NOT_FOUND";
    throw error;
  }
  if (element instanceof HTMLInputElement && element.type === "file") {
    const error = new Error("File pickers require foreground/user interaction; background mode will not open one.");
    error.code = "CHROME_FOREGROUND_REQUIRED";
    throw error;
  }
  if (("disabled" in element && Boolean(element.disabled)) || element.getAttribute("aria-disabled") === "true") {
    const error = new Error(`Element is disabled: ${selector}`);
    error.code = "CHROME_ELEMENT_DISABLED";
    throw error;
  }

  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") {
    const error = new Error(`Element is not visible: ${selector}`);
    error.code = "CHROME_ELEMENT_NOT_VISIBLE";
    throw error;
  }

  const clientX = Math.max(0, Math.min(Math.max(0, window.innerWidth - 1), rect.left + rect.width / 2));
  const clientY = Math.max(0, Math.min(Math.max(0, window.innerHeight - 1), rect.top + rect.height / 2));
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    screenX: Number(window.screenX || 0) + clientX,
    screenY: Number(window.screenY || 0) + clientY,
    button: 0,
  };
  const events = [];
  const dispatchPointer = (type, buttons) => {
    if (typeof PointerEvent !== "function") return true;
    events.push(type);
    return element.dispatchEvent(new PointerEvent(type, {
      ...common,
      buttons,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      pressure: buttons ? 0.5 : 0,
    }));
  };
  const dispatchMouse = (type, buttons) => {
    events.push(type);
    return element.dispatchEvent(new MouseEvent(type, { ...common, buttons, detail: type === "mousedown" ? 1 : 0 }));
  };
  const visiblePopupCount = () => [...document.querySelectorAll('[role="listbox"],[role="menu"],[role="dialog"],[data-state="open"]')]
    .filter((node) => {
      if (!(node instanceof Element)) return false;
      const box = node.getBoundingClientRect();
      const computed = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && computed.display !== "none" && computed.visibility !== "hidden";
    }).length;
  const readActivationState = () => ({
    ariaExpanded: element.getAttribute("aria-expanded"),
    ariaHasPopup: element.getAttribute("aria-haspopup"),
    dataState: element.getAttribute("data-state"),
    visiblePopupCount: visiblePopupCount(),
  });
  const stateChanged = (before, after) => before.ariaExpanded !== after.ariaExpanded
    || before.dataState !== after.dataState
    || before.visiblePopupCount !== after.visiblePopupCount;

  const before = readActivationState();
  dispatchPointer("pointerover", 0);
  dispatchMouse("mouseover", 0);
  dispatchPointer("pointermove", 0);
  dispatchMouse("mousemove", 0);
  dispatchPointer("pointerdown", 1);
  const mouseDownAllowed = dispatchMouse("mousedown", 1);
  if (mouseDownAllowed && element instanceof HTMLElement) {
    try { element.focus({ preventScroll: true }); } catch {}
  }

  // React/headless/custom comboboxes often do their real work on mousedown and
  // call preventDefault() to manage focus. Give that discrete event one task to
  // flush before deciding whether a second synthetic click is appropriate.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterMouseDown = readActivationState();
  const semanticMouseDownControl = element.matches('[role="combobox"],[aria-haspopup]')
    || element.closest('[role="combobox"],[aria-haspopup]') != null;
  const activatedOnMouseDown = stateChanged(before, afterMouseDown)
    || (mouseDownAllowed === false && semanticMouseDownControl);

  dispatchPointer("pointerup", 0);
  dispatchMouse("mouseup", 0);
  let activation = "mousedown";
  if (!activatedOnMouseDown) {
    events.push("click");
    element.click();
    activation = "click";
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  let after = readActivationState();

  // Accessible comboboxes are expected to open on ArrowDown. Some React/headless
  // controls ignore synthetic pointer/mouse activation but still honor keyboard
  // semantics. Use that as a narrow fallback only when the semantic combobox is
  // still closed after the mouse path.
  let keyboardFallbackUsed = false;
  if (semanticMouseDownControl && after.ariaExpanded !== "true" && after.dataState !== "open" && after.visiblePopupCount === 0) {
    if (element instanceof HTMLElement) {
      try { element.focus({ preventScroll: true }); } catch {}
    }
    const keyCommon = { bubbles: true, cancelable: true, composed: true, key: "ArrowDown", code: "ArrowDown" };
    events.push("keydown:ArrowDown");
    element.dispatchEvent(new KeyboardEvent("keydown", keyCommon));
    events.push("keyup:ArrowDown");
    element.dispatchEvent(new KeyboardEvent("keyup", keyCommon));
    keyboardFallbackUsed = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    after = readActivationState();
    if (after.ariaExpanded === "true" || after.dataState === "open" || after.visiblePopupCount > 0) {
      activation = "keyboard-arrowdown";
    }
  }

  return {
    clicked: true,
    selector,
    strategy: "adaptive-pointer-mouse-sequence",
    activation,
    trusted: false,
    mouseDownAllowed,
    semanticMouseDownControl,
    keyboardFallbackUsed,
    stateChangedOnMouseDown: stateChanged(before, afterMouseDown),
    before,
    afterMouseDown,
    after,
    clientX,
    clientY,
    events,
    title: document.title,
    url: location.href,
  };
}

async function pageFill(selector, value, submit) {
  const matches = [...document.querySelectorAll(selector)];
  if (matches.length === 0) throw new Error(`No element matches selector: ${selector}`);
  const isFillable = (candidate) => candidate?.isContentEditable
    || candidate instanceof HTMLInputElement
    || candidate instanceof HTMLTextAreaElement
    || candidate instanceof HTMLSelectElement;
  const isDisabled = (candidate) => Boolean(candidate?.disabled)
    || candidate?.getAttribute?.("aria-disabled") === "true";
  const isVisible = (candidate) => {
    if (!(candidate instanceof Element)) return false;
    const rect = candidate.getBoundingClientRect();
    const style = getComputedStyle(candidate);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && style.opacity !== "0";
  };
  const fillableMatches = matches.filter(isFillable);
  if (fillableMatches.length === 0) {
    const error = new Error(`Element ${selector} is not fillable.`);
    error.code = "CHROME_ELEMENT_NOT_FILLABLE";
    throw error;
  }
  const visibleMatches = fillableMatches.filter(isVisible);
  if (visibleMatches.length === 0) {
    const error = new Error(`No visible fillable element matches selector: ${selector}`);
    error.code = "CHROME_ELEMENT_NOT_VISIBLE";
    throw error;
  }
  const element = visibleMatches.find((candidate) => !isDisabled(candidate));
  if (!element) {
    const error = new Error(`Every visible matching element is disabled: ${selector}`);
    error.code = "CHROME_ELEMENT_DISABLED";
    throw error;
  }
  const selectedMatchIndex = matches.indexOf(element);
  const selectedVisible = true;
  const selectedDisabled = false;
  if (element instanceof HTMLInputElement && element.type === "file") {
    const error = new Error("File inputs require foreground/user interaction; background mode will not populate one.");
    error.code = "CHROME_FOREGROUND_REQUIRED";
    throw error;
  }
  if (element.isContentEditable) {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    try { element.focus({ preventScroll: true }); } catch { element.focus(); }
    try { element.select(); } catch {}
    const setWithNativeEvents = () => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const FRAMEWORK_COMMIT_FALLBACK_MS = 250;
    const waitForFrameworkCommit = () => new Promise((resolve) => {
      let settled = false;
      let fallbackTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        resolve();
      };
      // Inactive/background Chrome tabs may suspend requestAnimationFrame
      // indefinitely. Retain the two-frame framework settle path when it is
      // available, but never let a fill request wait on animation frames alone.
      fallbackTimer = setTimeout(finish, FRAMEWORK_COMMIT_FALLBACK_MS);
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
      } catch {
        finish();
      }
    });
    let inserted = false;
    try { inserted = Boolean(document.execCommand("insertText", false, value)); } catch {}
    if (!inserted || element.value !== value) setWithNativeEvents();
    await waitForFrameworkCommit();
    if (element.value !== value) {
      setWithNativeEvents();
      await waitForFrameworkCommit();
    }
    if (element.value !== value) {
      const error = new Error(`Element ${selector} did not retain the filled value.`);
      error.code = "CHROME_FILL_NOT_STICKY";
      throw error;
    }
  } else if (element instanceof HTMLSelectElement) {
    const exactValue = [...element.options].find((option) => option.value === value);
    const labelMatch = [...element.options].find(
      (option) => String(option.textContent || "").trim().toLowerCase() === value.trim().toLowerCase(),
    );
    const option = exactValue || labelMatch;
    if (!option) {
      const error = new Error(`No select option matches value or label: ${value}`);
      error.code = "CHROME_SELECT_OPTION_NOT_FOUND";
      throw error;
    }
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const error = new Error(`Element ${selector} is not fillable.`);
    error.code = "CHROME_ELEMENT_NOT_FILLABLE";
    throw error;
  }
  let submitStrategy = null;
  let submitterTag = null;
  let submitterType = null;
  const form = element.closest("form");
  if (submit) {
    const submitter = form
      ? [...form.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"]')]
        .find((candidate) => isVisible(candidate) && !isDisabled(candidate))
      : null;
    submitterTag = submitter?.tagName?.toLowerCase?.() || null;
    submitterType = submitter?.getAttribute?.("type") || (submitterTag === "button" ? "submit" : null);
    if (form?.requestSubmit) {
      if (submitter) {
        form.requestSubmit(submitter);
        submitStrategy = "requestSubmit:visible-submitter";
      } else {
        form.requestSubmit();
        submitStrategy = "requestSubmit";
      }
    } else if (submitter?.click) {
      submitter.click();
      submitStrategy = "submitter.click";
    } else {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      submitStrategy = "keyboard-enter";
    }
  }
  return {
    filled: true,
    submitted: Boolean(submit),
    submitStrategy,
    submitterTag,
    submitterType,
    selector,
    matchCount: matches.length,
    fillableMatchCount: fillableMatches.length,
    selectedMatchIndex,
    selectedVisible,
    selectedDisabled,
    selectedTag: element.tagName?.toLowerCase?.() || null,
    formAction: form?.action || null,
    formMethod: String(form?.method || "").toUpperCase() || null,
    title: document.title,
    url: location.href,
  };
}

async function executeInTab(tabId, func, args, world = "ISOLATED") {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args,
  });
  return result?.[0]?.result ?? null;
}

async function dispatch(message) {
  const args = message.args || {};

  // Purely local extension/workspace operations do not touch authenticated web
  // content and therefore do not need a personal-browser URL grant.
  if (message.method === "status") {
    return { version: VERSION, extensionId: chrome.runtime.id, connected: true };
  }
  if (message.method === "extension.reload") {
    // Internal maintenance hook for this unpacked extension. Respond first so the
    // native host/client sees success, then let Chrome restart the service worker.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true, version: VERSION, extensionId: chrome.runtime.id };
  }
  if (message.method === "workspace.status") return await workspaceStatus();
  if (message.method === "workspace.init") return await initializeWorkspace(args.poolSize);
  if (message.method === "workspace.release") return await releaseWorkspaceTab(args.tabId) || { released: false, workspace: false, tabId: numericTabId(args.tabId) };
  if (message.method === "chatgpt.extensionStatus") return await chatgptExtensionStatus();

  const compiled = compilePatterns(message.allowedUrlPatterns);
  switch (message.method) {
    case "workspace.open":
    case "tabs.open": {
      // tabs.open is retained only as a compatibility alias for older callers.
      // It must never call chrome.tabs.create directly; every agent open leases
      // a managed tab from the MDB group.
      const url = String(args.url || "");
      return await leaseWorkspaceTab(url, compiled);
    }

    case "tabs.list": {
      const urlContains = String(args.urlContains || "").toLowerCase();
      const titleContains = String(args.titleContains || "").toLowerCase();
      const maxTabs = Math.max(1, Math.min(500, Number(args.maxTabs || 200)));
      const tabs = await chrome.tabs.query({});
      const filtered = tabs.filter((tab) => {
        if (!urlAllowed(tab.url, compiled)) return false;
        if (urlContains && !String(tab.url || "").toLowerCase().includes(urlContains)) return false;
        if (titleContains && !String(tab.title || "").toLowerCase().includes(titleContains)) return false;
        return true;
      }).slice(0, maxTabs);
      return {
        tabs: filtered.map((tab) => ({
          tabId: tab.id,
          windowId: tab.windowId,
          active: Boolean(tab.active),
          pinned: Boolean(tab.pinned),
          groupId: Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null,
          title: tab.title || "",
          url: tab.url || "",
          status: tab.status || null,
        })),
        count: filtered.length,
      };
    }

    case "tabs.navigate": {
      const tab = await getApprovedTab(args.tabId, compiled);
      const url = String(args.url || "");
      assertUrlAllowed(url, compiled);
      const previousUrl = String(tab.url || "");
      await chrome.tabs.update(tab.id, { url, active: false });
      const settled = await waitForApprovedNavigation(tab.id, compiled, { previousUrl, requestedUrl: url });
      await touchWorkspaceLease(tab.id);
      return { tabId: settled.id, windowId: settled.windowId, active: Boolean(settled.active), url: settled.url || url };
    }

    case "tabs.close": {
      const released = await releaseWorkspaceTab(args.tabId);
      if (released) return released;
      const tab = await getApprovedTab(args.tabId, compiled);
      if (tab.active && !args.allowActive) {
        const error = new Error("Refusing to close Chrome's active tab in background mode. Use a bridge workspace tab, or explicitly set allowActive=true.");
        error.code = "CHROME_ACTIVE_TAB_REFUSED";
        throw error;
      }
      await chrome.tabs.remove(tab.id);
      return { closed: true, released: false, workspace: false, tabId: tab.id, wasActive: Boolean(tab.active) };
    }

    case "tabs.taskAudit": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageTaskAudit, [], "MAIN");
    }

    case "tabs.exactTaskSave": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageExactTaskSave, [args.expected || {}, args.proposed || {}], "MAIN");
    }

    case "tabs.prepareExactTaskEditor": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pagePrepareExactTaskEditor, [args.expected || {}, args.proposed || {}], "MAIN");
    }

    case "tabs.installExactTaskSaveRewrite": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageInstallExactTaskSaveRewrite, [args.expected || {}, args.proposed || {}], "MAIN");
    }

    case "tabs.readExactTaskSaveRewrite": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageReadExactTaskSaveRewrite, [], "MAIN");
    }

    case "tabs.removeExactTaskSaveRewrite": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageRemoveExactTaskSaveRewrite, [], "MAIN");
    }

    case "tabs.installTaskMutationProbe": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageInstallTaskMutationProbe, [], "MAIN");
    }

    case "tabs.readTaskMutationProbe": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageReadTaskMutationProbe, [], "MAIN");
    }

    case "tabs.removeTaskMutationProbe": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageRemoveTaskMutationProbe, [], "MAIN");
    }

    case "tabs.chatgptConversationStart": {
      const transport = String(args.transport || "runtime");
      if (!['runtime', 'raw'].includes(transport)) {
        const error = new Error("ChatGPT transport must be runtime or raw.");
        error.code = "CHATGPT_TRANSPORT_INVALID";
        throw error;
      }
      const model = String(args.model || "gpt-5-6-pro");
      const thinkingEffort = String(args.thinkingEffort || "standard");
      const projectId = args.projectId == null ? null : String(args.projectId);
      if (projectId !== null && !/^g-p-[A-Za-z0-9_-]{8,128}$/.test(projectId)) {
        const error = new Error("ChatGPT Project id is invalid.");
        error.code = "CHATGPT_PROJECT_ID_INVALID";
        throw error;
      }
      const conversationId = args.conversationId == null ? null : String(args.conversationId);
      if (conversationId !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(conversationId)) {
        const error = new Error("ChatGPT conversation id is invalid.");
        error.code = "CHATGPT_CONVERSATION_ID_INVALID";
        throw error;
      }
      if (transport === "raw" && conversationId !== null) {
        const error = new Error("ChatGPT continuation is supported only by the runtime transport.");
        error.code = "CHATGPT_CONTINUATION_TRANSPORT_INVALID";
        throw error;
      }
      let tab;
      let autoLeased = false;
      if (args.tabId !== undefined && args.tabId !== null) {
        tab = await getApprovedTab(args.tabId, compiled);
      } else if (transport === "runtime") {
        const route = projectId !== null && conversationId === null
          ? `/g/${encodeURIComponent(projectId)}/project`
          : conversationId === null
            ? "/"
            : `/c/${encodeURIComponent(conversationId)}`;
        const query = new URLSearchParams({ model, thinking_effort: thinkingEffort });
        const targetUrl = `https://chatgpt.com${route}?${query}`;
        const leased = await leaseWorkspaceTab(targetUrl, compiled);
        tab = await readTab(leased.tabId);
        autoLeased = true;
      } else {
        const candidates = (await chrome.tabs.query({ url: ["https://chatgpt.com/*"] }))
          .filter((candidate) => Number.isInteger(candidate.id) && urlAllowed(candidate.url, compiled))
          .sort((a, b) => Number(b.status === "complete") - Number(a.status === "complete"));
        tab = candidates[0] || null;
        if (!tab) {
          const error = new Error("No approved, already-open chatgpt.com tab is available. Open and sign in to ChatGPT first.");
          error.code = "CHATGPT_TAB_UNAVAILABLE";
          throw error;
        }
        await touchWorkspaceLease(tab.id);
      }
      try {
        if (!tab || !String(tab.url || "").startsWith("https://chatgpt.com/")) {
          const error = new Error("The selected tab is not a chatgpt.com page.");
          error.code = "CHATGPT_TAB_UNAVAILABLE";
          throw error;
        }
        const pageFunction = transport === "runtime"
          ? pageChatgptRuntimeConversationStart
          : pageChatgptConversationStart;
        const pageArguments = [{
          prompt: String(args.prompt || ""),
          model,
          thinkingEffort,
          maxRuntimeSeconds: Math.max(30, Math.min(3600, Number(args.maxRuntimeSeconds || 600))),
          continueInWork: args.continueInWork !== false,
          ...(projectId === null ? {} : { projectId }),
          ...(conversationId === null ? {} : { conversationId }),
        }];
        const modelReadyDeadline = Date.now() + 20_000;
        let result;
        for (;;) {
          result = await executeInTab(tab.id, pageFunction, pageArguments, "MAIN");
          if (
            transport !== "runtime" ||
            !["CHATGPT_RUNTIME_MODEL_MISMATCH", "CHATGPT_RUNTIME_THINKING_EFFORT_MISMATCH", "CHATGPT_RUNTIME_NOT_READY"].includes(result?.error?.code) ||
            Date.now() >= modelReadyDeadline
          ) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (result?.ok === false) {
          const error = new Error(result.error?.message || "ChatGPT conversation request failed.");
          error.code = result.error?.code || "CHATGPT_CONVERSATION_FAILED";
          error.details = result.error || null;
          throw error;
        }
        if (transport === "runtime" && result?.complete === true && result?.conversation_id) {
          const conversationUrl = String(result.page_url || (await readTab(tab.id))?.url || tab.url || "");
          await chrome.tabs.reload(tab.id);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await waitForApprovedNavigation(tab.id, compiled, {
            previousUrl: conversationUrl,
            requestedUrl: conversationUrl,
          });
          const persisted = await executeInTab(tab.id, pageChatgptPersistedAssistantRead, [{
            conversationId: result.conversation_id,
            ...(result.assistant_message_id ? { assistantMessageId: result.assistant_message_id } : {}),
            timeoutMs: 15_000,
          }], "MAIN");
          if (persisted?.ok === false) {
            const error = new Error(persisted.error?.message || "ChatGPT persisted conversation verification failed.");
            error.code = persisted.error?.code || "CHATGPT_CONVERSATION_HANDOFF_UNCERTAIN";
            error.details = persisted.error || null;
            throw error;
          }
          result = {
            ...result,
            assistant_message_id: persisted.assistant_message_id || result.assistant_message_id || null,
            assistant_text: persisted.assistant_text,
            persisted_response_bytes: persisted.persisted_response_bytes,
            observation_source: persisted.observation_source,
          };
        }
        const settledTab = await readTab(tab.id);
        return {
          ...result,
          transport,
          tab_id: tab.id,
          tab_url: result?.page_url || settledTab?.url || tab.url || "",
          tab_active: Boolean(settledTab?.active ?? tab.active),
        };
      } finally {
        if (autoLeased && tab?.id != null) await releaseWorkspaceTab(tab.id).catch(() => {});
      }
    }

    case "tabs.chatgptRuntimeInventory": {
      const tab = await getApprovedTab(args.tabId, compiled);
      if (!String(tab.url || "").startsWith("https://chatgpt.com/")) {
        const error = new Error("The selected tab is not a chatgpt.com page.");
        error.code = "CHATGPT_TAB_UNAVAILABLE";
        throw error;
      }
      const result = await executeInTab(tab.id, pageChatgptRuntimeInventory, [], "MAIN");
      if (result?.ok === false) {
        const error = new Error(result.error?.message || "ChatGPT runtime inventory failed.");
        error.code = result.error?.code || "CHATGPT_RUNTIME_INVENTORY_FAILED";
        throw error;
      }
      return { ...result, tab_id: tab.id, tab_active: Boolean(tab.active) };
    }

    case "tabs.snapshot": {
      const tab = await getApprovedTab(args.tabId, compiled);
      const maxTextChars = Math.max(1_000, Math.min(200_000, Number(args.maxTextChars || 50_000)));
      const maxElements = Math.max(1, Math.min(500, Number(args.maxElements || 200)));
      return await executeInTab(tab.id, pageSnapshot, [maxTextChars, maxElements]);
    }

    case "tabs.click": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageClick, [String(args.selector || "")], "MAIN");
    }

    case "tabs.fill": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageFill, [String(args.selector || ""), String(args.value ?? ""), Boolean(args.submit)], "MAIN");
    }

    default: {
      const error = new Error(`Unknown background-browser method: ${message.method}`);
      error.code = "CHROME_UNKNOWN_METHOD";
      throw error;
    }
  }
}

chrome.tabGroups.onRemoved.addListener((group) => {
  void (async () => {
    const state = await loadWorkspaceState();
    if (state?.groupId === group.id) await clearWorkspaceState();
  })().catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void (async () => {
    const win = await chrome.windows.get(windowId);
    if (win?.type !== "normal" || win.focused !== true) return;
    await initializeWorkspaceIfChromeFocused();
  })().catch(() => {});
});

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1_000);
}

async function connect() {
  let profile = { signedIn: false, email: null, id: null };
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    profile = {
      signedIn: Boolean(info?.email && info?.id),
      email: info?.email || null,
      id: info?.id || null,
    };
  } catch (error) {
    profile = { signedIn: false, email: null, id: null, error: String(error?.message || error) };
  }

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    scheduleReconnect();
    return;
  }
  try {
    const workspace = await initializeWorkspaceIfChromeFocused();
    if (workspace) await setWorkspaceGroupActivity(workspace);
  } catch {}

  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== "request" || !message.id) return;
    try {
      const result = await dispatch(message);
      port.postMessage({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      port.postMessage({ type: "response", id: message.id, ok: false, error: errorPayload(error) });
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleReconnect();
  });
  port.postMessage({ type: "ready", version: VERSION, extensionId: chrome.runtime.id, profile });
}

connect();
