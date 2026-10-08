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
{
  const clickStart = source.indexOf("async function pageClick(");
  const clickEnd = source.indexOf("\nasync function pageDrag(", clickStart);
  assert.ok(clickStart >= 0 && clickEnd > clickStart);
  const clickSource = source.slice(clickStart, clickEnd);
  class FakeEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  }
  class FakeMouseEvent extends FakeEvent {}
  class FakePointerEvent extends FakeMouseEvent {}
  class FakeElement {
    constructor() { this.isConnected = true; this.events = []; }
    getAttribute() { return null; }
    matches(selector) { return selector === "#target"; }
    closest() { return null; }
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 20, top: 40, width: 100, height: 40 }; }
    dispatchEvent(event) { this.events.push(event); return true; }
    focus() {}
    click() { throw new Error("HTMLElement.click must not replace the pointer sequence's final activation"); }
  }
  class FakeInput extends FakeElement {}
  for (const hasPointerEvents of [true, false]) {
    const element = new FakeElement();
    const window = { innerWidth: 800, innerHeight: 600, screenX: 10, screenY: 20 };
    const document = { querySelector: () => element, title: "Pointer activation fixture", getElementById: () => null };
    const context = vm.createContext({
      Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput,
      MouseEvent: FakeMouseEvent, PointerEvent: hasPointerEvents ? FakePointerEvent : undefined,
      KeyboardEvent: FakeEvent, window, document, location: { href: "https://fixture.invalid/" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      setTimeout, Date,
    });
    const click = vm.runInContext(`(${clickSource})`, context);
    const result = await click("#target");
    const clicks = element.events.filter((event) => event.type === "click");
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].detail, 1);
    assert.equal(clicks[0].clientX, 70);
    assert.equal(clicks[0].clientY, 60);
    assert.equal(clicks[0].buttons, 0);
    assert.equal(clicks[0].view, window);
    assert.equal(element.events.find((event) => event.type === "mouseup").detail, 1);
    if (hasPointerEvents) {
      assert.ok(clicks[0] instanceof FakePointerEvent);
      assert.equal(clicks[0].pointerType, "mouse");
      assert.equal(clicks[0].pointerId, 1);
      assert.equal(element.events.find((event) => event.type === "pointermove").button, -1);
    } else assert.ok(clicks[0] instanceof FakeMouseEvent);
    assert.equal(result.clicked, true);
    assert.equal(result.trusted, false);
    assert.equal(result.outcomeVerified, false);
  }
  scenarios.push("coherent-pointer-click-with-mouse-fallback-without-HTMLElement-click");
}
{
  const clickStart = source.indexOf("async function pageClick(");
  const clickSource = source.slice(clickStart, source.indexOf("\nasync function pageDrag(", clickStart));
  class FakeEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  }
  class FakeElement {
    constructor() {
      this.isConnected = true; this.disabled = false; this.events = [];
      this.armed = true; this.activations = 0; this.nativeClicks = 0; this.focuses = 0; this.scrolls = 0;
    }
    getAttribute() { return null; }
    matches(selector) { return selector === ":disabled" ? this.disabled : selector === "#target"; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 30 }; }
    scrollIntoView() { this.scrolls += 1; }
    focus() { this.focuses += 1; }
    dispatchEvent(event) {
      this.events.push(event.type);
      if (event.type === "mousedown") this.armed = false;
      if (event.type === "click" && this.armed) this.activations += 1;
      return true;
    }
    click() { this.nativeClicks += 1; this.dispatchEvent(new FakeEvent("click", { detail: 0 })); }
  }
  class FakeInput extends FakeElement {}
  const fixture = () => {
    const element = new FakeElement();
    const context = vm.createContext({
      Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput,
      MouseEvent: FakeEvent, PointerEvent: FakeEvent, KeyboardEvent: FakeEvent,
      window: { innerWidth: 800, innerHeight: 600 },
      document: { querySelector: () => element, getElementById: () => null, title: "Explicit DOM activation fixture" },
      location: { href: "https://fixture.invalid/" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      setTimeout, Date,
    });
    return { element, click: vm.runInContext(`(${clickSource})`, context) };
  };
  const direct = fixture();
  const result = await direct.click("#target", { clickStrategy: "dom-click" });
  assert.equal(direct.element.activations, 1);
  assert.equal(direct.element.nativeClicks, 1);
  assert.equal(direct.element.focuses, 0);
  assert.equal(direct.element.scrolls, 0);
  assert.deepEqual(direct.element.events, ["click"], "direct activation has no synthetic prelude");
  assert.equal(result.strategy, "dom-click");
  assert.equal(result.trusted, false);
  assert.equal(result.applicationAccepted, null);
  const adaptive = fixture();
  await adaptive.click("#target");
  assert.equal(adaptive.element.activations, 0, "this fixture intentionally has different mousedown semantics");
  assert.equal(adaptive.element.nativeClicks, 0, "adaptive remains the explicit pointer sequence");
  for (const blocked of ["disabled", "expired", "detached", "invalid-strategy"]) {
    const f = fixture();
    if (blocked === "disabled") f.element.disabled = true;
    if (blocked === "detached") f.element.isConnected = false;
    const options = { clickStrategy: blocked === "invalid-strategy" ? "automatic-retry" : "dom-click",
      ...(blocked === "expired" ? { deadlineMs: Date.now() - 1 } : {}) };
    const code = { disabled: "CHROME_ELEMENT_DISABLED", expired: "CHROME_OPERATION_DEADLINE_EXCEEDED",
      detached: "CHROME_TARGET_CHANGED", "invalid-strategy": "CHROME_CLICK_STRATEGY_INVALID" }[blocked];
    await assert.rejects(() => f.click("#target", options),
      (error) => error.code === code && error.details.actionDispatched === false);
    assert.equal(f.element.nativeClicks, 0);
    assert.deepEqual(f.element.events, []);
  }
  scenarios.push("explicit-dom-click-one-activation-without-pointer-or-focus-prelude");
  scenarios.push("direct-click-disabled-expired-detached-invalid-fail-before-action");
}
{
  const clickStart = source.indexOf("async function pageClick(");
  const clickSource = source.slice(clickStart, source.indexOf("\nasync function pageDrag(", clickStart));
  class FakeEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  class FakeElement {
    constructor() {
      this.isConnected = true; this.disabled = false; this.events = []; this.listeners = new Map();
      this.armed = false; this.activations = 0; this.focuses = 0; this.nativeFocusEvents = [];
    }
    getAttribute() { return null; }
    matches(selector) { return selector === ":disabled" ? this.disabled : selector === "#target"; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 30 }; }
    scrollIntoView() {}
    focus() {
      this.focuses += 1;
      const transitioned = this.ownerDocument.activeElement !== this;
      this.ownerDocument.activeElement = this;
      if (transitioned) for (const type of this.nativeFocusEvents) this.dispatchEvent(new FakeEvent(type, { isTrusted: true }));
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) {
      event.target = this;
      this.events.push(event.type);
      for (const callback of this.listeners.get(event.type) || []) callback(event);
      if (event.type === "focusin") this.armed = true;
      if (event.type === "click" && this.armed) this.activations += 1;
      return this.onEvent?.(event) !== false;
    }
    click() { this.dispatchEvent(new FakeEvent("click")); }
  }
  class FakeInput extends FakeElement {}
  const makeFixture = () => {
    const element = new FakeElement();
    let now = 100;
    const document = { querySelector: () => element, getElementById: () => null, title: "Inactive focus activation fixture",
      hasFocus: () => false, activeElement: null, addEventListener() {}, removeEventListener() {} };
    element.ownerDocument = document;
    const context = vm.createContext({
      Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput,
      MouseEvent: FakeEvent, PointerEvent: FakeEvent, KeyboardEvent: FakeEvent, FocusEvent: FakeEvent,
      window: { innerWidth: 800, innerHeight: 600 }, document,
      location: { href: "https://fixture.invalid/" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      setTimeout, Date: { now: () => now },
    });
    return { element, document, expire: () => { now = 1000; }, click: vm.runInContext(`(${clickSource})`, context) };
  };
  for (const nativeEvents of [[], ["focus"], ["focus", "focusin"]]) {
    const f = makeFixture();
    f.element.nativeFocusEvents = nativeEvents;
    const result = await f.click("#target");
    assert.equal(f.element.activations, 1, "focusin-dependent activation must receive its missing background event");
    assert.equal(f.element.focuses, 1);
    for (const type of ["focus", "focusin"]) assert.equal(f.element.events.filter((name) => name === type).length, 1);
    assert.equal(result.focusEventFallbackUsed, nativeEvents.length !== 2);
    assert.equal(result.trusted, false);
  }
  const direct = makeFixture();
  const result = await direct.click("#target", { clickStrategy: "dom-click" });
  assert.deepEqual(direct.element.events, ["click"]);
  assert.equal(direct.element.focuses, 0);
  assert.equal(result.focusEventFallbackUsed, false, "explicit direct DOM click must still omit all focus preludes");
  scenarios.push("inactive-adaptive-focus-events-once-with-direct-mode-unchanged");
  for (const phase of ["focus", "focusin"]) {
    for (const mutation of ["disabled", "detached", "deadline", "refocus"]) {
      const f = makeFixture();
      f.element.onEvent = (event) => {
        if (event.type !== phase) return true;
        if (mutation === "disabled") f.element.disabled = true;
        if (mutation === "detached") f.element.isConnected = false;
        if (mutation === "deadline") f.expire();
        if (mutation === "refocus") f.document.activeElement = null;
        return true;
      };
      const code = { disabled: "CHROME_ELEMENT_DISABLED", detached: "CHROME_TARGET_CHANGED", deadline: "CHROME_OPERATION_DEADLINE_EXCEEDED", refocus: "CHROME_FOCUS_CHANGED" }[mutation];
      await assert.rejects(() => f.click("#target", { deadlineMs: 500 }), (error) => error.code === code);
      assert.equal(f.element.activations, 0);
      assert.equal(f.element.events.includes("click"), false);
      assert.equal(f.element.events.includes("pointerup"), false, "reentrant focus must stop the remaining pointer sequence");
      for (const type of ["focus", "focusin"]) assert.equal(f.element.listeners.get(type)?.size, 0);
    }
  }
  scenarios.push("adaptive-focus-handler-mutations-stop-before-remaining-pointer-events");
}
console.log(JSON.stringify({ passed: true, scenarios }));
