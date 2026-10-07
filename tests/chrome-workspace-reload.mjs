import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../chrome-extension/service-worker.js',import.meta.url),'utf8');
const a=source.indexOf('async function waitForParkedWorkspaceTab('),b=source.indexOf('async function workspaceStatus()',a);
assert.ok(a>0&&b>a);
function fixture({leases={},active=false,foreign=false}={}) {
 const state={groupId:7,tabIds:[1,2],leases};
 const idle='chrome-extension://owned/workspace.html';
 const tabs=new Map([[1,{id:1,groupId:7,active,url:foreign?'https://unrelated.example/':idle,status:'complete'}],[2,{id:2,groupId:7,active:false,url:idle,status:'complete'}]]);
 const stored={};const updates=[];let saved=state;
 const context={WORKSPACE_KEY:'pool',MAX_WORKSPACE_POOL_SIZE:32,Date,Error,Number,Array,Object,
  mutateWorkspaceState:async fn=>await fn(),loadWorkspaceState:async()=>saved,readTab:async id=>tabs.get(id),readGroup:async id=>id===7?{id}:null,
  workspaceIdleUrl:()=>idle,delay:async()=>{},waitForWorkspaceIdleNavigation:async id=>{assert.equal(tabs.get(id).url,idle);return tabs.get(id);},
  saveWorkspaceState:async s=>{saved=s;},chrome:{storage:{local:{get:async key=>({[key]:stored[key]}),set:async values=>Object.assign(stored,values),remove:async key=>{delete stored[key];}}},tabs:{update:async(id,values)=>{updates.push([id,values.url]);Object.assign(tabs.get(id),values);return tabs.get(id);}}}};
 const f=vm.runInNewContext('(()=>{'+source.slice(a,b)+';return {prepare:prepareWorkspaceForReload,restore:restoreWorkspaceAfterReload};})()',context);
 return {...f,tabs,stored,updates,saved:()=>saved,idle};
}
{
 const x=fixture();const p=await x.prepare();assert.equal(p.parked,2);assert.equal(x.tabs.get(1).url,'about:blank');
 assert.ok(x.stored['pool:reload-parking-v1']);const r=await x.restore();assert.equal(r.restored,2);
 assert.equal(x.tabs.get(1).url,x.idle);assert.equal(x.saved().tabIds.length,2);assert.equal(x.stored['pool:reload-parking-v1'],undefined);
}
for(const settings of [{leases:{1:{leasedAt:1}}},{active:true},{foreign:true}]) {
 const x=fixture(settings);await assert.rejects(x.prepare(),{code:'CHROME_WORKSPACE_RELOAD_BUSY'});assert.equal(x.updates.length,0);
}
{
 const x=fixture();await x.prepare();x.tabs.get(2).url='https://user-opened.example/';const r=await x.restore();assert.equal(r.restored,1);
 assert.equal(x.tabs.get(2).url,'https://user-opened.example/');assert.deepEqual(Array.from(x.saved().tabIds),[1]);
}
console.log('Workspace reload regressions: idle pool survives; active leases, active tabs and unrelated pages remain untouched');
