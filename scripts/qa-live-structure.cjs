'use strict';
// A READ-ONLY structure probe for an already authenticated, dedicated FDE QA profile.
// No queue mutations, DOM injection, navigation interactions, or Send clicks.
// Only public boolean/count evidence is returned; not chat IDs, text or URLs.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const PIN='d17117047f5e582591e514240c008b166bf96d8a';
function targetUrl(raw){
  let u;
  try{if(typeof raw!=='string'||raw.length>250)throw Error();u=new URL(raw);}
  catch{throw Error('an exact private QA conversation URL is required');}
  if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.port||u.username||
     u.password||u.search||u.hash||!/^\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(u.pathname))
    throw Error('target must be one exact https ChatGPT conversation');
  return u.href;
}
function profilePath(dataDir){
  if(!path.isAbsolute(dataDir||''))throw Error('QA profile data directory must be absolute');
  const qa=path.resolve(dataDir,'chat-queue-fde-qa');
  const profile=path.join(qa,'profile');
  for(const dir of [dataDir,qa,profile]){
    const st=fs.lstatSync(dir);
    if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe QA profile boundary');
  }
  if((fs.statSync(profile).mode&0o077)!==0)
    throw Error('QA profile must not be readable by other users');
  return profile;
}
function inspectCounts(){
  // Actual selectors used by the production Queue implementation. The Send
  // button may be disabled while the editor is empty; count its presence but
  // never click or enable it. Do not transfer account or prompt metadata.
  const editorSelector='#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]';
  const sendSelector='button[data-testid="send-button"],button[data-testid="composer-submit-button"],#composer-submit-button,button[aria-label="Send prompt" i],button[aria-label="Send message" i]';
  // Match Queue's actionableControl geometry/visibility and usableComposer
  // shape checks without any click or mutation. Disabled Send is allowed as
  // mere STRUCTURE evidence because ChatGPT disables it for empty drafts.
  const actionable=(e,requireEnabled)=>{
    if(!e.isConnected||!e.getClientRects().length||
       e.closest('[hidden],[inert],[aria-hidden="true" i]')||
       (requireEnabled&&(e.disabled||e.readOnly||e.getAttribute('aria-disabled')==='true'||
         e.closest('[aria-disabled="true" i],fieldset:disabled'))))return false;
    for(let p=e;p;p=p.parentElement){
      const s=getComputedStyle(p);
      if(s.display==='none'||s.visibility!=='visible'||!(Number(s.opacity)>0))return false;
    }
    const r=e.getBoundingClientRect();
    if(r.width<=0||r.height<=0||r.right<=0||r.bottom<=0||
       r.left>=innerWidth||r.top>=innerHeight||
       getComputedStyle(e).pointerEvents==='none')return false;
    const hit=document.elementFromPoint(
      (Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,
      (Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2);
    return Boolean(hit&&(hit===e||e.contains(hit)));
  };
  const editors=[...document.querySelectorAll(editorSelector)].filter(e=>{
    const text=e instanceof HTMLTextAreaElement||
      (e instanceof HTMLInputElement&&['text','search'].includes(e.type));
    return actionable(e,true)&&(text||e.isContentEditable===true);
  });
  const form=editors.length===1?editors[0].closest('form'):null;
  const controls=form?[...form.querySelectorAll(sendSelector)]
    .filter(e=>actionable(e,false)):[];
  const attachments=Boolean(form&&[...form.querySelectorAll('input[type="file"]')]
    .some(input=>input.files?.length));
  return {
    exactRoute:/^\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(location.pathname),
    composerCandidates:editors.length,formPresent:Boolean(form),
    sendCandidates:controls.length,
    sendDisabled:controls.length===1?Boolean(controls[0].disabled||
      controls[0].getAttribute('aria-disabled')==='true'):null,
    attachmentPresent:attachments,
    draftOccupied:editors.length===1?Boolean((editors[0].value??editors[0].textContent??'').trim()):null,
    queueMounted:Boolean(document.getElementById('chat-queue-extension-root')),
    signalPagePresent:typeof document.documentElement.dataset.chatSignalsState==='string'
  };
}
function qualify(o){
  if(!o?.exactRoute||!o.queueMounted||!o.signalPagePresent)
    return {qualified:false,reason:'route-or-addons-not-ready'};
  if(o.composerCandidates!==1||!o.formPresent||o.sendCandidates!==1)
    return {qualified:false,reason:'ambiguous-composer-or-send'};
  if(o.draftOccupied!==false)
    return {qualified:false,reason:'existing-user-draft-preserved'};
  if(o.attachmentPresent!==false)
    return {qualified:false,reason:'existing-attachment-preserved'};
  return {qualified:true,reason:'read-only-structure-only'};
}
// The authenticated QA profile may already contain pending Queue data.
// Installing the unchanged production add-on would violate a "no Send"
// guarantee even when WebDriver itself never clicks anything. In the
// TEMPORARY copied bundle alone, disable dispatchOne before loading Firefox.
// Fail closed when upstream restructures either the dispatcher or Send path.
function disarmQueueDispatch(content){
  const entry='  async function dispatchOne() {';
  const click='      send.click(); clicked=true;';
  if(typeof content!=='string'||content.split(entry).length!==2||
     content.split(click).length!==2)
    throw Error('Queue dispatch source contract changed; live probe blocked');
  return content.replace(entry,
    entry+String.fromCharCode(10)+'    return; // Read-only QA: never prepare, journal, insert, or Send');
}
// Copy only the audited extension payload, not arbitrary local untracked
// files or symlinks. If the production manifest starts referencing another
// script, stop instead of silently omitting potentially security-relevant code.
const PRODUCTION_FILES=[
  'manifest.json','src/background.js','src/content.js','src/core.js',
  'src/grants.js','src/rule-store.js','src/rules.js','src/signal.js',
  'options/options.html','options/options.js','options/rule-preview.js'
];
function copyProductionBundle(destination,sourceRoot){
  const manifest=JSON.parse(fs.readFileSync(path.join(sourceRoot,'manifest.json'),'utf8'));
  const required=[
    ...(manifest.background?.scripts||[]),
    ...(manifest.content_scripts||[]).flatMap(c=>c.js||[]),
    manifest.options_ui?.page
  ];
  const seen=new Set(PRODUCTION_FILES);
  if(required.some(file=>!seen.has(file))||
    JSON.stringify([...new Set(required)].sort())!==JSON.stringify(
      PRODUCTION_FILES.filter(f=>f.startsWith('src/')||f==='options/options.html').sort()))
    throw Error('production manifest files changed; revise QA allowlist');
  for(const relative of PRODUCTION_FILES){
    const input=path.join(sourceRoot,relative);
    const stat=fs.lstatSync(input);
    if(!stat.isFile()||stat.isSymbolicLink())
      throw Error('unsafe production bundle source');
    const output=path.join(destination,relative);
    fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
    fs.copyFileSync(input,output);
  }
}
function pinnedProvider(dir){
  if(!path.isAbsolute(dir||''))throw Error('pinned provider source must be absolute');
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  if(manifest.browser_specific_settings?.gecko?.id!=='chat-signals@sguzman.github')
    throw Error('independent publisher identity mismatch');
  const sha=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const dirty=execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8'}).trim();
  if(sha!==PIN||dirty)throw Error('pinned provider provenance differs');
}
async function main(){
  if(process.argv.length!==2)throw Error('no command arguments supported');
  const target=targetUrl(process.env.CHAT_QUEUE_QA_URL);
  const home=process.env.XDG_DATA_HOME||path.join(process.env.HOME||'','.local','share');
  const profile=profilePath(home);
  const binary=process.env.FDE_BINARY;
  if(!path.isAbsolute(binary||'')||!fs.statSync(binary).isFile())
    throw Error('explicit Firefox Developer Edition executable required');
  pinnedProvider(process.env.CHAT_SIGNALS_PROVIDER_SOURCE);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.browser_specific_settings?.gecko?.id!=='chat-queue@sguzman.github')
    throw Error('Queue identity mismatch');
  const {Builder}=require('selenium-webdriver');
  const firefox=require('selenium-webdriver/firefox');
  const options=new firefox.Options().setBinary(binary)
    .addArguments('--headless','--no-remote','-profile',profile);
  // Never package a checkout, Git history, QA artifacts, or any unreviewed
  // local files into a live-site extension. Copy only the production bundle.
  const addonDir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-readonly-'));
  let driver;
  try{
    copyProductionBundle(addonDir,root);
    const contentFile=path.join(addonDir,'src/content.js');
    const disarmed=disarmQueueDispatch(fs.readFileSync(contentFile,'utf8'));
    fs.writeFileSync(contentFile,disarmed,{mode:0o600});
    driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
    const queueId=await driver.installAddon(addonDir,true);
    const providerId=await driver.installAddon(process.env.CHAT_SIGNALS_PROVIDER_SOURCE,true);
    if(queueId!=='chat-queue@sguzman.github'||providerId!=='chat-signals@sguzman.github')
      throw Error('temporary add-on identity mismatch');
    await driver.get(target);
    // Do not expose even an account URL or an on-page selector failure.
    const current=new URL(await driver.getCurrentUrl());
    if(current.origin!=='https://chatgpt.com'||current.pathname!==new URL(target).pathname){
      process.stdout.write(JSON.stringify({qualified:false,reason:'qa-login-or-route-not-ready',sendAttempted:false})+'\n');
      process.exitCode=1;return;
    }
    let result=await driver.executeScript(inspectCounts);
    if(!result.queueMounted||!result.signalPagePresent){
      try{await driver.wait(async()=>{
        const o=await driver.executeScript(inspectCounts);
        return o.queueMounted&&o.signalPagePresent;
      },10000);}catch{}
      result=await driver.executeScript(inspectCounts);
    }
    const summary={...result,...qualify(result),sendAttempted:false,
      authenticatedSubmissionVerified:false};
    process.stdout.write('FDE read-only live-structure QA: '+JSON.stringify(summary)+'\n');
    if(!summary.qualified)process.exitCode=1;
  }finally{
    try{if(driver)await driver.quit();}
    finally{fs.rmSync(addonDir,{recursive:true,force:true});}
  }
}
module.exports={targetUrl,profilePath,qualify,inspectCounts,disarmQueueDispatch,copyProductionBundle};
if(require.main===module)main().catch(()=>{
  // Browser exceptions often include session/profile URLs. Never print them.
  process.stderr.write('Read-only FDE QA blocked; details retained locally.\n');
  process.exitCode=1;
});
