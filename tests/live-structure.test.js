'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const vm=require('node:vm');
const {targetUrl,profilePath,qualify,inspectCounts,disarmQueueDispatch}=
  require('../scripts/qa-live-structure.cjs');
test('live read-only QA only accepts exact existing conversation URLs',()=>{
  const good='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
  assert.equal(targetUrl(good),good);
  for(const x of [undefined,'','https://chatgpt.com/',
    'https://chatgpt.com/c/short','https://chatgpt.com/c/1234567890123456',
    'https://not-chatgpt.com/c/12345678-1234-1234-1234-123456789abc',
    'http://chatgpt.com/c/12345678-1234-1234-1234-123456789abc',
    good+'?prompt=private',good+'#private',
    'https://me:secret@chatgpt.com/c/12345678-1234-1234-1234-123456789abc'
  ])assert.throws(()=>targetUrl(x));
});
test('live QA reports count-only structure and preserves draft',()=>{
  const txt=inspectCounts.toString();
  for(const forbidden of ['outerHTML','innerHTML','document.cookie',
     'localStorage','sessionStorage','location.href','console.log','click()'])
    assert.equal(txt.includes(forbidden),false,forbidden);
  const ok={exactRoute:true,composerCandidates:1,formPresent:true,
    sendCandidates:1,draftOccupied:false,queueMounted:true,signalPagePresent:true};
  assert.deepEqual(qualify(ok),{qualified:true,reason:'read-only-structure-only'});
  assert.equal(qualify({...ok,draftOccupied:true}).qualified,false);
  assert.equal(qualify({...ok,composerCandidates:2}).qualified,false);
  assert.equal(qualify({...ok,sendCandidates:0}).qualified,false);
  assert.equal(qualify({...ok,queueMounted:false}).qualified,false);
});
test('isolated QA profile exists with private permissions and no symlink escapes',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cq-live-qa-'));
  try{
    const root=path.join(tmp,'chat-queue-fde-qa'),profile=path.join(root,'profile');
    fs.mkdirSync(profile,{recursive:true,mode:0o700});fs.chmodSync(profile,0o700);
    assert.equal(profilePath(tmp),profile);
    fs.chmodSync(profile,0o755);
    assert.throws(()=>profilePath(tmp));
    fs.chmodSync(profile,0o700);
    fs.rmSync(profile,{recursive:true});
    fs.symlinkSync(tmp,profile);
    assert.throws(()=>profilePath(tmp));
    assert.throws(()=>profilePath('relative'));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('live structural probe disarms all Queue dispatch before any browser load',()=>{
  const production=fs.readFileSync(path.join(__dirname,'../src/content.js'),'utf8');
  const originalEntry='  async function dispatchOne() {';
  assert.equal(production.split(originalEntry).length,2,
    'Production source must retain exactly one Send pipeline entry');
  const qa=disarmQueueDispatch(production);
  new vm.Script(qa);
  assert.ok(qa.includes(originalEntry+String.fromCharCode(10)+'    return; // Read-only QA: never prepare, journal, insert, or Send'));
  assert.ok(!production.includes('Read-only QA: never prepare, journal, insert, or Send'),
    'Production must never include the QA-only dispatch interlock');
  assert.equal((qa.match(/send[.]click[(][)]/g)||[]).length,1,
    'The only known scripted Send click is unreachable behind the early return');
  assert.throws(()=>disarmQueueDispatch(production.replace('      send.click(); clicked=true;',
    '      alternateSendAction();')),/source contract changed/);
  assert.throws(()=>disarmQueueDispatch(production.replace(originalEntry,'  async function newDispatch() {')),
    /source contract changed/);
});
