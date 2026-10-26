'use strict';
// Real Firefox Developer Edition extension-to-extension API acceptance.
// All pages, messages and grants are synthetic; no ChatGPT login or real Send.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const queueId='chat-queue-api-qa@sguzman.github';
const clientId='queue-api-client-qa@sguzman.github';
const grantsKey='chatqueue:api-grants:v2';
const initialPolicy={version:2,grants:{[clientId]:['discover','append','rules']}};
const html=`<!doctype html><html><head><meta charset="utf-8"><title>API fixture</title></head><body>
<main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button" onclick="window.__sent++">Send</button></form></main>
<script>window.__sent=0;window.__apiResults=[];window.__grantResults=[];window.__metadataResults=[];
window.addEventListener('message',e=>{if(e.data?.kind==='qa-api-response')window.__apiResults.push(e.data);if(e.data?.kind==='qa-grants-ack')window.__grantResults.push(e.data);if(e.data?.kind==='qa-meta-response')window.__metadataResults.push(e.data)});
</script></body></html>`;
function createQueue(dest,root){
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 manifest.browser_specific_settings.gecko.id=queueId;
 manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
 manifest.content_scripts[0].js.push('qa-grants-content.js');
 manifest.background.scripts.unshift('qa-grants-background.js');
 fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify(manifest));
 for(const folder of ['src','options'])fs.cpSync(path.join(root,folder),path.join(dest,folder),{recursive:true});
 const contentFile=path.join(dest,'src/content.js');
 let content=fs.readFileSync(contentFile,'utf8');
 const marker="attachShadow({mode:'closed'})";
 assert.equal(content.split(marker).length,2);
 const queueSet='api.storage.local.set({[key]:data})';
 assert.equal(content.split(queueSet).length,2);
 content=content.replace(marker,"attachShadow({mode:'open'})")
   .replace(queueSet,"(document.documentElement.dataset.qaRejectQueueSet==='once' ? "+
     "(document.documentElement.dataset.qaRejectQueueSet='consumed',Promise.reject(new Error('qa-queue-save-failed'))) : "+
     "api.storage.local.set({[key]:data}))");
 fs.writeFileSync(contentFile,content);
 const bgFile=path.join(dest,'src/background.js');
 let bg=fs.readFileSync(bgFile,'utf8');
 const before=String.raw`if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;`;
 const after=String.raw`if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url || tab.url || '')) return;`;
 assert.equal(bg.split(before).length,2);
 bg=bg.replace(before,after);
 const nav="!change.url.startsWith('https://chatgpt.com/')";
 assert.equal(bg.split(nav).length,2);
 bg=bg.replace(nav,"!change.url.startsWith('http://127.0.0.1:')");
 // QA-only: simulate a persisted revocation whose onChanged delivery is
 // delayed, while an already-authorized private status response is in flight.
 // The production add-on never accepts this payload field or QA flag.
 const statusBoundary="      // Status contains private prompts. A storage revocation can commit";
 assert.equal(bg.split(statusBoundary).length,2);
 bg=bg.replace(statusBoundary,
   "      if(message.action==='status'&&message.payload?.qaHold===true){"+
   "globalThis.__qaPrivateStatusHoldEntered=true;"+
   "await new Promise(resolve=>setTimeout(resolve,2400));}\n"+
   statusBoundary);
 // QA-only: suspend Rules preview after its initial persisted scope read.
 // Production does not accept qaHoldRules or inject a delay.
 const previewBoundary="    if (message.action === 'previewRules') {";
 assert.equal(bg.split(previewBoundary).length,2);
 bg=bg.replace(previewBoundary,
   "    if(message.action==='previewRules'&&message.payload?.qaHoldRules===true){"+
   "globalThis.__qaRulesPreviewHoldEntered=true;"+
   // Reuse the QA grant-revoke barrier for this separate Rules scope test.
   // It changes no production authorization logic or provider state.
   "globalThis.__qaPrivateStatusHoldEntered=true;"+
   "await new Promise(resolve=>setTimeout(resolve,2400));}\n"+
   previewBoundary);
 // QA-only: suspend one failed old peer forward until a new registration.
 const forwardBoundary="      const reply=await api.tabs.sendMessage(message.tabId, {";
 assert.equal(bg.split(forwardBoundary).length,2);
 bg=bg.replace(forwardBoundary,
   "      if(message.action==='enqueue'&&message.payload?.qaRejectOldForward===true){"+
   "globalThis.__qaOldForwardEntered=true;"+
   "await new Promise(resolve=>{globalThis.__qaOldForwardRelease=resolve;});"+
   "throw new Error('qa-old-document-no-receiver');}\n"+forwardBoundary);
 const grantListener="  api.storage.onChanged.addListener((changes,area)=>{";
 assert.equal(bg.split(grantListener).length,2);
 bg=bg.replace(grantListener,grantListener+
   "\n    if(globalThis.__qaSkipGrantChangeNotice&&area==='local'&&changes[grants.KEY])return;");
 // QA-only: freeze the first external Append ACL snapshot and resolve it
 // after a durable revocation that has not yet notified the event page.
 // Production does not interpret qaHoldInitial or delay authorization.
 const initialGrantRead="    const config = await api.storage.local.get(grants.KEY);";
 assert.equal(bg.split(initialGrantRead).length,2);
 bg=bg.replace(initialGrantRead,
   "    const config = await ((message.action==='enqueue'&&"+
   "message.payload?.qaHoldInitial===true)?"+
   "(async()=>{const snapshot=await api.storage.local.get(grants.KEY);"+
   "globalThis.__qaPrivateStatusHoldEntered=true;"+
   "await new Promise(resolve=>setTimeout(resolve,2200));"+
   "return snapshot;})():api.storage.local.get(grants.KEY));");
 // QA-only: pause external Enqueue immediately before the browser URL
 // lookup after its first two durable grant reads. Production ignores
 // qaHoldWriteUrl; a silent permission revoke must withhold the mutation.
 const mutationLookup="      let live;\n      try{live=new URL((await api.tabs.get(message.tabId))?.url);}";
 assert.equal(bg.split(mutationLookup).length,2);
 bg=bg.replace(mutationLookup,
   "      if(message.action==='enqueue'&&message.payload?.qaHoldWriteUrl===true){"+
   "globalThis.__qaPrivateStatusHoldEntered=true;"+
   "await new Promise(resolve=>setTimeout(resolve,2400));}\n"+
   mutationLookup);
 // QA-only: delay the final browser URL verification, not the earlier
 // response hold or permission check. Test that a silent durable Read revoke
 // committed during this last await is still denied before prompt disclosure.
 const finalUrlBoundary="        let finalUrl;\n        try{finalUrl=new URL((await api.tabs.get(message.tabId))?.url);}";
 assert.equal(bg.split(finalUrlBoundary).length,2);
 bg=bg.replace(finalUrlBoundary,
   "        if(message.action==='status'&&message.payload?.qaHoldFinalUrl===true){"+
   "globalThis.__qaPrivateStatusHoldEntered=true;"+
   "await new Promise(resolve=>setTimeout(resolve,2400));}\n"+
   finalUrlBoundary);
 // QA-only: suspend a previous document's metadata-only hold release
 // after capturing its generation but before the durable storage read.
 // Production never interprets qaHoldOldRelease.
 const holdRead="          try{hold=(await api.storage.local.get(key))[key];}";
 assert.equal(bg.split(holdRead).length,2);
 bg=bg.replace(holdRead,
   "          if(message.action==='release-send-hold'&&message.qaHoldOldRelease===true){"+
   "globalThis.__qaOldHoldReleaseEntered=true;"+
   "await new Promise(resolve=>{globalThis.__qaOldHoldReleaseResume=resolve;});}\n"+
   holdRead);
 // QA-only: delay one stale tab metadata state before URL inspection.
 const section=bg.indexOf("    if (message.action === 'state') {");
 assert.ok(section>=0);
 const lookup="      return currentRoute(sender).then(live=>{";
 const fragment=bg.slice(section);
 assert.equal(fragment.split(lookup).length,2);
 bg=bg.slice(0,section)+fragment.replace(lookup,
   "      return ((message.sequence===100001||message.sequence===200001) ? "+
   "new Promise(resolve=>setTimeout(resolve,900)).then(()=>currentRoute(sender)) : "+
   "currentRoute(sender)).then(live=>{");
 fs.writeFileSync(bgFile,bg);
 // QA-only bootstrap and permission update handler. Production extension
 // remains unchanged; it receives genuine browser.storage.local writes.
 fs.writeFileSync(path.join(dest,'qa-grants-background.js'),`
 browser.storage.local.set({[${JSON.stringify(grantsKey)}]:${JSON.stringify(initialPolicy)}});
 browser.runtime.onMessage.addListener((msg,sender)=>{
   if(!sender.tab||!sender.url?.startsWith('http://127.0.0.1:'))return;
   if(msg?.type==='qa-preview-hold-state')
     return Promise.resolve({ok:true,entered:globalThis.__qaRulesPreviewHoldEntered===true});
   if(msg?.type==='qa-seed-send-hold'){
     const route='/c/synthetic',holdId='12345678-aaaa-4444-bbbb-111111111111';
     const key='chatqueue:send-hold:v1:synthetic';
     return browser.storage.local.set({[key]:{version:1,route,
       tabId:sender.tab.id,holdId}}).then(()=>({ok:true}));
   }
   if(msg?.type==='qa-old-hold-state')
     return Promise.resolve({ok:true,entered:globalThis.__qaOldHoldReleaseEntered===true});
   if(msg?.type==='qa-old-hold-resume'){
     const resume=globalThis.__qaOldHoldReleaseResume;
     if(typeof resume!=='function')return Promise.resolve({ok:false,error:'not-held'});
     globalThis.__qaOldHoldReleaseResume=null;
     globalThis.__qaOldHoldReleaseEntered=false;
     resume();return Promise.resolve({ok:true});
   }
   if(msg?.type==='qa-old-forward-state')
     return Promise.resolve({ok:true,entered:globalThis.__qaOldForwardEntered===true});
   if(msg?.type==='qa-old-forward-release'){
     const release=globalThis.__qaOldForwardRelease;
     if(typeof release!=='function')return Promise.resolve({ok:false,error:'not-held'});
     globalThis.__qaOldForwardRelease=null;globalThis.__qaOldForwardEntered=false;
     release();return Promise.resolve({ok:true});
   }
   if(msg?.type==='qa-seed-uncertain'){
     const key='chatqueue:v1:tab:'+sender.tab.id+':/c/api-uncertain';
     return browser.storage.local.set({[key]:{version:1,
       items:[{id:'qa-uncertain-item',text:'Synthetic possibly submitted payload',status:'uncertain'}]
     }}).then(()=>({ok:true}));
   }
   if(msg?.type==='qa-grants-update-silent'){
     // Wait for the production external-status handler to reach the delayed
     // return boundary before committing the synthetic revocation.
     return new Promise(resolve=>{
       let tries=0;
       const poll=()=>{
         if(globalThis.__qaPrivateStatusHoldEntered===true){
           globalThis.__qaSkipGrantChangeNotice=true;
           browser.storage.local.set({[${JSON.stringify(grantsKey)}]:msg.policy})
             .then(()=>resolve({ok:true}),()=>resolve({ok:false,error:'qa-save-failed'}));
         }else if(++tries<150)setTimeout(poll,15);
         else resolve({ok:false,error:'qa-status-not-paused'});
       };
       poll();
     });
   }
   if(msg?.type!=='qa-grants-update')return;
   globalThis.__qaSkipGrantChangeNotice=false;
   globalThis.__qaPrivateStatusHoldEntered=false;
   return browser.storage.local.set({[${JSON.stringify(grantsKey)}]:msg.policy}).then(()=>({ok:true}));
 });`);
 fs.writeFileSync(path.join(dest,'qa-grants-content.js'),`
 window.addEventListener('message',event=>{
  if(event.source!==window||!['qa-grants-set','qa-grants-set-silent','qa-seed-uncertain'].includes(event.data?.kind))return;
  const {nonce,policy,kind}=event.data;
  browser.runtime.sendMessage(kind==='qa-seed-uncertain'?{type:'qa-seed-uncertain'}:
    {type:kind==='qa-grants-set-silent'?'qa-grants-update-silent':'qa-grants-update',policy})
    .then(result=>window.postMessage({kind:'qa-grants-ack',nonce,result},'*'))
    .catch(()=>window.postMessage({kind:'qa-grants-ack',nonce,result:{ok:false}},'*'));
 });
 window.addEventListener('message',event=>{
  if(event.source!==window||event.data?.kind!=='qa-meta-send')return;
  const {nonce,message}=event.data;
  browser.runtime.sendMessage(message)
    .then(result=>window.postMessage({kind:'qa-meta-response',nonce,result},'*'))
    .catch(()=>window.postMessage({kind:'qa-meta-response',nonce,result:{ok:false,error:'transport'}},'*'));
 });`);
}
function createClient(dest){
 fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'Synthetic Queue API Client',version:'1.0',
  browser_specific_settings:{gecko:{id:clientId}},
  background:{scripts:['background.js']},
  content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js'],run_at:'document_idle'}]
 }));
 fs.writeFileSync(path.join(dest,'background.js'),`
 let port=null;let events=[];let disconnected=false;
 browser.runtime.onMessage.addListener(message=>{
  if(message?.type!=='qa-api-request')return;
  const req=message.request;
  if(req?.action==='subscribe'){
   port=browser.runtime.connect('${queueId}',{name:'chat-queue/v1'});
   port.onMessage.addListener(v=>events.push(v));
   port.onDisconnect.addListener(()=>{disconnected=true});
   return Promise.resolve({ok:true});
  }
  if(req?.action==='portState')return Promise.resolve({ok:true,events,disconnected});
  if(req?.action==='qa-cyclic-message'){
   const cycle={type:'chat-queue/v1',action:'enqueue',tabId:req.tabId,
     payload:{text:'Synthetic private message; do not leak'}};
   cycle.self=cycle;
   return browser.runtime.sendMessage('${queueId}',cycle)
     .catch(()=>({ok:false,error:'browser-transport-error'}));
  }
  return browser.runtime.sendMessage('${queueId}',req)
    .catch(e=>({ok:false,error:'browser-transport-error'}));
 });`);
 fs.writeFileSync(path.join(dest,'content.js'),`
 document.documentElement.dataset.qaApiClientReady='yes';
 window.addEventListener('message',event=>{
  if(event.source!==window||event.data?.kind!=='qa-api-request')return;
  const {nonce,request}=event.data;
  browser.runtime.sendMessage({type:'qa-api-request',request})
    .then(result=>window.postMessage({kind:'qa-api-response',nonce,result},'*'))
    .catch(()=>window.postMessage({kind:'qa-api-response',nonce,result:{ok:false,error:'client-transport-error'}},'*'));
 });`);
}
async function main(){
 const binary=process.env.FDE_BINARY;
 if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY must be Firefox Developer Edition');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-api-fde-'));
 const qdir=path.join(base,'queue'),cdir=path.join(base,'client');
 fs.mkdirSync(qdir);fs.mkdirSync(cdir);
 createQueue(qdir,path.resolve(__dirname,'..'));createClient(cdir);
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)});
 let driver=null,stage='initialization';
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  driver=await new Builder().forBrowser('firefox').setFirefoxOptions(
   new firefox.Options().setBinary(binary).addArguments('-headless')).build();
  assert.equal(await driver.installAddon(qdir,true),queueId);
  assert.equal(await driver.installAddon(cdir,true),clientId);
  await driver.get(`http://127.0.0.1:${server.address().port}/c/synthetic`);
  await driver.wait(async()=>await driver.executeScript(`return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run'))&&document.documentElement.dataset.qaApiClientReady==='yes'`),15000);
  let nonce=0;
  const command=async request=>{
   const id=++nonce;
   await driver.executeScript('window.postMessage({kind:"qa-api-request",nonce:arguments[0],request:arguments[1]},"*")',id,request);
   await driver.wait(async()=>await driver.executeScript('return window.__apiResults.some(x=>x.nonce===arguments[0])',id),10000);
   return driver.executeScript('return window.__apiResults.find(x=>x.nonce===arguments[0]).result',id);
  };
  let result=await command({type:'chat-queue/v1',action:'capabilities'});
  assert.equal(result.ok,true);assert.deepEqual(result.scopes,['discover','append','rules']);
  assert.equal(result.protocolVersion,1);
  assert.equal(result.grantVersion,2);
  assert.equal(result.version,2);
  const syntheticSignal={version:1,route:'/c/synthetic',documentToken:'a'.repeat(32),
    sequence:1,epoch:1,phase:'failed',origin:'fresh',confidence:'observed'};
  const syntheticRule={version:1,id:'pause-on-error',enabled:true,priority:40,
    when:{phase:'failed'},then:{type:'pause'}};
  result=await command({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[syntheticRule],signal:syntheticSignal}});
  assert.equal(result.ok,true);assert.equal(result.decision.ruleId,'pause-on-error');
  assert.equal(result.decision.approvalRequired,true);
  assert.equal(result.audit.phase,'failed');
  assert.equal(result.audit.ruleId,'pause-on-error');
  assert.equal(result.audit.action,'pause');
  assert.equal(JSON.stringify(result.audit).includes(syntheticSignal.route),false);
  assert.equal(JSON.stringify(result.audit).includes(syntheticSignal.documentToken),false);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  stage='native-silent-Rules-revocation-before-preview';
  const holdPreview=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-api-request",nonce:arguments[0],request:{type:"chat-queue/v1",action:"previewRules",payload:{rules:[arguments[1]],signal:arguments[2],qaHoldRules:true}}},"*")',
    holdPreview,syntheticRule,syntheticSignal);
  const pollMetadata=async message=>{
    const i=++nonce;
    await driver.executeScript(
      'window.postMessage({kind:"qa-meta-send",nonce:arguments[0],message:arguments[1]},"*")',
      i,message);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__metadataResults.some(x=>x.nonce===arguments[0])',i),5000);
    return driver.executeScript(
      'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result',i);
  };
  await driver.wait(async()=>(await pollMetadata({
    type:'qa-preview-hold-state'}))?.entered===true,8000);
  const revokePreview=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set-silent",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append"]}}},"*")',
    revokePreview,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',
    revokePreview),10000);
  assert.equal(await driver.executeScript(
    'return window.__grantResults.find(x=>x.nonce===arguments[0]).result.ok',
    revokePreview),true);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__apiResults.some(x=>x.nonce===arguments[0])',
    holdPreview),10000);
  assert.equal(await driver.executeScript(
    'return window.__apiResults.find(x=>x.nonce===arguments[0]).result.error',
    holdPreview),'authorization-changed');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  const restorePreview=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append","rules"]}}},"*")',
    restorePreview,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',
    restorePreview),10000);
  assert.equal((await command({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[syntheticRule],signal:syntheticSignal}})).ok,true);
  stage='scoped-persistent-rules';
  const firstLibrary=await command({type:'chat-queue/v1',action:'rulesGet'});
  assert.equal(firstLibrary.ok,true);
  assert.equal(firstLibrary.revision,0);
  assert.deepEqual(firstLibrary.rules,[]);
  assert.equal((await command({action:'subscribe'})).ok,true);
  await driver.wait(async()=>{const stream=await command({action:'portState'});
    return stream.events.some(x=>x.event==='ready');},7000);
  const created=await command({type:'chat-queue/v1',action:'rulesPut',
    payload:{revision:0,rules:[syntheticRule]}});
  assert.equal(created.ok,true);
  assert.equal(created.revision,1);
  const persisted=await command({type:'chat-queue/v1',action:'rulesGet'});
  assert.equal(persisted.ok,true);
  assert.equal(persisted.revision,1);
  assert.equal(persisted.rules[0].id,syntheticRule.id);
  assert.equal((await command({type:'chat-queue/v1',action:'rulesPut',
    payload:{revision:0,rules:[]}})).error,'rule-revision-conflict');
  const proposals=await Promise.all([
    command({type:'chat-queue/v1',action:'rulesPut',
      payload:{revision:1,rules:[{...syntheticRule,priority:41}]}}),
    command({type:'chat-queue/v1',action:'rulesPut',
      payload:{revision:1,rules:[{...syntheticRule,priority:42}]}})
  ]);
  assert.equal(proposals.filter(x=>x.ok).length,1);
  assert.equal(proposals.filter(x=>x.error==='rule-revision-conflict').length,1);
  const raced=await command({type:'chat-queue/v1',action:'rulesGet'});
  assert.equal(raced.revision,2);
  assert.ok([41,42].includes(raced.rules[0].priority));
  await driver.wait(async()=>{const stream=await command({action:'portState'});
    return stream.events.some(x=>x.event==='rulesChanged'&&x.revision===2);},7000);
  const ruleEvents=(await command({action:'portState'})).events.filter(x=>x.event==='rulesChanged');
  const revisions=ruleEvents.map(x=>x.revision);
  assert.ok(revisions.length>=1&&revisions.length<=2);
  assert.equal(revisions.at(-1),2,'newest committed revision must be observable');
  assert.ok(revisions.every((x,i)=>i===0||x>revisions[i-1]),
    'older asynchronous revision notifications must never arrive after newer ones');
  assert.equal(JSON.stringify(ruleEvents).includes('pause-on-error'),false);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  result=await command({type:'chat-queue/v1',action:'listTabs'});
  assert.equal(result.ok,true);assert.equal(result.tabs.length,1);
  const tabId=result.tabs[0].tabId;
  stage='adversarial-ipc';
  // A hostile peer add-on can send a cyclic object under Firefox's structured
  // clone semantics. Either the transport rejects it or Chat Queue returns a
  // structured fail-closed error; it must never reach a tab or disclose text.
  const cyclic=await command({action:'qa-cyclic-message',tabId});
  assert.equal(cyclic.ok,false);
  assert.ok(['invalid-request','browser-transport-error'].includes(cyclic.error));
  assert.ok(!JSON.stringify(cyclic).includes('Synthetic private message'));
  const oversized=await command({type:'chat-queue/v1',action:'enqueue',tabId,
    payload:{text:'X'.repeat(33000)}});
  assert.equal(oversized.error,'request-too-large');
  // 12,000 CJK characters fit under the former UTF-16 count but exceed
  // 32 KiB on the actual Firefox extension transport.
  const unicodeOversized=await command({type:'chat-queue/v1',
    action:'capabilities',padding:'漢'.repeat(12000)});
  assert.equal(unicodeOversized.error,'request-too-large');
  assert.equal(await driver.executeScript(
    'return document.querySelector("#chat-queue-extension-root").shadowRoot.getElementById("count").textContent'),'0 queued');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  for(const action of ['status','start','remove']){
   result=await command({type:'chat-queue/v1',action,tabId,payload:{id:'unused'}});
   assert.equal(result.error,'forbidden-scope');
  }
  result=await command({type:'chat-queue/v1',action:'enqueue',tabId,payload:{text:'Synthetic external enqueue'}});
  assert.equal(result.ok,true);
  const itemId=result.id;
  await driver.wait(async()=>await driver.executeScript('return document.querySelector("#chat-queue-extension-root")?.shadowRoot?.getElementById("count")?.textContent==="1 queued"'),9000);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  assert.ok(!JSON.stringify(await command({type:'chat-queue/v1',action:'listTabs'})).includes('Synthetic external enqueue'));
  // Explicitly elevate the synthetic client for snapshot/edit acceptance.
  let readNonce=++nonce;
  await driver.executeScript('window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append","read","edit"]}}},"*")',readNonce,clientId);
  await driver.wait(async()=>await driver.executeScript('return window.__grantResults.some(x=>x.nonce===arguments[0])',readNonce),10000);
  // Verify the real Firefox event page rechecks persisted privileges even
  // if its grant-change event is intentionally delayed by the QA background.
  stage='silent-grant-revocation-of-private-status';
  const delayedStatusNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-api-request",nonce:arguments[0],request:{type:"chat-queue/v1",action:"status",tabId:arguments[1],payload:{qaHold:true}}},"*")',
    delayedStatusNonce,tabId);
  const silentRevokeNonce=++nonce;
  await driver.executeScript('window.postMessage({kind:"qa-grants-set-silent",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append"]}}},"*")',
    silentRevokeNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',silentRevokeNonce),9000);
  const silentAck=await driver.executeScript(
    'return window.__grantResults.find(x=>x.nonce===arguments[0]).result',silentRevokeNonce);
  assert.equal(silentAck.ok,true,'QA must commit revocation after the private response enters its hold');
  await driver.wait(async()=>await driver.executeScript(
    'return window.__apiResults.some(x=>x.nonce===arguments[0])',delayedStatusNonce),10000);
  const blockedPrivate=await driver.executeScript(
    'return window.__apiResults.find(x=>x.nonce===arguments[0]).result',delayedStatusNonce);
  assert.equal(blockedPrivate.error,'authorization-changed',
    'the stored grant, not only an already-delivered change event, must control disclosure');
  assert.equal(JSON.stringify(blockedPrivate).includes('Synthetic external enqueue'),false);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  // Restore the prior synthetic scopes before continuing the established
  // navigation, editing and final real Firefox revocation coverage.
  const restoreNonce=++nonce;
  await driver.executeScript('window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append","read","edit"]}}},"*")',
    restoreNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',restoreNonce),10000);
  assert.equal((await command({type:'chat-queue/v1',action:'status',tabId})).ok,true);
  stage='silent-revocation-while-last-url-read-waits';
  const lateStatusNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-api-request",nonce:arguments[0],request:{type:"chat-queue/v1",action:"status",tabId:arguments[1],payload:{qaHoldFinalUrl:true}}},"*")',
    lateStatusNonce,tabId);
  const lateRevokeNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set-silent",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append"]}}},"*")',
    lateRevokeNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',
    lateRevokeNonce),9000);
  assert.equal(await driver.executeScript(
    'return window.__grantResults.find(x=>x.nonce===arguments[0]).result.ok',
    lateRevokeNonce),true);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__apiResults.some(x=>x.nonce===arguments[0])',
    lateStatusNonce),10000);
  const withheldLate=await driver.executeScript(
    'return window.__apiResults.find(x=>x.nonce===arguments[0]).result',
    lateStatusNonce);
  assert.equal(withheldLate.error,'authorization-changed',
    'Last async URL lookup cannot bypass silent durable Read revocation');
  assert.equal(JSON.stringify(withheldLate).includes('Synthetic external enqueue'),false);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  const lateRestoreNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append","read","edit"]}}},"*")',
    lateRestoreNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',
    lateRestoreNonce),10000);
  assert.equal((await command({type:'chat-queue/v1',action:'status',tabId})).ok,true);
  stage='native-silent-append-revocation-before-forward';
  const staleAppendNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-api-request",nonce:arguments[0],request:{type:"chat-queue/v1",action:"enqueue",tabId:arguments[1],payload:{text:"Synthetic revoked Append must not enter queue",qaHoldInitial:true}}},"*")',
    staleAppendNonce,tabId);
  const revokeAppendNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set-silent",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","read","edit"]}}},"*")',
    revokeAppendNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',revokeAppendNonce),10000);
  const revokedAppendAck=await driver.executeScript(
    'return window.__grantResults.find(x=>x.nonce===arguments[0]).result',revokeAppendNonce);
  assert.equal(revokedAppendAck.ok,true);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__apiResults.some(x=>x.nonce===arguments[0])',staleAppendNonce),10000);
  const deniedAppend=await driver.executeScript(
    'return window.__apiResults.find(x=>x.nonce===arguments[0]).result',staleAppendNonce);
  assert.equal(deniedAppend.error,'authorization-changed');
  assert.equal(await driver.executeScript(
    'return document.querySelector("#chat-queue-extension-root").shadowRoot.getElementById("count").textContent'),
    '1 queued','revoked first-read Append cannot mutate the destination queue');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  const restoreAppendNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append","read","edit"]}}},"*")',
    restoreAppendNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',restoreAppendNonce),10000);
  stage='native-silent-append-revocation-during-tab-lookup';
  const delayedWriteNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-api-request",nonce:arguments[0],request:{type:"chat-queue/v1",action:"enqueue",tabId:arguments[1],payload:{text:"Synthetic late-revoked Append",qaHoldWriteUrl:true}}},"*")',
    delayedWriteNonce,tabId);
  const delayedRevokeNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set-silent",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","read","edit"]}}},"*")',
    delayedRevokeNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',
    delayedRevokeNonce),10000);
  assert.equal(await driver.executeScript(
    'return window.__grantResults.find(x=>x.nonce===arguments[0]).result.ok',
    delayedRevokeNonce),true);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__apiResults.some(x=>x.nonce===arguments[0])',
    delayedWriteNonce),10000);
  const withheldWrite=await driver.executeScript(
    'return window.__apiResults.find(x=>x.nonce===arguments[0]).result',
    delayedWriteNonce);
  assert.equal(withheldWrite.error,'authorization-changed',
    'Silently revoked Append must not cross the final URL lookup');
  assert.equal(await driver.executeScript(
    'return document.querySelector("#chat-queue-extension-root").shadowRoot.getElementById("count").textContent'),
    '1 queued','Late-revoked mutation must not alter queued prompts');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  const finalWriteRestoreNonce=++nonce;
  await driver.executeScript(
    'window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{[arguments[1]]:["discover","append","read","edit"]}}},"*")',
    finalWriteRestoreNonce,clientId);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',
    finalWriteRestoreNonce),10000);
  assert.equal((await command({type:'chat-queue/v1',action:'status',tabId})).ok,true);

  // The fallback must detect Firefox URL change events when History API updates the route.
  stage='scoped-rules-revocation';
  const scopedLibrary=await command({type:'chat-queue/v1',action:'rulesGet'});
  assert.equal(scopedLibrary.error,'forbidden-scope');
  const scopedWrite=await command({type:'chat-queue/v1',action:'rulesPut',
    payload:{revision:2,rules:[]}});
  assert.equal(scopedWrite.error,'forbidden-scope');
  const scopedPreview=await command({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[syntheticRule],signal:syntheticSignal}});
  assert.equal(scopedPreview.error,'forbidden-scope','Removing rules scope revokes preview');
  stage='pre-navigation-snapshot';
  const beforeNavigation=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.equal(beforeNavigation.ok,true);
  stage='pushState';
  await driver.executeScript('history.pushState({},"","/c/second")');
  await driver.wait(async()=>await driver.executeScript(
    'return document.querySelector("#chat-queue-extension-root")?.shadowRoot?.getElementById("count")?.textContent==="0 queued"'),10000);
  // The HUD updates before Firefox has necessarily delivered the new
  // registration to the background. Await the settled registry, not a race.
  const changed=await driver.wait(async()=>{
   const reply=await command({type:'chat-queue/v1',action:'listTabs'});
   return reply.ok&&reply.tabs.length===1&&reply.tabs[0].phase==='unknown' ? reply : false;
  },15000);
  assert.equal(changed.tabs[0].phase,'unknown');
  // Reopening the original route must recover its queue without enabling auto-send.
  stage='replaceState';
  await driver.executeScript('history.replaceState({},"","/c/synthetic")');
  await driver.wait(async()=>await driver.executeScript(
    'return document.querySelector("#chat-queue-extension-root")?.shadowRoot?.getElementById("count")?.textContent==="1 queued"'),10000);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  const returned=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.equal(returned.ok,true);
  assert.notEqual(returned.etag,beforeNavigation.etag,'route return must invalidate stale revision token');
  assert.equal((await command({type:'chat-queue/v1',action:'update',tabId,payload:{id:itemId,text:'Stale route overwrite',ifMatch:beforeNavigation.etag}})).error,'revision-conflict');
  // Check optimistic mutation tokens after route recovery.

  stage='optimistic-token-updates';
  const snapshot=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.equal(snapshot.ok,true);assert.equal(typeof snapshot.etag,'string');
  assert.equal(snapshot.items[0].text,'Synthetic external enqueue');
  result=await command({type:'chat-queue/v1',action:'update',tabId,payload:{id:itemId,text:'Wrong stale update',ifMatch:'old-token'}});
  assert.equal(result.error,'revision-conflict');
  result=await command({type:'chat-queue/v1',action:'update',tabId,payload:{id:itemId,text:'Synthetic updated message',ifMatch:snapshot.etag}});
  assert.equal(result.ok,true);
  result=await command({type:'chat-queue/v1',action:'update',tabId,payload:{id:itemId,text:'Duplicate stale update',ifMatch:snapshot.etag}});
  assert.equal(result.error,'revision-conflict');
  assert.equal((await command({type:'chat-queue/v1',action:'status',tabId})).items[0].text,'Synthetic updated message');
  stage='rejected-api-update-rollback';
  const beforeEditFailure=await command({type:'chat-queue/v1',action:'status',tabId});
  await driver.executeScript("document.documentElement.dataset.qaRejectQueueSet='once'");
  const failedEdit=await command({type:'chat-queue/v1',action:'update',tabId,
    payload:{id:itemId,text:'Must never survive a rejected save',ifMatch:beforeEditFailure.etag}});
  assert.equal(failedEdit.error,'queue-save-failed');
  const afterEditFailure=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.deepEqual(afterEditFailure.items,beforeEditFailure.items,
    'A rejected API update must not remain in memory');
  assert.notEqual(afterEditFailure.etag,beforeEditFailure.etag,
    'Rolling back a rejected mutation must invalidate its optimistic revision token');
  const recoveredEdit=await command({type:'chat-queue/v1',action:'update',tabId,
    payload:{id:itemId,text:'Synthetic updated message',ifMatch:afterEditFailure.etag}});
  assert.equal(recoveredEdit.ok,true,'A fresh explicit update must restore normal storage');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  // Approved clients must supply an exact permutation; invalid requests must
  // not modify the queue or permit a subsequent unintended Send.
  const second=await command({type:'chat-queue/v1',action:'enqueue',tabId,payload:{text:'Synthetic second item'}});
  assert.equal(second.ok,true);
  const orderOf=async()=> (await command({type:'chat-queue/v1',action:'status',tabId})).items.map(item=>item.id);
  assert.deepEqual(await orderOf(),[itemId,second.id]);
  for(const ids of [[itemId,itemId],[itemId],['foreign-id',second.id],null]){
    const bad=await command({type:'chat-queue/v1',action:'reorder',tabId,payload:{ids}});
    assert.equal(bad.error,'invalid-order');
    assert.deepEqual(await orderOf(),[itemId,second.id]);
  }
  assert.equal((await command({type:'chat-queue/v1',action:'reorder',tabId,payload:{ids:[second.id,itemId]}})).ok,true);
  assert.deepEqual(await orderOf(),[second.id,itemId]);
  assert.equal((await command({type:'chat-queue/v1',action:'move',tabId,payload:{id:itemId,beforeId:second.id}})).ok,true);
  assert.deepEqual(await orderOf(),[itemId,second.id]);
  for(const payload of [{id:'foreign-id',beforeId:second.id},{id:itemId,beforeId:'foreign-id'},{id:itemId,beforeId:itemId}]){
    assert.equal((await command({type:'chat-queue/v1',action:'move',tabId,payload})).error,'invalid-order');
    assert.deepEqual(await orderOf(),[itemId,second.id]);
  }
  assert.equal((await command({type:'chat-queue/v1',action:'remove',tabId,payload:{id:second.id}})).ok,true);
  assert.deepEqual(await orderOf(),[itemId]);
  stage='durable-sequenced-enqueue';
  const sequenced={type:'chat-queue/v1',action:'enqueueSequenced',tabId,
    payload:{text:'Single synthetic sequenced enqueue',sequence:1}};
  const once=await command(sequenced);
  assert.equal(once.ok,true);
  assert.equal((await command(sequenced)).error,'replayed-request');
  assert.equal((await command({...sequenced,payload:{...sequenced.payload,sequence:0}})).error,'invalid-request-sequence');
  assert.deepEqual((await command({type:'chat-queue/v1',action:'status',tabId})).items.map(x=>x.text),
    ['Synthetic updated message','Single synthetic sequenced enqueue']);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  // High-water marks survive a full content-script reload rather than relying
  // on the background event page's volatile in-memory state.
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript(
    "return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run'))&&document.documentElement.dataset.qaApiClientReady==='yes'"),12000);
  assert.equal((await command(sequenced)).error,'replayed-request');
  const nextSequence=await command({...sequenced,payload:{text:'Another synthetic sequenced enqueue',sequence:2}});
  assert.equal(nextSequence.ok,true);
  assert.equal((await command(sequenced)).error,'replayed-request');
  assert.deepEqual((await command({type:'chat-queue/v1',action:'status',tabId})).items.map(x=>x.text),
    ['Synthetic updated message','Single synthetic sequenced enqueue','Another synthetic sequenced enqueue']);
  assert.equal(await driver.executeScript('return window.__sent'),0);

  stage='failed-sequenced-write-and-exact-retry';
  const failedSequence={...sequenced,payload:{
    text:'Synthetic retriable queue write',sequence:3}};
  const beforeFailedWrite=await command({type:'chat-queue/v1',action:'status',tabId});
  await driver.executeScript("document.documentElement.dataset.qaRejectQueueSet='once'");
  const rejected=await command(failedSequence);
  assert.equal(rejected.error,'queue-save-failed');
  const afterRejected=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.deepEqual(afterRejected.items,beforeFailedWrite.items,
    'Rejected save must revert the prompt and replay watermark');
  const retried=await command(failedSequence);
  assert.equal(retried.ok,true,'The identical sequence must be eligible after failure');
  assert.equal((await command(failedSequence)).error,'replayed-request');
  assert.equal((await command({type:'chat-queue/v1',action:'status',tabId})).items.filter(
    x=>x.text==='Synthetic retriable queue write').length,1);
  assert.equal((await command({type:'chat-queue/v1',action:'remove',tabId,
    payload:{id:retried.id}})).ok,true);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  assert.equal((await command({type:'chat-queue/v1',action:'start',tabId})).error,'forbidden-scope');
  stage='concurrent-optimistic-api-edits';
  const raceSnapshot=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.equal(raceSnapshot.ok,true);
  const raceNonces=[++nonce,++nonce];
  const raceUpdates=['Synthetic concurrent A','Synthetic concurrent B'].map(text=>({
    type:'chat-queue/v1',action:'update',tabId,
    payload:{id:itemId,text,ifMatch:raceSnapshot.etag}
  }));
  await driver.executeScript((ids,requests)=>{
    requests.forEach((request,i)=>window.postMessage({
      kind:'qa-api-request',nonce:ids[i],request
    },'*'));
  },raceNonces,raceUpdates);
  await driver.wait(async()=>await driver.executeScript(
    'return arguments[0].every(id=>window.__apiResults.some(x=>x.nonce===id))',
    raceNonces),10000);
  const raceResults=await driver.executeScript(
    'return arguments[0].map(id=>window.__apiResults.find(x=>x.nonce===id).result)',
    raceNonces);
  assert.equal(raceResults.filter(x=>x.ok===true).length,1,
    'Only one concurrent same-revision edit may commit');
  assert.equal(raceResults.filter(x=>x.error==='revision-conflict').length,1,
    'The loser must fail closed with an explicit stale revision');
  const raceWinner=await command({type:'chat-queue/v1',action:'status',tabId});
  assert.ok(['Synthetic concurrent A','Synthetic concurrent B'].includes(
    raceWinner.items.find(x=>x.id===itemId).text));
  assert.equal(await driver.executeScript('return window.__sent'),0);
  result=await command({action:'subscribe'});assert.equal(result.ok,true);
  await driver.wait(async()=>{const s=await command({action:'portState'});return s.events.some(x=>x.event==='ready')},7000);
  const stream=await command({action:'portState'});
  assert.equal(stream.events.find(x=>x.event==='ready')?.protocolVersion,1);
  stage='native-firefox-metadata-ordering';
  // This test is a real Firefox internal content-script IPC round trip.
  // Bind state frames to the exact registration generation, as production
  // does, before challenging their ordering and stale-document safety.
  const generationNonce=++nonce;
  await driver.executeScript((id,message)=>
    window.postMessage({kind:'qa-meta-send',nonce:id,message},'*'),
    generationNonce,{type:'chat-queue-internal/v1',action:'register',
      route:'/c/synthetic',registrationVersion:2});
  await driver.wait(async()=>await driver.executeScript(
    'return window.__metadataResults.some(x=>x.nonce===arguments[0])',
    generationNonce),8000);
  const initialGeneration=await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.registrationGeneration',
    generationNonce);
  assert.ok(Number.isSafeInteger(initialGeneration),
    'versioned Firefox registration must return one private generation');
  const staleNonce=++nonce,latestNonce=++nonce;
  const oldState={type:'chat-queue-internal/v1',action:'state',
    sequence:100001,phase:'idle',running:false,awaiting:false,size:3,revision:100,
    registrationGeneration:initialGeneration};
  const newestState={...oldState,sequence:100002,phase:'generating',
    running:true,awaiting:true,revision:101};
  await driver.executeScript((a,b,m,n)=>{
    window.postMessage({kind:'qa-meta-send',nonce:a,message:m},'*');
    window.postMessage({kind:'qa-meta-send',nonce:b,message:n},'*');
  },staleNonce,latestNonce,oldState,newestState);
  await driver.wait(async()=>await driver.executeScript(
    'return [arguments[0],arguments[1]].every(id=>window.__metadataResults.some(x=>x.nonce===id))',
    staleNonce,latestNonce),12000);
  const staleResult=await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result',staleNonce);
  const newestResult=await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result',latestNonce);
  assert.equal(newestResult.ok,true,'latest metadata wins in Firefox');
  assert.equal(staleResult.error,'stale-state','delayed paused metadata must be rejected');
  const stateAfterRace=await command({type:'chat-queue/v1',action:'listTabs'});
  const entry=stateAfterRace.tabs.find(x=>x.tabId===tabId);
  assert.equal(entry.running,true);
  assert.equal(entry.awaiting,true);
  assert.equal(entry.phase,'generating');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  stage='native-firefox-re-registration-generation';
  const priorNonce=++nonce,registerNonce=++nonce;
  await driver.executeScript((id,message)=>{
    window.postMessage({kind:'qa-meta-send',nonce:id,message},'*');
  },priorNonce,{type:'chat-queue-internal/v1',action:'state',sequence:200001,
    phase:'idle',running:false,awaiting:false,size:3,revision:200});
  await driver.executeScript((id,message)=>{
    window.postMessage({kind:'qa-meta-send',nonce:id,message},'*');
  },registerNonce,{type:'chat-queue-internal/v1',action:'register',route:'/c/synthetic',registrationVersion:2});
  await driver.wait(async()=>await driver.executeScript(
    'return window.__metadataResults.some(x=>x.nonce===arguments[0])',
    registerNonce),8000);
  assert.equal(await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.ok',registerNonce),true);
  const successorGeneration=await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.registrationGeneration',
    registerNonce);
  assert.ok(Number.isSafeInteger(successorGeneration));
  assert.notEqual(successorGeneration,initialGeneration);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__metadataResults.some(x=>x.nonce===arguments[0])',
    priorNonce),10000);
  assert.equal(await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.error',priorNonce),
    'stale-state','older registration state must not affect newly registered tab');
  const newNonce=++nonce;
  await driver.executeScript((id,message)=>{
    window.postMessage({kind:'qa-meta-send',nonce:id,message},'*');
  },newNonce,{type:'chat-queue-internal/v1',action:'state',
    sequence:1,phase:'generating',running:true,awaiting:true,size:3,revision:201,
    registrationGeneration:successorGeneration});
  await driver.wait(async()=>await driver.executeScript(
    'return window.__metadataResults.some(x=>x.nonce===arguments[0])',
    newNonce),8000);
  assert.equal(await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.ok',
    newNonce),true);
  assert.equal((await command({type:'chat-queue/v1',action:'listTabs'})).tabs[0].running,true);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  // Unlike an already-pending callback, this OLD document state begins
  // AFTER successor registration; only its private generation can expose it.
  const lateNonce=++nonce;
  await driver.executeScript((id,message)=>
    window.postMessage({kind:'qa-meta-send',nonce:id,message},'*'),
    lateNonce,{type:'chat-queue-internal/v1',action:'state',sequence:999999,
      phase:'finished',running:false,awaiting:false,leasePending:false,
      registrationGeneration:initialGeneration});
  await driver.wait(async()=>await driver.executeScript(
    'return window.__metadataResults.some(x=>x.nonce===arguments[0])',
    lateNonce),8000);
  assert.equal(await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.error',
    lateNonce),'stale-registration',
    'late old-document frame cannot replace live state');
  assert.equal((await command({type:'chat-queue/v1',action:'listTabs'})).tabs[0].running,true);
  assert.equal(await driver.executeScript('return window.__sent'),0);

  stage='stale-forward-rejection-preserves-new-registration';
  const staleForwardNonce=++nonce;
  await driver.executeScript((id,target)=>{
    window.postMessage({kind:'qa-api-request',nonce:id,request:{
      type:'chat-queue/v1',action:'enqueue',tabId:target,
      payload:{text:'Synthetic old tab forward must fail',qaRejectOldForward:true}
    }},'*');
  },staleForwardNonce,tabId);
  const metaCommand=async message=>{
    const id=++nonce;
    await driver.executeScript((token,payload)=>
      window.postMessage({kind:'qa-meta-send',nonce:token,message:payload},'*'),
      id,message);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__metadataResults.some(x=>x.nonce===arguments[0])',id),9000);
    return driver.executeScript(
      'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result',id);
  };
  await driver.wait(async()=>(await metaCommand({
    type:'qa-old-forward-state'}))?.entered===true,8000,
    'Old API forwarding must enter deliberate fault hold');
  assert.equal((await metaCommand({type:'chat-queue-internal/v1',
    action:'register',route:'/c/synthetic'})).ok,true,
    'A real Firefox message must create a newer registration');
  assert.equal((await metaCommand({type:'chat-queue-internal/v1',
    action:'state',sequence:1,phase:'idle',size:3,running:false,awaiting:false})).ok,true);
  assert.equal((await metaCommand({type:'qa-old-forward-release'})).ok,true);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__apiResults.some(x=>x.nonce===arguments[0])',staleForwardNonce),9000);
  assert.equal(await driver.executeScript(
    'return window.__apiResults.find(x=>x.nonce===arguments[0]).result.error',
    staleForwardNonce),'tab-unavailable');
  const afterOldFailure=await command({type:'chat-queue/v1',action:'listTabs'});
  assert.equal(afterOldFailure.ok,true);
  assert.equal(afterOldFailure.tabs.length,1,'Old error must preserve fresh registration');
  assert.equal(afterOldFailure.tabs[0].tabId,tabId);
  assert.equal(afterOldFailure.tabs[0].phase,'idle');
  assert.equal((await command({type:'chat-queue/v1',action:'status',tabId})).ok,true);
  assert.equal(await driver.executeScript('return window.__sent'),0);

  stage='native-reload-stale-send-hold-release';
  const holdId='12345678-aaaa-4444-bbbb-111111111111';
  assert.equal((await metaCommand({type:'qa-seed-send-hold'})).ok,true);
  const oldReleaseNonce=++nonce;
  await driver.executeScript((i,token)=>
    window.postMessage({kind:'qa-meta-send',nonce:i,message:{
      type:'chat-queue-internal/v1',action:'release-send-hold',
      route:'/c/synthetic',holdId:token,qaHoldOldRelease:true
    }},'*'),oldReleaseNonce,holdId);
  await driver.wait(async()=>(await metaCommand({
    type:'qa-old-hold-state'}))?.entered===true,8000);
  assert.equal((await metaCommand({type:'chat-queue-internal/v1',
    action:'register',route:'/c/synthetic'})).ok,true);
  assert.equal((await metaCommand({type:'qa-old-hold-resume'})).ok,true);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__metadataResults.some(x=>x.nonce===arguments[0])',
    oldReleaseNonce),9000);
  assert.equal(await driver.executeScript(
    'return window.__metadataResults.find(x=>x.nonce===arguments[0]).result.error',
    oldReleaseNonce),'stale-registration',
    'A prior document must not clear a newer document durable Send hold');
  const held=await metaCommand({type:'chat-queue-internal/v1',
    action:'send-hold-status',route:'/c/synthetic'});
  assert.equal(held.held,true);
  assert.equal(held.holdId,holdId);
  assert.equal((await metaCommand({type:'chat-queue-internal/v1',
    action:'review-send-hold',route:'/c/synthetic',holdId,confirmed:true})).ok,true,
    'New registration retains the manual double-confirmed orphan recovery');
  assert.equal((await metaCommand({type:'chat-queue-internal/v1',
    action:'send-hold-status',route:'/c/synthetic'})).held,false);
  assert.equal(await driver.executeScript('return window.__sent'),0);
  stage='api-uncertain-item-resolution';
  const seedNonce=++nonce;
  await driver.executeScript('window.postMessage({kind:"qa-seed-uncertain",nonce:arguments[0]},"*")',seedNonce);
  await driver.wait(async()=>await driver.executeScript(
    'return window.__grantResults.some(x=>x.nonce===arguments[0])',seedNonce),10000);
  assert.equal(await driver.executeScript(
    'return window.__grantResults.find(x=>x.nonce===arguments[0]).result.ok',seedNonce),true);
  await driver.executeScript('history.pushState({},"","/c/api-uncertain")');
  await driver.wait(async()=>await driver.executeScript(
    "return document.querySelector('#chat-queue-extension-root')?.shadowRoot?.querySelectorAll('.item.uncertain').length===1"),12000);
  const uncertainStatus=await driver.wait(async()=>{
    const current=await command({type:'chat-queue/v1',action:'status',tabId});
    return current.ok&&current.items.length===1&&current.items[0].status==='uncertain'?current:false;
  },12000);
  const uncertainId=uncertainStatus.items[0].id;
  for(const [action,payload] of [
    ['update',{id:uncertainId,text:'Synthetic forbidden rewrite'}],
    ['remove',{id:uncertainId}],
    ['clear',null]
  ]){
    const answer=await command({type:'chat-queue/v1',action,tabId,payload});
    assert.equal(answer.error,'resolve-uncertain-message',
      'Generic '+action+' must not discard evidence of a possibly sent prompt');
    const unchanged=await command({type:'chat-queue/v1',action:'status',tabId});
    assert.deepEqual(unchanged.items,uncertainStatus.items);
  }
  assert.equal((await command({type:'chat-queue/v1',action:'resolve',tabId,
    payload:{id:uncertainId,decision:'discard'}})).ok,true);
  assert.deepEqual((await command({type:'chat-queue/v1',action:'status',tabId})).items,[]);
  await driver.executeScript('history.pushState({},"","/c/synthetic")');
  await driver.wait(async()=>await driver.executeScript(
    "return document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('count')?.textContent==='3 queued'"),12000);
  assert.equal(await driver.executeScript('return window.__sent'),0);

  stage='grant-revocation';
  const grantNonce=++nonce;
  await driver.executeScript('window.postMessage({kind:"qa-grants-set",nonce:arguments[0],policy:{version:2,grants:{}}},"*")',grantNonce);
  await driver.wait(async()=>await driver.executeScript('return window.__grantResults.some(x=>x.nonce===arguments[0])',grantNonce),10000);
  const ack=await driver.executeScript('return window.__grantResults.find(x=>x.nonce===arguments[0]).result',grantNonce);
  assert.equal(ack.ok,true);
  await driver.wait(async()=>{const s=await command({action:'portState'});return s.disconnected===true},7000);
  result=await command({type:'chat-queue/v1',action:'listTabs'});
  assert.equal(result.error,'unauthorized');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  stage='peer-extension-unload';
  await driver.uninstallAddon(clientId);
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript(
    'return Boolean(document.querySelector("#chat-queue-extension-root")?.shadowRoot?.getElementById("run"))'
  ),12000);
  assert.notEqual(await driver.executeScript(
    "return document.documentElement.dataset.qaApiClientReady"),'yes',
    'Uninstalled peer must not reinstall a content-script API bridge');
  assert.equal(await driver.executeScript(
    "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent"),
    '3 queued','Client removal must not erase the destination queue');
  assert.equal(await driver.executeScript('return window.__sent'),0);
  console.log('FDE scoped API: concurrent CAS, bounded replay, peer unload, revocation and no Send');
 }catch(error){
  throw new Error('FDE API stage '+stage+': '+error.message);
 }finally{
  if(driver)await driver.quit();
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(base,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error('FDE API fixture failed:',e.message);process.exitCode=1});
