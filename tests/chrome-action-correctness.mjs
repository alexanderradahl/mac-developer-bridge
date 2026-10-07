import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "chrome-extension/service-worker.js"), "utf8");
const start = source.indexOf("async function executeInTab(");
const end = source.indexOf("\nasync function dispatch(", start);
assert.ok(start >= 0 && end > start);
const functions = source.slice(start, end);

function eventBus() {
  const listeners = new Set();
  return {
    addListener: (callback) => listeners.add(callback),
    removeListener: (callback) => listeners.delete(callback),
    emit: (...args) => { for (const callback of listeners) callback(...args); },
    size: () => listeners.size,
  };
}

function fixture() {
  const events = { onCreated: eventBus(), onRemoved: eventBus(), onUpdated: eventBus() };
  let injectionCalls = 0;
  let response = [{ result: { filled: true }, frameId: 0, documentId: "fixture-document" }];
  const context = vm.createContext({
    chrome: {
      tabs: events,
      scripting: { executeScript: async () => { injectionCalls += 1; return response; } },
    },
    // This unit suite verifies correlation and cleanup, not timer accuracy;
    // real browser fixtures exercise the actual asynchronous input waits.
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout,
    Date,
    Number,
    Map,
  });
  vm.runInContext(functions, context);
  return {
    events,
    execute: context.executeInTab,
    observe: context.observeTabAction,
    injectionCalls: () => injectionCalls,
    setResponse: (next) => { response = next; },
    assertClean: () => {
      for (const bus of Object.values(events)) assert.equal(bus.size(), 0, "observation listeners must be removed");
    },
  };
}

const scenarios = [];
{
  const f = fixture();
  await assert.rejects(
    () => f.execute(7, () => {}, [], "MAIN", { deadlineMs: Date.now() - 1 }),
    (error) => error.code === "CHROME_OPERATION_DEADLINE_EXCEEDED" && error.details.actionDispatched === false,
  );
  assert.equal(f.injectionCalls(), 0, "an expired action must not reach the renderer");
  scenarios.push("expired-before-injection");
}
{
  const f = fixture();
  const result = await f.execute(7, () => {}, [], "MAIN", { includeDocumentIdentity: true });
  assert.equal(result.tabId, 7);
  assert.equal(result.frameId, 0);
  assert.equal(result.documentId, "fixture-document");
  f.setResponse([{ result: { __mdbPageActionError: {
    code: "CHROME_FILL_NOT_STICKY", stage: "verify", actionDispatched: true, targetReplaced: true,
  } }, frameId: 0, documentId: "fixture-document" }]);
  await assert.rejects(
    () => f.execute(7, () => {}, [], "MAIN", { includeDocumentIdentity: true }),
    (error) => error.code === "CHROME_FILL_NOT_STICKY" && error.details.targetReplaced === true && error.details.documentId === "fixture-document",
  );
  scenarios.push("safe-renderer-error-and-document-identity");
}
{
  const f = fixture();
  f.setResponse([]);
  await assert.rejects(
    () => f.execute(7, () => {}, [], "MAIN", { includeDocumentIdentity: true }),
    (error) => error.code === "CHROME_SCRIPT_RESULT_UNAVAILABLE" && error.details.actionDispatched === null,
  );
  scenarios.push("missing-renderer-receipt-is-uncertain");
}
{
  const f = fixture();
  const result = await f.observe(7, async () => {
    f.events.onCreated.emit({ id: 40, windowId: 2, openerTabId: 9, url: "https://unrelated.invalid/" });
    f.events.onCreated.emit({ id: 41, windowId: 3, openerTabId: 7, url: "https://oauth.invalid/?secret=must-not-leak" });
    f.events.onRemoved.emit(41);
    f.events.onUpdated.emit(7, { url: "https://owner.invalid/?token=must-not-leak" });
    return { clicked: true, outcomeVerified: false };
  });
  assert.equal(result.popupObservation.childTabs.length, 1);
  assert.equal(result.popupObservation.childTabs[0].tabId, 41);
  assert.equal(result.popupObservation.childTabs[0].closed, true);
  assert.equal(result.popupObservation.navigationObserved, true);
  assert.equal(result.popupObservation.complete, false, "bounded observation is not a guarantee of no later popup");
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|oauth\.invalid|owner\.invalid|unrelated/);
  f.assertClean();
  scenarios.push("opener-correlated-popup-close-and-navigation-without-urls");
}
{
  const f = fixture();
  const result = await f.observe(7, async () => {
    for (let id = 0; id < 15; id += 1) f.events.onCreated.emit({ id, windowId: 2, openerTabId: 7 });
    return { filled: true };
  });
  assert.equal(result.popupObservation.childTabs.length, 10);
  assert.equal(result.popupObservation.childTabsTruncated, true);
  f.assertClean();
  scenarios.push("popup-observation-is-bounded");
}
{
  const f = fixture();
  await assert.rejects(
    () => f.observe(7, async () => {
      f.events.onCreated.emit({ id: 4, windowId: 2, openerTabId: 7 });
      const error = new Error("fixture action failed");
      error.code = "CHROME_FILL_NOT_STICKY";
      throw error;
    }),
    (error) => error.code === "CHROME_FILL_NOT_STICKY" && error.details.popupObservedCount === 1,
  );
  f.assertClean();
  scenarios.push("failure-keeps-safe-observation-and-cleans-listeners");
}
console.log(JSON.stringify({ passed: true, scenarios }));
