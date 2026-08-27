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

class FakeInputElement {
  constructor() {
    this._value = "";
    this.type = "text";
    this.events = [];
    this.isContentEditable = false;
  }
  get value() { return this._value; }
  set value(next) { this._value = String(next); }
  focus() {}
  select() {}
  dispatchEvent(event) { this.events.push(event.type); return true; }
  closest() { return null; }
}
class FakeTextAreaElement extends FakeInputElement {}
class FakeSelectElement extends FakeInputElement {
  constructor() {
    super();
    this.options = [];
  }
}
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

const element = new FakeTextAreaElement();
const context = vm.createContext({
  document: {
    title: "Background Reddit composer",
    querySelector: () => element,
    execCommand: () => false,
  },
  location: { href: "https://old.reddit.com/r/test/comments/example/" },
  HTMLInputElement: FakeInputElement,
  HTMLTextAreaElement: FakeTextAreaElement,
  HTMLSelectElement: FakeSelectElement,
  InputEvent: FakeEvent,
  Event: FakeEvent,
  KeyboardEvent: FakeEvent,
  // Deliberately never invoke the callback: Chrome can suspend rAF in an
  // inactive background tab, which previously left chrome_fill unresolved.
  requestAnimationFrame: () => 1,
  setTimeout,
  clearTimeout,
});
const pageFill = vm.runInContext(`(${pageFillSource})`, context);

const startedAt = Date.now();
const result = await Promise.race([
  pageFill('textarea[name="text"]', "background fill succeeds", false),
  new Promise((_, reject) => setTimeout(() => reject(new Error("pageFill hung on suspended requestAnimationFrame")), 1_500)),
]);
const elapsedMs = Date.now() - startedAt;

assert.equal(result.filled, true);
assert.equal(result.submitted, false);
assert.equal(element.value, "background fill succeeds");
assert.deepEqual(element.events, ["input", "change"]);
assert.ok(elapsedMs >= 200, `expected the bounded fallback to be exercised, got ${elapsedMs}ms`);
assert.ok(elapsedMs < 1_250, `background fill should settle well before the transport timeout, got ${elapsedMs}ms`);

console.log(JSON.stringify({ passed: true, elapsedMs, value: element.value }));
