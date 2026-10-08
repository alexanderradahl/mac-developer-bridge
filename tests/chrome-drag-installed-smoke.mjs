import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Starts only a loopback fixture. Exercise it with the public installed MDB
// chrome_open/snapshot/drag/navigate/close tools; no browser is attached here.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-drag-installed-'));
await fs.chmod(dir, 0o700);
let order = ['staff', 'regular', 'member-bot', 'last'];
const receipts = [];
const html = () => '<!doctype html><meta charset="utf-8"><title>MDB local drag acceptance</title><h1>Local drag acceptance</h1><p>Loopback fixture only.</p><div id="roles">' + order.map(id => '<div id="' + id + '"' + (id === 'member-bot' ? ' draggable="true"' : '') + '>' + id + '</div>').join('') + '</div><output id="result">Saved changes: ' + receipts.length + '</output><pre id="evidence"></pre><script src="/fixture.js"></script>';
const script = `const roles = document.getElementById('roles');
const source = document.getElementById('member-bot');
const target = document.getElementById('regular');
const events = [];
let backend = 'keyboard';
const evidence = () => document.getElementById('evidence').textContent = JSON.stringify({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState, backend, order: Array.from(roles.children, e => e.id), events });
setInterval(evidence, 200); evidence();
for (const type of ['pointerover','mouseover','pointermove','mousemove','pointerdown','mousedown','pointercancel','pointerup','mouseup','click','dragstart','drag','dragenter','dragover','drop','dragend']) document.addEventListener(type, e => {events.push({type, trusted:e.isTrusted, hasFocus:document.hasFocus(), visibilityState:document.visibilityState}); evidence();}, true);
document.addEventListener('mousedown', () => {backend='html5';}, true);
source.addEventListener('dragstart', e => {if(backend!=='html5'){e.preventDefault();return;}e.dataTransfer.setData('application/x-mdb-fixture','member-bot'); e.dataTransfer.effectAllowed='move';});
target.addEventListener('dragover', e => {e.preventDefault(); e.dataTransfer.dropEffect='move';});
target.addEventListener('drop', async e => {
  e.preventDefault();
  if (e.dataTransfer.getData('application/x-mdb-fixture') !== 'member-bot') return;
  const rect = target.getBoundingClientRect();
  roles.insertBefore(source, e.clientY < rect.top + rect.height/2 ? target : target.nextSibling);
  const response = await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:Array.from(roles.children,e=>e.id),hasFocus:document.hasFocus(),visibilityState:document.visibilityState,backend,events})});
  const saved = await response.json();
  document.getElementById('result').textContent='Saved changes: '+saved.count;
  evidence();
});`;
const server = http.createServer(async (req,res) => {
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
 if(req.headers.host !== '127.0.0.1:'+server.address().port){res.writeHead(403).end();return;}
 if(req.method==='GET' && req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html().replace('</title>','</title><link rel="stylesheet" href="/style.css">'));return;}
 if(req.method==='GET' && req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
 if(req.method==='GET' && req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end('body{font:16px system-ui;margin:32px}#roles>div{padding:16px;margin:8px;border:1px solid;width:260px;height:28px}');return;}
 if(req.method==='GET' && req.url==='/receipts'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({order,receipts}));return;}
 if(req.method==='POST' && req.url==='/receipt'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>8192){res.writeHead(413).end();return;}}
  try{
   const data=JSON.parse(body);
   if(JSON.stringify(data.order)!==JSON.stringify(['staff','member-bot','regular','last']) || data.hasFocus!==false || data.visibilityState!=='hidden' || data.backend!=='html5' || !Array.isArray(data.events) || data.events.filter(e=>e.type==='mousedown').length!==1 || data.events.filter(e=>e.type==='drop').length!==1 || data.events.some(e=>e.type==='click' || e.hasFocus!==false || e.visibilityState!=='hidden'))throw Error();
   order=data.order;receipts.push(data);
   await fs.writeFile(path.join(dir,'receipt.json'),JSON.stringify({order,receipts},null,2),{mode:0o600});
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:receipts.length}));
  }catch{res.writeHead(400).end('Invalid fixture receipt');}
  return;
 }
 res.writeHead(404).end();
});
server.listen(0,'127.0.0.1',async()=>{
 const info={pid:process.pid,origin:'http://127.0.0.1:'+server.address().port,directory:dir};
 await fs.writeFile(path.join(dir,'server-info.json'),JSON.stringify(info),{mode:0o600});
 console.log(JSON.stringify(info));
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
