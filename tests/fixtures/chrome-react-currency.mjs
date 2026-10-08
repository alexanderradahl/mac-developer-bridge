import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// A genuine React controlled field. onChange owns the displayed draft;
// onBlur commits the business amount and formats the field. The server receives
// React state from the submit closure, never an input.value read.
function CurrencyForm() {
  const scenario = new URLSearchParams(location.search).get('scenario');
  // This deliberate editing-history consumer distinguishes an actual browser
  // editing operation from a value assignment. It does not inspect isTrusted
  // and does not claim to reproduce Patreon internals.
  const requiresTextIntent = scenario.startsWith('react-text-input-');
  const requiresNativeEdit = scenario.startsWith('react-native-edit-') || requiresTextIntent;
  const textIntent = useRef(null);
  const [draft, setDraft] = useState('');
  const [amount, setAmount] = useState(null);
  const [nativeEditSeen, setNativeEditSeen] = useState(false);
  const [receipt, setReceipt] = useState('not submitted');
  const [error, setError] = useState('');
  return React.createElement('form', {
    onSubmit: async event => {
      event.preventDefault();
      if (amount === null) { setError('Missing committed amount'); return; }
      window.fixtureState.saves++;
      const response = await fetch('/receipt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario, amount, draft }),
      });
      setReceipt(JSON.stringify(await response.json()));
    },
  },
  React.createElement('label', null, 'React tier amount ', React.createElement('input', {
    id: 'react-amount', name: 'amount', inputMode: 'decimal', required: true, value: draft,
    onBeforeInput: event => {
      window.fixtureState.events.reactBeforeInput = (window.fixtureState.events.reactBeforeInput || 0) + 1;
      (window.fixtureState.reactBeforeInputEvents ||= []).push({ nativeType: event.nativeEvent.type, data: event.data, trusted: event.nativeEvent.isTrusted });
      if (window.fixtureState.cancelReactBeforeInput) event.preventDefault();
      else textIntent.current = event.data;
    },
    onInput: () => { window.fixtureState.events.reactInput = (window.fixtureState.events.reactInput || 0) + 1; },
    onChange: event => {
      window.fixtureState.events.reactChange = (window.fixtureState.events.reactChange || 0) + 1;
      setNativeEditSeen(document.queryCommandEnabled('undo'));
      setDraft(event.target.value);
    },
    onBlur: () => {
      const next = /^\d+(?:\.\d+)?$/.test(draft) && (!requiresNativeEdit || nativeEditSeen) && (!requiresTextIntent || textIntent.current === draft) ? Number(draft) : null;
      setAmount(next);
      if (next !== null) setDraft(next.toFixed(2));
    },
  })),
  React.createElement('button', { type: 'submit' }, 'Save React tier'),
  React.createElement('output', { id: 'react-model' }, String(amount)),
  React.createElement('output', { id: 'react-error' }, error),
  React.createElement('output', { id: 'react-receipt' }, receipt));
}

createRoot(document.getElementById('root')).render(React.createElement(CurrencyForm));
