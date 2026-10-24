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
    fs.copyFileSync(path.join(root,'scripts/ci-supply-chain-audit.mjs'),scriptFile);
    const check=()=>spawnSync(process.execPath,[scriptFile],{encoding:'utf8',timeout:10000});
    const baseline=fs.readFileSync(workflowFile,'utf8');
    const passing=check();
    assert.equal(passing.status,0,passing.stderr);
    for(const mutation of [
      source=>source.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v4'),
      source=>source.replace(/actions\/checkout@[0-9a-f]{40}/,'untrusted/other@'+'f'.repeat(40)),
      source=>source+'\npull_request_target:\n',
      source=>source+'\npermissions: write-all\n'
    ]){
      const modified=mutation(baseline);
      assert.notEqual(modified,baseline,'adversarial fixture should change a real workflow');
      fs.writeFileSync(workflowFile,modified);
      const failed=check();
      assert.notEqual(failed.status,0,'unsafe workflow modification must fail CI audit');
      assert.match(failed.stderr,/CI supply-chain audit:/);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
