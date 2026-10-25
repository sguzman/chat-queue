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
    t.status=t.id==='M7-12'?'planned':'verified';
    t.evidence=t.id==='M7-12'?[]:['Synthetic release test; no real acceptance'];
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
test('synthetic 95-task pre-tag ledger still refuses signing without Mozilla credentials',()=>{
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
 assert.match(script,/key\.startsWith\('WEB_EXT_'\)/);
 assert.match(script,/WEB_EXT_API_KEY:process\.env\.WEB_EXT_API_KEY/);
 assert.match(script,/WEB_EXT_API_SECRET:process\.env\.WEB_EXT_API_SECRET/);
 assert.ok(script.includes("'--no-config-discovery'"));
 assert.ok(script.includes("'https://addons.mozilla.org/api/v5/'"));
 assert.match(script,/scripts\/release-gate\.mjs'\],\{env:preflightEnv\}/);
 assert.match(script,/\['run','check'\],\{env:preflightEnv\}/);
 assert.match(script,/--warnings-as-errors','--boring'\],\{env:preflightEnv\}/);
 assert.match(script,/--no-input'\],\{env:signingEnv\}/);
});

test('fake local signing tool proves ordered gates and secret isolation without network',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-fake-sign-'));
 try{
  fs.mkdirSync(path.join(temp,'scripts'));
  for(const file of ['release-gate.mjs','sign-unlisted.mjs'])
   fs.copyFileSync(path.join(root,'scripts',file),path.join(temp,'scripts',file));
  for(const file of ['manifest.json','progress.json'])
   fs.copyFileSync(path.join(root,file),path.join(temp,file));
  for(const dir of ['src','options'])
   fs.cpSync(path.join(root,dir),path.join(temp,dir),{recursive:true});
  const ledgerFile=path.join(temp,'progress.json');
  const ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
  for(const task of ledger.milestones.flatMap(m=>m.phases.flatMap(p=>p.features.flatMap(f=>f.tasks)))){
   task.status='verified';task.evidence=['Synthetic fixture — not production acceptance'];
  }
  fs.writeFileSync(ledgerFile,JSON.stringify(ledger));
  const bin=path.join(temp,'bin');fs.mkdirSync(bin);
  const fakeNpm=path.join(bin,'npm');
  fs.writeFileSync(fakeNpm,`#!/usr/bin/env node
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
const phase=args.includes('sign')?'sign':args.includes('lint')?'lint':'check';
const record={phase,hasKey:Boolean(process.env.WEB_EXT_API_KEY),
 hasSecret:Boolean(process.env.WEB_EXT_API_SECRET)};
if(phase==='sign'){
 const index=args.indexOf('--source-dir');
 const staging=args[index+1];
 record.stagedManifest=fs.existsSync(path.join(staging,'manifest.json'));
 record.stagedCore=fs.existsSync(path.join(staging,'src','core.js'));
 record.stagedTests=fs.existsSync(path.join(staging,'tests'));
 record.stagedPrivate=fs.existsSync(path.join(staging,'progress.json'));
}
fs.appendFileSync(path.join(process.cwd(),'observed-signing-processes.jsonl'),JSON.stringify(record)+'\\n');
process.exit(0);
`);
  fs.chmodSync(fakeNpm,0o755);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,
   WEB_EXT_API_KEY:'TEST_CREDENTIAL_ONLY',WEB_EXT_API_SECRET:'TEST_SECRET_ONLY'};
  const result=spawnSync(process.execPath,[path.join(temp,'scripts/sign-unlisted.mjs')],
   {cwd:temp,env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const observed=fs.readFileSync(path.join(temp,'observed-signing-processes.jsonl'),'utf8')
   .trim().split('\n').map(JSON.parse);
  assert.deepEqual(observed.map(o=>o.phase),['check','lint','sign']);
  assert.deepEqual(observed.map(o=>[o.hasKey,o.hasSecret]),[
   [false,false],[false,false],[true,true]
  ]);
  assert.equal(observed[2].stagedManifest,true);
  assert.equal(observed[2].stagedCore,true);
  assert.equal(observed[2].stagedTests,false);
  assert.equal(observed[2].stagedPrivate,false);
  assert.doesNotMatch(result.stdout+result.stderr,/TEST_CREDENTIAL_ONLY|TEST_SECRET_ONLY/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
