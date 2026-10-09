import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deps = process.env.MDB_BROWSER_TEST_NODE_MODULES;
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.MDB_BROWSER_TEST_PLAYWRIGHT || require.resolve("playwright"));
const { build } = await import(deps ? path.join(deps, "esbuild/lib/main.js") : require.resolve("esbuild"));
const workerPath = path.resolve(process.env.MDB_BROWSER_TEST_WORKER || path.join(root, "chrome-extension/service-worker.js"));
const worker = await fs.readFile(workerPath, "utf8");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function extract(name) {
  const start = worker.indexOf("function " + name + "(");
  const asyncStart = worker.lastIndexOf("async ", start);
  const actualStart = asyncStart === start - 6 ? asyncStart : start;
  const end = worker.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start);
  const source = worker.slice(actualStart, end + 2);
  new vm.Script("(" + source + ")");
  return source;
}
const actions = ["pagePasteContent", "pageSnapshot", "pageClick"].map(extract).join("\n") + "\nwindow.mdbPasteActions={pagePasteContent,pageSnapshot,pageClick};";
const bundle = await build({
  entryPoints: [path.join(root, "tests/fixtures/chrome-prosemirror-paste.mjs")],
  bundle: true, write: false, format: "iife", platform: "browser",
  nodePaths: deps ? [deps] : [], logLevel: "silent",
});
const moduleText = bundle.outputFiles[0].text;
const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mdb-rich-paste-browser-")));
await fs.chmod(profile, 0o700);
const saved = new Map(), results = [], measurements = {}, blockedRequests = [], imageRequests = [];
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
let origin;
const documentHtml = '<!doctype html><meta charset="utf-8"><title>Owned rich paste fixture</title><style>body{font:16px sans-serif;padding:20px}.ProseMirror,#plain{border:1px solid #777;min-height:80px;padding:12px;white-space:pre-wrap}img{width:80px;height:50px}#hidden{display:none}</style><h1>Article editing fixture</h1><img id="cover" src="/cover.png" alt="Unchanged cover"><div id="mount"></div><div id="plain" contenteditable="true"><p>Plain <strong>original</strong> body.</p></div><input id="decoy-input"><p id="outside">Outside editor</p><div id="disabled" contenteditable="true" aria-disabled="true">Disabled</div><div id="readonly" contenteditable="true" aria-readonly="true">Read only</div><div id="hidden" contenteditable="true">Hidden</div><div class="ambiguous" contenteditable="true">First</div><div class="ambiguous" contenteditable="true">Second</div><button id="save">Save article</button><script src="/actions.js"></script><script src="/fixture.js"></script>';
const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.headers.host !== "127.0.0.1:" + server.address().port) { response.writeHead(403).end(); return; }
  const url = new URL(request.url, origin);
  const scenario = url.searchParams.get("scenario") || "default";
  if (url.pathname === "/fixture") response.writeHead(200, { "Content-Type": "text/html" }).end(documentHtml);
  else if (url.pathname === "/actions.js") response.writeHead(200, { "Content-Type": "text/javascript" }).end(actions);
  else if (url.pathname === "/fixture.js") response.writeHead(200, { "Content-Type": "text/javascript" }).end(moduleText);
  else if (url.pathname === "/cover.png") response.writeHead(200, { "Content-Type": "image/png" }).end(imageBytes);
  else if (url.pathname === "/state") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(saved.get(scenario) || { count: 0, doc: null }));
  else if (url.pathname === "/save" && request.method === "POST") {
    let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 300000) { response.writeHead(413).end(); return; } }
    const value = JSON.parse(body);
    const next = { count: (saved.get(scenario)?.count || 0) + 1, doc: value.doc };
    saved.set(scenario, next);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(next));
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + server.address().port;
const html = '<h2>Where it stands</h2><p>A <strong>real game</strong> with <em>that particular</em> meal.</p><p><img src="https://media.example.test/one.png" alt="Mika at the bay"></p><p>Mika, and what she wants right now.</p><h3>Linden Rise</h3><p><img src="https://media.example.test/two.png" alt="The Overlook bench"></p><p>The Overlook at 7:30 pm.</p><ul><li>Send feedback</li></ul><blockquote>A town on a hill.</blockquote><p><a href="https://simgoodie.example/devlog/game-log-1/">Original Game Log</a></p>';
const plainText = "Where it stands\nA real game with that particular meal.\nMika, and what she wants right now.\nLinden Rise\nThe Overlook at 7:30 pm.\nSend feedback\nA town on a hill.\nOriginal Game Log";
let context, fatalError;
async function scenario(name, run) {
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  try {
    await page.goto(origin + "/fixture?scenario=" + encodeURIComponent(name));
    await page.waitForSelector('body[data-ready="true"]');
    const read = () => page.evaluate(() => fixtureEvidence());
    const call = async (overrides = {}, options = {}) => {
      const selector = overrides.selector || "#editor";
      const snapshot = await page.evaluate(() => mdbPasteActions.pageSnapshot(10000, 100));
      const editable = snapshot.elements.find(value => value.selector === selector);
      const content = { html, plainText, mode: "replace", expectedText: editable?.editableText ?? "", ...overrides };
      delete content.selector;
      return await page.evaluate(async ({ selector, content, options }) => {
        try { return { result: await mdbPasteActions.pagePasteContent(selector, content, { deadlineMs: Date.now() + 3000, ...options }) }; }
        catch (error) { return { error: { code: error.code, message: error.message, details: error.details } }; }
      }, { selector, content, options });
    };
    await run(page, call, read);
    results.push({ name, passed: true });
  } catch (error) {
    measurements[name] = { ...(measurements[name] || {}), error: error.message, stack: error.stack, state: await page.evaluate(() => fixtureEvidence?.()).catch(() => null) };
    results.push({ name, passed: false, error: error.message });
  } finally { await page.close(); }
}
function accepted(response) {
  assert.ok(!response.error, JSON.stringify(response.error));
  assert.equal(response.result.pasteDispatched, true);
  assert.equal(response.result.applicationAccepted, null);
  assert.equal(response.result.outcomeVerified, false);
  return response.result;
}
function collect(doc, type) {
  const found = []; function visit(node) { if (node.type === type) found.push(node); for (const child of node.content || []) visit(child); }
  visit(doc); return found;
}
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: process.env.MDB_BROWSER_TEST_CHANNEL || "chrome", viewport: { width: 1100, height: 1000 }, serviceWorkers: "block", acceptDownloads: false });
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) await route.continue();
    else if (/^https:\/\/media\.example\.test\/(?:one|two)\.png$/u.test(url)) {
      imageRequests.push(url); await route.fulfill({ status: 200, contentType: "image/png", body: imageBytes });
    } else { blockedRequests.push(url); await route.abort("blockedbyclient"); }
  });
  for (const name of ["framework-replace-save-reload", "framework-unfocused-save-reload"]) await scenario(name, async (page, call, read) => {
    let decoy;
    if (name.includes("unfocused")) {
      decoy = await context.newPage(); await decoy.goto(origin + "/fixture?scenario=decoy"); await decoy.bringToFront();
      const cdp = await context.newCDPSession(page); await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      assert.equal((await read()).hasFocus, false);
    }
    const before = await read();
    const result = accepted(await call());
    const after = await read();
    assert.equal(after.pasteEvents.length, 1);
    assert.deepEqual(after.pasteEvents[0].types, ["text/html", "text/plain"]);
    assert.equal(after.pasteEvents[0].trusted, false);
    assert.equal(after.saveAttempts, 0);
    assert.equal(saved.get(name), undefined, "Paste never saves implicitly");
    assert.equal(result.pasteDefaultPrevented, true, "ProseMirror's public paste handler accepts and cancels browser default");
    assert.equal(result.domChanged, true);
    assert.deepEqual(collect(after.doc, "heading").map(node => node.attrs.level), [2, 3]);
    assert.deepEqual(collect(after.doc, "image").map(node => [node.attrs.src, node.attrs.alt]), [
      ["https://media.example.test/one.png", "Mika at the bay"], ["https://media.example.test/two.png", "The Overlook bench"],
    ]);
    assert.ok(collect(after.doc, "text").some(node => node.text === "real game" && node.marks?.some(mark => mark.type === "strong")));
    assert.ok(collect(after.doc, "text").some(node => node.text === "that particular" && node.marks?.some(mark => mark.type === "em")));
    assert.ok(collect(after.doc, "text").some(node => node.marks?.some(mark => mark.type === "link" && mark.attrs.href === "https://simgoodie.example/devlog/game-log-1/")));
    assert.equal(after.headerSrc, before.headerSrc);
    await page.evaluate(() => mdbPasteActions.pageClick("#save", { clickStrategy: "dom-click", deadlineMs: Date.now() + 3000 }));
    await page.waitForFunction(() => fixtureEvidence().saves === 1);
    assert.equal(saved.get(name).count, 1);
    const expectedDoc = after.doc;
    await page.reload(); await page.waitForSelector('body[data-ready="true"]');
    const reloaded = await read();
    assert.deepEqual(reloaded.doc, expectedDoc, "Actual editor-model state survives server save and a fresh document");
    assert.equal(reloaded.pasteEvents.length, 0, "Reload does not replay paste");
    const snap = await page.evaluate(() => mdbPasteActions.pageSnapshot(20000, 100));
    const editable = snap.elements.find(node => node.selector === "#editor");
    assert.equal(editable.editableText, reloaded.editorText);
    assert.equal(editable.editableTextTruncated, false);
    assert.deepEqual(editable.editableNodes.filter(node => node.tag === "img").map(node => node.alt), ["Mika at the bay", "The Overlook bench"]);
    assert.deepEqual(editable.editableNodes.filter(node => node.tag === "h2" || node.tag === "h3").map(node => node.text), ["Where it stands", "Linden Rise"]);
    measurements[name] = { result, doc: reloaded.doc, snapshot: editable, saveCount: saved.get(name).count, pasteCount: after.pasteEvents.length, pasteFocus: after.pasteEvents[0].hasFocus };
    if (decoy) await decoy.close();
  });
  await scenario("append-preserves-existing-model", async (page, call, read) => {
    const before = await read();
    const result = accepted(await call({ mode: "append", html: "<p>Appended <em>news</em>.</p>", plainText: "Appended news." }));
    const after = await read();
    assert.ok(after.editorText.startsWith(before.editorText));
    assert.match(after.editorText, /Appended news\./u);
    assert.ok(collect(after.doc, "text").some(node => node.text === "content." && node.marks?.some(mark => mark.type === "strong")));
    measurements["append-preserves-existing-model"] = { result, doc: after.doc };
  });
  for (const name of ["unhandled", "cancel"]) await scenario(name, async (page, call, read) => {
    const selector = name === "unhandled" ? "#plain" : "#editor";
    const before = await read();
    const result = accepted(await call({ selector }));
    const after = await read();
    assert.deepEqual(after.doc, before.doc);
    assert.equal(after.plainText, before.plainText);
    assert.equal(after.pasteEvents.length, 1);
    assert.equal(result.domChanged, false);
    assert.equal(result.pasteDefaultPrevented, name === "cancel");
    assert.equal(after.saveAttempts, 0);
    measurements[name] = { result, unchanged: true };
  });
  for (const [name, overrides, code] of [
    ["missing", { selector: "#missing" }, "CHROME_ELEMENT_NOT_FOUND"],
    ["ambiguous", { selector: ".ambiguous" }, "CHROME_SELECTOR_NOT_UNIQUE"],
    ["native-input", { selector: "#decoy-input" }, "CHROME_ELEMENT_NOT_CONTENTEDITABLE"],
    ["inherited-child", { selector: "#editor p" }, "CHROME_SELECTOR_NOT_UNIQUE"],
    ["disabled", { selector: "#disabled" }, "CHROME_ELEMENT_DISABLED"],
    ["readonly", { selector: "#readonly" }, "CHROME_ELEMENT_READ_ONLY"],
    ["hidden", { selector: "#hidden" }, "CHROME_ELEMENT_NOT_VISIBLE"],
    ["stale-text", { expectedText: "Someone else's draft" }, "CHROME_PASTE_TEXT_CHANGED"],
    ["unsafe-html", { html: '<img src="https://example.test/a.png" onerror="alert(1)">' }, "CHROME_PASTE_HTML_INVALID"],
  ]) await scenario(name, async (page, call, read) => {
    const response = await call(overrides);
    assert.equal(response.error?.code, code, JSON.stringify(response));
    assert.equal(response.error.details.pasteDispatched, false);
    assert.equal((await read()).pasteEvents.length, 0);
  });
  await scenario("inherited-single-child", async (page, call, read) => {
    const response = await call({ selector: "#editor p:first-child" });
    assert.equal(response.error?.code, "CHROME_ELEMENT_NOT_CONTENTEDITABLE");
    assert.equal((await read()).pasteEvents.length, 0);
  });
  for (const [name, code] of [
    ["focus-replace", "CHROME_TARGET_CHANGED"], ["focus-readonly", "CHROME_ELEMENT_READ_ONLY"],
    ["focus-text", "CHROME_PASTE_TEXT_CHANGED"], ["focus-redirect", "CHROME_FOCUS_CHANGED"],
    ["selection-escape", "CHROME_PASTE_SELECTION_CHANGED"],
  ]) await scenario(name, async (page, call, read) => {
    await page.evaluate(() => armFixtureGuard());
    const response = await call();
    assert.equal(response.error?.code, code, JSON.stringify(response));
    assert.equal(response.error.details.pasteDispatched, false);
    assert.equal((await read()).pasteEvents.length, 0);
  });
  await scenario("expired-deadline", async (page, call, read) => {
    const response = await call({}, { deadlineMs: 1 });
    assert.equal(response.error?.code, "CHROME_OPERATION_DEADLINE_EXCEEDED");
    assert.equal(response.error.details.pasteDispatched, false);
    assert.equal((await read()).pasteEvents.length, 0);
  });
  await scenario("changed-document-url", async (page, call, read) => {
    const response = await call({}, { expectedUrl: origin + "/other" });
    assert.equal(response.error?.code, "CHROME_DOCUMENT_CHANGED");
    assert.equal(response.error.details.pasteDispatched, false);
  });
  for (const [name, code, options] of [
    ["post-paste-replace", "CHROME_TARGET_CHANGED", {}],
    ["post-paste-deadline", "CHROME_OPERATION_DEADLINE_EXCEEDED", { deadlineMs: Date.now() + 120000 }],
  ]) await scenario(name, async (page, call, read) => {
    const response = name === "post-paste-deadline"
      ? await call({}, { deadlineMs: Date.now() + 100 })
      : await call({}, options);
    assert.equal(response.error?.code, code, JSON.stringify(response));
    assert.equal(response.error.details.pasteDispatched, true);
    assert.equal((await read()).pasteEvents.length, 1);
    measurements[name] = response;
  });
  await scenario("whitespace-guard-and-long-snapshot", async (page, call, read) => {
    const text = "  Long\u00a0 draft  \n\n" + "body ".repeat(1200) + "\n\n last  ";
    await page.evaluate(text => { document.getElementById("plain").textContent = text; }, text);
    const snapshot = await page.evaluate(() => mdbPasteActions.pageSnapshot(20000, 100));
    const editable = snapshot.elements.find(node => node.selector === "#plain");
    assert.ok(editable.editableText.length > 500);
    assert.equal(editable.editableTextTruncated, false);
    accepted(await call({ selector: "#plain", expectedText: text.replace(/\s+/gu, " ").trim() }));
    assert.equal((await read()).pasteEvents.length, 1);
  });
  await scenario("bounded-passive-editor-inventory", async (page, call, read) => {
    await page.evaluate(() => {
      for (let index = 0; index < 30; index++) {
        const editable = document.createElement("div");
        editable.contentEditable = "true"; editable.id = "extra-editor-" + index;
        for (let p = 0; p < 30; p++) {
          const paragraph = document.createElement("p"); paragraph.textContent = "visible ".repeat(60);
          editable.appendChild(paragraph);
        }
        document.body.appendChild(editable);
      }
    });
    const before = await read();
    const snapshot = await page.evaluate(() => mdbPasteActions.pageSnapshot(20000, 500));
    const editables = snapshot.elements.filter(node => Object.hasOwn(node, "editableText"));
    assert.ok(editables.reduce((sum, node) => sum + node.editableText.length, 0) <= 64000);
    assert.ok(editables.reduce((sum, node) => sum + node.editableNodes.length, 0) <= 200);
    assert.ok(editables.some(node => node.editableTextTruncated));
    assert.equal((await read()).pasteEvents.length, before.pasteEvents.length);
    assert.equal((await read()).transactions, before.transactions);
  });
  assert.deepEqual(blockedRequests, [], "No network request outside the owned fixture/image intercepts");
} catch (error) { fatalError = { message: error.message, stack: error.stack }; }
finally {
  const browserVersion = context ? await context.pages()[0]?.evaluate(() => navigator.userAgent).catch(() => null) : null;
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
  const versions = {};
  for (const name of ["prosemirror-model", "prosemirror-state", "prosemirror-view", "prosemirror-schema-basic", "prosemirror-schema-list", "playwright"]) {
    if (deps) versions[name] = JSON.parse(await fs.readFile(path.join(deps, name, "package.json"), "utf8")).version;
  }
  const report = { generatedAt: new Date().toISOString(), workerSha256: hash(worker), workerSha256AtEnd: hash(await fs.readFile(workerPath)), browserVersion, nodeVersion: process.version, versions, passed: results.filter(x => x.passed).length, total: results.length, results, measurements, blockedRequests, interceptedImageRequestCount: imageRequests.length, cleanup: { browserClosed: true, profileRemoved: true, serverClosed: true }, ...(fatalError ? { fatalError } : {}) };
  if (process.env.MDB_BROWSER_TEST_OUTPUT) await fs.writeFile(process.env.MDB_BROWSER_TEST_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, total: report.total, results, fatalError, cleanup: report.cleanup }, null, 2));
  if (fatalError || results.some(x => !x.passed)) process.exitCode = 1;
}
