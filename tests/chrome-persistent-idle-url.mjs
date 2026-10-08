import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../chrome-extension/service-worker.js',import.meta.url),'utf8');
const match=source.match(/function workspaceIdleUrl\(\) \{([\s\S]*?)\n\}/);
assert.ok(match);
const url=id=>vm.runInNewContext('(function(){'+match[1]+'})()',{
 chrome:{runtime:{getURL:part=>'chrome-extension://'+id+'/'+part}}
});
const initial=url('example-extension');
assert.equal(initial,'about:blank#mdb-workspace-idle-example-extension');
assert.equal(url('example-extension'),initial,'An extension reload must retain the same marker');
assert.notEqual(url('another-extension'),initial,'Different extension ownership must not collide');
assert.match(source,/CHROME_WORKSPACE_SETUP_FOREGROUND_REQUIRED/,'Creating tabs must still require the existing foreground check');
assert.doesNotMatch(initial,/cookie|token|password|secret/i);
console.log('Persistent idle marker: stable across worker reloads; distinct extension ownership; foreground gate retained');
