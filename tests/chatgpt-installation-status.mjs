import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const source=await fsp.readFile(new URL('../bridge.mjs',import.meta.url),'utf8');
const begin=source.indexOf('async function chatgptChromeExtensionInstallationStatus(');
const end=source.indexOf('function backgroundChromeApprovalError(',begin);
assert.ok(begin>0&&end>begin);
const home=await fsp.mkdtemp(path.join(os.tmpdir(),'mdb-installation-test-'));
const extension='hehggadaopoacecdllhhajmbjkdcmajg';const host='com.openai.codexextension';
const functions=vm.runInNewContext('(()=>{'+source.slice(begin,end)+';return {extension:chatgptChromeExtensionInstallationStatus,native:chatgptNativeHostInstallationStatus};})()',
 {fsp:{...fsp,stat:async p=>{if(String(p).startsWith('/Library/'))throw Object.assign(new Error('test system path absent'),{code:'ENOENT'});return fsp.stat(p);}},fs,path,HOME:home,CHATGPT_CHROME_EXTENSION_ID:extension,CHATGPT_NATIVE_HOST_NAME:host});
try {
  assert.equal((await functions.extension()).installed,false);
  assert.equal((await functions.native()).registered,false);
  const root=path.join(home,'Library/Application Support/Google/Chrome');
  const extDir=path.join(root,'Default/Extensions',extension,'1.0_0');await fsp.mkdir(extDir,{recursive:true});
  await fsp.writeFile(path.join(extDir,'manifest.json'),JSON.stringify({version:'1.0'}));
  let result=await functions.extension();assert.equal(result.installed,true);assert.equal(result.enabled,null);assert.equal(result.installations[0].version,'1.0');
  const nativeDir=path.join(root,'NativeMessagingHosts');await fsp.mkdir(nativeDir,{recursive:true});
  const dummy=path.join(home,'not-executed');await fsp.writeFile(dummy,'exit 13\n',{mode:0o700});
  const manifest=path.join(nativeDir,host+'.json');await fsp.writeFile(manifest,JSON.stringify({name:host,type:'stdio',path:dummy,allowed_origins:['chrome-extension://'+extension+'/']}));
  result=await functions.native();assert.equal(result.registered,true);assert.equal(result.registrations[0].extensionAllowed,true);assert.equal(result.registrations[0].executablePresent,true);
  await fsp.writeFile(manifest,'broken JSON');result=await functions.native();assert.equal(result.registered,null);assert.equal(result.errors[0].code,'INVALID_MANIFEST');
  await fsp.writeFile(path.join(extDir,'manifest.json'),'{}');result=await functions.extension();assert.equal(result.installed,null);
  console.log('Installation diagnostics: missing, installed and malformed states passed; no native host executed');
}finally{await fsp.rm(home,{recursive:true,force:true});}
