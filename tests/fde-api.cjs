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
<script>window.__sent=0;window.__apiResults=[];window.__grantResults=[];
window.addEventListener('message',e=>{if(e.data?.kind==='qa-api-response')window.__apiResults.push(e.data);if(e.data?.kind==='qa-grants-ack')window.__grantResults.push(e.data)});
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
 fs.writeFileSync(contentFile,content.replace(marker,"attachShadow({mode:'open'})"));
 const bgFile=path.join(dest,'src/background.js');
 let bg=fs.readFileSync(bgFile,'utf8');
 const before=String.raw`if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;`;
 const after=String.raw`if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url || tab.url || '')) return;`;
 assert.equal(bg.split(before).length,2);
 bg=bg.replace(before,after);
 const nav="!change.url.startsWith('https://chatgpt.com/')";
 assert.equal(bg.split(nav).length,2);
 bg=bg.replace(nav,"!change.url.startsWith('http://127.0.0.1:')");
 fs.writeFileSync(bgFile,bg);
 // QA-only bootstrap and permission update handler. Production extension
 // remains unchanged; it receives genuine browser.storage.local writes.
 fs.writeFileSync(path.join(dest,'qa-grants-background.js'),`
 browser.storage.local.set({[${JSON.stringify(grantsKey)}]:${JSON.stringify(initialPolicy)}});
 browser.runtime.onMessage.addListener((msg,sender)=>{
   if(msg?.type!=='qa-grants-update'||!sender.tab||!sender.url?.startsWith('http://127.0.0.1:'))return;
   return browser.storage.local.set({[${JSON.stringify(grantsKey)}]:msg.policy}).then(()=>({ok:true}));
 });`);
 fs.writeFileSync(path.join(dest,'qa-grants-content.js'),`
 window.addEventListener('message',event=>{
  if(event.source!==window||event.data?.kind!=='qa-grants-set')return;
  const {nonce,policy}=event.data;
  browser.runtime.sendMessage({type:'qa-grants-update',policy})
    .then(result=>window.postMessage({kind:'qa-grants-ack',nonce,result},'*'))
    .catch(()=>window.postMessage({kind:'qa-grants-ack',nonce,result:{ok:false}},'*'));
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
  // The fallback must detect Firefox URL change events when History API updates the route.
  stage='scoped-rules-revocation';
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
  console.log('FDE scoped API: rules preview, grant revocation, optimistic edits, SPA routing and no Send');
 }catch(error){
  throw new Error('FDE API stage '+stage+': '+error.message);
 }finally{
  if(driver)await driver.quit();
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(base,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error('FDE API fixture failed:',e.message);process.exitCode=1});
