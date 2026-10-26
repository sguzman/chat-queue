'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const script=path.join(__dirname,'../scripts/codeql-findings-gate.mjs');
function fixture(manipulate){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cq-codeql-'));
  try{
    const sarif={version:'2.1.0',runs:[{tool:{driver:{name:'CodeQL'}},results:[]}]};
    if(manipulate)manipulate({dir,sarif});
    else fs.writeFileSync(path.join(dir,'javascript.sarif'),JSON.stringify(sarif));
    return spawnSync(process.execPath,[script,dir],{encoding:'utf8',timeout:10000});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('zero-result valid CodeQL report passes without exposing SARIF paths',()=>{
  const r=fixture();
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/CodeQL gate: 0 findings/);
  assert.equal(r.stdout.includes('/tmp/'),false);
});
test('even a single finding causes fail-closed CodeQL status',()=>{
  const r=fixture(({dir,sarif})=>{
    sarif.runs[0].results.push({ruleId:'js/missing-origin-check',
      message:{text:'private synthetic test only'},locations:[{}]});
    fs.writeFileSync(path.join(dir,'javascript.sarif'),JSON.stringify(sarif));
  });
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/1 analyzer findings/);
  assert.doesNotMatch(r.stderr,/private synthetic test only/);
});
test('missing and malformed security results do not appear clean',()=>{
  const missing=fixture(()=>{});
  assert.notEqual(missing.status,0);
  const malformed=fixture(({dir})=>
    fs.writeFileSync(path.join(dir,'javascript.sarif'),'not sarif'));
  assert.notEqual(malformed.status,0);
  const masquerade=fixture(({dir,sarif})=>{
    sarif.runs[0].tool.driver.name='NotCodeQL';
    fs.writeFileSync(path.join(dir,'javascript.sarif'),JSON.stringify(sarif));
  });
  assert.notEqual(masquerade.status,0);
  const duplicate=fixture(({dir,sarif})=>{
    fs.writeFileSync(path.join(dir,'a.sarif'),JSON.stringify(sarif));
    fs.writeFileSync(path.join(dir,'b.sarif'),JSON.stringify(sarif));
  });
  assert.notEqual(duplicate.status,0);
  const symlink=fixture(({dir,sarif})=>{
    const source=path.join(dir,'source.txt');
    fs.writeFileSync(source,JSON.stringify(sarif));
    fs.symlinkSync(source,path.join(dir,'javascript.sarif'));
  });
  assert.notEqual(symlink.status,0,'SARIF symlinks must be rejected');
});
