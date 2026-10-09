import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { safeChromeDiagnostics } from "../lib/chrome-extension-client.mjs";
import { isReadOnlyChromeMethod, operationFingerprint } from "../lib/chrome-operation-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = await fs.readFile(path.join(root, "chrome-extension/service-worker.js"), "utf8");
const bridge = await fs.readFile(path.join(root, "bridge.mjs"), "utf8");
const start = worker.indexOf("  function sanitizeHtml(input) {");
const end = worker.indexOf("\n  }\n", start);
assert.ok(start >= 0 && end > start);
const sanitize = vm.runInNewContext("(" + worker.slice(start, end + 4).trim() + ")", {
  URL, Set, Object, String, Number, parseInt,
  fail(code, message) { const error = new Error(message); error.code = code; throw error; },
});
const results = [];
function scenario(name, run) {
  try { run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
const html = '<h2>Where it stands</h2><p>A <strong>real game</strong> with <em>emphasis</em>.</p><p><img src="https://media.example.test/one.webp" alt="Mika &amp; the bay"></p><p>A caption.</p><ul><li>Feedback</li></ul><p><a href="https://simgoodie.example/devlog/game-log-1/">Read the original</a></p>';
scenario("allowed-content-roundtrip", () => assert.equal(sanitize(html), html));
scenario("quoted-attributes-and-entities-are-canonicalized", () => {
  assert.equal(sanitize("<P>A & B &#x1f31f; <EM>small</EM><BR/></P>"), "<p>A &amp; B 🌟 <em>small</em><br></p>");
  assert.equal(sanitize('<img src="HTTPS://MEDIA.EXAMPLE.TEST/a.png" alt="a &lt; b &quot;x&quot;">'), '<img src="https://media.example.test/a.png" alt="a &lt; b &quot;x&quot;">');
});
const attacks = [
  ["script", "<script>alert(1)</script>"],
  ["style", "<style>p{}</style>"],
  ["svg", "<svg><a>bad</a></svg>"],
  ["iframe", '<iframe src="https://example.test"></iframe>'],
  ["object", "<object></object>"], ["form", "<form><p>x</p></form>"],
  ["base", '<base href="https://evil.example/">'], ["meta", '<meta http-equiv="refresh" content="0">'],
  ["custom", "<x-editor>x</x-editor>"], ["comment", "<!--x--><p>x</p>"],
  ["handler", '<img src="https://example.test/a.png" onerror="bad()">'],
  ["style-attribute", '<p style="color:red">x</p>'],
  ["srcset", '<img src="https://example.test/a.png" srcset="https://other.test/a.png 2x">'],
  ["duplicate-attribute", '<a href="https://example.test/" HREF="https://other.test/">x</a>'],
  ["unquoted-attribute", '<a href=https://example.test/>x</a>'],
  ["unclosed-quote", '<a href="https://example.test/>x</a>'],
  ["unbalanced", "<p><strong>x</p>"], ["nested-paragraph", "<p><p>x</p></p>"],
  ["javascript-entity", '<a href="&#x6a;avascript:alert(1)">x</a>'],
  ["encoded-colon", '<a href="javascript&colon;alert(1)">x</a>'],
  ["data", '<img src="data:image/png;base64,AA==">'],
  ["http", '<img src="http://example.test/a.png">'],
  ["credentials", '<a href="https://user:secret@example.test/">x</a>'],
  ["control-character", '<a href="https://exa\nmple.test/">x</a>'],
  ["backslash", '<a href="https://example.test\\@evil.test/">x</a>'],
  ["localhost", '<img src="https://localhost/a.png">'],
  ["private-address", '<img src="https://127.0.0.1/a.png">'],
  ["local-host", '<img src="https://device.local/a.png">'],
  ["trailing-dot-localhost", '<img src="https://localhost./a.png">'],
  ["trailing-dot-local", '<img src="https://device.local./a.png">'],
  ["trailing-dot-internal", '<img src="https://service.internal./a.png">'],
  ["missing-src", '<img alt="x">'], ["missing-href", "<a>x</a>"],
  ["nested-link", '<a href="https://a.test/"><a href="https://b.test/">x</a></a>'],
  ["unknown-entity", "<p>&evil;</p>"], ["numeric-nul", "<p>&#0;</p>"],
  ["invalid-code-point", "<p>&#1114112;</p>"], ["raw-nul", "<p>\0</p>"],
  ["list-text", "<ul>unexpected<li>x</li></ul>"], ["orphan-list-item", "<li>x</li>"],
  ["too-many-images", '<img src="https://example.test/a.png">'.repeat(41)],
  ["too-deep", "<blockquote>".repeat(25) + "x" + "</blockquote>".repeat(25)],
  ["over-size", "<p>" + "a".repeat(128000) + "</p>"],
];
for (const [name, value] of attacks) scenario("reject-" + name, () => {
  assert.throws(() => sanitize(value), error => error.code === "CHROME_PASTE_HTML_INVALID");
});
const auditStart = bridge.indexOf("function auditSafeArguments(");
const auditEnd = bridge.indexOf("\n}", auditStart);
const redact = vm.runInNewContext("(" + bridge.slice(auditStart, auditEnd + 2) + ")", { Buffer, crypto });
const content = { html, plainText: "PRIVATE_CLIPBOARD_TEXT", expectedText: "PRIVATE_EXISTING_TEXT", mode: "replace" };
for (const [name, args] of [
  ["public", { tab_id: 42, selector: "#editor", expected_document_id: "document-a", html, plain_text: content.plainText, expected_text: content.expectedText, mode: "replace", operation_id: "paste-contract-01" }],
  ["wire", { tabId: 42, selector: "#editor", expectedDocumentId: "document-a", content }],
]) scenario("audit-redaction-" + name, () => {
  const value = JSON.parse(JSON.stringify(redact("chrome_paste_content", args)));
  assert.equal(value.tab_id, 42);
  assert.equal(value.expected_document_id, "document-a");
  assert.equal(value.mode, "replace");
  assert.ok(!JSON.stringify(value).includes(html));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_CLIPBOARD_TEXT|PRIVATE_EXISTING_TEXT|media\.example/);
  assert.equal(Object.hasOwn(value, "content"), false);
});
scenario("safe-post-dispatch-failure-metadata", () => {
  const safe = { pasteDispatched: true, pasteDefaultPrevented: true, selectionPrepared: true, domChanged: false, pasteMode: "replace", textGuardNormalization: "collapse-whitespace" };
  assert.deepEqual(safeChromeDiagnostics({ ...safe, html, plainText: content.plainText, expectedText: content.expectedText, message: html }), safe);
});
scenario("extension-error-envelope-preserves-paste-flags", () => {
  const start = worker.indexOf("function errorPayload(");
  const end = worker.indexOf("\n}", start);
  const errorPayload = vm.runInNewContext("(" + worker.slice(start, end + 2) + ")");
  const value = JSON.parse(JSON.stringify(errorPayload({
    code: "CHROME_TARGET_CHANGED", message: "The original editable changed.",
    details: { pasteDispatched: true, pasteDefaultPrevented: true, selectionPrepared: true, domChanged: true, html },
  })));
  assert.equal(value.details.pasteDispatched, true);
  assert.equal(value.details.selectionPrepared, true);
  assert.equal(Object.hasOwn(value.details, "html"), false);
});
scenario("fingerprint-binds-all-paste-arguments", () => {
  const request = { method: "tabs.pasteContent", args: { tabId: 42, selector: "#editor", expectedDocumentId: "document-a", content }, allowedUrlPatterns: ["https://example.test/*"] };
  const original = operationFingerprint(request);
  assert.equal(isReadOnlyChromeMethod(request.method), false);
  for (const changes of [{ html: html + " " }, { plainText: "changed" }, { expectedText: "changed" }, { mode: "append" }]) {
    assert.notEqual(operationFingerprint({ ...request, args: { ...request.args, content: { ...content, ...changes } } }), original);
  }
  assert.notEqual(operationFingerprint({ ...request, args: { ...request.args, expectedDocumentId: "document-b" } }), original);
  const reordered = { ...request, args: { content: { mode: content.mode, expectedText: content.expectedText, plainText: content.plainText, html }, expectedDocumentId: "document-a", selector: "#editor", tabId: 42 } };
  assert.equal(operationFingerprint(reordered), original);
});
scenario("no-editor-state-or-DOM-write-fallback", () => {
  const actionStart = worker.indexOf("async function pagePasteContent(");
  const actionEnd = worker.indexOf("\n}\n", actionStart);
  const action = worker.slice(actionStart, actionEnd + 2);
  assert.doesNotMatch(action, /\.innerHTML\s*=|execCommand|navigator\.clipboard|__react|\.view\.state|insertAdjacentHTML/);
  assert.equal((action.match(/element\.dispatchEvent\(paste\)/g) || []).length, 1);
});
console.log(JSON.stringify({ passed: results.filter(x => x.passed).length, total: results.length, results }, null, 2));
if (results.some(x => !x.passed)) process.exitCode = 1;
