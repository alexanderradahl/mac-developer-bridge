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
    this.attributes = new Map();
  }
  getBoundingClientRect() {
    return this.visible
      ? { width: 400, height: 120, left: 0, top: 0 }
      : { width: 0, height: 0, left: 0, top: 0 };
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
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
  requestSubmit(submitter) { this.requestSubmitCalls.push(submitter ?? null); }
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
  }
  get value() { return this._value; }
  set value(next) { this._value = String(next); }
  focus() {}
  select() {}
  dispatchEvent(event) { this.events.push(event.type); return true; }
  closest(selector) { return selector === "form" ? this.form : null; }
}
class FakeTextAreaElement extends FakeInputElement {
  constructor(options = {}) { super(options); this.tagName = "TEXTAREA"; }
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

function createContext(matches) {
  return vm.createContext({
    document: {
      title: "Background Reddit composer",
      querySelectorAll: () => matches,
      execCommand: () => false,
    },
    location: { href: "https://old.reddit.com/r/test/comments/example/" },
    Element: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLSelectElement: FakeSelectElement,
    InputEvent: FakeEvent,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    getComputedStyle: (element) => ({
      display: element.visible ? "block" : "none",
      visibility: element.visible ? "visible" : "hidden",
      opacity: "1",
    }),
    // Deliberately never invoke the callback: Chrome can suspend rAF in an
    // inactive background tab, which previously left chrome_fill unresolved.
    requestAnimationFrame: () => 1,
    setTimeout,
    clearTimeout,
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
  assert.deepEqual(element.events, ["input", "change"]);
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

console.log(JSON.stringify({ passed: true, scenarios: ["suspended-background-frame", "hidden-first-visible-submit", "hidden-only-fails-closed"] }));
