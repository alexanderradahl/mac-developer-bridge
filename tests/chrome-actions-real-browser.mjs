import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Explicit integration test. Requires a separately installed Playwright and its
// headless Chromium; it never attaches to an existing browser or user profile.
//   npm install --prefix /tmp/mdb-browser-test-deps playwright react react-dom esbuild
//   /tmp/mdb-browser-test-deps/node_modules/.bin/playwright install chromium --only-shell
//   MDB_BROWSER_TEST_PLAYWRIGHT=/tmp/mdb-browser-test-deps/node_modules/playwright/index.mjs \
//     MDB_BROWSER_TEST_NODE_MODULES=/tmp/mdb-browser-test-deps/node_modules \
//     node tests/chrome-actions-real-browser.mjs
// MDB_BROWSER_TEST_WORKER may point to a byte-for-byte source copy when running
// in a separate test machine. The report always records that file's SHA-256.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.resolve(process.env.MDB_BROWSER_TEST_WORKER || path.join(root, 'chrome-extension', 'service-worker.js'));
const workerSource = await fs.readFile(workerPath, 'utf8');
const workerSha256 = crypto.createHash('sha256').update(workerSource).digest('hex');
const fixture = await fs.readFile(path.join(root, 'tests', 'fixtures', 'chrome-actions.html'));
const testSourceSha256 = crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
const fixtureSourceSha256 = crypto.createHash('sha256').update(fixture).digest('hex');
const reactFixtureSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(root, 'tests', 'fixtures', 'chrome-react-currency.mjs'))).digest('hex');
const require = createRequire(import.meta.url);
const playwrightPath = process.env.MDB_BROWSER_TEST_PLAYWRIGHT || require.resolve('playwright');
const { chromium } = await import(playwrightPath);
const dependencyPaths = [process.env.MDB_BROWSER_TEST_NODE_MODULES || root];
const esbuild = require(require.resolve('esbuild', { paths: dependencyPaths }));
const reactVersion = require(require.resolve('react/package.json', { paths: dependencyPaths })).version;
const reactBundle = (await esbuild.build({
  entryPoints: [path.join(root, 'tests', 'fixtures', 'chrome-react-currency.mjs')],
  bundle: true, write: false, format: 'iife', platform: 'browser',
  nodePaths: dependencyPaths,
  define: { 'process.env.NODE_ENV': '"development"' },
})).outputFiles[0].contents;
// CI images may provide a packaged headless binary instead of a Playwright CDN
// browser. This option still creates the same new, disposable test profile.
const packagedBrowser = process.env.MDB_BROWSER_TEST_CHROMIUM_PACKAGE
  ? (await import(process.env.MDB_BROWSER_TEST_CHROMIUM_PACKAGE)).default : null;

function extractFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(workerSource);
  assert.ok(match, `Missing production function ${name}`);
  const end = workerSource.indexOf('\n}', match.index);
  assert.ok(end > match.index, `Missing production function terminator ${name}`);
  const source = workerSource.slice(match.index, end + 2);
  new vm.Script(`(${source})`, { filename: `${workerPath}:${name}` });
  return source;
}
const actionSource = ['pageSnapshot', 'pageClick', 'pageFill', 'pageDrag'].map(extractFunction).join('\n\n')
  + '\nwindow.mdbTestActions = { pageSnapshot, pageClick, pageFill, pageDrag };';

