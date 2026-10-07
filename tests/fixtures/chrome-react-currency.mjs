import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

// A genuine React controlled field. onChange owns the displayed draft;
// onBlur commits the business amount and formats the field. The server receives
// React state from the submit closure, never an input.value read.
function CurrencyForm() {
  const [draft, setDraft] = useState('');
  const [amount, setAmount] = useState(null);
  const [receipt, setReceipt] = useState('not submitted');
  return React.createElement('form', {
    onSubmit: async event => {
      event.preventDefault();
      window.fixtureState.saves++;
      const response = await fetch('/receipt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: 'react-currency', amount, draft }),
      });
      setReceipt(JSON.stringify(await response.json()));
    },
  },
  React.createElement('label', null, 'React tier amount ', React.createElement('input', {
    id: 'react-amount', name: 'amount', inputMode: 'decimal', required: true, value: draft,
    onChange: event => {
      window.fixtureState.events.reactChange = (window.fixtureState.events.reactChange || 0) + 1;
      setDraft(event.target.value);
    },
    onBlur: () => {
      const next = /^\d+(?:\.\d+)?$/.test(draft) ? Number(draft) : null;
      setAmount(next);
      if (next !== null) setDraft(next.toFixed(2));
    },
  })),
  React.createElement('button', { type: 'submit' }, 'Save React tier'),
  React.createElement('output', { id: 'react-model' }, String(amount)),
  React.createElement('output', { id: 'react-receipt' }, receipt));
}

createRoot(document.getElementById('root')).render(React.createElement(CurrencyForm));
