'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'..');
function runGate(change=()=>{}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-release-gate-'));
  try{
    fs.mkdirSync(path.join(temp,'scripts'));
    fs.copyFileSync(path.join(source,'scripts/release-gate.mjs'),
      path.join(temp,'scripts/release-gate.mjs'));
    for(const name of ['progress.json','manifest.json'])
      fs.copyFileSync(path.join(source,name),path.join(temp,name));
    const ledger=JSON.parse(fs.readFileSync(path.join(temp,'progress.json'),'utf8'));
    const tasks=ledger.milestones.flatMap(m=>m.phases.flatMap(p=>p.features.flatMap(f=>f.tasks)));
    change({temp,ledger,tasks});
    fs.writeFileSync(path.join(temp,'progress.json'),JSON.stringify(ledger));
    return spawnSync(process.execPath,[path.join(temp,'scripts/release-gate.mjs')],
      {encoding:'utf8',timeout:10000});
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
test('current not-yet-verified repository cannot pass the release gate',()=>{
  const result=runGate();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Release blocked/);
  assert.doesNotMatch(result.stdout,/Release ledger gate passed/);
});
test('synthetic 96-task all-verified evidence ledger passes only the ledger gate',()=>{
  const result=runGate(({tasks})=>{
    for(const t of tasks){t.status='verified';t.evidence=['Synthetic fixture only'];}
  });
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/all 96 verified with evidence/);
  assert.match(result.stdout,/signing gates remain separate/);
});
test('missing acceptance evidence fails even if task status says verified',()=>{
  const result=runGate(({tasks})=>{
    for(const t of tasks){t.status='verified';t.evidence=['Synthetic fixture'];}
    tasks[40].evidence=[];
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/1\/96 tasks missing verified acceptance evidence/);
});
test('missing task or changed Firefox add-on identity blocks release',()=>{
  const missing=runGate(({ledger})=>{
    ledger.milestones[0].phases[0].features[0].tasks.pop();
  });
  assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/task inventory or manifest identity changed/);
  const changed=runGate(({temp})=>{
    const p=path.join(temp,'manifest.json');
    const m=JSON.parse(fs.readFileSync(p,'utf8'));
    m.browser_specific_settings.gecko.id='impostor@example.test';
    fs.writeFileSync(p,JSON.stringify(m));
  });
  assert.notEqual(changed.status,0);
  assert.match(changed.stderr,/task inventory or manifest identity changed/);
});
