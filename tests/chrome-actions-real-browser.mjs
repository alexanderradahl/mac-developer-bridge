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
const actionSource = ['pageSnapshot', 'pageClick', 'pageFill'].map(extractFunction).join('\n\n')
  + '\nwindow.mdbTestActions = { pageSnapshot, pageClick, pageFill };';

const receipts = [];
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/fixture') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixture);
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
    const result = await run(page, call);
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
} catch (error) {
  fatalError = { message: error.message, stack: error.stack };
} finally {
  if (context) { await context.close(); browserClosed = true; }
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profilePath, { recursive: true, force: true });
  profileRemoved = await fs.stat(profilePath).then(() => false, error => error.code === 'ENOENT');
}

const passed = !fatalError && results.length === 19 && results.every(result => result.passed) && profileRemoved && browserClosed;
console.log(JSON.stringify({
  passed,
  browserVersion,
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
  ...(fatalError ? { fatalError } : {}),
}, null, 2));
if (!passed) process.exitCode = 1;
