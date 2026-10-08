import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDrag, useDrop, useDragDropManager } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { DndProvider, MouseTransition, createTransition } from 'react-dnd-multi-backend';
import KeyboardBackend, { isKeyboardDragTrigger } from 'react-dnd-accessible-backend';

// The actual public Discord backend, without patched triggers, manager actions,
// focus/trust overrides, or a hand-written replacement drag implementation.
const scenario = new URLSearchParams(location.search).get('scenario') || 'installed';
const state = { scenario, events: [], order: [], saves: 0, drops: 0, dragging: false, dndMode: false, keyboardTransitions: 0, pending: false, error: null };
window.fixtureState = state;
const evidence = () => ({ ...state, hasFocus: document.hasFocus(), visibilityState: document.visibilityState, activeId: document.activeElement?.id || null });
window.fixtureEvidence = evidence;
function renderEvidence() {
  document.getElementById('evidence').textContent = JSON.stringify(evidence());
  document.getElementById('result').textContent = `Saved changes: ${state.saves}; dragging: ${state.dragging}; active: ${document.activeElement?.id || 'none'}`;
}
for (const type of ['keydown', 'keyup', 'focus', 'focusin', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dragstart', 'drop', 'dragend']) {
  window.addEventListener(type, event => {
    const item = { type, key: event.key ?? null, code: event.code ?? null, constructor: event.constructor.name, transitionCountBefore: state.keyboardTransitions,
      target: event.target?.id || null, trusted: event.isTrusted, hasFocus: document.hasFocus(), visibilityState: document.visibilityState,
      ctrlKey: Boolean(event.ctrlKey), metaKey: Boolean(event.metaKey), get defaultPrevented() { return event.defaultPrevented; } };
    state.events.push(item);
    queueMicrotask(renderEvidence);
  }, true);
}
setInterval(renderEvidence, 150);
const KeyboardTransition = createTransition('keydown', event => {
  if (!isKeyboardDragTrigger(event)) return false;
  event.preventDefault();
  state.keyboardTransitions += 1;
  return true;
});
const backendOptions = { backends: [
  { id: 'html5', backend: HTML5Backend, transition: MouseTransition },
  { id: 'keyboard', backend: KeyboardBackend, context: { window, document }, preview: true,
    options: { onDndModeChanged: enabled => { state.dndMode = enabled; } }, transition: KeyboardTransition },
] };
function Row({ id, onDrop }) {
  const [, drag] = useDrag(() => ({ type: 'role', item: { id }, canDrag: id === 'member-bot' && !scenario.includes('cannot-drag') }), [id]);
  const [, drop] = useDrop(() => ({ accept: 'role', canDrop: () => id === 'regular' || id === 'last', drop: item => onDrop(item.id, id) }), [id, onDrop]);
  const attach = useCallback(node => { drop(node); drag(node); }, [drop, drag]);
  return React.createElement('div', { id, ref: attach, tabIndex: 0, role: 'listitem', 'data-dnd-name': id, 'aria-label': id }, id);
}
function Roles({ initial }) {
  const [order, setOrder] = useState(initial);
  const currentOrder = useRef(initial);
  const manager = useDragDropManager();
  useEffect(() => manager.getMonitor().subscribeToStateChange(() => {
    state.dragging = manager.getMonitor().isDragging();
    state.sourceId = manager.getMonitor().getSourceId();
    state.targetIds = manager.getMonitor().getTargetIds();
    renderEvidence();
  }), [manager]);
  const onDrop = useCallback((source, target) => {
    const next = currentOrder.current.filter(id => id !== source);
    next.splice(next.indexOf(target), 0, source);
    currentOrder.current = next;
    state.order = next;
    state.drops += 1;
    state.pending = true;
    setOrder(next);
    // Save from the real application's drop callback. The short delay lets the
    // receipt include release/focus events; it does not trigger any input.
    setTimeout(async () => {
      try {
        const response = await fetch('/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evidence()) });
        if (!response.ok) throw Error(`Fixture save rejected: ${response.status}`);
        state.saves = (await response.json()).count;
      } catch (error) { state.error = error.message; }
      state.pending = false;
      renderEvidence();
    }, 50);
  }, []);
  useEffect(() => { state.order = order; document.getElementById('root').dataset.ready = 'true'; renderEvidence(); }, [order]);
  return React.createElement('div', { id: 'roles', role: 'list' }, order.map(id => React.createElement(Row, { key: id, id, onDrop })));
}

// Independent native-reference controls test generic keyboard sequencing. They
// are not connected to the DnD manager and cannot save/reorder fixture roles.
const guard = document.getElementById('guard-source');
guard.addEventListener('keydown', event => {
  if (!scenario.startsWith('guard-') || /initial|fault|post-keyup|deadline/.test(scenario)) return;
  event.preventDefault();
  const change = () => {
    if (scenario.includes('replace')) guard.replaceWith(guard.cloneNode(true));
    else if (scenario.includes('disable')) guard.disabled = true;
    else if (scenario.includes('focus')) document.getElementById('guard-next').focus();
  };
  if (scenario.includes('microtask')) queueMicrotask(change); else change();
});

if (scenario.startsWith('guard-initial-')) {
  const type = scenario.includes('focusin') ? 'focusin' : 'focus';
  guard.addEventListener(type, () => {
    const change = () => {
      if (scenario.includes('replace')) guard.replaceWith(guard.cloneNode(true));
      else if (scenario.includes('disable')) guard.disabled = true;
      else document.getElementById('guard-next').focus();
    };
    if (scenario.includes('microtask')) queueMicrotask(change); else change();
  });
}
if (scenario === 'guard-deadline-during-keydown') guard.addEventListener('keydown', () => {
  const began = performance.now();
  while (performance.now() - began < 300) { /* real elapsed deadline, no clock override */ }
});
if (scenario === 'guard-post-keyup-focus') guard.addEventListener('keyup', () => queueMicrotask(() => document.getElementById('guard-next').focus()));
if (scenario === 'guard-fault-keyup-constructor') {
  window.KeyboardEvent = new Proxy(window.KeyboardEvent, { construct(Target, args) {
    if (args[0] === 'keyup') throw Error('Owned keyup constructor fault');
    return Reflect.construct(Target, args);
  } });
}
if (scenario === 'guard-fault-keyup-dispatch') {
  const dispatch = guard.dispatchEvent.bind(guard);
  guard.dispatchEvent = event => {
    if (event.type === 'keyup') throw Error('Owned keyup dispatch fault');
    return dispatch(event);
  };
}

fetch('/state?scenario=' + encodeURIComponent(scenario)).then(response => response.json()).then(saved => {
  state.saves = saved.count;
  createRoot(document.getElementById('root')).render(React.createElement(DndProvider, { options: backendOptions }, React.createElement(Roles, { initial: saved.order })));
}).catch(error => { state.error = error.message; renderEvidence(); });
