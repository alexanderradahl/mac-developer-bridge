import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Owned offline fixtures in a fresh headless profile only. No owner-browser
// attachment, app internals, remote requests, credentials or trusted-event spoof.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const playwright = await import(process.env.MDB_BROWSER_TEST_PLAYWRIGHT || require.resolve('playwright'));
const {chromium} = playwright.chromium ? playwright : playwright.default;
const current = await fs.readFile(path.join(root, 'chrome-extension/service-worker.js'), 'utf8');
const old = process.env.MDB_BROWSER_TEST_BASELINE ? await fs.readFile(process.env.MDB_BROWSER_TEST_BASELINE, 'utf8') : null;
function extract(source, name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name);
  const end = source.indexOf('\n}', match.index);
  assert.ok(end > match.index);
  return source.slice(match.index, end + 2);
}
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-control-events-test-'));
await fs.chmod(profile, 0o700);
let context;
const results = [];
const observations = {};
let cleanup = false;
async function scenario(name, run) {
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  try {
    await page.setContent('<!doctype html><meta charset="utf-8"><title>Owned MDB control test</title><main><section><div id="control" style="padding:20px;cursor:pointer"><button id="label">Select</button></div><input id="tags"><output id="saved"></output><button disabled id="disabled">Disabled</button><input type="password" value="PRIVATE-PASSWORD-CANARY"></section></main>');
    await page.addScriptTag({content: ['pageSnapshot', 'pageClick', 'pageKeypress'].map(n => extract(current, n)).join('\n') + '\nwindow.fixtureActions={pageSnapshot,pageClick,pageKeypress};'});
    await page.evaluate(() => {
      window.events = [];
      document.querySelector('#tags').addEventListener('keydown', e => {
        window.events.push({key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,charCode:e.charCode,trusted:e.isTrusted});
        if (e.keyCode === 13 && e.which === 13) {
          e.preventDefault(); document.querySelector('#saved').textContent = e.target.value; e.target.value = '';
        }
      });
      document.querySelector('#control').addEventListener('mousedown', e => {
        if (e.target === e.currentTarget) document.querySelector('#saved').textContent = 'collection opened';
      });
    });
    await run(page);
    results.push({name,passed:true});
  } catch (e) {results.push({name,passed:false,error:e.message,stack:e.stack});}
  finally {await page.close();}
}
try {
  context = await chromium.launchPersistentContext(profile, {headless:true,channel:process.env.MDB_BROWSER_TEST_CHANNEL || 'chrome',viewport:{width:1000,height:800},serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*', route => route.abort());
  await scenario('baseline-reproduces-enter-without-legacy-codes', async page => {
    if (!old) {observations.baseline='not supplied';return;}
    await page.addScriptTag({content:'window.oldKeypress='+extract(old,'pageKeypress')+';'});
    await page.locator('#tags').fill('development');
    await page.evaluate(() => window.oldKeypress('#tags','Enter'));
    assert.equal(await page.locator('#saved').textContent(),'');
    const events=await page.evaluate(() => window.events);assert.equal(events[0].keyCode,0);assert.equal(events[0].which,0);
    observations.baseline=events;
  });
  await scenario('enter-commits-legacy-tag-control-once-without-trusted-event', async page => {
    await page.locator('#tags').fill('development');
    const result=await page.evaluate(() => window.fixtureActions.pageKeypress('#tags','Enter'));
    assert.equal(await page.locator('#saved').textContent(),'development');
    const events=await page.evaluate(() => window.events);assert.equal(events.length,1);assert.equal(events[0].keyCode,13);assert.equal(events[0].which,13);assert.equal(events[0].trusted,false);
    assert.equal(result.keyDownDefaultPrevented,true);assert.equal(result.applicationAccepted,null);assert.equal(result.outcomeVerified,false);
    observations.repaired=events;
  });
  await scenario('all-allowlisted-keys-match-native-key-fields', async page => {
    const cases=[['d','d'],['Enter','Enter'],['Space','Space'],['Escape','Escape'],['ArrowUp','ArrowUp'],['ArrowDown','ArrowDown'],['ArrowLeft','ArrowLeft'],['ArrowRight','ArrowRight']];
    for(const [key,native] of cases){
      await page.evaluate(() => {window.events=[];});await page.locator('#tags').focus();await page.keyboard.press(native);
      const reference=await page.evaluate(() => window.events[0]);
      await page.evaluate(() => {window.events=[];});await page.evaluate(k => window.fixtureActions.pageKeypress('#tags',k),key);
      const actual=await page.evaluate(() => window.events[0]);
      for(const field of ['key','code','keyCode','which','charCode'])assert.equal(actual[field],reference[field],`${key}.${field}`);
      assert.equal(actual.trusted,false);
    }
  });
  await scenario('default-snapshot-unchanged-and-exact-text-context-is-passive-bounded', async page => {
    const result=await page.evaluate(() => window.fixtureActions.pageSnapshot(20000,200,{textQuery:'Select'}));
    observations.controlContextProbe=result.elements;
    const found=result.elements.find(x=>x.selector==='#label');assert.ok(found);assert.equal(found.controlContext.pointerEvents,'auto');assert.ok(found.controlContext.ancestors.length<=4);
    assert.equal(found.controlContext.centerHit.selector,'#label');assert.equal(found.controlContext.hitInsideTarget,true);
    assert.equal(await page.locator('#saved').textContent(),'');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE-PASSWORD-CANARY|addEventListener|outerHTML|innerHTML/);
    if(old){await page.addScriptTag({content:'window.oldSnapshot='+extract(old,'pageSnapshot')+';'});assert.deepEqual(await page.evaluate(()=>window.fixtureActions.pageSnapshot(20000,200)),await page.evaluate(()=>window.oldSnapshot(20000,200)));}
  });
  await scenario('observed-wrapper-target-opens-collection-without-auto-retarget', async page => {
    const selected=await page.evaluate(()=>window.fixtureActions.pageSnapshot(20000,200,{textQuery:'Select'}));
    const target=selected.elements.find(x=>x.selector==='#label').controlContext.ancestors.find(x=>x.selector==='#control').selector;
    await page.evaluate(s=>window.fixtureActions.pageClick(s),target);
    assert.equal(await page.locator('#saved').textContent(),'collection opened');
  });
  await scenario('disabled-and-expired-actions-do-not-dispatch', async page => {
    const result=await page.evaluate(()=>window.fixtureActions.pageKeypress('#disabled','Enter',{errorsAsData:true}));
    assert.equal(result.__mdbPageActionError.code,'CHROME_ELEMENT_DISABLED');assert.equal(result.__mdbPageActionError.actionDispatched,false);
    const expired=await page.evaluate(()=>window.fixtureActions.pageKeypress('#tags','Enter',{errorsAsData:true,deadlineMs:Date.now()-1}));assert.equal(expired.__mdbPageActionError.actionDispatched,false);assert.equal(await page.locator('#saved').textContent(),'');
  });
} finally {
  if(context)await context.close();await fs.rm(profile,{recursive:true,force:true});cleanup=true;
}
const report={passed:results.filter(r=>r.passed).length,total:results.length,workerSha256:crypto.createHash('sha256').update(current).digest('hex'),baselineCompared:Boolean(old),freshProfileRemoved:cleanup,observations,results};
console.log(JSON.stringify(report,null,2));if(report.passed!==report.total)process.exitCode=1;
