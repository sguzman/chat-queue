'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function attemptSigning(verifyAll=false,credentials=false){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-sign-guard-'));
 try{
  fs.mkdirSync(path.join(tmp,'scripts'));
  for(const script of ['release-gate.mjs','sign-unlisted.mjs'])
   fs.copyFileSync(path.join(root,'scripts',script),path.join(tmp,'scripts',script));
  for(const file of ['manifest.json','progress.json'])
   fs.copyFileSync(path.join(root,file),path.join(tmp,file));
  if(verifyAll){
   const p=path.join(tmp,'progress.json');
   const ledger=JSON.parse(fs.readFileSync(p,'utf8'));
   for(const t of ledger.milestones.flatMap(m=>m.phases.flatMap(p=>p.features.flatMap(f=>f.tasks)))){
    t.status='verified';t.evidence=['Synthetic release test; no real acceptance'];
   }
   fs.writeFileSync(p,JSON.stringify(ledger));
  }
  const env={...process.env};
  delete env.WEB_EXT_API_KEY;delete env.WEB_EXT_API_SECRET;
  if(credentials){
   env.WEB_EXT_API_KEY='FAKE_TEST_ONLY';
   env.WEB_EXT_API_SECRET='FAKE_TEST_ONLY';
  }
  const result=spawnSync(process.execPath,[path.join(tmp,'scripts/sign-unlisted.mjs')],
   {cwd:tmp,env,encoding:'utf8',timeout:10000});
  return {status:result.status,stdout:result.stdout,stderr:result.stderr,
    staged:fs.existsSync(path.join(tmp,'dist','signed'))};
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
test('incomplete real ledger stops signing even if fake credentials are supplied',()=>{
 const result=attemptSigning(false,true);
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Signing refused: release acceptance ledger is not complete/);
 assert.equal(result.staged,false);
 assert.doesNotMatch(result.stdout+result.stderr,/FAKE_TEST_ONLY/);
});
test('synthetic complete ledger still refuses signing without Mozilla credentials',()=>{
 const result=attemptSigning(true,false);
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Mozilla API credentials are required/);
 assert.equal(result.staged,false);
 assert.match(result.stdout,/Release ledger gate passed/);
});
test('signing implementation confines upload to unlisted channel and allowlisted sources',()=>{
 const script=fs.readFileSync(path.join(root,'scripts/sign-unlisted.mjs'),'utf8');
 assert.match(script,/--channel','unlisted'/);
 assert.match(script,/source-dir',stage/);
 assert.match(script,/WEB_EXT_API_KEY/);
 assert.match(script,/WEB_EXT_API_SECRET/);
 assert.match(script,/\bfs\.copyFileSync\(from,to\)/);
 assert.doesNotMatch(script,/shell:true/);
 assert.match(script,/delete preflightEnv\.WEB_EXT_API_KEY/);
 assert.match(script,/delete preflightEnv\.WEB_EXT_API_SECRET/);
 assert.match(script,/scripts\/release-gate\.mjs'\],\{env:preflightEnv\}/);
 assert.match(script,/\['run','check'\],\{env:preflightEnv\}/);
 assert.match(script,/--warnings-as-errors','--boring'\],\{env:preflightEnv\}/);
 assert.match(script,/--no-input'\],\{env:process\.env\}/);
});
