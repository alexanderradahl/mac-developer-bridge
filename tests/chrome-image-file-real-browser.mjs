import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { prepareChromeImageFile } from '../lib/chrome-image-file.mjs';

// This suite launches a fresh headless browser profile, never an owner profile.
// MDB_BROWSER_TEST_PLAYWRIGHT=/absolute/test-deps/node_modules/playwright/index.mjs \
// MDB_BROWSER_TEST_CHANNEL=chrome node tests/chrome-image-file-real-browser.mjs
// Fixture-only mode serves owned loopback content without attaching to a browser:
// MDB_IMAGE_FILE_FIXTURE_ONLY=1 node tests/chrome-image-file-real-browser.mjs
// Installed smoke users must perform upload and the separate Save through public
// bridge actions, then verify the receipt and a fresh document. REQUIRE_HIDDEN=1
// makes the server reject a save unless both upload events were hidden/unfocused.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function makePng() {
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(type, bytes) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const body = Buffer.concat([Buffer.from(type), bytes]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(3, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, 35, 83, 53, 255, 35, 83, 53, 255, 35, 83, 53, 255]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}

export async function createImageFileFixtureServer({ actionSource = '', requireHidden = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-image-file-fixture-')));
  await fs.chmod(directory, 0o700);
  const fixturePath = path.join(root, 'tests/fixtures/chrome-image-file-input.html');
  const fixtureBytes = await fs.readFile(fixturePath);
  const imageBytes = makePng();
  const imagePath = path.join(directory, 'reviewed-logo.png');
  await fs.writeFile(imagePath, imageBytes, { mode: 0o600 });
  const image = await prepareChromeImageFile({ localPath: imagePath, expectedSha256: hash(imageBytes), mimeType: 'image/png' });
  const receipts = [];
  const rejectedReceipts = [];
  const savedFiles = new Map();
  const getState = scenario => ({ count: receipts.filter(item => item.scenario === scenario).length,
    file: receipts.findLast(item => item.scenario === scenario)?.file || null });
  let origin;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers.host !== '127.0.0.1:' + server.address().port) { response.writeHead(403).end(); return; }
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && ['/', '/fixture'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(fixtureBytes.toString('utf8').replace('</body>', (actionSource ? '<script src="/actions.js"></script>' : '') + '</body>'));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/actions.js' && actionSource) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(actionSource); return;
    }
    if (request.method === 'GET' && url.pathname === '/pixel.png') { response.setHeader('Content-Type', 'image/png'); response.end(imageBytes); return; }
    if (request.method === 'GET' && url.pathname === '/state') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(getState(url.searchParams.get('scenario') || 'installed'))); return;
    }
    if (request.method === 'GET' && url.pathname === '/saved-image') {
      const saved = savedFiles.get(url.searchParams.get('scenario') || 'installed');
      if (!saved) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'image/png'); response.end(saved); return;
    }
    if (request.method === 'GET' && url.pathname === '/receipts') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ receipts, rejectedReceipts, requireHidden })); return;
    }
    if (request.method === 'POST' && url.pathname === '/save') {
      if (request.headers.origin !== origin) { response.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 2 * 1024 * 1024) { response.writeHead(413).end(); return; } }
      try {
        const data = JSON.parse(body);
        assert.equal(typeof data.scenario, 'string');
        assert.equal(getState(data.scenario).count, 0, 'A duplicate save is rejected by the fixture');
        assert.equal(data.name, image.name);
        assert.equal(data.mimeType, image.mimeType);
        assert.equal(data.size, image.size);
        const receivedBytes = Buffer.from(data.base64, 'base64');
        assert.deepEqual(receivedBytes, imageBytes, 'The provider receives the exact reviewed bytes');
        assert.equal(hash(receivedBytes), image.sha256);
        assert.equal(data.sha256, image.sha256);
        const events = data.events || [];
        if (requireHidden) {
          const fileEvents = events.filter(event => ['input', 'change'].includes(event.type));
          assert.deepEqual(fileEvents.map(event => [event.type, event.target]), [['input', 'logo-file'], ['change', 'logo-file']]);
          assert.ok(fileEvents.every(event => event.hasFocus === false && event.visibilityState === 'hidden' && event.trusted === false));
        }
        const file = { name: data.name, mimeType: data.mimeType, size: data.size, sha256: data.sha256 };
        savedFiles.set(data.scenario, receivedBytes);
        receipts.push({ scenario: data.scenario, file, events, receivedAt: new Date().toISOString() });
        await fs.writeFile(path.join(directory, 'receipts.json'), JSON.stringify({ receipts, rejectedReceipts, requireHidden }, null, 2), { mode: 0o600 });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(getState(data.scenario))); return;
      } catch (error) {
        rejectedReceipts.push({ reason: error.message });
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); return;
      }
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const info = { pid: process.pid, origin, directory, requireHidden, imagePath, imageSha256: image.sha256,
    imageMimeType: image.mimeType, imageSize: image.size, fixtureSha256: hash(fixtureBytes) };
  await fs.writeFile(path.join(directory, 'server-info.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
  return { origin, directory, image, info, getState, receipts, rejectedReceipts,
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function runBrowserTests() {
  const workerPath = path.resolve(process.env.MDB_BROWSER_TEST_WORKER || path.join(root, 'chrome-extension/service-worker.js'));
  const workerSource = await fs.readFile(workerPath, 'utf8');
  function extractFunction(name) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(workerSource);
    assert.ok(match, `Missing actual production function ${name}`);
    const end = workerSource.indexOf('\n}', match.index);
    assert.ok(end > match.index);
    const source = workerSource.slice(match.index, end + 2);
    new vm.Script(`(${source})`);
    return source;
  }
  const actionSource = ['pageSetFileInput', 'pageSnapshot', 'pageClick'].map(extractFunction).join('\n')
    + '\nwindow.mdbFileActions = { pageSetFileInput, pageSnapshot, pageClick };';
  const require = createRequire(import.meta.url);
  const playwrightPath = process.env.MDB_BROWSER_TEST_PLAYWRIGHT || require.resolve('playwright');
  const { chromium } = await import(playwrightPath);
  const fixture = await createImageFileFixtureServer({ actionSource });
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-image-file-browser-')));
  await fs.chmod(profile, 0o700);
  const results = [];
  const measurements = {};
  const blockedRequests = [];
  let context;
  let browserVersion;
  let browserClosed = false;
  let profileRemoved = false;
  let serverClosed = false;
  let fatalError;
  async function scenario(name, run) {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const startedAt = performance.now();
    try {
      await page.goto(fixture.origin + '/fixture?scenario=' + encodeURIComponent(name));
      await page.waitForSelector('body[data-ready="true"]');
      const call = async (selector = '#logo-file', file = fixture.image, options = {}) => page.evaluate(async ({ selector, file, options }) => {
        try { return { result: await mdbFileActions.pageSetFileInput(selector, file, { deadlineMs: Date.now() + (options.testBudgetMs || 3000), ...options }) }; }
        catch (error) { return { error: { code: error.code, message: error.message, details: error.details } }; }
      }, { selector, file, options });
      const read = () => page.evaluate(() => fixtureEvidence());
      const record = value => { measurements[name] = value; };
      await run(page, call, read, record);
      assert.deepEqual(pageErrors, [], 'No unexpected fixture application exception');
      results.push({ name, passed: true, durationMs: Math.round(performance.now() - startedAt) });
    } catch (error) {
      measurements[name] = { ...measurements[name], errorState: await page.evaluate(() => fixtureEvidence?.()).catch(() => null) };
      results.push({ name, passed: false, error: error.message, stack: error.stack, durationMs: Math.round(performance.now() - startedAt) });
    } finally { await page.close(); }
  }
  function success(response) {
    assert.ok(!response.error, JSON.stringify(response.error));
    const result = response.result;
    assert.equal(result.fileAssigned, true);
    assert.equal(result.inputEventDispatched, true);
    assert.equal(result.changeEventDispatched, true);
    assert.equal(result.fileRetained, true);
    assert.equal(result.fileCount, 1);
    assert.equal(result.fileSize, fixture.image.size);
    assert.equal(result.fileSha256, fixture.image.sha256);
    assert.equal(result.outcomeVerified, false, 'Dispatch is never misreported as provider acceptance');
    assert.ok(!JSON.stringify(result).includes(fixture.image.base64));
    assert.ok(!JSON.stringify(result).includes(fixture.info.imagePath));
    return result;
  }
  function noImplicitAction(state) {
    assert.equal(state.events.filter(event => !['input', 'change'].includes(event.type)).length, 0, 'Upload dispatches no click, focus, pointer, keyboard, or submit fallback');
    assert.equal(state.submitCount, 0);
    assert.equal(state.saveAttempts, 0);
    assert.equal(state.saves, 0);
  }
  function flags(response, assigned, input, change) {
    assert.equal(response.error.details.fileAssigned, assigned);
    assert.equal(response.error.details.inputEventDispatched, input);
    assert.equal(response.error.details.changeEventDispatched, change);
  }
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true,
      ...(process.env.MDB_BROWSER_TEST_CHANNEL ? { channel: process.env.MDB_BROWSER_TEST_CHANNEL } : {}),
      viewport: { width: 1100, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false });
    browserVersion = context.browser()?.version() || await context.pages()[0].evaluate(() => navigator.userAgent);
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === fixture.origin) await route.continue();
      else { blockedRequests.push(route.request().url()); await route.abort('blockedbyclient'); }
    });
    for (const name of ['accepted-save', 'native-setter', 'unfocused-save']) await scenario(name, async (page, call, read, record) => {
      let decoy;
      if (name === 'unfocused-save') {
        decoy = await context.newPage();
        await decoy.goto(fixture.origin + '/fixture?scenario=decoy');
        await decoy.bringToFront();
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        assert.equal((await read()).hasFocus, false);
      }
      const before = await read();
      const result = success(await call());
      await page.waitForFunction(() => fixtureState.selectionReady || fixtureState.error);
      const selected = await read();
      assert.equal(selected.error, null);
      assert.equal(selected.pending.sha256, fixture.image.sha256);
      assert.deepEqual(selected.events.map(event => [event.type, event.target]), [['input', 'logo-file'], ['change', 'logo-file']]);
      assert.ok(selected.events.every(event => event.trusted === false && event.cancelable === false));
      assert.equal(selected.wrongInstanceSetterCalls, 0);
      assert.equal(selected.preview.naturalWidth, 3);
      assert.equal(selected.preview.naturalHeight, 2);
      assert.equal(selected.activeId, before.activeId, 'File assignment does not move DOM focus');
      noImplicitAction(selected);
      assert.equal(fixture.getState(name).count, 0);
      if (name === 'unfocused-save') assert.ok(selected.events.every(event => event.hasFocus === false));
      const save = await page.evaluate(async () => mdbFileActions.pageClick('#save-button', { clickStrategy: 'dom-click', deadlineMs: Date.now() + 3000 }));
      await page.waitForFunction(() => fixtureState.saves === 1 || fixtureState.error);
      const saved = await read();
      assert.equal(saved.error, null);
      assert.equal(saved.saveAttempts, 1);
      assert.equal(saved.saves, 1);
      assert.equal(fixture.getState(name).count, 1);
      assert.equal(saved.submitCount, 0);
      await page.reload();
      await page.waitForSelector('body[data-ready="true"]');
      await page.waitForFunction(() => fixtureState.saved && document.getElementById('logo-preview').complete);
      const reloaded = await read();
      assert.notEqual(reloaded.pageNonce, before.pageNonce);
      assert.equal(reloaded.saved.sha256, fixture.image.sha256);
      assert.equal(reloaded.saves, 1);
      assert.equal(reloaded.currentInput.files.length, 0, 'The new document has a fresh, empty file input');
      assert.equal(reloaded.preview.naturalWidth, 3);
      assert.equal(reloaded.preview.naturalHeight, 2);
      assert.equal(fixture.getState(name).count, 1, 'Fresh read never repeats Save');
      record({ before, result, selected, save, saved, reloaded, noHiddenClaimUnlessMeasured: true });
      if (decoy) await decoy.close();
    });
    await scenario('prevent-default', async (page, call, read, record) => {
      const result = success(await call());
      await page.waitForFunction(() => fixtureState.selectionReady || fixtureState.error);
      const state = await read();
      assert.equal(result.inputDefaultPrevented, false);
      assert.equal(result.changeDefaultPrevented, false);
      assert.deepEqual(state.events.map(event => event.type), ['input', 'change']);
      assert.ok(state.events.every(event => event.cancelable === false && event.defaultPrevented === false));
      noImplicitAction(state);
      record({ result, state, note: 'preventDefault on noncancelable file events neither cancels nor triggers replay.' });
    });
    await scenario('application-rejects', async (page, call, read, record) => {
      const result = success(await call());
      const state = await read();
      assert.match(state.error, /fixture rejected/);
      assert.equal(state.selectionReady, false);
      noImplicitAction(state);
      assert.equal(fixture.getState('application-rejects').count, 0);
      record({ result, state, note: 'Application rejection is observed separately; the tool never retries or saves.' });
    });
    const targetErrors = [
      ['missing-target', '#missing-file', 'CHROME_ELEMENT_NOT_FOUND'],
      ['ambiguous-target', '.ambiguous-file', 'CHROME_FILE_INPUT_AMBIGUOUS'],
      ['wrong-input-type', '#text-field', 'CHROME_ELEMENT_NOT_FILE_INPUT'],
      ['disabled-target', '#disabled-file', 'CHROME_ELEMENT_DISABLED'],
      ['disabled-fieldset', '#fieldset-disabled', 'CHROME_ELEMENT_DISABLED'],
      ['directory-target', '#directory-file', 'CHROME_FILE_DIRECTORY_UNSUPPORTED'],
      ['unaccepted-mime', '#wrong-accept', 'CHROME_FILE_ACCEPT_MISMATCH'],
    ];
    for (const [name, selector, code] of targetErrors) await scenario(name, async (page, call, read, record) => {
      const response = await call(selector);
      assert.equal(response.error?.code, code, JSON.stringify(response));
      flags(response, false, false, false);
      const state = await read();
      assert.deepEqual(state.events, []);
      assert.equal(await page.evaluate(selector => [...document.querySelectorAll(selector)].every(node => !node.files?.length), selector), true);
      noImplicitAction(state);
      record({ response, state });
    });
    for (const [name, selector] of [['extension-accept', '#visible-file'], ['mime-wildcard-one-file', '#wildcard-file']]) await scenario(name, async (page, call, read, record) => {
      const result = success(await call(selector));
      const state = await read();
      assert.deepEqual(state.events.map(event => [event.type, event.target]), [['input', selector.slice(1)], ['change', selector.slice(1)]]);
      assert.equal(await page.evaluate(selector => document.querySelector(selector).files.length, selector), 1);
      noImplicitAction(state);
      record({ result, state });
    });
    for (const change of ['replace', 'disable', 'type', 'clear', 'same-name', 'duplicate', 'url', 'root']) for (const timing of ['', '-microtask']) {
      await scenario('guard-' + change + timing, async (page, call, read, record) => {
        const response = await call();
        const expected = { replace: 'CHROME_FILE_INPUT_REPLACED', disable: 'CHROME_ELEMENT_DISABLED',
          type: 'CHROME_ELEMENT_NOT_FILE_INPUT', clear: 'CHROME_FILE_SELECTION_CHANGED', 'same-name': 'CHROME_FILE_SELECTION_CHANGED',
          duplicate: 'CHROME_FILE_INPUT_REPLACED', url: 'CHROME_DOCUMENT_CHANGED', root: 'CHROME_DOCUMENT_CHANGED' }[change];
        assert.equal(response.error?.code, expected, JSON.stringify(response));
        flags(response, true, true, false);
        const state = await read();
        assert.deepEqual(state.events.map(event => event.type), ['input'], 'No change is redirected to a replacement or invalid input');
        assert.equal(state.selectionReady, false);
        noImplicitAction(state);
        if (change === 'replace') assert.equal(state.currentInput.files.length, 0);
        record({ response, state });
      });
    }
    await scenario('expected-document-url-mismatch', async (page, call, read, record) => {
      const response = await call('#logo-file', fixture.image, { expectedUrl: fixture.origin + '/unrelated-document' });
      assert.equal(response.error?.code, 'CHROME_DOCUMENT_CHANGED', JSON.stringify(response));
      flags(response, false, false, false);
      const state = await read();
      assert.deepEqual(state.events, []);
      noImplicitAction(state);
      record({ response, state });
    });
    for (const [name, options, assigned] of [
      ['expired-before-assignment', { deadlineMs: 1 }, false],
      ['guard-deadline', { testBudgetMs: 100 }, true],
      ['guard-deadline-microtask', { testBudgetMs: 100 }, true],
    ]) await scenario(name, async (page, call, read, record) => {
      const response = await call('#logo-file', fixture.image, options);
      assert.equal(response.error?.code, 'CHROME_OPERATION_DEADLINE_EXCEEDED', JSON.stringify(response));
      flags(response, assigned, assigned, false);
      const state = await read();
      assert.deepEqual(state.events.map(event => event.type), assigned ? ['input'] : []);
      noImplicitAction(state);
      record({ response, state });
    });
    for (const [name, mutate] of [
      ['payload-size-mismatch', file => ({ ...file, size: file.size + 1 })],
      ['payload-hash-mismatch', file => ({ ...file, sha256: '0'.repeat(64) })],
      ['payload-invalid-base64', file => ({ ...file, base64: '<not base64>' })],
      ['payload-invalid-type', file => ({ ...file, mimeType: 'image/svg+xml' })],
      ['payload-invalid-name', file => ({ ...file, name: '../logo.png' })],
    ]) await scenario(name, async (page, call, read, record) => {
      const response = await call('#logo-file', mutate(fixture.image));
      assert.equal(response.error?.code, 'CHROME_FILE_PAYLOAD_INVALID', JSON.stringify(response));
      flags(response, false, false, false);
      const state = await read();
      assert.deepEqual(state.events, []);
      assert.equal(state.currentInput.files.length, 0);
      noImplicitAction(state);
      record({ response, state });
    });
    await scenario('error-as-data', async (page, call, read, record) => {
      const response = await call('#missing-file', fixture.image, { errorsAsData: true });
      assert.ok(!response.error);
      assert.equal(response.result?.__mdbPageActionError?.code, 'CHROME_ELEMENT_NOT_FOUND');
      const state = await read();
      assert.deepEqual(state.events, []);
      noImplicitAction(state);
      record({ response, state });
    });
    await scenario('passive-image-file-snapshot', async (page, call, read, record) => {
      await page.waitForFunction(() => document.getElementById('static-image').naturalWidth === 3);
      const before = await read();
      const snapshot = await page.evaluate(() => mdbFileActions.pageSnapshot(4000, 80));
      const after = await read();
      assert.deepEqual(after.events, before.events);
      assert.ok(Array.isArray(snapshot.images));
      assert.ok(Array.isArray(snapshot.fileInputs));
      const image = snapshot.images.find(item => item.selector === '#static-image');
      assert.ok(image, 'A visible image is discoverable');
      assert.equal(image.naturalWidth, 3);
      assert.equal(image.naturalHeight, 2);
      assert.equal(image.renderedWidth, 96);
      assert.equal(image.renderedHeight, 64);
      assert.equal(image.currentSrc, fixture.origin + '/pixel.png');
      assert.equal(image.complete, true);
      assert.ok(!snapshot.images.some(item => item.selector === '#hidden-image'));
      const input = snapshot.fileInputs.find(item => item.selector === '#logo-file');
      assert.ok(input, 'The hidden file input is discoverable without opening a picker');
      assert.equal(input.visible, false);
      assert.equal(input.accept, 'image/png,image/jpeg,image/webp');
      assert.equal(input.disabled, false);
      assert.deepEqual(input.labels, [{ selector: '#upload-label', text: 'Choose the community logo', visible: true }]);
      for (const item of [...snapshot.images, ...snapshot.fileInputs]) {
        assert.equal(await page.evaluate(selector => document.querySelectorAll(selector).length, item.selector), 1);
      }
      assert.ok(!JSON.stringify(snapshot).includes(fixture.image.base64));
      assert.equal(fixture.getState('passive-image-file-snapshot').count, 0);
      record({ snapshot, before, after });
    });
    await scenario('populated-file-and-data-image-redaction', async (page, call, read, record) => {
      success(await call('#visible-file'));
      await page.evaluate(base64 => {
        const image = document.createElement('img'); image.id = 'data-image'; image.width = 3; image.height = 2;
        image.src = 'data:image/png;base64,' + base64; document.body.appendChild(image);
      }, fixture.image.base64);
      await page.waitForFunction(() => document.getElementById('data-image').naturalWidth === 3);
      const before = await read();
      const snapshot = await page.evaluate(() => mdbFileActions.pageSnapshot(4000, 80));
      const field = snapshot.elements.find(element => element.selector === '#visible-file');
      assert.equal(field.value, '<redacted>', 'A populated file input never reveals the browser fake path');
      const dataImage = snapshot.images.find(image => image.selector === '#data-image');
      assert.equal(dataImage.sourceKind, 'data');
      assert.equal(dataImage.currentSrc, null, 'Snapshot does not return embedded image bytes');
      assert.equal(dataImage.naturalWidth, 3);
      assert.equal(dataImage.naturalHeight, 2);
      assert.ok(!JSON.stringify(snapshot).includes(fixture.image.base64));
      assert.ok(!JSON.stringify(snapshot).includes('fakepath'));
      assert.deepEqual((await read()).events, before.events, 'Snapshot remains passive after a file is populated');
      record({ snapshot });
    });
    await scenario('bounded-image-file-snapshot', async (page, call, read, record) => {
      await page.evaluate(() => {
        for (let index = 0; index < 250; index++) {
          const image = document.createElement('img');
          image.id = 'extra-image-' + index; image.alt = 'extra image ' + index;
          image.src = '/pixel.png'; image.width = 3; image.height = 2; document.body.appendChild(image);
          const input = document.createElement('input'); input.id = 'extra-file-' + index;
          input.type = 'file'; input.hidden = true; document.body.appendChild(input);
        }
      });
      const before = await read();
      const snapshot = await page.evaluate(() => mdbFileActions.pageSnapshot(1000, 5));
      assert.ok(snapshot.images.length <= 100, 'Image inventory remains bounded');
      assert.ok(snapshot.fileInputs.length <= 32, 'File input inventory remains bounded');
      assert.ok(snapshot.images.length > 0 && snapshot.fileInputs.length > 0);
      assert.equal(snapshot.imagesTruncated, true);
      assert.equal(snapshot.fileInputsTruncated, true);
      assert.deepEqual((await read()).events, before.events);
      record({ imageCount: snapshot.images.length, fileInputCount: snapshot.fileInputs.length, snapshot });
    });
  } catch (error) { fatalError = { message: error.message, stack: error.stack }; }
  finally {
    if (context) { await context.close(); browserClosed = true; }
    await fixture.close(); serverClosed = true;
    await fs.rm(profile, { recursive: true, force: true }); profileRemoved = true;
    const report = { generatedAt: new Date().toISOString(), browserVersion, nodeVersion: process.version,
      workerPath, workerSha256: hash(workerSource), workerSha256AtEnd: hash(await fs.readFile(workerPath)),
      moduleSha256: hash(await fs.readFile(path.join(root, 'lib/chrome-image-file.mjs'))),
      testSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixture: fixture.info,
      results, measurements, receipts: fixture.receipts, rejectedReceipts: fixture.rejectedReceipts,
      blockedRequests, browserClosed, profileRemoved, serverClosed, fatalError };
    const reportPath = process.env.MDB_BROWSER_TEST_REPORT || path.join(fixture.directory, 'browser-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ reportPath, passed: results.filter(result => result.passed).length, total: results.length,
      failed: results.filter(result => !result.passed), fatalError, browserClosed, profileRemoved, serverClosed }, null, 2));
  }
  if (fatalError || results.some(result => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.MDB_IMAGE_FILE_FIXTURE_ONLY === '1') {
    const fixture = await createImageFileFixtureServer({ requireHidden: process.env.MDB_IMAGE_FILE_FIXTURE_REQUIRE_HIDDEN === '1' });
    console.log(JSON.stringify(fixture.info));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => fixture.close().then(() => process.exit(0)));
  } else await runBrowserTests();
}
