import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// This module only serves owned loopback content. It never attaches to a
// browser. Run it, then use installed public chrome_open/keypress/snapshot/
// navigate/close tools with unique operation IDs. Actual hidden+unfocused
// receipt validation is mandatory in standalone (installed acceptance) mode.
export async function createKeyboardFixtureServer({ requireHidden = false, actionSource = '' } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(import.meta.url);
  const dependencyPaths = (process.env.MDB_BROWSER_TEST_NODE_MODULES || root).split(path.delimiter);
  const esbuild = require(require.resolve('esbuild', { paths: dependencyPaths }));
  const fixturePath = path.join(root, 'tests/fixtures/chrome-keyboard-dnd.mjs');
  const bundle = (await esbuild.build({ entryPoints: [fixturePath], bundle: true, write: false, format: 'iife', platform: 'browser', nodePaths: dependencyPaths,
    define: { 'process.env.NODE_ENV': '"development"' } })).outputFiles[0].contents;
  const versions = {};
  for (const name of ['react', 'react-dom', 'react-dnd', 'react-dnd-html5-backend', 'react-dnd-multi-backend', 'react-dnd-accessible-backend']) {
    for (const directory of dependencyPaths) {
      try { versions[name] = JSON.parse(await fs.readFile(path.join(directory, name, 'package.json'), 'utf8')).version; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.ok(versions[name], `Missing fixture dependency ${name}`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-keyboard-fixture-'));
  await fs.chmod(dir, 0o700);
  const initial = ['staff', 'regular', 'member-bot', 'last'];
  const expected = ['staff', 'member-bot', 'regular', 'last'];
  const receipts = [];
  const rejected = [];
  const getState = scenario => { const rows = receipts.filter(row => row.scenario === scenario); return { order: rows.at(-1)?.order || initial, count: rows.length }; };
  const html = '<!doctype html><meta charset="utf-8"><title>MDB keyboard backend acceptance</title><link rel="stylesheet" href="/style.css"><h1>Local keyboard backend acceptance</h1><p>Real Discord accessible backend. Focus member-bot, Control+D or Meta+D to lift, ArrowUp to regular, Enter or Space to drop. Escape cancels. Only drop saves.</p><div id="root"></div><output id="result"></output><pre id="evidence"></pre><div id="passive-focus" tabindex="-1" aria-label="Passive focus target">Passive focus target</div><div id="reference"><button id="guard-source">Native reference source</button><button id="guard-next">Native reference next focus</button></div><script src="/fixture.js"></script>';
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== '127.0.0.1:' + server.address().port) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html + (actionSource ? '<script src="/actions.js"></script>' : '')); return; }
    if (req.method === 'GET' && url.pathname === '/actions.js' && actionSource) { res.setHeader('Content-Type', 'text/javascript'); res.end(actionSource); return; }
    if (req.method === 'GET' && url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); return; }
    if (req.method === 'GET' && url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{font:16px system-ui;margin:32px}#roles>div{padding:16px;margin:8px;border:1px solid;width:260px}#roles>div:focus{outline:3px solid blue}pre{white-space:pre-wrap;overflow-wrap:anywhere}#reference{margin-top:20px}'); return; }
    if (req.method === 'GET' && url.pathname === '/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(getState(url.searchParams.get('scenario') || 'installed'))); return; }
    if (req.method === 'GET' && url.pathname === '/receipts') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ receipts, rejected, versions, requireHidden })); return; }
    if (req.method === 'POST' && url.pathname === '/receipt') {
      if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 100000) { res.writeHead(413).end(); return; } }
      try {
        const data = JSON.parse(body);
        assert.equal(typeof data.scenario, 'string');
        assert.deepEqual(data.order, expected);
        assert.equal(data.drops, 1);
        assert.equal(getState(data.scenario).count, 0, 'No repeated save accepted');
        assert.ok(!data.scenario.includes('cannot-drag'));
        assert.ok(!data.scenario.includes('cancel'));
        assert.ok(Array.isArray(data.events));
        assert.equal(data.events.filter(event => /^(click|pointerdown|pointerup|mousedown|mouseup|dragstart|drop|dragend)$/.test(event.type)).length, 0, 'No pointer/click/HTML5 drag fallback');
        const keys = data.events.filter(event => event.type === 'keydown' && event.key && !['Control', 'Meta'].includes(event.key));
        assert.deepEqual(keys.map(event => event.key), ['d', 'd', 'ArrowUp', data.scenario.includes('space') ? ' ' : 'Enter']);
        assert.deepEqual(keys.map(event => event.target), ['member-bot', 'member-bot', 'member-bot', 'regular']);
        assert.equal(keys.filter(event => event.key === 'd' && event.transitionCountBefore === 1).length, 1, 'Exactly one application transition clone');
        const releases = data.events.filter(event => event.type === 'keyup' && event.key && !['Control', 'Meta'].includes(event.key));
        assert.deepEqual(releases.map(event => [event.key, event.target]), [['d', 'member-bot'], ['ArrowUp', 'regular'], [data.scenario.includes('space') ? ' ' : 'Enter', 'member-bot']]);
        if (requireHidden) {
          assert.equal(data.hasFocus, false);
          assert.equal(data.visibilityState, 'hidden');
          assert.ok(data.events.every(event => event.hasFocus === false && event.visibilityState === 'hidden'), 'No foregrounding during input');
          assert.ok(keys.every(event => event.trusted === false));
        }
        receipts.push(data);
        await fs.writeFile(path.join(dir, 'receipts.json'), JSON.stringify({ receipts, rejected, versions, requireHidden }, null, 2), { mode: 0o600 });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ count: getState(data.scenario).count }));
      } catch (error) {
        rejected.push({ reason: error.message });
        res.writeHead(400).end('Invalid fixture receipt: ' + error.message);
      }
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const info = { pid: process.pid, origin, directory: dir, requireHidden, versions,
    fixtureSha256: crypto.createHash('sha256').update(await fs.readFile(fixturePath)).digest('hex'),
    bundleSha256: crypto.createHash('sha256').update(bundle).digest('hex') };
  await fs.writeFile(path.join(dir, 'server-info.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
  return { server, origin, dir, receipts, rejected, getState, info, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await createKeyboardFixtureServer({ requireHidden: true });
  console.log(JSON.stringify(fixture.info));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => fixture.close().then(() => process.exit(0)));
}
