import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

async function start() {
  const scenario = new URL(location.href).searchParams.get("scenario") || "default";
  const schema = new Schema({ nodes: addListNodes(basicSchema.spec.nodes, "paragraph block*", "block"), marks: basicSchema.spec.marks });
  const saved = await fetch("/state?scenario=" + encodeURIComponent(scenario)).then(response => response.json());
  const initial = saved.doc ? schema.nodeFromJSON(saved.doc) : schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("Original "), schema.text("content.", [schema.marks.strong.create()])]),
    schema.node("paragraph", null, [schema.text("The existing final paragraph.")]),
  ]);
  const stats = { pasteEvents: [], transactions: 0, saveAttempts: 0, saves: saved.count, error: null, initialDocument: initial.toJSON() };
  const view = new EditorView(document.getElementById("mount"), {
    state: EditorState.create({ schema, doc: initial }),
    dispatchTransaction(transaction) {
      stats.transactions++;
      view.updateState(view.state.apply(transaction));
    },
  });
  view.dom.id = "editor";
  view.dom.setAttribute("aria-label", "Test article body");
  const node = view.dom;
  let armed = false;
  window.armFixtureGuard = () => { armed = true; };
  node.addEventListener("focus", () => {
    if (!armed) return;
    if (scenario === "focus-replace") node.replaceWith(node.cloneNode(true));
    if (scenario === "focus-readonly") node.setAttribute("aria-readonly", "true");
    if (scenario === "focus-text") node.appendChild(document.createTextNode("Changed by the application."));
    if (scenario === "focus-redirect") document.getElementById("decoy-input").focus();
  }, true);
  document.addEventListener("selectionchange", () => {
    if (!armed || scenario !== "selection-escape") return;
    const selection = getSelection();
    if (!selection.anchorNode || !node.contains(selection.anchorNode)) return;
    const outside = document.createRange();
    outside.selectNodeContents(document.getElementById("outside"));
    selection.removeAllRanges();
    selection.addRange(outside);
  });
  document.addEventListener("paste", event => {
    if (!event.target.closest("#editor,#plain")) return;
    stats.pasteEvents.push({ target: event.target.id, trusted: event.isTrusted, types: [...event.clipboardData.types], hasFocus: document.hasFocus(), visibilityState: document.visibilityState });
    if (scenario === "cancel") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  node.addEventListener("paste", () => {
    if (scenario === "post-paste-replace") node.replaceWith(node.cloneNode(true));
    if (scenario === "post-paste-deadline") {
      const until = performance.now() + 180;
      while (performance.now() < until) {}
    }
  });
  document.getElementById("save").addEventListener("click", async () => {
    stats.saveAttempts++;
    try {
      const response = await fetch("/save?scenario=" + encodeURIComponent(scenario), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: view.state.doc.toJSON() }) });
      if (!response.ok) throw new Error("Save failed");
      stats.saves = (await response.json()).count;
    } catch (error) { stats.error = error.message; }
  });
  window.fixtureEvidence = () => ({
    ...stats, doc: view.state.doc.toJSON(), editorText: document.getElementById("editor")?.innerText,
    plainText: document.getElementById("plain").innerText,
    hasFocus: document.hasFocus(), activeId: document.activeElement?.id, scenario,
    headerSrc: document.getElementById("cover").getAttribute("src"),
  });
  document.body.dataset.ready = "true";
}
start().catch(error => { document.body.dataset.error = error.message; });