const receipts = [];
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/fixture') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixture);
  } else if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/saved-order') {
    const name = new URL(request.url, 'http://localhost').searchParams.get('scenario');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(receipts.findLast(item => item.scenario === name && Array.isArray(item.order)) || {}));
  } else if (request.method === 'GET' && request.url === '/react-fixture.js') {
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    response.end(reactBundle);
  } else if (request.method === 'POST' && request.url === '/receipt') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4096) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks));
    receipts.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ received: body }));
  } else {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-browser-regression-'));
await fs.chmod(profilePath, 0o700);
const results = [];
const compatibilityMeasurements = {};
let context;
let browserVersion;
let fatalError;
let profileRemoved = false;
let browserClosed = false;
const blockedRequests = [];

async function scenario(name, run) {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const start = performance.now();
  try {
    await page.goto(`${origin}/fixture?scenario=${name}`);
    await page.addScriptTag({ content: actionSource });
    const call = async (method, ...args) => {
      let timer;
      try {
        return await Promise.race([
          page.evaluate(async ({ method, args }) => {
            try { return { result: await window.mdbTestActions[method](...args) }; }
            catch (error) { return { error: { code: error.code, message: error.message, details: error.details } }; }
          }, { method, args }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} exceeded the 4-second fixture deadline`)), 4000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const record = value => { compatibilityMeasurements[name] = value; };
    const result = await run(page, call, record);
    assert.deepEqual(errors, [], 'Fixture application raised an unexpected error');
    results.push({ scenario: name, passed: true, durationMs: Math.round(performance.now() - start), ...result });
  } catch (error) {
    results.push({ scenario: name, passed: false, durationMs: Math.round(performance.now() - start), error: error.message, stack: error.stack });
  } finally {
    await page.close();
  }
}

function success(response) {
  assert.ok(!response.error, JSON.stringify(response.error));
  return response.result;
}

try {
  context = await chromium.launchPersistentContext(profilePath, {
    ...(packagedBrowser ? { executablePath: await packagedBrowser.executablePath(), args: ['--disable-gpu'] } : {}),
    ...(process.env.MDB_BROWSER_TEST_CHANNEL ? { channel: process.env.MDB_BROWSER_TEST_CHANNEL } : {}),
    headless: true,
    viewport: { width: 1100, height: 800 },
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  browserVersion = context.browser()?.version() || await context.pages()[0].evaluate(() => navigator.userAgent);
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { blockedRequests.push(route.request().url()); await route.abort('blockedbyclient'); }
  });

  for (const name of ['drag-native', 'drag-before', 'drag-after', 'drag-second-tab', 'drag-backend-transition', 'drag-native-backend-transition']) {
    await scenario(name, async (page, call, record) => {
      await page.waitForSelector('#root[data-ready="true"]');
      const snapshot = success(await call('pageSnapshot', { maxElements: 50, maxTextChars: 2000 }));
      assert.ok(JSON.stringify(snapshot).includes('"draggable":true'), 'Draggable controls must be discoverable');
      assert.equal(await page.evaluate(() => fixtureState.dragEvents.length), 0, 'Snapshots must not dispatch drag events');
      let decoy;
      if (name === 'drag-second-tab') {
        decoy = await context.newPage();
        await decoy.goto(origin + '/fixture?scenario=passive-snapshot');
        await decoy.bringToFront();
        // Headless Chromium can report focus for every page. The installed\n        // MDB loopback smoke separately proves genuine inactive-tab behavior.
      }
      let result;
      if (name.startsWith('drag-native')) {
        await page.dragAndDrop('#source', '#target', { targetPosition: { x: 50, y: 8 } });
      } else {
        result = success(await call('pageDrag', '#source', '#target', { targetPosition: name === 'drag-after' ? 'after' : 'before', deadlineMs: Date.now() + 3000 }));
        assert.equal(result.pointerDownDispatched, true);
        assert.equal(result.mouseDownDispatched, true);
        assert.equal(result.dragStartDispatched, true);
        assert.equal(result.pointerCancelDispatched, true);
        assert.equal(result.pointerUpDispatched, false);
        assert.equal(result.mouseUpDispatched, false);
        assert.equal(result.dropDispatched, true);
        assert.equal(result.dragEndDispatched, true);
        assert.equal(result.trusted, false);
        assert.equal(result.applicationAccepted, null);
        assert.equal(result.outcomeVerified, false);
      }
      await page.waitForFunction(() => document.getElementById('drag-receipt').textContent.length > 0);
      const expected = name === 'drag-after' ? ['staff', 'target', 'source', 'last'] : ['staff', 'source', 'target', 'last'];
      const observed = await page.evaluate(() => ({ order: fixtureState.order(), drops: fixtureState.drops, events: fixtureState.dragEvents, initiation: fixtureState.initiationEvents, backend: fixtureState.dragBackend, pointerPressed: fixtureState.pointerPressed, mousePressed: fixtureState.mousePressed, hasFocus: document.hasFocus() }));
      assert.deepEqual(observed.order, expected);
      assert.equal(observed.drops, 1);
      assert.equal(observed.backend, 'html5');
      assert.equal(observed.pointerPressed, false);
      assert.equal(observed.mousePressed, false);
      assert.equal(observed.initiation.filter(event => event.type === 'mousedown').length, 1);
      assert.equal(observed.initiation.filter(event => event.type === 'click').length, 0, 'Drag must never activate a click');
      if (!name.startsWith('drag-native')) {
        assert.deepEqual(observed.initiation.map(event => event.type), ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointercancel']);
        assert.ok(observed.initiation.every(event => event.trusted === false));
        const press = observed.initiation.find(event => event.type === 'pointerdown');
        assert.equal(press.pointerId, 1);
        assert.equal(press.pointerType, 'mouse');
        assert.equal(press.buttons, 1);
        assert.equal(press.button, 0);
        for (const event of observed.initiation.filter(event => ['pointerover', 'pointermove'].includes(event.type))) assert.equal(event.button, -1);
      }
      assert.equal(receipts.filter(item => item.scenario === name).length, 1, 'Exactly one application save');
      assert.equal(observed.events.filter(event => event.type === 'drop').length, 1);

      await page.reload();
      await page.waitForSelector('#root[data-ready="true"]');
      assert.deepEqual(await page.evaluate(() => fixtureState.order()), expected, 'Server receipt must survive fresh reload');
      record({ result, observed, persistedOrder: expected });
      if (decoy) await decoy.close();
      return { persisted: true, saves: 1, secondTabOpen: name === 'drag-second-tab' };
    });
  }
  // Every synchronous prelude callback is a mutation boundary. After press we
  // also yield once so queued backend reconnects cannot evade retained-node,
  // disabled-state or deadline checks before dragstart.
  for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointercancel']) {
    const cases = ['source-replaced', 'target-replaced', 'source-disabled', 'target-disabled', 'deadline'];
    if (['mousedown', 'pointercancel'].includes(type)) cases.push(...cases.map(value => value + '-async'));
    if (['pointerdown', 'mousedown'].includes(type)) cases.push('cancelled');
    for (const change of cases) {
      const name = `drag-prelude-${type}-${change}`;
      await scenario(name, async (page, call, record) => {
        await page.waitForSelector('#root[data-ready="true"]');
        const response = await call('pageDrag', '#source', '#target', { targetPosition: 'before', deadlineMs: Date.now() + 3000 });
        const code = change.includes('replaced') ? 'CHROME_TARGET_CHANGED' : change.includes('disabled') ? 'CHROME_ELEMENT_DISABLED' : change.startsWith('deadline') ? 'CHROME_OPERATION_DEADLINE_EXCEEDED' : 'CHROME_DRAG_CANCELLED';
        assert.equal(response.error?.code, code, JSON.stringify(response));
        const details = response.error.details;
        assert.equal(details.actionDispatched, true);
        assert.equal(details.dragStartDispatched, type === 'pointercancel');
        assert.equal(details.dragStarted, type === 'pointercancel');
        assert.equal(details.dropDispatched, false);
        assert.equal(details.pointerDownDispatched, ['pointerdown', 'mousedown', 'pointercancel'].includes(type));
        assert.equal(details.mouseDownDispatched, ['mousedown', 'pointercancel'].includes(type));
        assert.equal(details.pointerCancelDispatched, type === 'pointercancel');
        assert.equal(details.pointerUpDispatched, change === 'cancelled');
        assert.equal(details.mouseUpDispatched, change === 'cancelled' && type === 'mousedown');
        const observed = await page.evaluate(() => ({ order: fixtureState.order(), drops: fixtureState.drops, events: fixtureState.dragEvents, initiation: fixtureState.initiationEvents }));
        assert.deepEqual(observed.order, ['staff', 'target', 'source', 'last']);
        assert.equal(observed.drops, 0);
        assert.deepEqual(observed.events.map(event => event.type), type === 'pointercancel' ? ['dragstart'] : []);
        assert.equal(observed.initiation.at(-1).type, change === 'cancelled' ? (type === 'mousedown' ? 'mouseup' : 'pointerup') : type);
        assert.equal(observed.initiation.filter(event => event.type === type).length, 1, 'No press replay');
        assert.equal(observed.initiation.filter(event => event.type === 'click').length, 0);
        assert.equal(receipts.filter(item => item.scenario === name).length, 0);
        record({ response, observed });
        return { saves: 0, noDrop: true, noDragStart: type !== 'pointercancel', noRetargetOrRetry: true };
      });
    }
  }
  for (const [name, code, options] of [
    ['drag-not-accepted', 'CHROME_DRAG_NOT_ACCEPTED', {}],
    ['drag-effect-none', 'CHROME_DRAG_NOT_ACCEPTED', {}],
    ['drag-effect-incompatible', 'CHROME_DRAG_NOT_ACCEPTED', {}],
    ['drag-pointercancel-effect-escalation', 'CHROME_DRAG_NOT_ACCEPTED', {}],
    ['drag-cancelled', 'CHROME_DRAG_CANCELLED', {}],
    ['drag-replaced', 'CHROME_TARGET_CHANGED', {}],
    ['drag-disabled', 'CHROME_ELEMENT_DISABLED', {}],
    ['drag-pointer-only', 'CHROME_DRAG_UNSUPPORTED', {}],
    ['drag-deadline', 'CHROME_OPERATION_DEADLINE_EXCEEDED', { deadlineMs: 1 }],
    ['drag-over-deadline', 'CHROME_OPERATION_DEADLINE_EXCEEDED', { deadlineMs: Date.now() + 30_000 }],
    ['drag-ambiguous', 'CHROME_SELECTOR_NOT_UNIQUE', {}],
  ]) {
    await scenario(name, async (page, call, record) => {
      await page.waitForSelector('#root[data-ready="true"]');
      const response = await call('pageDrag', name === 'drag-ambiguous' ? '#roles > div' : '#source', '#target', options);
      assert.equal(response.error?.code, code, JSON.stringify(response));
      assert.equal(response.error.details.dropDispatched, false);
      const observed = await page.evaluate(() => ({ order: fixtureState.order(), drops: fixtureState.drops, events: fixtureState.dragEvents }));
      assert.deepEqual(observed.order, ['staff', 'target', 'source', 'last']);
      assert.equal(observed.drops, 0);
      assert.equal(receipts.filter(item => item.scenario === name).length, 0);
      if (['drag-disabled', 'drag-pointer-only', 'drag-deadline', 'drag-ambiguous'].includes(name)) assert.equal(observed.events.length, 0);
      if (name === 'drag-not-accepted') assert.equal(response.error.details.dragEndDispatched, true);
      if (name === 'drag-pointercancel-effect-escalation') {
        assert.equal(response.error.details.pointerCancelDispatched, true);
        assert.equal(await page.evaluate(() => fixtureState.pointerCancelEffectAfterAttempt), 'copy', 'A callback cannot promote the completed dragstart transfer phase');
      }
      if (name === 'drag-cancelled') {
        assert.equal(response.error.details.dragStartDispatched, true);
        assert.equal(response.error.details.dragStarted, false);
        assert.equal(response.error.details.pointerCancelDispatched, false);
        assert.equal(response.error.details.pointerUpDispatched, true);
        assert.equal(response.error.details.mouseUpDispatched, true);
        assert.deepEqual(await page.evaluate(() => [fixtureState.pointerPressed, fixtureState.mousePressed]), [false, false]);
        assert.equal(await page.evaluate(() => fixtureState.initiationEvents.filter(event => event.type === 'click').length), 0);
      }
      record({ response, observed });
      return { saves: 0, noDrop: true };
    });
  }
  await scenario('drag-after-drop-replaced', async (page, call, record) => {
    await page.waitForSelector('#root[data-ready="true"]');
    const response = await call('pageDrag', '#source', '#target', { targetPosition: 'before', errorsAsData: true });
    const failure = success(response).__mdbPageActionError;
    assert.equal(failure.code, 'CHROME_TARGET_CHANGED');
    assert.equal(failure.dropDispatched, true, 'A dispatched drop must not be reported as safe to retry');
    assert.equal(failure.dragEndDispatched, false);
    await page.waitForFunction(() => document.getElementById('drag-receipt').textContent.length > 0);
    assert.equal(receipts.filter(item => item.scenario === 'drag-after-drop-replaced').length, 1);
    assert.equal(await page.evaluate(() => fixtureState.drops), 1);
    record({ failure });
    return { knownDropDispatched: true, saves: 1, noRetargetOrRetry: true };
  });

  await scenario('ordinary-click', async (page, call) => {
    const result = success(await call('pageClick', '#save'));
    assert.equal(await page.locator('#saved').textContent(), '1');
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    assert.equal(result.clicked, true);
    assert.equal(result.actionDispatched, true);
    return { applicationSaveCount: 1 };
  });

  await scenario('mousedown-combobox', async (page, call) => {
    const result = success(await call('pageClick', '#combo'));
    assert.equal(await page.evaluate(() => fixtureState.toggles), 1);
    assert.equal(await page.locator('#combo').getAttribute('aria-expanded'), 'true');
    assert.equal(result.clicked, false, 'Mousedown control should not receive a second click');
    assert.equal(result.actionDispatched, true);
    return { applicationToggleCount: 1 };
  });

  await scenario('passive-snapshot', async (page, call) => {
    const before = await page.evaluate(() => ({ events: { ...fixtureState.events }, html: document.getElementById('root').innerHTML, active: document.activeElement.tagName }));
    for (let n = 0; n < 3; n++) success(await call('pageSnapshot', 5000, 100));
    const after = await page.evaluate(() => ({ events: { ...fixtureState.events }, html: document.getElementById('root').innerHTML, active: document.activeElement.tagName }));
    assert.deepEqual(after, before);
    assert.deepEqual(after.events, { invalid: 0, input: 0, change: 0, focus: 0, blur: 0, submit: 0 });
    const snapshot = success(await call('pageSnapshot', 5000, 100));
    const elements = snapshot.elements;
    assert.ok(elements.some(element => element.selector === '#semantic-combo'));
    assert.ok(elements.some(element => element.selector === '#semantic-tab'));
    return { snapshotCount: 4, emittedEvents: after.events };
  });

  await scenario('controlled-currency', async (page, call) => {
    const result = success(await call('pageFill', '#amount', '5', true, { commit: 'blur', normalization: 'numeric' }));
    await page.waitForFunction(() => document.getElementById('server-receipt').value.includes('received'));
    const recorded = receipts.filter(receipt => receipt.scenario === 'controlled-currency');
    assert.deepEqual(recorded, [{ scenario: 'controlled-currency', amount: 5, draft: '5' }]);
    assert.equal(await page.locator('#amount').inputValue(), '5.00');
    assert.equal(result.domValueRetained, true);
    assert.equal(result.applicationAccepted, null);
    assert.equal(result.outcomeVerified, false);
    assert.equal(result.submissionRequested, true);
    assert.equal(result.submissionObserved, true);
    assert.equal(result.submitted, true);
    assert.equal(result.submitDefaultPrevented, true);
    return { serverReceivedAmount: 5, display: '5.00', submissions: recorded.length };
  });

  await scenario('react-currency', async (page, call) => {
    await page.locator('#react-amount').waitFor({ state: 'visible' });
    const result = success(await call('pageFill', '#react-amount', '5', true, { commit: 'blur', normalization: 'numeric' }));
    await page.waitForFunction(() => document.getElementById('react-receipt').textContent.includes('received'));
    const recorded = receipts.filter(receipt => receipt.scenario === 'react-currency');
    assert.deepEqual(recorded, [{ scenario: 'react-currency', amount: 5, draft: '5.00' }]);
    assert.equal(await page.locator('#react-model').textContent(), '5');
    assert.equal(await page.locator('#react-amount').inputValue(), '5.00');
    assert.equal(await page.evaluate(() => fixtureState.events.reactChange), 1);
    assert.equal(result.submissionObserved, true);
    assert.equal(result.applicationAccepted, null);
    assert.equal(result.outcomeVerified, false);
    return { reactVersion, serverReceivedAmount: 5, submissions: recorded.length, reactOnChangeCount: 1 };
  });

  await scenario('replace-accepted', async (page, call) => {
    const result = success(await call('pageFill', '#replace', 'retained', true, { commit: 'blur' }));
    await page.waitForFunction(() => fixtureState.saves === 1);
    assert.equal(result.targetReplaced, true);
    assert.equal(result.domValueRetained, true);
    assert.equal(await page.locator('#replace').inputValue(), 'retained');
    assert.equal(await page.evaluate(() => fixtureState.accepted), 'retained');
    return { replacementCount: await page.evaluate(() => fixtureState.replacements), committedCurrentElement: true };
  });

  await scenario('replace-rejected', async (page, call) => {
    const response = await call('pageFill', '#replace', 'requested', true, { commit: 'blur' });
    assert.equal(response.error?.code, 'CHROME_FILL_NOT_STICKY');
    assert.equal(await page.locator('#replace').inputValue(), 'rejected');
    assert.equal(await page.evaluate(() => fixtureState.saves), 0);
    return { rejectedWithoutSubmitting: true };
  });

  await scenario('contenteditable', async (page, call) => {
    const cases = ['A real edit\n\nA second paragraph ✨', '\nLeading', 'Trailing\n', 'A\n\n', 'A  B', '', '\n', '\n\n'];
    const inputCounts = [];
    for (const text of cases) {
      const nativeInputCount = await page.locator('#editor').evaluate((element, value) => {
        element.textContent = 'before'; fixtureState.events.input = 0; element.focus();
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('insertText', false, value)) throw new Error('Native editable reference operation failed');
        return fixtureState.events.input;
      }, text);
      assert.ok(nativeInputCount > 0, 'Native reference operation must produce an input event');
      await page.locator('#editor').evaluate(element => { element.textContent = 'before'; fixtureState.events.input = 0; });
      const response = await call('pageFill', '#editor', text, false);
      assert.ok(!response.error, JSON.stringify({ requested: text, error: response.error, observed: await page.locator('#editor').evaluate(element => ({ innerText: element.innerText, textContent: element.textContent, html: element.innerHTML })) }));
      const result = success(response);
      const observed = await page.locator('#editor').evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return { selectedText: selection.toString(), textContent: element.textContent };
      });
      if (text === 'A  B') assert.equal(observed.textContent, text, 'DOM text must preserve consecutive spaces');
      else assert.equal(observed.selectedText, text, 'Browser selection must preserve exact line breaks');
      const toolInputCount = await page.evaluate(() => fixtureState.events.input);
      assert.equal(toolInputCount, nativeInputCount, 'Worker must not add duplicate input events to the browser-native editable operation');
      inputCounts.push({ native: nativeInputCount, worker: toolInputCount });
      assert.equal(result.domValueRetained, true);
    }
    return { exactEditableCases: cases.length, inputEventCounts: inputCounts };
  });

  await scenario('contenteditable-rejected', async (page, call) => {
    const response = await call('pageFill', '#editor', 'A rejected edit', false);
    assert.equal(response.error?.code, 'CHROME_FILL_NOT_STICKY');
    assert.equal(await page.locator('#editor').textContent(), 'rejected');
  });

  await scenario('select', async (page, call) => {
    const result = success(await call('pageFill', '#choice', 'Choice B', false));
    assert.equal(await page.locator('#choice').inputValue(), 'b');
    assert.equal(await page.evaluate(() => fixtureState.accepted), 'b');
    assert.equal(result.domValueRetained, true);
  });

  await scenario('select-rejected', async (page, call) => {
    const response = await call('pageFill', '#choice', 'b', false);
    assert.equal(response.error?.code, 'CHROME_FILL_NOT_STICKY');
    assert.equal(await page.locator('#choice').inputValue(), 'a');
  });

  await scenario('invalid-submit', async (page, call) => {
    const result = success(await call('pageFill', '#filled', 'valid here', true));
    assert.equal(result.submissionRequested, true);
    assert.equal(result.submissionObserved, false);
    assert.equal(result.submissionBlocked, true);
    assert.equal(result.submitted, false);
    assert.equal(result.outcomeVerified, false);
    assert.equal(await page.evaluate(() => fixtureState.saves), 0);
    return { businessSubmissionCount: 0, validationPreventedSubmission: true };
  });

  await scenario('no-form-submit', async (page, call) => {
    const result = success(await call('pageFill', '#plain', 'standalone', true));
    assert.equal(result.submissionRequested, true);
    assert.equal(result.submissionObserved, false);
    assert.equal(result.submitted, false);
    assert.equal(result.outcomeVerified, false);
  });

  await scenario('read-only', async (page, call) => {
    const response = await call('pageFill', '#locked', 'overwrite', false);
    assert.ok(response.error?.code, 'Read-only field must be refused');
    assert.equal(await page.locator('#locked').inputValue(), 'unchanged');
    assert.equal(await page.evaluate(() => fixtureState.events.input || 0), 0);
  });

  await scenario('focus-lock', async (page, call) => {
    const response = await call('pageFill', '#locking', 'overwrite', false);
    assert.equal(response.error?.code, 'CHROME_ELEMENT_READ_ONLY');
    assert.equal(await page.locator('#locking').inputValue(), 'unchanged');
    assert.equal(await page.evaluate(() => fixtureState.events.input || 0), 0);
    return { refusedAfterSynchronousFocusLock: true };
  });

  await scenario('beforeinput-lock', async (page, call) => {
    const response = await call('pageFill', '#locking', 'overwrite', false);
    assert.equal(response.error?.code, 'CHROME_ELEMENT_DISABLED');
    assert.equal(await page.locator('#locking').inputValue(), 'unchanged');
    assert.equal(await page.evaluate(() => fixtureState.events.input || 0), 0);
    return { refusedAfterSynchronousBeforeinputLock: true };
  });

  await scenario('cancel-beforeinput', async (page, call) => {
    const response = await call('pageFill', '#cancel', 'overwrite', false);
    assert.ok(response.error?.code, 'Canceled beforeinput must be refused');
    assert.equal(await page.locator('#cancel').inputValue(), 'unchanged');
    assert.equal(await page.evaluate(() => fixtureState.events.input || 0), 0);
  });

  await scenario('suspended-raf', async (page, call) => {
    const started = performance.now();
    const result = success(await call('pageFill', '#background', 'background accepted', false));
    const elapsedMs = Math.round(performance.now() - started);
    assert.equal(result.domValueRetained, true);
    assert.equal(await page.evaluate(() => fixtureState.accepted), 'background accepted');
    assert.ok(await page.evaluate(() => fixtureState.events.raf > 0));
    assert.ok(elapsedMs >= 200, `Expected fallback wait to be exercised, got ${elapsedMs}ms`);
    assert.ok(elapsedMs < 1500, `Suspended RAF must not hang, got ${elapsedMs}ms`);
    return { elapsedMs, animationCallbacksExecuted: 0 };
  });

  await scenario('hidden-first', async (page, call) => {
    const result = success(await call('pageFill', '.field', 'visible replacement', false));
    assert.equal(await page.locator('.field').nth(0).inputValue(), 'hidden');
    assert.equal(await page.locator('.field').nth(1).inputValue(), 'visible replacement');
    assert.equal(result.selectedVisible, true);
  });

  await scenario('click-event-sequence', async (page, call, record) => {
    const box = await page.locator('#mouse-action').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const native = await page.evaluate(() => fixtureState.sequence);
    assert.equal(await page.evaluate(() => fixtureState.saves), 1);
    await page.evaluate(() => { document.getElementById('mouse-action').blur(); fixtureState.sequence = []; fixtureState.saves = 0; });
    const result = success(await call('pageClick', '#mouse-action'));
    const worker = await page.evaluate(() => fixtureState.sequence);
    record({ native, worker });
    const clickProperties = event => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'trusted'));
    assert.deepEqual(clickProperties(worker.find(event => event.type === 'click')), clickProperties(native.find(event => event.type === 'click')), 'The final synthetic mouse click must preserve the measured native click semantics except trust');
    assert.equal(worker.find(event => event.type === 'mouseup').detail, 1, 'mouseup must retain the same click count as mousedown');
    assert.ok(worker.filter(event => event.type !== 'focus').every(event => event.viewIsWindow));
    assert.equal(worker.find(event => event.type === 'click').trusted, false, 'Synthetic action must not impersonate trusted hardware input');
    assert.equal(await page.evaluate(() => fixtureState.saves), 1);
    assert.equal(result.clicked, true);
    return { clickCount: 1, nativePointerSemanticsMatched: true, trustPreservedAsSynthetic: true };
  });

  await scenario('mouse-sensitive-menu', async (page, call, record) => {
    await page.locator('#mouse-menu-action').click();
    const native = await page.evaluate(() => fixtureState.lastMenuEvent);
    record({ native });
    assert.equal(await page.locator('#roles-panel').isVisible(), true, 'The fixture must accept a native mouse click');
    await page.evaluate(() => { document.getElementById('mouse-menu').hidden = false; document.getElementById('roles-panel').hidden = true; fixtureState.saves = 0; fixtureState.clickAttempts = 0; });
    success(await call('pageClick', '#mouse-menu-action'));
    const observed = await page.evaluate(() => ({ panelVisible: !document.getElementById('roles-panel').hidden, menuClosed: document.getElementById('mouse-menu').hidden, acceptedCount: fixtureState.saves, clickAttempts: fixtureState.clickAttempts }));
    record({ native, worker: observed, workerEvent: await page.evaluate(() => fixtureState.lastMenuEvent) });
    assert.deepEqual(observed, { panelVisible: true, menuClosed: true, acceptedCount: 1, clickAttempts: 1 });
    return { acceptedCount: 1, fixtureRequiresCoherentMouseClick: true, providerCauseEstablished: false };
  });

  await scenario('click-default-activation', async (page, call, record) => {
    success(await call('pageClick', '#check-default'));
    success(await call('pageClick', '#check-cancelled'));
    success(await call('pageClick', '#link-default'));
    success(await call('pageClick', '#link-cancelled'));
    const observed = await page.evaluate(() => ({ checked: document.getElementById('check-default').checked, cancelledChecked: document.getElementById('check-cancelled').checked, events: fixtureState.events, hash: location.hash }));
    record(observed);
    assert.deepEqual(observed, { checked: true, cancelledChecked: false, events: { 'check-default:input': 1, 'check-default:change': 1 }, hash: '#activation-target' });
    return { checkboxToggledOnce: true, localLinkActivated: true, preventDefaultRespected: true };
  });

  await scenario('react-native-edit-reference', async (page, call, record) => {
    await page.locator('#react-amount').waitFor({ state: 'visible' });
    await page.locator('#react-amount').focus();
    await page.keyboard.insertText('10');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#react-model').textContent(), '10');
    await page.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.getElementById('react-receipt').textContent.includes('received'));
    const recorded = receipts.filter(receipt => receipt.scenario === 'react-native-edit-reference');
    assert.deepEqual(recorded, [{ scenario: 'react-native-edit-reference', amount: 10, draft: '10.00' }]);
    const observed = await page.evaluate(() => ({ events: fixtureState.editEvents, reactChanges: fixtureState.events.reactChange, execCommands: fixtureState.execCommands }));
    record(observed);
    return { serverReceivedAmount: 10, submissions: 1, nativeReferenceAccepted: true };
  });

  await scenario('react-native-edit-setter', async (page, call, record) => {
    await page.locator('#react-amount').waitFor({ state: 'visible' });
    const result = success(await call('pageFill', '#react-amount', '10', true, { commit: 'blur', normalization: 'numeric' }));
    const observed = await page.evaluate(() => ({ display: document.getElementById('react-amount').value, model: document.getElementById('react-model').textContent, businessError: document.getElementById('react-error').textContent, saves: fixtureState.saves, execCommands: fixtureState.execCommands, events: fixtureState.editEvents }));
    record(observed);
    assert.equal(observed.display, '10');
    assert.equal(observed.model, 'null');
    assert.equal(observed.businessError, 'Missing committed amount');
    assert.equal(observed.saves, 0);
    assert.equal(observed.execCommands, 0, 'Default strategy must remain explicit value assignment');
    assert.equal(result.domValueRetained, true);
    assert.equal(result.applicationAccepted, null);
    assert.equal(result.outcomeVerified, false);
    assert.equal(receipts.filter(receipt => receipt.scenario === 'react-native-edit-setter').length, 0);
    return { displayRetained: true, businessAmountAccepted: false, applicationRejectionHonest: true };
  });

  await scenario('react-native-edit-insert-text', async (page, call, record) => {
    await page.locator('#react-amount').waitFor({ state: 'visible' });
    const result = success(await call('pageFill', '#react-amount', '10', true, { commit: 'blur', normalization: 'numeric', inputStrategy: 'insert-text' }));
    const observed = await page.evaluate(() => ({ display: document.getElementById('react-amount').value, model: document.getElementById('react-model').textContent, businessError: document.getElementById('react-error').textContent, events: fixtureState.editEvents, execCommands: fixtureState.execCommands, reactChanges: fixtureState.events.reactChange }));
    record(observed);
    assert.equal(observed.model, '10', 'The React business model must accept the actual browser edit');
    assert.equal(observed.display, '10.00');
    assert.equal(observed.execCommands, 1, 'One explicit editing operation, with no fallback write');
    assert.equal(observed.reactChanges, 1);
    assert.equal(observed.events.filter(event => event.type === 'input').length, 1);
    assert.equal(observed.events.filter(event => event.type === 'change').length, 1, 'Blur must not duplicate the native change event');
    await page.waitForFunction(() => document.getElementById('react-receipt').textContent.includes('received'));
    const recorded = receipts.filter(receipt => receipt.scenario === 'react-native-edit-insert-text');
    assert.deepEqual(recorded, [{ scenario: 'react-native-edit-insert-text', amount: 10, draft: '10.00' }]);
    assert.equal(result.applicationAccepted, null);
    assert.equal(result.outcomeVerified, false);
    return { reactVersion, serverReceivedAmount: 10, submissions: 1, nativeEditOperations: 1, reactChanges: 1 };
  });

  await scenario('insert-text-supported', async (page, call, record) => {
    const cases = [];
    record(cases);
    for (const type of ['text', 'search', 'tel', 'url', 'password', 'textarea']) {
      const value = type === 'textarea' ? 'A\nB' : '10';
      const selector = `#edit-${type}`;
      const native = await page.locator(selector).evaluate((field, value) => {
        field.focus(); field.setSelectionRange(0, field.value.length);
        const commandReturned = document.execCommand('insertText', false, value);
        field.blur();
        const reference = { commandReturned, events: fixtureState.fieldEvents[field.id] };
        field.value = field.tagName === 'TEXTAREA' ? 'before' : '123';
        fixtureState.fieldEvents[field.id] = []; fixtureState.execCommands = 0;
        return reference;
      }, value);
      assert.equal(native.commandReturned, true);
      const result = success(await call('pageFill', selector, value, false, { commit: 'blur', inputStrategy: 'insert-text' }));
      const worker = await page.locator(selector).evaluate(field => ({ value: field.value, events: fixtureState.fieldEvents[field.id], execCommands: fixtureState.execCommands }));
      cases.push({ type, native, worker, reportedStrategy: result.inputStrategy });
      assert.equal(worker.value, value);
      assert.equal(worker.execCommands, 1);
      for (const eventType of ['input', 'change']) assert.equal(worker.events.filter(event => event.type === eventType).length, native.events.filter(event => event.type === eventType).length, `${type} ${eventType} count must match one native editing operation`);
      assert.equal(worker.events.filter(event => event.type === 'beforeinput').length, 1, 'A single cancellable intent event must precede the native edit');
      assert.equal(result.domValueRetained, true);
    }
    return { supportedControlTypes: cases.map(item => item.type), nativeCountsMatched: true };
  });

  await scenario('insert-text-unsupported', async (page, call, record) => {
    for (const [selector, original, requested] of [['#edit-email', 'before@example.test', 'after@example.test'], ['#edit-number', '7', '10']]) {
      const response = await call('pageFill', selector, requested, false, { inputStrategy: 'insert-text' });
      record({ selector, response, actualValue: await page.locator(selector).inputValue() });
      assert.ok(response.error?.code, 'An unsupported selection type must refuse the explicit editing strategy');
      assert.equal(await page.locator(selector).inputValue(), original);
    }
    assert.equal(await page.evaluate(() => fixtureState.execCommands), 0);
    assert.equal(await page.evaluate(() => fixtureState.events.input || 0), 0);
    return { refusedBeforeMutation: true, unsupportedTypes: ['email', 'number'] };
  });

  for (const name of ['insert-text-cancelled', 'insert-text-command-failure', 'insert-text-rejected']) {
    await scenario(name, async (page, call, record) => {
      const response = await call('pageFill', '#edit-failure', '10', false, { commit: 'blur', inputStrategy: 'insert-text' });
      const observed = await page.evaluate(() => ({ value: document.getElementById('edit-failure').value, events: fixtureState.events, execCommands: fixtureState.execCommands }));
      record({ ...observed, response });
      assert.ok(response.error?.code, 'Cancelled, failed, or rejected explicit edits must report failure');
      assert.equal(observed.value, name === 'insert-text-rejected' ? 'rejected' : 'before');
      assert.equal(observed.execCommands, name === 'insert-text-cancelled' ? 0 : 1, 'Never retry an editing operation or silently fall back to a setter');
      assert.equal(observed.events.input || 0, name === 'insert-text-rejected' ? 1 : 0);
      return { nativeEditOperations: observed.execCommands, fallbackWrites: 0, rejectionReported: true };
    });
  }

  await scenario('dom-click-direct-menu', async (page, call, record) => {
    success(await call('pageClick', '#direct-action'));
    const adaptive = await page.evaluate(() => ({ disarmed: fixtureState.disarmed, saves: fixtureState.saves, events: fixtureState.actionTrace }));
    assert.equal(adaptive.saves, 0, 'Fixture must demonstrate why a caller might select pure DOM activation');
    assert.equal(adaptive.disarmed, true);
    await page.evaluate(() => { document.getElementById('direct-menu').hidden = false; fixtureState.disarmed = false; fixtureState.actionTrace = []; fixtureState.saves = 0; document.getElementById('direct-action').blur(); });
    const result = success(await call('pageClick', '#direct-action', { clickStrategy: 'dom-click' }));
    const direct = await page.evaluate(() => ({ disarmed: fixtureState.disarmed, saves: fixtureState.saves, events: fixtureState.actionTrace, settingsVisible: !document.getElementById('direct-result').hidden }));
    record({ adaptive, direct, result });
    assert.deepEqual(direct, { disarmed: false, saves: 1, events: ['click'], settingsVisible: true });
    assert.deepEqual(result.events, ['click']);
    assert.equal(result.clicked, true);
    assert.equal(result.trusted, false);
    return { directActivationCount: 1, noHoverDownFocusPrelude: true, providerCauseEstablished: false };
  });

  await scenario('dom-click-default-activation', async (page, call, record) => {
    for (const selector of ['#check-default', '#check-cancelled', '#link-default', '#link-cancelled']) {
      const result = success(await call('pageClick', selector, { clickStrategy: 'dom-click' }));
      assert.deepEqual(result.events, ['click']);
    }
    const observed = await page.evaluate(() => ({ checked: document.getElementById('check-default').checked, cancelledChecked: document.getElementById('check-cancelled').checked, events: fixtureState.events, hash: location.hash }));
    record(observed);
    assert.deepEqual(observed, { checked: true, cancelledChecked: false, events: { 'check-default:input': 1, 'check-default:change': 1 }, hash: '#activation-target' });
    return { checkboxToggledOnce: true, linkActivatedOnce: true, cancellationRespected: true };
  });

  await scenario('dom-click-refused', async (page, call, record) => {
    const disabled = await call('pageClick', '#direct-disabled', { clickStrategy: 'dom-click' });
    const expired = await call('pageClick', '#direct-expired', { clickStrategy: 'dom-click', deadlineMs: Date.now() - 1000 });
    const events = await page.evaluate(() => fixtureState.events);
    record({ disabled, expired, events });
    assert.equal(disabled.error?.code, 'CHROME_ELEMENT_DISABLED');
    assert.equal(expired.error?.code, 'CHROME_OPERATION_DEADLINE_EXCEEDED');
    assert.deepEqual(events, {});
    return { disabledAndExpiredRefusedBeforeAction: true };
  });

  await scenario('react-text-input-existing-strategy', async (page, call, record) => {
    await page.locator('#react-amount').waitFor({ state: 'visible' });
    const result = success(await call('pageFill', '#react-amount', '10', true, { commit: 'blur', normalization: 'numeric', inputStrategy: 'insert-text' }));
    const observed = await page.evaluate(() => ({ value: document.getElementById('react-amount').value, model: document.getElementById('react-model').textContent, error: document.getElementById('react-error').textContent, events: fixtureState.editEvents, reactBeforeInput: fixtureState.events.reactBeforeInput || 0, reactInput: fixtureState.events.reactInput || 0, reactChange: fixtureState.events.reactChange || 0, execCommands: fixtureState.execCommands }));
    record(observed);
    assert.equal(observed.value, '10');
    assert.equal(observed.model, 'null');
    assert.equal(observed.error, 'Missing committed amount');
    assert.equal(observed.reactBeforeInput, 0, 'Existing insert-text semantics must remain unchanged');
    assert.equal(observed.reactInput, 1);
    assert.equal(observed.reactChange, 1);
    assert.equal(observed.execCommands, 1);
    assert.equal(result.applicationAccepted, null);
    assert.equal(receipts.filter(item => item.scenario === 'react-text-input-existing-strategy').length, 0);
    return { existingStrategyUnchanged: true, rejectionNotMisrepresented: true };
  });

  await scenario('react-text-input-accept', async (page, call, record) => {
    await page.locator('#react-amount').waitFor({ state: 'visible' });
    const result = success(await call('pageFill', '#react-amount', '10', true, { commit: 'blur', normalization: 'numeric', inputStrategy: 'text-input' }));
    const observed = await page.evaluate(() => ({ value: document.getElementById('react-amount').value, model: document.getElementById('react-model').textContent, events: fixtureState.editEvents, beforeInputs: fixtureState.reactBeforeInputEvents, reactBeforeInput: fixtureState.events.reactBeforeInput || 0, reactInput: fixtureState.events.reactInput || 0, reactChange: fixtureState.events.reactChange || 0, execCommands: fixtureState.execCommands }));
    record(observed);
    assert.equal(observed.model, '10');
    assert.equal(observed.value, '10.00');
    assert.equal(observed.reactBeforeInput, 1);
    assert.equal(observed.reactInput, 1);
    assert.equal(observed.reactChange, 1);
    assert.equal(observed.execCommands, 1);
    assert.deepEqual(observed.events.map(event => event.type), ['beforeinput', 'textInput', 'input', 'change', 'blur']);
    assert.deepEqual(observed.beforeInputs, [{ nativeType: 'textInput', data: '10', trusted: false }]);
    await page.waitForFunction(() => document.getElementById('react-receipt').textContent.includes('received'));
    const saved = receipts.filter(item => item.scenario === 'react-text-input-accept');
    assert.deepEqual(saved, [{ scenario: 'react-text-input-accept', amount: 10, draft: '10.00' }]);
    assert.equal(result.applicationAccepted, null);
    assert.equal(result.outcomeVerified, false);
    return { serverReceivedAmount: 10, submissions: 1, nativeEditOperations: 1, reactBeforeInputDeliveredOnce: true };
  });

  for (const name of ['react-text-input-dom-cancelled', 'react-text-input-react-cancelled']) {
    await scenario(name, async (page, call, record) => {
      await page.locator('#react-amount').waitFor({ state: 'visible' });
      const response = await call('pageFill', '#react-amount', '10', true, { commit: 'blur', normalization: 'numeric', inputStrategy: 'text-input' });
      const observed = await page.evaluate(() => ({ value: document.getElementById('react-amount').value, events: fixtureState.editEvents, reactBeforeInput: fixtureState.events.reactBeforeInput || 0, reactInput: fixtureState.events.reactInput || 0, reactChange: fixtureState.events.reactChange || 0, execCommands: fixtureState.execCommands }));
      record({ response, observed });
      assert.ok(response.error?.code);
      assert.equal(observed.value, '');
      assert.equal(observed.reactBeforeInput, 1);
      assert.equal(observed.reactInput, 0);
      assert.equal(observed.reactChange, 0);
      assert.equal(observed.execCommands, 0);
      assert.deepEqual(observed.events.map(event => event.type), ['beforeinput', 'textInput']);
      assert.equal(receipts.filter(item => item.scenario === name).length, 0);
      return { cancellationRespected: true, nativeEditOperations: 0, submissions: 0 };
    });
  }

  for (const name of ['text-input-value-change', 'text-input-replaced', 'text-input-handler-edit', 'text-input-handler-same-value']) {
    await scenario(name, async (page, call, record) => {
      const response = await call('pageFill', '#text-intent', '10', false, { commit: 'blur', inputStrategy: 'text-input' });
      const observed = await page.evaluate(() => ({ value: document.getElementById('text-intent').value, events: fixtureState.events, execCommands: fixtureState.execCommands, handlerCommands: fixtureState.handlerCommands, replacements: fixtureState.replacements }));
      record({ response, observed });
      assert.ok(response.error?.code, 'A reentrant handler mutation must be reported before a second edit');
      assert.equal(observed.value, name === 'text-input-replaced' ? 'replacement-owned' : name === 'text-input-handler-same-value' ? 'before' : 'handler-owned');
      assert.equal(observed.events.beforeinput, 1);
      assert.equal(observed.events.textInput, 1);
      assert.equal(observed.execCommands, name.startsWith('text-input-handler-') ? 1 : 0, 'The worker must not issue its own command after a handler mutation');
      assert.equal(observed.handlerCommands, name.startsWith('text-input-handler-') ? 1 : 0);
      assert.equal(observed.events.input || 0, name.startsWith('text-input-handler-') ? 1 : 0);
      if (name.startsWith('text-input-handler-')) assert.equal(response.error.code, 'CHROME_TEXT_EDIT_ALREADY_HANDLED');
      assert.equal(observed.replacements, name === 'text-input-replaced' ? 1 : 0);
      return { handlerMutationPreserved: true, workerNativeEditOperations: 0, fallbackWrites: 0 };
    });
  }
  await scenario('active-focus-blur-native', async (page, call, record) => {
    const variants = [];
    for (const inputStrategy of ['set-value', 'insert-text', 'text-input']) {
      await page.evaluate(() => { document.getElementById('focus-case').value = ''; fixtureState.focusEvents = []; });
      const result = success(await call('pageFill', '#focus-case', '10', false, { inputStrategy, commit: 'blur' }));
      const observed = await page.evaluate(() => ({ events: fixtureState.focusEvents, hasFocus: document.hasFocus(), activeElement: document.activeElement?.id || document.activeElement?.tagName }));
      variants.push({ inputStrategy, result, observed });
      assert.equal(observed.hasFocus, true, 'This scenario verifies preservation of native events in an active document');
      assert.deepEqual(observed.events.map(event => event.type), ['focus', 'focusin', 'blur', 'focusout']);
      assert.ok(observed.events.every(event => event.trusted), 'No synthetic duplicates may be added when native focus events were delivered');
      assert.equal(observed.activeElement, 'BODY');
    }
    record({ variants });
    return { nativeFocusEventsPreserved: true, duplicateSyntheticEvents: 0, strategies: variants.length };
  });
} catch (error) {
  fatalError = { message: error.message, stack: error.stack };
} finally {
  if (context) { await context.close(); browserClosed = true; }
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profilePath, { recursive: true, force: true });
  profileRemoved = await fs.stat(profilePath).then(() => false, error => error.code === 'ENOENT');
}

const passed = !fatalError && results.length === 107 && results.every(result => result.passed) && profileRemoved && browserClosed;
console.log(JSON.stringify({
  passed,
  browserVersion,
  browserChannel: process.env.MDB_BROWSER_TEST_CHANNEL || null,
  reactVersion,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  workerPath,
  workerSha256,
  testSourceSha256,
  fixtureSourceSha256,
  reactFixtureSha256,
  isolation: {
    profilePath,
    newTemporaryProfile: true,
    noExistingBrowserAttachment: true,
    networkRestrictedToFixtureOrigin: origin,
    externalRequestsBlocked: blockedRequests.length,
    browserClosed,
    profileRemoved,
    serverClosed: !server.listening,
  },
  fixtureReceiptCount: receipts.length,
  fixtureReceipts: receipts,
  scenarios: results,
  compatibilityMeasurements,
  ...(fatalError ? { fatalError } : {}),
}, null, 2));
if (!passed) process.exitCode = 1;
