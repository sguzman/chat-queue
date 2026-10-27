'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const vm=require('node:vm');
const {targetUrl,profilePath,qualify,inspectCounts,disarmQueueDispatch,copyProductionBundle}=
  require('../scripts/qa-live-structure.cjs');
test('live read-only QA only accepts exact existing conversation URLs',()=>{
  const good='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
  assert.equal(targetUrl(good),good);
  const project='https://chatgpt.com/g/g-p-example123/c/12345678-1234-1234-1234-123456789abc';
  assert.equal(targetUrl(project),project,
    'the supported exact project-conversation route must be eligible for read-only QA');
  for(const x of [undefined,'','https://chatgpt.com/',
    'https://chatgpt.com/c/short','https://chatgpt.com/c/1234567890123456',
    'https://not-chatgpt.com/c/12345678-1234-1234-1234-123456789abc',
    'http://chatgpt.com/c/12345678-1234-1234-1234-123456789abc',
    good+'?prompt=private',good+'#private',
    project+'?private=1',project+'#private',project+'/extra',
    'https://chatgpt.com/g/g-p-synthetic123/c/short',
    'https://chatgpt.com/g/g-p-synthetic123/not-a-conversation/12345678-1234-1234-1234-123456789abc',
    'https://chatgpt.com/g/%2e%2e/c/12345678-1234-1234-1234-123456789abc',
    'https://me:secret@chatgpt.com/c/12345678-1234-1234-1234-123456789abc'
  ])assert.throws(()=>targetUrl(x));
});
test('live QA reports count-only structure and preserves draft',()=>{
  const txt=inspectCounts.toString();
  for(const forbidden of ['outerHTML','innerHTML','document.cookie',
     'localStorage','sessionStorage','location.href','console.log','click()'])
    assert.equal(txt.includes(forbidden),false,forbidden);
  const ok={exactRoute:true,composerCandidates:1,formPresent:true,
    sendCandidates:1,sendDisabled:true,attachmentPresent:false,
    draftOccupied:false,queueMounted:true,signalPagePresent:true};
  assert.deepEqual(qualify(ok),{qualified:true,reason:'read-only-structure-only'});
  assert.equal(qualify({...ok,draftOccupied:true}).qualified,false);
  assert.deepEqual(qualify({...ok,attachmentPresent:true}),
    {qualified:false,reason:'existing-attachment-preserved'});
  assert.equal(qualify({...ok,attachmentPresent:undefined}).qualified,false);
  assert.equal(qualify({...ok,sendDisabled:true}).qualified,true,
    'Empty ChatGPT draft may legitimately leave its visible Send disabled');
  assert.equal(qualify({...ok,composerCandidates:2}).qualified,false);
  assert.equal(qualify({...ok,sendCandidates:0}).qualified,false);
  assert.equal(qualify({...ok,queueMounted:false}).qualified,false);
});
test('serialized Selenium probe is self-contained on direct and project pages',()=>{
  const source='('+inspectCounts.toString()+')';
  assert.equal(source.includes('QA_CONVERSATION_ROUTE'),false,
    'Selenium page context cannot access Node module-scope variables');
  const pathnameRoute='/g/g-p-example123/c/12345678-1234-1234-1234-123456789abc';
  const page={querySelectorAll:()=>[],getElementById:()=>null,
    documentElement:{dataset:{chatSignalsState:'idle'}}};
  const ctx=vm.createContext({document:page,location:{pathname:pathnameRoute}});
  const isolated=vm.runInContext(source,ctx);
  assert.equal(isolated().exactRoute,true);
  ctx.location.pathname='/c/12345678-1234-1234-1234-123456789abc';
  assert.equal(isolated().exactRoute,true);
  ctx.location.pathname='/share/12345678-1234-1234-1234-123456789abc';
  assert.equal(isolated().exactRoute,false);
  assert.equal(isolated().queueMounted,false);
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

test('read-only QA addon includes only the audited production files',()=>{
  const root=path.resolve(__dirname,'..');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cq-prod-qa-'));
  try{
    copyProductionBundle(temp,root);
    const selected=[];
    const scan=(dir,base='')=>{
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const name=path.posix.join(base,entry.name);
        if(entry.isDirectory())scan(path.join(dir,entry.name),name);
        else selected.push(name);
      }
    };
    scan(temp);
    assert.deepEqual(selected.sort(),[
      'manifest.json','src/background.js','src/content.js','src/core.js',
      'src/grants.js','src/rule-store.js','src/rules.js','src/signal.js',
      'options/options.html','options/options.js','options/rule-preview.js'
    ].sort());
    const bad=fs.mkdtempSync(path.join(os.tmpdir(),'cq-src-fail-'));
    try{
      const newManifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
      newManifest.background.scripts.push('src/unreviewed.js');
      fs.writeFileSync(path.join(bad,'manifest.json'),JSON.stringify(newManifest));
      assert.throws(()=>copyProductionBundle(temp,bad),/manifest files changed/);
    }finally{fs.rmSync(bad,{recursive:true,force:true});}
    const bogus=fs.mkdtempSync(path.join(os.tmpdir(),'cq-src-link-'));
    try{
      const stat=fs.lstatSync(path.join(root,'src/content.js'));
      assert.ok(stat.isFile());
      // The hardcoded production-file inventory must not accept a symlink
      // even when its destination looks like legitimate source.
      fs.copyFileSync(path.join(root,'manifest.json'),path.join(bogus,'manifest.json'));
      fs.mkdirSync(path.join(bogus,'src'));
      fs.symlinkSync(path.join(root,'src/background.js'),
        path.join(bogus,'src/background.js'));
      assert.throws(()=>copyProductionBundle(temp,bogus),/unsafe production bundle source/);
    }finally{fs.rmSync(bogus,{recursive:true,force:true});}
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('live probe rejects a symlinked source directory before staging private source',()=>{
  const root=path.resolve(__dirname,'..');
  const fake=fs.mkdtempSync(path.join(os.tmpdir(),'cq-qa-dir-symlink-'));
  const target=fs.mkdtempSync(path.join(os.tmpdir(),'cq-qa-dir-target-'));
  try{
    fs.copyFileSync(path.join(root,'manifest.json'),path.join(fake,'manifest.json'));
    fs.symlinkSync(path.join(root,'src'),path.join(fake,'src'),'dir');
    fs.mkdirSync(path.join(fake,'options'));
    assert.throws(()=>copyProductionBundle(target,fake),
      /unsafe production bundle source/);
    assert.equal(fs.existsSync(path.join(target,'src/background.js')),false,
      'source from a symlinked directory must not be staged');
  }finally{
    fs.rmSync(fake,{recursive:true,force:true});
    fs.rmSync(target,{recursive:true,force:true});
  }
});

test('live probe refuses source symlinks and never stages their private bytes',()=>{
  const root=path.resolve(__dirname,'..');
  const fake=fs.mkdtempSync(path.join(os.tmpdir(),'cq-qa-file-symlink-'));
  const target=fs.mkdtempSync(path.join(os.tmpdir(),'cq-qa-file-target-'));
  const privateFile=path.join(fake,'private-canary.txt');
  try{
    fs.copyFileSync(path.join(root,'manifest.json'),path.join(fake,'manifest.json'));
    fs.mkdirSync(path.join(fake,'src'));fs.mkdirSync(path.join(fake,'options'));
    fs.writeFileSync(privateFile,'QA-PRIVATE-CANARY-MUST-NOT-BE-STAGED');
    fs.symlinkSync(privateFile,path.join(fake,'src/background.js'));
    assert.throws(()=>copyProductionBundle(target,fake),
      /unsafe production bundle source/);
    assert.equal(fs.existsSync(path.join(target,'src/background.js')),false);
    assert.equal(fs.readFileSync(path.join(target,'manifest.json'),'utf8')
      .includes('QA-PRIVATE-CANARY-MUST-NOT-BE-STAGED'),false);
  }finally{
    fs.rmSync(fake,{recursive:true,force:true});
    fs.rmSync(target,{recursive:true,force:true});
  }
});

test('read-only selector probe tracks production editor and Send selectors',()=>{
  const production=fs.readFileSync(path.join(__dirname,'../src/content.js'),'utf8');
  const probe=inspectCounts.toString();
  const expected=[
    ['editorSelector','composer'],
    ['sendSelector','send']
  ];
  for(const [variable,label] of expected){
    const match=production.match(new RegExp(
      'const '+variable+'\\s*=\\s*(\\x27[^\\x27]+\\x27)'));
    assert.ok(match,'Production '+label+' selector must have known audited form');
    assert.ok(probe.includes(match[1].slice(1,-1)),
      'Probe '+label+' selector must match production literally');
  }
  for(const required of ['elementFromPoint','getBoundingClientRect',
    'aria-disabled','input[type="file"]','isContentEditable']){
    assert.ok(probe.includes(required),'Probe must carry '+required+' safety check');
  }
});
