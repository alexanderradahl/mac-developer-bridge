import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = await fs.readFile(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
const match = workerSource.match(/async function pageFill\([\s\S]*?\n}\n\nasync function executeInTab/);
assert.ok(match, "pageFill source should be extractable for the background-frame regression");
const pageFillSource = match[0].replace(/\n\nasync function executeInTab$/, "");

class FakeElement {
  constructor({ visible = true, disabled = false, tagName = "DIV" } = {}) {
    this.visible = visible;
    this.disabled = disabled;
    this.tagName = tagName;
    this.isContentEditable = false;
    this.isConnected = true;
    this.readOnly = false;
    this.attributes = new Map();
  }
  getBoundingClientRect() {
    return this.visible
      ? { width: 400, height: 120, left: 0, top: 0 }
      : { width: 0, height: 0, left: 0, top: 0 };
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  matches(selector) {
    if (selector === ":disabled") return this.disabled;
    return this.tagName === "BUTTON" && this.getAttribute("type") === "submit";
  }
}
class FakeForm extends FakeElement {
  constructor({ submitter = null } = {}) {
    super({ tagName: "FORM" });
    this.submitter = submitter;
    this.requestSubmitCalls = [];
    this.action = "https://old.reddit.com/api/comment";
    this.method = "post";
  }
  querySelectorAll() { return this.submitter ? [this.submitter] : []; }
  requestSubmit(submitter) {
    this.requestSubmitCalls.push(submitter ?? null);
    this.ownerDocument.dispatchEvent({ type: "submit", target: this, defaultPrevented: false });
  }
}
class FakeButtonElement extends FakeElement {
  constructor({ visible = true, disabled = false } = {}) {
    super({ visible, disabled, tagName: "BUTTON" });
    this.setAttribute("type", "submit");
  }
  click() {}
}
class FakeInputElement extends FakeElement {
  constructor({ visible = true, disabled = false, form = null } = {}) {
    super({ visible, disabled, tagName: "INPUT" });
    this._value = "";
    this.type = "text";
    this.events = [];
    this.form = form;
    this.focusCalls = 0;
    this.setterCalls = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.listeners = new Map();
  }
  get value() { return this._value; }
  set value(next) { this.setterCalls += 1; this._value = String(next); }
  focus() {
    this.focusCalls += 1;
    const transitioned = this.ownerDocument.activeElement !== this;
    this.ownerDocument.activeElement = this;
    if (transitioned) for (const type of this.nativeFocusEvents || []) this.dispatchEvent(new FakeEvent(type, { isTrusted: true }));
  }
  blur() {
    const transitioned = this.ownerDocument.activeElement === this;
    this.ownerDocument.activeElement = null;
    if (this.nativeEditDirty) {
      this.nativeEditDirty = false;
      this.dispatchEvent(new FakeEvent("change", { bubbles: true }));
    }
    if (transitioned) for (const type of this.nativeBlurEvents || []) this.dispatchEvent(new FakeEvent(type, { isTrusted: true }));
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  select() {}
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) {
    event.target = this;
    this.events.push(event.type);
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    return this.onEvent?.(event) !== false;
  }
  closest(selector) { return selector === "form" ? this.form : null; }
}
class FakeTextAreaElement extends FakeInputElement {
  constructor(options = {}) { super(options); this.tagName = "TEXTAREA"; }
  get value() { return this._value; }
  set value(next) { this.setterCalls += 1; this._value = String(next); }
}
class FakeSelectElement extends FakeInputElement {
  constructor(options = {}) { super(options); this.tagName = "SELECT"; this.options = []; }
}
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}
class FakeTextEvent extends FakeEvent {
  constructor() { super("textInput"); }
  initTextEvent(type, bubbles, cancelable, view, data) { Object.assign(this, { type, bubbles, cancelable, view, data }); }
}

function createContext(matches, { execCommand = () => false, fastFrames = false, clock = Date, legacyEvents = true, documentFocused = true } = {}) {
  const listeners = new Map();
  const document = {
    title: "Background Reddit composer",
    hasFocus: () => documentFocused,
    querySelectorAll: () => matches,
    getElementById: () => null,
    execCommand: (...args) => execCommand(document.activeElement, ...args),
    createEvent: (type) => {
      if (type !== "TextEvent" || !legacyEvents) throw new Error("Unsupported fixture event");
      return new FakeTextEvent();
    },
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    dispatchEvent: (event) => {
      for (const callback of listeners.get(event.type) || []) callback(event);
    },
  };
  for (const element of matches) {
    element.ownerDocument = document;
    if (element.form) element.form.ownerDocument = document;
  }
  return vm.createContext({
    document,
    window: {},
    location: { href: "https://old.reddit.com/r/test/comments/example/" },
    Element: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLSelectElement: FakeSelectElement,
    InputEvent: FakeEvent,
    FocusEvent: FakeEvent,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    getComputedStyle: (element) => ({
      display: element.visible ? "block" : "none",
      visibility: element.visible ? "visible" : "hidden",
      opacity: "1",
    }),
    // Deliberately never invoke the callback: Chrome can suspend rAF in an
    // inactive background tab, which previously left chrome_fill unresolved.
    requestAnimationFrame: fastFrames ? (callback) => setTimeout(callback, 0) : () => 1,
    setTimeout,
    clearTimeout,
    Date: clock,
  });
}

{
  const element = new FakeTextAreaElement();
  const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([element]));
  const startedAt = Date.now();
  const result = await Promise.race([
    pageFill('textarea[name="text"]', "background fill succeeds", false),
    new Promise((_, reject) => setTimeout(() => reject(new Error("pageFill hung on suspended requestAnimationFrame")), 1_500)),
  ]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.filled, true);
  assert.equal(result.submitted, false);
  assert.equal(result.matchCount, 1);
  assert.equal(result.selectedMatchIndex, 0);
  assert.equal(result.selectedVisible, true);
  assert.equal(element.value, "background fill succeeds");
  assert.deepEqual(element.events, ["beforeinput", "input", "change"]);
  assert.ok(elapsedMs >= 200, `expected the bounded fallback to be exercised, got ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_250, `background fill should settle well before the transport timeout, got ${elapsedMs}ms`);
}

{
  const visibleSubmitter = new FakeButtonElement();
  const hiddenSubmitter = new FakeButtonElement({ visible: false });
  const visibleForm = new FakeForm({ submitter: visibleSubmitter });
  const hiddenForm = new FakeForm({ submitter: hiddenSubmitter });
  const hiddenTemplate = new FakeTextAreaElement({ visible: false, form: hiddenForm });
  const visibleComposer = new FakeTextAreaElement({ visible: true, form: visibleForm });
  const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([hiddenTemplate, visibleComposer]));

  const result = await pageFill('textarea[name="text"]', "visible composer wins", true);

  assert.equal(hiddenTemplate.value, "", "the hidden reply template must not be filled");
  assert.equal(visibleComposer.value, "visible composer wins");
  assert.equal(result.matchCount, 2);
  assert.equal(result.fillableMatchCount, 2);
  assert.equal(result.selectedMatchIndex, 1);
  assert.equal(result.selectedVisible, true);
  assert.equal(result.submitStrategy, "requestSubmit:visible-submitter");
  assert.equal(result.submissionRequested, true);
  assert.equal(result.submissionObserved, true);
  assert.equal(result.submitted, true);
  assert.equal(result.submissionBlocked, false);
  assert.equal(result.outcomeVerified, false, "a submit event does not prove application persistence");
  assert.equal(result.submitterTag, "button");
  assert.equal(result.submitterType, "submit");
  assert.equal(result.formAction, "https://old.reddit.com/api/comment");
  assert.equal(result.formMethod, "POST");
  assert.deepEqual(hiddenForm.requestSubmitCalls, []);
  assert.deepEqual(visibleForm.requestSubmitCalls, [visibleSubmitter]);
}

{
  const hiddenOnly = new FakeTextAreaElement({ visible: false });
  const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([hiddenOnly]));
  await assert.rejects(
    () => pageFill('textarea[name="text"]', "must not enter a hidden field", false),
    (error) => error?.code === "CHROME_ELEMENT_NOT_VISIBLE",
  );
  assert.equal(hiddenOnly.value, "");
}

const nativeEditScenarios = [];
{
  for (const type of ["email", "number", "date", "range"]) {
    const element = new FakeInputElement();
    element.type = type;
    const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([element]));
    await assert.rejects(() => pageFill("input", "10", false, { inputStrategy: "insert-text" }),
      (error) => error.code === "CHROME_FILL_INPUT_STRATEGY_UNSUPPORTED" && error.details.actionDispatched === false);
    assert.equal(element.focusCalls, 0);
    assert.equal(element.setterCalls, 0);
  }
  const element = new FakeInputElement();
  const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([element]));
  await assert.rejects(() => pageFill("input", "10", false, { inputStrategy: "retry-until-accepted" }),
    (error) => error.code === "CHROME_FILL_INPUT_STRATEGY_INVALID" && error.details.actionDispatched === false);
  assert.equal(element.focusCalls, 0);
  nativeEditScenarios.push("explicit-native-edit-validation-before-focus");
}
{
  const element = new FakeInputElement();
  element._value = "previous amount";
  let nativeEdits = 0;
  const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([element], {
    fastFrames: true,
    execCommand: (target, command, showUI, value) => {
      nativeEdits += 1;
      assert.equal(command, "insertText");
      assert.equal(showUI, false);
      assert.equal(target, element);
      assert.equal(target.selectionStart, 0);
      assert.equal(target.selectionEnd, target.value.length);
      target._value = value;
      target.nativeEditDirty = true;
      target.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: value }));
      return true;
    },
  }));
  const result = await pageFill("input", "10", false, { inputStrategy: "insert-text", commit: "blur" });
  assert.equal(nativeEdits, 1);
  assert.equal(element.setterCalls, 0, "the explicit native edit must not call the value setter");
  assert.equal(element.value, "10");
  assert.deepEqual(element.events, ["beforeinput", "input", "change"], "native input and blur change must not be duplicated");
  assert.equal(result.inputStrategy, "native-insert-text");
  assert.equal(result.applicationAccepted, null);
  assert.equal(result.trusted, false);
  nativeEditScenarios.push("one-native-edit-and-one-blur-commit");
}
{
  for (const rejection of ["cancel", "selection", "focus", "readonly", "deadline", "replace", "unsupported"]) {
    const element = new FakeInputElement();
    element._value = "original";
    const matches = [element];
    let nativeEdits = 0;
    let now = 100;
    const context = createContext(matches, {
      clock: { now: () => now },
      execCommand: () => { nativeEdits += 1; return false; },
    });
    element.onEvent = (event) => {
      if (event.type !== "beforeinput") return true;
      if (rejection === "cancel") return false;
      if (rejection === "selection") element.selectionStart = 1;
      if (rejection === "focus") context.document.activeElement = null;
      if (rejection === "readonly") element.readOnly = true;
      if (rejection === "deadline") now = 1000;
      if (rejection === "replace") { element.isConnected = false; matches.splice(0); }
      return true;
    };
    const expectedCode = {
      cancel: "CHROME_INPUT_CANCELLED", selection: "CHROME_TEXT_EDIT_SELECTION_CHANGED",
      focus: "CHROME_TEXT_EDIT_SELECTION_CHANGED", readonly: "CHROME_ELEMENT_READ_ONLY",
      deadline: "CHROME_OPERATION_DEADLINE_EXCEEDED", replace: "CHROME_TARGET_CHANGED",
      unsupported: "CHROME_TEXT_EDIT_UNSUPPORTED",
    }[rejection];
    const pageFill = vm.runInContext(`(${pageFillSource})`, context);
    await assert.rejects(() => pageFill("input", "10", false, { inputStrategy: "insert-text", deadlineMs: 500 }),
      (error) => error.code === expectedCode);
    assert.equal(nativeEdits, rejection === "unsupported" ? 1 : 0, "failed native edits must never replay");
    assert.equal(element.setterCalls, 0, "failed native edits must never fall back to a setter");
    assert.equal(element.value, "original");
  }
  nativeEditScenarios.push("cancel-focus-selection-readonly-deadline-replacement-fail-without-replay");
}
{
  const element = new FakeTextAreaElement();
  element._value = "replace this text";
  let nativeEdits = 0;
  const context = createContext([element], { fastFrames: true,
    execCommand: (target, command, showUI, value) => {
      nativeEdits += 1;
      assert.equal(command, "insertText");
      target._value = value;
      target.nativeEditDirty = true;
      target.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: value }));
      return true;
    },
  });
  let intentCalls = 0;
  element.onEvent = (event) => {
    if (event.type !== "textInput") return true;
    intentCalls += 1;
    assert.equal(event.cancelable, true);
    assert.equal(event.bubbles, true);
    assert.equal(event.data, "10");
    assert.equal(element.value, "replace this text", "legacy edit intent itself must not write");
    assert.equal(nativeEdits, 0);
    return true;
  };
  const pageFill = vm.runInContext(`(${pageFillSource})`, context);
  const result = await pageFill("textarea", "10", false, { inputStrategy: "text-input", commit: "blur" });
  assert.equal(intentCalls, 1);
  assert.equal(nativeEdits, 1);
  assert.equal(element.setterCalls, 0);
  assert.deepEqual(element.events, ["beforeinput", "textInput", "input", "change"]);
  assert.equal(result.inputStrategy, "native-insert-text-with-text-input");
  assert.equal(result.applicationAccepted, null);
  nativeEditScenarios.push("explicit-legacy-text-intent-before-one-native-edit");
}
{
  for (const mutation of ["cancel", "selection", "focus", "readonly", "disabled", "deadline", "replace", "value", "page-edit", "unsupported-event"]) {
    const element = new FakeInputElement();
    element._value = "original";
    const matches = [element];
    let nativeEdits = 0;
    let now = 100;
    const context = createContext(matches, {
      clock: { now: () => now }, legacyEvents: mutation !== "unsupported-event",
      execCommand: (target, command, showUI, value) => {
        nativeEdits += 1;
        target._value = value;
        target.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: value }));
        return true;
      },
    });
    element.onEvent = (event) => {
      if (event.type !== "textInput") return true;
      if (mutation === "cancel") return false;
      if (mutation === "selection") element.selectionStart = 1;
      if (mutation === "focus") context.document.activeElement = null;
      if (mutation === "readonly") element.readOnly = true;
      if (mutation === "disabled") element.disabled = true;
      if (mutation === "deadline") now = 1000;
      if (mutation === "replace") { element.isConnected = false; matches.splice(0); }
      if (mutation === "value") element._value = "page-owned edit";
      if (mutation === "page-edit") {
        // Even a handler-owned edit that restores the identical value/selection
        // must not be followed by another native operation from the helper.
        context.document.execCommand("insertText", false, "original");
        element.setSelectionRange(0, element.value.length);
      }
      return true;
    };
    const expectedCode = {
      cancel: "CHROME_INPUT_CANCELLED", selection: "CHROME_TEXT_EDIT_SELECTION_CHANGED",
      focus: "CHROME_TEXT_EDIT_SELECTION_CHANGED", readonly: "CHROME_ELEMENT_READ_ONLY", disabled: "CHROME_ELEMENT_DISABLED",
      deadline: "CHROME_OPERATION_DEADLINE_EXCEEDED", replace: "CHROME_TARGET_CHANGED", value: "CHROME_TEXT_EDIT_SELECTION_CHANGED",
      "page-edit": "CHROME_TEXT_EDIT_ALREADY_HANDLED", "unsupported-event": "CHROME_TEXT_INPUT_EVENT_UNSUPPORTED",
    }[mutation];
    const pageFill = vm.runInContext(`(${pageFillSource})`, context);
    await assert.rejects(() => pageFill("input", "10", false, { inputStrategy: "text-input", commit: "blur", deadlineMs: 500 }),
      (error) => error.code === expectedCode);
    assert.equal(nativeEdits, mutation === "page-edit" ? 1 : 0, "page-owned or rejected edits must never be repeated");
    assert.equal(element.setterCalls, 0);
    assert.equal(element.listeners.get("input")?.size || 0, 0, "intent observation must be removed on every outcome");
  }
  const editable = new FakeInputElement();
  editable.isContentEditable = true;
  const pageFill = vm.runInContext(`(${pageFillSource})`, createContext([editable]));
  await assert.rejects(() => pageFill("[contenteditable]", "text", false, { inputStrategy: "text-input" }),
    (error) => error.code === "CHROME_FILL_INPUT_STRATEGY_UNSUPPORTED" && error.details.actionDispatched === false);
  nativeEditScenarios.push("legacy-intent-cancellation-and-reentrant-mutation-fail-without-another-edit");
}
{
  const form = new FakeForm();
  const element = new FakeInputElement({ form });
  element.setAttribute("inputmode", "decimal");
  let model = null;
  let nativeEdits = 0;
  let savedModel = null;
  form.requestSubmit = () => { form.requestSubmitCalls.push(null); savedModel = model; form.ownerDocument.dispatchEvent({ type: "submit", target: form }); };
  element.onEvent = (event) => {
    if (event.type === "focusout") { model = Number(element.value); element._value = model.toFixed(2); }
    return true;
  };
  const context = createContext([element], {
    documentFocused: false, fastFrames: true,
    execCommand: (target, command, showUI, value) => {
      nativeEdits += 1; target._value = value; target.nativeEditDirty = true;
      target.dispatchEvent(new FakeEvent("input", { inputType: "insertText", data: value }));
      return true;
    },
  });
  const result = await vm.runInContext(`(${pageFillSource})`, context)("input", "10", true, {
    inputStrategy: "text-input", commit: "blur", normalization: "numeric",
  });
  assert.equal(nativeEdits, 1);
  assert.equal(savedModel, 10, "the background focusout must commit the application model before submission");
  assert.equal(element.value, "10.00");
  assert.deepEqual(element.events, ["focus", "focusin", "beforeinput", "textInput", "input", "change", "blur", "focusout"]);
  assert.equal(form.requestSubmitCalls.length, 1);
  assert.equal(result.focusEventFallbackUsed, true);
  assert.equal(result.blurEventFallbackUsed, true);
  assert.equal(result.trusted, false);
  assert.equal(result.applicationAccepted, null);
  for (const type of ["focus", "focusin", "blur", "focusout"]) assert.equal(element.listeners.get(type)?.size, 0);
  nativeEditScenarios.push("inactive-native-focus-transitions-commit-model-once");
}
{
  for (const partial of [false, true]) {
    const element = new FakeInputElement();
    element.nativeFocusEvents = partial ? ["focus"] : ["focus", "focusin"];
    element.nativeBlurEvents = partial ? ["blur"] : ["blur", "focusout"];
    const context = createContext([element], { documentFocused: false, fastFrames: true });
    const result = await vm.runInContext(`(${pageFillSource})`, context)("input", "retained", false, { commit: "blur" });
    for (const type of ["focus", "focusin", "blur", "focusout"]) assert.equal(element.events.filter((name) => name === type).length, 1, `${type} must never be duplicated`);
    assert.equal(result.focusEventFallbackUsed, partial);
    assert.equal(result.blurEventFallbackUsed, partial);
  }
  const element = new FakeInputElement();
  const result = await vm.runInContext(`(${pageFillSource})`, createContext([element], { fastFrames: true }))("input", "retained", false, { commit: "blur" });
  assert.equal(result.focusEventFallbackUsed, false, "the fallback is restricted to unfocused documents");
  assert.equal(result.blurEventFallbackUsed, false);
  nativeEditScenarios.push("native-focus-events-never-duplicated-and-foreground-path-unchanged");
}
{
  for (const phase of ["focus", "blur"]) {
    for (const mutation of ["readonly", "disabled", "deadline", "replace", "refocus"]) {
      const form = new FakeForm();
      const element = new FakeInputElement({ form });
      const matches = [element];
      let nativeEdits = 0;
      let now = 100;
      const context = createContext(matches, {
        documentFocused: false, fastFrames: true, clock: { now: () => now },
        execCommand: (target, command, showUI, value) => {
          nativeEdits += 1; target._value = value; target.nativeEditDirty = true;
          target.dispatchEvent(new FakeEvent("input")); return true;
        },
      });
      element.onEvent = (event) => {
        if (event.type !== phase) return true;
        if (mutation === "readonly") element.readOnly = true;
        if (mutation === "disabled") element.disabled = true;
        if (mutation === "deadline") now = 1000;
        if (mutation === "replace") { element.isConnected = false; matches.splice(0); }
        if (mutation === "refocus") context.document.activeElement = phase === "focus" ? null : element;
        return true;
      };
      const expectedCode = { readonly: "CHROME_ELEMENT_READ_ONLY", disabled: "CHROME_ELEMENT_DISABLED", deadline: "CHROME_OPERATION_DEADLINE_EXCEEDED", replace: "CHROME_TARGET_CHANGED", refocus: "CHROME_FOCUS_CHANGED" }[mutation];
      await assert.rejects(() => vm.runInContext(`(${pageFillSource})`, context)("input", "10", true, { inputStrategy: "text-input", commit: "blur", deadlineMs: 500 }),
        (error) => error.code === expectedCode);
      assert.equal(nativeEdits, phase === "focus" ? 0 : 1);
      assert.equal(element.events.includes(phase === "focus" ? "focusin" : "focusout"), false, "remaining focus events must stop after a reentrant mutation");
      assert.equal(form.requestSubmitCalls.length, 0);
      for (const type of ["focus", "focusin", "blur", "focusout"]) assert.equal(element.listeners.get(type)?.size || 0, 0);
    }
  }
  nativeEditScenarios.push("reentrant-focus-handlers-stop-before-remaining-event-edit-or-submit");
}
console.log(JSON.stringify({ passed: true, scenarios: ["suspended-background-frame", "hidden-first-visible-submit", "hidden-only-fails-closed", ...nativeEditScenarios] }));
