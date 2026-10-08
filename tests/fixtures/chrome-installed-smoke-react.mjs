import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const metrics = { reactBeforeInput: 0, reactInput: 0, reactChange: 0, nativeInput: 0, nativeChange: 0, nativeTextInput: 0, nativeBeforeInput: 0, edits: [], startVisibility: document.visibilityState, startHasFocus: document.hasFocus(), directMouseDown: 0, directClick: 0, directAccepted: 0 };
let armed = true;
const activeElementLabel = () => document.activeElement?.id || document.activeElement?.tagName || null;
const renderEvidence = () => { document.getElementById('evidence').textContent = JSON.stringify({ ...metrics, visibility: document.visibilityState, hasFocus: document.hasFocus(), activeElement: activeElementLabel() }); };
for (const type of ['beforeinput', 'textInput', 'input', 'change', 'focus', 'focusin', 'blur', 'focusout']) document.addEventListener(type, event => {
  if (event.target.id !== 'smoke-amount') return;
  if (type === 'beforeinput') metrics.nativeBeforeInput++;
  if (type === 'textInput') metrics.nativeTextInput++;
  if (type === 'input') metrics.nativeInput++;
  if (type === 'change') metrics.nativeChange++;
  metrics.edits.push({ type, isTrusted: event.isTrusted, visibility: document.visibilityState, hasFocus: document.hasFocus(), activeElement: activeElementLabel(), relatedTarget: event.relatedTarget?.id || event.relatedTarget?.tagName || null });
  queueMicrotask(renderEvidence);
}, true);
for (const type of ['visibilitychange', 'focus', 'blur']) window.addEventListener(type, renderEvidence);
function Currency() {
  const [draft, setDraft] = useState('');
  const [amount, setAmount] = useState(null);
  const [result, setResult] = useState('No submission');
  const intent = useRef(null);
  const nativeEdit = useRef(false);
  const submit = async event => {
    event.preventDefault();
    if (amount !== 10) { setResult('Rejected: actual React amount is not 10'); return; }
    const response = await fetch('/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount, reactBeforeInput: metrics.reactBeforeInput, reactInput: metrics.reactInput, reactChange: metrics.reactChange }) });
    setResult(JSON.stringify(await response.json()));
  };
  return React.createElement('form', { id: 'smoke-form', onSubmit: submit },
    React.createElement('label', { htmlFor: 'smoke-amount' }, 'Controlled amount'),
    React.createElement('input', { id: 'smoke-amount', type: 'text', inputMode: 'decimal', value: draft,
      onBeforeInput: event => { metrics.reactBeforeInput++; intent.current = event.data; renderEvidence(); },
      onInput: () => { metrics.reactInput++; renderEvidence(); },
      onChange: event => { metrics.reactChange++; nativeEdit.current = document.queryCommandEnabled('undo'); setDraft(event.target.value); renderEvidence(); },
      onBlur: () => { const parsed = Number(draft); if (draft && intent.current === draft && nativeEdit.current && Number.isFinite(parsed)) { setAmount(parsed); setDraft(parsed.toFixed(2)); } renderEvidence(); }
    }),
    React.createElement('p', { id: 'actual-model' }, `Actual React amount: ${amount === null ? 'null' : amount}`),
    React.createElement('button', { id: 'smoke-submit', type: 'submit' }, 'Submit fixture amount'),
    React.createElement('p', { id: 'receipt-result' }, result)
  );
}
createRoot(document.getElementById('app')).render(React.createElement(Currency));
const direct = document.getElementById('direct-action');
direct.addEventListener('mousedown', () => { metrics.directMouseDown++; armed = false; renderEvidence(); });
direct.addEventListener('click', () => { metrics.directClick++; if (armed) metrics.directAccepted++; renderEvidence(); });
renderEvidence();
