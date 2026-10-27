'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function runAudit(mutator=()=>{}) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-audit-'));
  try {
    for(const file of ['manifest.json','package.json'])
      fs.copyFileSync(path.join(root,file),path.join(temp,file));
    for(const dir of ['src','options','scripts','ui'])
      fs.cpSync(path.join(root,dir),path.join(temp,dir),{recursive:true});
    mutator(temp);
    return spawnSync(process.execPath,[path.join(temp,'scripts/security-audit.mjs')],
      {encoding:'utf8',timeout:10000});
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
test('production add-on passes its static permission and privacy audit',()=>{
  const result=runAudit();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Security audit:/);
});
test('manifest permission escalation is caught before shipping',()=>{
  const result=runAudit(dir=>{
    const name=path.join(dir,'manifest.json');
    const json=JSON.parse(fs.readFileSync(name,'utf8'));
    json.permissions.push('tabs');
    fs.writeFileSync(name,JSON.stringify(json));
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/permission scope changed/);
});
test('network code added to production JavaScript fails the audit',()=>{
  const result=runAudit(dir=>{
    fs.appendFileSync(path.join(dir,'options/options.js'),"\nfetch('/unapproved-endpoint');\n");
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/network fetch/);
});
test('a remotely hosted Options script fails the audit',()=>{
  const result=runAudit(dir=>{
    fs.appendFileSync(path.join(dir,'options/options.html'),
      '<script src="https://untrusted.example.invalid/client.js"></script>');
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/remote assets or inline executable Options HTML/);
});

test('a new unreviewed local Options script fails the audit',()=>{
  const result=runAudit(dir=>{
    fs.appendFileSync(path.join(dir,'options/options.html'),
      '<script src="unreviewed-local.js"></script>');
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/unreviewed local Options script/);
});

test('MAIN-world script injection is rejected as an unreviewed privilege change',()=>{
  const result=runAudit(dir=>{
    const name=path.join(dir,'manifest.json');
    const json=JSON.parse(fs.readFileSync(name,'utf8'));
    json.content_scripts[0].world='MAIN';
    fs.writeFileSync(name,JSON.stringify(json));
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/content script injection context changed/);
});
test('additional script entrypoint is rejected even if static text looks safe',()=>{
  const result=runAudit(dir=>{
    const name=path.join(dir,'manifest.json');
    const json=JSON.parse(fs.readFileSync(name,'utf8'));
    json.content_scripts[0].js.unshift('src/core.js');
    fs.writeFileSync(name,JSON.stringify(json));
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/unreviewed Firefox content entrypoint/);
});
test('unexpected background workers are rejected before release',()=>{
  const result=runAudit(dir=>{
    const name=path.join(dir,'manifest.json');
    const json=JSON.parse(fs.readFileSync(name,'utf8'));
    json.background.service_worker='src/background.js';
    fs.writeFileSync(name,JSON.stringify(json));
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/background context changed/);
});
test('remote CSS url and form actions are rejected in local options',()=>{
  for(const injection of [
    '<style>body{background:url(https://untrusted.invalid/tracker)}</style>',
    '<form action="https://untrusted.invalid/capture"></form>'
  ]){
    const result=runAudit(dir=>{
      fs.appendFileSync(path.join(dir,'options/options.html'),injection);
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/remote assets or inline executable Options HTML/);
  }
});

test('optional data collection categories cannot bypass required-none disclosure',()=>{
  const result=runAudit(dir=>{
    const name=path.join(dir,'manifest.json');
    const json=JSON.parse(fs.readFileSync(name,'utf8'));
    json.browser_specific_settings.gecko.data_collection_permissions.optional=['browsingActivity'];
    fs.writeFileSync(name,JSON.stringify(json));
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Mozilla data collection disclosure fields changed/);
});
test('an unreviewed Firefox update URL must fail the manifest audit',()=>{
  const result=runAudit(dir=>{
    const name=path.join(dir,'manifest.json');
    const json=JSON.parse(fs.readFileSync(name,'utf8'));
    json.browser_specific_settings.gecko.update_url='https://untrusted.invalid/updates.json';
    fs.writeFileSync(name,JSON.stringify(json));
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Firefox identity and update policy changed/);
});
