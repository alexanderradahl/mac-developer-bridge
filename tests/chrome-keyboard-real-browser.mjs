import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createKeyboardFixtureServer } from './chrome-keyboard-installed-smoke.mjs';

// Fresh isolated headless browser only. Never attaches to an owner profile.
// npm install --prefix /tmp/mdb-keyboard-deps --ignore-scripts --save-exact \
//   react@19.2.0 react-dom@19.2.0 react-dnd@16.0.1 react-dnd-html5-backend@16.0.1 \
//   react-dnd-multi-backend@9.0.0 react-dnd-accessible-backend@2.1.0 playwright esbuild
// MDB_BROWSER_TEST_NODE_MODULES=/tmp/mdb-keyboard-deps/node_modules \
// MDB_BROWSER_TEST_PLAYWRIGHT=/tmp/mdb-keyboard-deps/node_modules/playwright/index.mjs \
// MDB_BROWSER_TEST_CHANNEL=chrome node tests/chrome-keyboard-real-browser.mjs
// NODE_MODULES accepts the platform path delimiter for separate build/browser deps.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.resolve(process.env.MDB_BROWSER_TEST_WORKER || path.join(root, 'chrome-extension/service-worker.js'));
const workerSource = await fs.readFile(workerPath, 'utf8');
const workerSha256 = crypto.createHash('sha256').update(workerSource).digest('hex');
const referenceOnly = process.env.MDB_BROWSER_TEST_REFERENCE_ONLY === '1';
function extractFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(workerSource);
  assert.ok(match, `Missing actual production function ${name}`);
  const end = workerSource.indexOf('\n}', match.index);
  assert.ok(end > match.index);
  const source = workerSource.slice(match.index, end + 2);
  new vm.Script(`(${source})`);
  return source;
}
const actionSource = referenceOnly ? '' : extractFunction('pageKeypress') + '\n' + extractFunction('pageSnapshot') + '\nwindow.mdbKeypress = pageKeypress; window.mdbSnapshot = pageSnapshot;';
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.MDB_BROWSER_TEST_PLAYWRIGHT || require.resolve('playwright'));
const fixture = await createKeyboardFixtureServer({ actionSource });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-keyboard-browser-'));
await fs.chmod(profile, 0o700);
const results = [];
const measurements = {};
const blockedRequests = [];
let context;
let browserVersion;
const expected = ['staff', 'member-bot', 'regular', 'last'];
const initial = ['staff', 'regular', 'member-bot', 'last'];
async function scenario(name, fn) {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(fixture.origin + '/?scenario=' + name);
    await page.waitForSelector('#root[data-ready="true"]');
    const call = async (selector, key, options = {}) => page.evaluate(async ({ selector, key, options }) => {
      try { return { result: await window.mdbKeypress(selector, key, { deadlineMs: Date.now() + (options.testBudgetMs || 3000), ...options }) }; }
      catch (error) { return { error: { code: error.code, message: error.message, details: error.details } }; }
    }, { selector, key, options });
    const read = () => page.evaluate(() => window.fixtureEvidence());
    const record = value => { measurements[name] = value; };
    await fn(page, call, read, record);
    assert.deepEqual(errors, [], 'No application exception');
    results.push({ name, passed: true });
  } catch (error) { measurements[name] = { errorState: await page.evaluate(() => window.fixtureEvidence?.()).catch(() => null) }; results.push({ name, passed: false, error: error.message, stack: error.stack }); }
  finally { await page.close(); }
}
function success(response) {
  assert.ok(!response.error, JSON.stringify(response.error));
  const result = response.result;
  assert.equal(result.keyDownDispatched, true);
  assert.equal(result.keyUpDispatched, true);
  assert.equal(result.applicationAccepted, null);
  assert.equal(result.outcomeVerified, false);
  assert.equal(result.trusted, false);
  assert.equal(result.keyEvents.filter(type => type === 'keydown').length, 1);
  assert.equal(result.keyEvents.filter(type => type === 'keyup').length, 1);
  return result;
}
function keyEvents(state) {
  const events = state.events.filter(event => ['keydown', 'keyup'].includes(event.type) && event.key && !['Control', 'Meta'].includes(event.key));
  const clones = events.filter(event => event.type === 'keydown' && event.key === 'd' && event.transitionCountBefore === 1);
  if (state.keyboardTransitions) assert.equal(clones.length, 1, 'Exactly one application-created MultiBackend transition clone');
  return events.filter(event => !clones.includes(event));
}
function noPointer(state) { assert.equal(state.events.filter(event => /^(click|pointerdown|pointerup|mousedown|mouseup|dragstart|drop|dragend)$/.test(event.type)).length, 0); }
async function nativeLift(page) { await page.locator('#member-bot').focus(); await page.keyboard.press('Control+d'); }
async function saved(page, name) {
  await page.waitForFunction(() => fixtureState.saves === 1 || fixtureState.error);
  const state = await page.evaluate(() => fixtureEvidence());
  assert.equal(state.error, null);
  assert.deepEqual(state.order, expected);
  assert.equal(state.drops, 1);
  assert.equal(state.dragging, false);
  assert.equal(fixture.getState(name).count, 1);
  noPointer(state);
  await page.reload();
  await page.waitForSelector('#root[data-ready="true"]');
  assert.deepEqual(await page.evaluate(() => fixtureState.order), expected, 'Actual drop save survives fresh document');
  assert.equal(fixture.getState(name).count, 1);
  return state;
}

