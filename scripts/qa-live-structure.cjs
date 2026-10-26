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
  const visible=e=>{
    if(!e.isConnected||!e.getClientRects().length||
       e.closest('[hidden],[inert],[aria-hidden="true" i]'))return false;
    for(let p=e;p;p=p.parentElement){
      const s=getComputedStyle(p);
      if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)<=0)return false;
    }
    return true;
  };
  const editors=[...document.querySelectorAll(editorSelector)]
    .filter(e=>visible(e)&&(e.isContentEditable||
      e instanceof HTMLTextAreaElement||e instanceof HTMLInputElement));
  const form=editors.length===1?editors[0].closest('form'):null;
  const controls=form?[...form.querySelectorAll(sendSelector)].filter(visible):[];
  return {
    exactRoute:/^\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(location.pathname),
    composerCandidates:editors.length,formPresent:Boolean(form),
    sendCandidates:controls.length,
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
  return {qualified:true,reason:'read-only-structure-only'};
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
    fs.copyFileSync(path.join(root,'manifest.json'),path.join(addonDir,'manifest.json'));
    for(const part of ['src','options'])
      fs.cpSync(path.join(root,part),path.join(addonDir,part),{recursive:true});
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
module.exports={targetUrl,profilePath,qualify,inspectCounts};
if(require.main===module)main().catch(()=>{
  // Browser exceptions often include session/profile URLs. Never print them.
  process.stderr.write('Read-only FDE QA blocked; details retained locally.\n');
  process.exitCode=1;
});
