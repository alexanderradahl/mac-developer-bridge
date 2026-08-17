const NATIVE_HOST = "io.github.alexanderradahl.mac_developer_bridge";
const VERSION = "0.2.3";
const WORKSPACE_KEY = "macDeveloperBridgeWorkspace";
const WORKSPACE_GROUP_TITLE = "MDB";
const WORKSPACE_GROUP_COLOR = "blue";
const WORKSPACE_LEASE_STALE_MS = 30 * 60 * 1000;
const WORKSPACE_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_WORKSPACE_POOL_SIZE = 4;
let port = null;
let reconnectTimer = null;

function errorPayload(error, code = "CHROME_EXTENSION_ERROR") {
  return {
    code: error?.code || code,
    message: String(error?.message || error),
  };
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

async function reconcileWorkspaceState({ releaseStale = true } = {}) {
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
  for (const tab of tabs) {
    const lease = state.leases?.[String(tab.id)];
    if (!lease || typeof lease !== "object") continue;
    const leasedAt = Number(lease.leasedAt || 0);
    if (releaseStale && (!Number.isFinite(leasedAt) || now - leasedAt > WORKSPACE_LEASE_STALE_MS)) continue;
    leases[String(tab.id)] = { leasedAt };
  }

  const next = { groupId: state.groupId, tabIds: tabs.map((tab) => tab.id), leases };
  await saveWorkspaceState(next);
  return { ...next, group, tabs };
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

async function initializeWorkspace(poolSize) {
  const desired = Math.max(1, Math.min(8, Number(poolSize || 4)));
  let state = await reconcileWorkspaceState();
  if (state && state.tabIds.length >= desired) {
    await setWorkspaceGroupActivity(state);
    return {
      initialized: true,
      created: false,
      groupId: state.groupId,
      tabIds: state.tabIds,
      poolSize: state.tabIds.length,
      title: WORKSPACE_GROUP_TITLE,
      color: WORKSPACE_GROUP_COLOR,
    };
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

  // Measured on Chrome 151/macOS: even tabs.create({active:false}) can bring
  // Chrome to the foreground. Workspace creation/expansion is therefore an
  // explicit one-time foreground setup and NEVER performs that focus change on
  // the operator's behalf.
  if (!targetWindow || !Number.isInteger(windowId)) {
    const error = new Error("No focused normal Chrome window is available. Bring Chrome to the front once, then run MDB workspace setup again.");
    error.code = "CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED";
    throw error;
  }
  if (targetWindow.focused !== true) {
    const error = new Error("MDB workspace setup would need to create background tabs, but Chrome is not currently focused. Bring Chrome to the front once and retry; routine browser work will stay background-only afterwards.");
    error.code = "CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED";
    throw error;
  }

  const existingTabIds = state?.tabIds || [];
  const tabIds = [...existingTabIds];
  while (tabIds.length < desired) {
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
  return {
    initialized: true,
    created: tabIds.length > existingTabIds.length,
    groupId,
    tabIds,
    poolSize: tabIds.length,
    title: WORKSPACE_GROUP_TITLE,
    color: WORKSPACE_GROUP_COLOR,
    foregroundSetupMayBeRequired: true,
  };
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
  const state = await reconcileWorkspaceState();
  if (state) return state;
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find((win) => win.focused === true);
  if (!focused) return null;
  try {
    await initializeWorkspace(DEFAULT_WORKSPACE_POOL_SIZE);
  } catch (error) {
    if (error?.code !== "CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED") throw error;
    return null;
  }
  return await reconcileWorkspaceState();
}

async function leaseWorkspaceTab(url, compiled) {
  assertUrlAllowed(url, compiled);
  let state = await reconcileWorkspaceState();
  if (!state) state = await initializeWorkspaceIfChromeFocused();
  if (!state) {
    const error = new Error("The Mac Developer Bridge Chrome tab group is missing. MDB will recreate it automatically the next time Chrome is naturally foreground; browser work refuses to create a loose fallback tab in the meantime.");
    error.code = "CHROME_WORKSPACE_MISSING";
    throw error;
  }

  const leasedIds = new Set(Object.keys(state.leases).map(Number));
  const tab = state.tabs.find((candidate) => !leasedIds.has(candidate.id));
  if (!tab) {
    const error = new Error(`All ${state.tabs.length} Mac Developer Bridge background tabs are currently in use. Release one or rerun workspace setup with a larger pool.`);
    error.code = "CHROME_WORKSPACE_EXHAUSTED";
    throw error;
  }

  state.leases[String(tab.id)] = { leasedAt: Date.now() };
  await saveWorkspaceState({ groupId: state.groupId, tabIds: state.tabIds, leases: state.leases });
  await setWorkspaceGroupActivity(state);
  try {
    const previousUrl = String(tab.url || "");
    await chrome.tabs.update(tab.id, { url, active: false });
    const settled = await waitForApprovedNavigation(tab.id, compiled, { previousUrl, requestedUrl: url });
    return {
      workspace: true,
      groupId: state.groupId,
      tabId: settled.id,
      windowId: settled.windowId,
      active: Boolean(settled.active),
      title: settled.title || "",
      url: settled.url || url,
    };
  } catch (error) {
    // Failed/blocked navigation must not strand a leased pool slot or leave an
    // unapproved destination sitting in the reusable workspace.
    try { await chrome.tabs.update(tab.id, { url: workspaceIdleUrl(), active: false }); } catch {}
    delete state.leases[String(tab.id)];
    await saveWorkspaceState({ groupId: state.groupId, tabIds: state.tabIds, leases: state.leases });
    await setWorkspaceGroupActivity(state);
    throw error;
  }
}

async function releaseWorkspaceTab(tabId) {
  const wanted = numericTabId(tabId);
  const state = await reconcileWorkspaceState({ releaseStale: false });
  if (!state || !state.tabIds.includes(wanted)) return null;
  delete state.leases[String(wanted)];
  await saveWorkspaceState({ groupId: state.groupId, tabIds: state.tabIds, leases: state.leases });
  let updated = await readTab(wanted);
  if (updated) {
    try { updated = await chrome.tabs.update(wanted, { url: workspaceIdleUrl(), active: false }); } catch {}
  }
  await setWorkspaceGroupActivity(state);
  return {
    workspace: true,
    released: true,
    closed: false,
    groupId: state.groupId,
    tabId: wanted,
    wasActive: Boolean(updated?.active),
  };
}

async function workspaceStatus() {
  const state = await reconcileWorkspaceState();
  if (!state) return { initialized: false, title: WORKSPACE_GROUP_TITLE, color: WORKSPACE_GROUP_COLOR };
  return {
    initialized: true,
    groupId: state.groupId,
    tabIds: state.tabIds,
    poolSize: state.tabIds.length,
    leasedTabIds: Object.keys(state.leases).map(Number),
    idleTabIds: state.tabIds.filter((id) => !state.leases[String(id)]),
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
  const tab = await chrome.tabs.get(numericTabId(tabId));
  assertUrlAllowed(tab.url, compiled);
  return tab;
}

function pageSnapshot(maxTextChars, maxElements) {
  function selectorFor(element) {
    if (!(element instanceof Element)) return null;
    if (element.id) return `#${CSS.escape(element.id)}`;
    const attrs = ["data-testid", "data-test", "data-qa", "name", "aria-label"];
    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (value) return `${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth += 1) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {}
      current = parent;
    }
    return parts.join(" > ") || null;
  }

  const bodyText = (document.body?.innerText || "").slice(0, maxTextChars);
  const candidates = [...document.querySelectorAll(
    "a[href],button,input,textarea,select,[contenteditable=true],[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio]",
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
      value = type === "password" ? "<redacted>" : String(element.value || "").slice(0, 500);
    }
    elements.push({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      type,
      role: element.getAttribute("role"),
      text: String(element.innerText || element.textContent || "").trim().slice(0, 500),
      ariaLabel: element.getAttribute("aria-label"),
      name: element.getAttribute("name"),
      placeholder: element.getAttribute("placeholder"),
      href: element instanceof HTMLAnchorElement ? element.href : null,
      disabled: Boolean(element.disabled),
      checked: "checked" in element ? Boolean(element.checked) : null,
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

function pageClick(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element matches selector: ${selector}`);
  if (element instanceof HTMLInputElement && element.type === "file") {
    const error = new Error("File pickers require foreground/user interaction; background mode will not open one.");
    error.code = "CHROME_FOREGROUND_REQUIRED";
    throw error;
  }
  element.click();
  return { clicked: true, selector, title: document.title, url: location.href };
}

function pageFill(selector, value, submit) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element matches selector: ${selector}`);
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
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element instanceof HTMLSelectElement) {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const error = new Error(`Element ${selector} is not fillable.`);
    error.code = "CHROME_ELEMENT_NOT_FILLABLE";
    throw error;
  }
  if (submit) {
    const form = element.closest("form");
    if (form?.requestSubmit) form.requestSubmit();
    else element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }
  return { filled: true, submitted: Boolean(submit), selector, title: document.title, url: location.href };
}

async function executeInTab(tabId, func, args) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
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
  if (message.method === "workspace.status") return await workspaceStatus();
  if (message.method === "workspace.init") return await initializeWorkspace(args.poolSize);

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

    case "workspace.release":
      return await releaseWorkspaceTab(args.tabId) || { released: false, workspace: false, tabId: numericTabId(args.tabId) };

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

    case "tabs.snapshot": {
      const tab = await getApprovedTab(args.tabId, compiled);
      const maxTextChars = Math.max(1_000, Math.min(200_000, Number(args.maxTextChars || 50_000)));
      const maxElements = Math.max(1, Math.min(500, Number(args.maxElements || 200)));
      return await executeInTab(tab.id, pageSnapshot, [maxTextChars, maxElements]);
    }

    case "tabs.click": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageClick, [String(args.selector || "")]);
    }

    case "tabs.fill": {
      const tab = await getApprovedTab(args.tabId, compiled);
      return await executeInTab(tab.id, pageFill, [String(args.selector || ""), String(args.value ?? ""), Boolean(args.submit)]);
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
    let workspace = await reconcileWorkspaceState();
    if (!workspace) workspace = await initializeWorkspaceIfChromeFocused();
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
