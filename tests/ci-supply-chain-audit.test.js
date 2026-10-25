'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('CI pins audited actions and rejects mutable, untrusted and broad-rights changes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-workflow-'));
  try{
    const workflowFile=path.join(dir,'.github/workflows/check.yml');
    const scriptFile=path.join(dir,'scripts/ci-supply-chain-audit.mjs');
    fs.mkdirSync(path.dirname(workflowFile),{recursive:true});
    fs.mkdirSync(path.dirname(scriptFile),{recursive:true});
    fs.copyFileSync(path.join(root,'.github/workflows/check.yml'),workflowFile);
    const launcherFile=path.join(dir,'.github/workflows/qa-launcher.yml');
    fs.copyFileSync(path.join(root,'.github/workflows/qa-launcher.yml'),launcherFile);
    fs.copyFileSync(path.join(root,'scripts/ci-supply-chain-audit.mjs'),scriptFile);
    const check=()=>spawnSync(process.execPath,[scriptFile],{encoding:'utf8',timeout:10000});
    const baseline=fs.readFileSync(workflowFile,'utf8');
    const passing=check();
    assert.equal(passing.status,0,passing.stderr);
    for(const mutation of [
      source=>source.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v4'),
      source=>source.replace(/actions\/checkout@[0-9a-f]{40}/,'untrusted/other@'+'f'.repeat(40)),
      source=>source+'\npull_request_target:\n',
      source=>source+'\npermissions: write-all\n',
      source=>source.replace('permissions:\n  contents: read\n',''),
      source=>source.replace('  contents: read','  contents: write')
    ]){
      const modified=mutation(baseline);
      assert.notEqual(modified,baseline,'adversarial fixture should change a real workflow');
      fs.writeFileSync(workflowFile,modified);
      const failed=check();
      assert.notEqual(failed.status,0,'unsafe workflow modification must fail CI audit');
      assert.match(failed.stderr,/CI supply-chain audit:/);
    }
    // Mutating the second workflow must fail the SAME canonical check, even
    // when the main Firefox workflow remains completely unchanged.
    const launcher=fs.readFileSync(launcherFile,'utf8');
    for(const mutation of [
      source=>source.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v4'),
      source=>source.replace('permissions:\n  contents: read\n',''),
      source=>source.replace('  contents: read','  contents: write'),
      source=>source.replace(/actions\/checkout@[0-9a-f]{40}/,
        'untrusted/other@'+'f'.repeat(40))
    ]){
      const changed=mutation(launcher);
      assert.notEqual(changed,launcher);
      fs.writeFileSync(launcherFile,changed);
      const rejected=check();
      assert.notEqual(rejected.status,0,'QA launcher permission or action drift must fail');
      assert.match(rejected.stderr,/CI supply-chain audit:/);
    }
    fs.writeFileSync(launcherFile,launcher);
    fs.writeFileSync(workflowFile,baseline);
    const extra=path.join(dir,'.github/workflows/unreviewed.yml');
    fs.writeFileSync(extra,'name: unreviewed\n');
    const rejected=check();
    assert.notEqual(rejected.status,0,'A new unaudited workflow must not be trusted');
    assert.match(rejected.stderr,/Unexpected or missing workflow inventory/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