try {
  context = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.MDB_BROWSER_TEST_CHANNEL ? { channel: process.env.MDB_BROWSER_TEST_CHANNEL } : {}), viewport: { width: 1100, height: 900 }, serviceWorkers: 'block', acceptDownloads: false });
  browserVersion = context.browser()?.version() || await context.pages()[0].evaluate(() => navigator.userAgent);
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === fixture.origin) await route.continue();
    else { blockedRequests.push(route.request().url()); await route.abort('blockedbyclient'); }
  });
  for (const suffix of ['enter', 'space']) await scenario('native-' + suffix, async (page, call, read, record) => {
    await nativeLift(page);
    assert.equal((await read()).dragging, true);
    await page.keyboard.press('ArrowUp');
    assert.equal((await read()).activeId, 'regular');
    await page.keyboard.press(suffix === 'space' ? 'Space' : 'Enter');
    const state = await saved(page, 'native-' + suffix);
    const events = keyEvents(state);
    assert.deepEqual(events.map(e => [e.type, e.key, e.target]), [
      ['keydown', 'd', 'member-bot'], ['keyup', 'd', 'member-bot'],
      ['keydown', 'ArrowUp', 'member-bot'], ['keyup', 'ArrowUp', 'regular'],
      ['keydown', suffix === 'space' ? ' ' : 'Enter', 'regular'], ['keyup', suffix === 'space' ? ' ' : 'Enter', 'member-bot'],
    ]);
    assert.ok(events.every(e => e.trusted));
    record({ state, nativeCurrentFocusKeyup: true });
  });
  for (const variant of ['focus', 'focus-microtask', 'replace', 'replace-microtask']) await scenario('guard-native-' + variant, async (page, call, read, record) => {
    await page.locator('#guard-source').focus();
    await page.keyboard.press('ArrowUp');
    const state = await read();
    const events = keyEvents(state);
    assert.equal(events[0].target, 'guard-source');
    assert.equal(events[0].defaultPrevented, true);
    assert.equal(events[1].target, variant.startsWith('focus') ? 'guard-next' : null);
    assert.equal(fixture.getState(state.scenario).count, 0);
    record(state);
  });
  await scenario('native-unfocused-focus', async (page, call, read, record) => {
    const decoy = await context.newPage();
    await decoy.goto(fixture.origin + '/?scenario=focus-decoy');
    await decoy.bringToFront();
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const before = await read();
    assert.equal(before.hasFocus, false);
    await page.locator('#roles > #member-bot').focus();
    const after = await read();
    assert.equal(after.activeId, 'member-bot', 'A real DOM focus transition occurs');
    assert.equal(after.hasFocus, false, 'The isolated page is not brought forward');
    assert.deepEqual(after.events.filter(e => ['focus', 'focusin'].includes(e.type)), [], 'Chromium withholds initial focus events while unfocused');
    record({ before, after, focusEventsWithheld: true, hiddenClaimed: false });
    await decoy.close();
  });
  if (!referenceOnly) {
    for (const suffix of ['enter', 'space', 'meta', 'second-tab']) await scenario('synthetic-' + suffix, async (page, call, read, record) => {
      let decoy;
      if (suffix === 'second-tab') {
        decoy = await context.newPage();
        await decoy.goto(fixture.origin + '/?scenario=decoy');
        await decoy.bringToFront();
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      }
      const before = await read();
      const lift = success(await call('#roles > #member-bot', 'd', { modifiers: [suffix === 'meta' ? 'Meta' : 'Control'] }));
      assert.equal(lift.keyDownDefaultPrevented, true, 'Handled lift must still release normally');
      assert.equal((await read()).dragging, true, 'Actual backend accepts lift');
      const up = success(await call('#roles > #member-bot', 'ArrowUp'));
      assert.equal(up.keyDownDefaultPrevented, true);
      assert.equal(up.keyUpTargetChanged, true);
      assert.equal((await read()).activeId, 'regular');
      const drop = success(await call('#roles > #regular', suffix === 'space' ? 'Space' : 'Enter'));
      assert.equal(drop.keyUpTargetChanged, true);
      assert.equal(up.focusAttempted, false);
      assert.equal(drop.focusAttempted, false);
      assert.equal(up.focusEventCompletionUsed, false);
      assert.equal(drop.focusEventCompletionUsed, false);
      const state = await saved(page, 'synthetic-' + suffix);
      const initialFocusEvents = state.events.slice(0, state.events.findIndex(e => e.type === 'keydown')).filter(e => ['focus', 'focusin'].includes(e.type));
      assert.deepEqual(initialFocusEvents.map(e => [e.type, e.target]), [['focus', 'member-bot'], ['focusin', 'member-bot']], 'Initial focus notification exactly once');
      if (suffix === 'second-tab') {
        assert.equal(before.hasFocus, false);
        assert.equal(lift.focusEventCompletionUsed, true);
        assert.ok(state.events.every(e => e.hasFocus === false), 'No foregrounding during keyboard sequence');
      } else assert.equal(lift.focusEventCompletionUsed, false);
      const events = keyEvents(state);
      assert.deepEqual(events.map(e => [e.type, e.key, e.target]), [
        ['keydown', 'd', 'member-bot'], ['keyup', 'd', 'member-bot'],
        ['keydown', 'ArrowUp', 'member-bot'], ['keyup', 'ArrowUp', 'regular'],
        ['keydown', suffix === 'space' ? ' ' : 'Enter', 'regular'], ['keyup', suffix === 'space' ? ' ' : 'Enter', 'member-bot'],
      ]);
      assert.ok(events.every(e => !e.trusted));
      record({ before, lift, up, drop, state, measuredInactive: before.hasFocus === false && before.visibilityState === 'hidden', note: 'Headless second tab is not claimed hidden unless measured; installed acceptance requires actual hidden+unfocused.' });
      if (decoy) await decoy.close();
    });
    for (const native of [true, false]) for (const operation of ['cannot-drag', 'cancel']) await scenario((native ? 'native-' : 'synthetic-') + operation, async (page, call, read, record) => {
      if (native) await nativeLift(page); else success(await call('#roles > #member-bot', 'd', { modifiers: ['Control'] }));
      if (operation === 'cancel') {
        assert.equal((await read()).dragging, true);
        if (native) { await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape'); }
        else { success(await call('#roles > #member-bot', 'ArrowUp')); success(await call('#roles > #regular', 'Escape')); }
      }
      const state = await read();
      assert.equal(state.dragging, false);
      assert.equal(state.drops, 0);
      assert.deepEqual(state.order, initial);
      assert.equal(fixture.getState(state.scenario).count, 0);
      noPointer(state);
      record(state);
    });
    for (const variant of ['focus', 'focus-microtask', 'replace', 'replace-microtask', 'disable', 'disable-microtask']) await scenario('guard-synthetic-' + variant, async (page, call, read, record) => {
      const response = await call('#guard-source', 'ArrowUp');
      const state = await read();
      const events = keyEvents(state);
      if (variant.startsWith('focus')) {
        const result = success(response);
        assert.equal(result.keyDownDefaultPrevented, true);
        assert.equal(result.keyUpTargetChanged, true);
        assert.deepEqual(events.map(e => [e.type, e.target]), [['keydown', 'guard-source'], ['keyup', 'guard-next']]);
      } else {
        assert.equal(response.error?.code, variant.startsWith('replace') ? 'CHROME_TARGET_CHANGED' : 'CHROME_ELEMENT_DISABLED', JSON.stringify(response));
        assert.equal(response.error.details.keyDownDispatched, true);
        assert.equal(response.error.details.keyUpDispatched, false);
        assert.deepEqual(events.map(e => e.type), ['keydown']);
      }
      assert.equal(fixture.getState(state.scenario).count, 0);
      noPointer(state);
      record({ response, state });
    });
    for (const type of ['focus', 'focusin']) for (const change of ['replace', 'disable', 'redirect']) for (const timing of ['sync', 'microtask']) {
      await scenario(`guard-initial-${type}-${change}-${timing}`, async (page, call, read, record) => {
        const decoy = await context.newPage();
        await decoy.goto(fixture.origin + '/?scenario=initial-focus-decoy');
        await decoy.bringToFront();
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        assert.equal((await read()).hasFocus, false);
        const response = await call('#guard-source', 'ArrowUp');
        const expectedCode = change === 'replace' ? 'CHROME_TARGET_CHANGED' : change === 'disable' ? 'CHROME_ELEMENT_DISABLED' : 'CHROME_FOCUS_CHANGED';
        assert.equal(response.error?.code, expectedCode, JSON.stringify(response));
        assert.equal(response.error.details.keyDownDispatched, false);
        assert.equal(response.error.details.keyUpDispatched, false);
        assert.equal(response.error.details.focusEventCompletionUsed, true);
        const state = await read();
        assert.deepEqual(keyEvents(state), []);
        noPointer(state);
        assert.equal(fixture.getState(state.scenario).count, 0);
        record({ response, state });
        await decoy.close();
      });
    }
    for (const timing of ['before', 'during-keydown']) await scenario('guard-deadline-' + timing, async (page, call, read, record) => {
      const response = await call('#guard-source', 'ArrowUp', timing === 'before' ? { deadlineMs: 1 } : { testBudgetMs: 150 });
      assert.equal(response.error?.code, 'CHROME_OPERATION_DEADLINE_EXCEEDED', JSON.stringify(response));
      assert.equal(response.error.details.keyDownDispatched, timing !== 'before');
      assert.equal(response.error.details.keyUpDispatched, false);
      const state = await read();
      assert.deepEqual(keyEvents(state).map(e => e.type), timing === 'before' ? [] : ['keydown']);
      assert.equal(fixture.getState(state.scenario).count, 0);
      noPointer(state);
      record({ response, state });
    });
    for (const type of ['constructor', 'dispatch']) await scenario('guard-fault-keyup-' + type, async (page, call, read, record) => {
      const response = await call('#guard-source', 'ArrowUp');
      assert.match(response.error?.message || '', /Owned keyup/);
      assert.equal(response.error.details.keyDownDispatched, true);
      assert.equal(response.error.details.keyUpDispatched, type === 'dispatch');
      const state = await read();
      assert.deepEqual(keyEvents(state).map(e => e.type), ['keydown']);
      assert.equal(fixture.getState(state.scenario).count, 0);
      noPointer(state);
      record({ response, state, note: 'A throwing dispatch call has an unknown partial outcome; no replay or fallback occurs.' });
    });
    await scenario('guard-post-keyup-focus', async (page, call, read, record) => {
      const result = success(await call('#guard-source', 'ArrowUp'));
      assert.equal(result.focusChanged, true);
      assert.equal(result.keyUpTargetChanged, false);
      assert.equal(result.focusedElement.id, 'guard-next');
      const state = await read();
      assert.deepEqual(keyEvents(state).map(e => [e.type, e.target]), [['keydown', 'guard-source'], ['keyup', 'guard-source']]);
      assert.equal(fixture.getState(state.scenario).count, 0);
      record({ result, state });
    });
    await scenario('snapshot-focused-element', async (page, call, read, record) => {
      const snapshots = [];
      for (const selector of ['#guard-next', '#passive-focus']) {
        await page.locator(selector).focus();
        const before = await read();
        const snapshot = await page.evaluate(() => mdbSnapshot({ maxElements: 50, maxTextChars: 2000 }));
        const after = await read();
        assert.deepEqual(after.events, before.events, 'Passive snapshot emits no focus or input events');
        assert.equal(snapshot.focusedElement.selector, selector);
        assert.equal(await page.evaluate(sel => document.querySelectorAll(sel).length, snapshot.focusedElement.selector), 1);
        if (selector === '#guard-next') assert.equal(snapshot.elements.find(e => e.selector === selector).focused, true);
        else assert.equal(snapshot.elements.some(e => e.selector === selector), false, 'tabindex=-1 stays excluded from ordinary control inventory');
        snapshots.push(snapshot);
      }
      assert.equal(fixture.getState('snapshot-focused-element').count, 0);
      record({ snapshots });
    });

  }
} finally {
  if (context) await context.close();
  await fixture.close();
  await fs.rm(profile, { recursive: true, force: true });
  const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const report = { generatedAt: new Date().toISOString(), referenceOnly, browserVersion, nodeVersion: process.version,
    workerPath, workerSha256, workerFileSha256AtEnd: await hash(workerPath), testSha256: await hash(fileURLToPath(import.meta.url)), installedServerSha256: await hash(path.join(root, 'tests/chrome-keyboard-installed-smoke.mjs')), fixture: fixture.info,
    results, measurements, receipts: fixture.receipts, rejectedReceipts: fixture.rejected, blockedRequests, browserClosed: true, profileRemoved: true };
  const reportPath = process.env.MDB_BROWSER_TEST_REPORT || path.join(fixture.dir, 'browser-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, passed: results.filter(r => r.passed).length, total: results.length, failed: results.filter(r => !r.passed) }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
