import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Explicit installed-runtime acceptance fixture. This starts only a loopback
// server; it never opens/attaches to a browser or accesses a signed-in service.
// See chrome-installed-loopback-smoke.md for public-MDB steps and cleanup.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencies = process.env.MDB_BROWSER_TEST_NODE_MODULES || root;
const esbuild = require(require.resolve('esbuild', { paths: [dependencies] }));
const reactVersion = require(require.resolve('react/package.json', { paths: [dependencies] })).version;
const reactDomVersion = require(require.resolve('react-dom/package.json', { paths: [dependencies] })).version;
const bundle = (await esbuild.build({
  entryPoints: [path.join(root, 'tests/fixtures/chrome-installed-smoke-react.mjs')],
  bundle: true, write: false, minify: true, platform: 'browser', format: 'iife',
  nodePaths: [dependencies], define: { 'process.env.NODE_ENV': '"production"' },
})).outputFiles[0].contents;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-installed-loopback-smoke-'));
await fs.chmod(dir, 0o700);
const receipts = [];
const html = '<!doctype html><meta charset="utf-8"><title>MDB owned localhost acceptance</title><h1>MDB owned localhost acceptance</h1><p>Local fixture only; no signed-in service requests.</p><div id="app"></div><button id="direct-action" type="button">Direct click fixture action</button><h2>Observable browser and event evidence</h2><pre id="evidence"></pre><script src="/bundle.js"></script>';
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end('Loopback fixture host only'); return; }
  if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
  if (req.method === 'GET' && req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(bundle); return; }
  if (req.method === 'GET' && req.url === '/receipts') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ receipts })); return; }
  if (req.method === 'POST' && req.url === '/receipt') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); res.end(); return; } }
    try {
      const data = JSON.parse(body);
      if (data.amount !== 10) throw new Error('Amount must be 10');
      receipts.push({ amount: data.amount, reactBeforeInput: data.reactBeforeInput, reactInput: data.reactInput, reactChange: data.reactChange });
      await fs.writeFile(path.join(dir, 'receipt.json'), JSON.stringify({ receipts }, null, 2));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true, amount: data.amount, submissionCount: receipts.length }));
    } catch { res.writeHead(400); res.end('Invalid fixture receipt'); }
    return;
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(0, '127.0.0.1', async () => {
  const info = { pid: process.pid, host: '127.0.0.1', port: server.address().port, origin: `http://127.0.0.1:${server.address().port}`, directory: dir, reactVersion, reactDomVersion, esbuildVersion: esbuild.version };
  await fs.writeFile(path.join(dir, 'server-info.json'), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
