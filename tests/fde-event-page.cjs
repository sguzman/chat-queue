'use strict';
// Native Firefox Developer Edition MV3 event-page suspension/restart probe.
// Production scripts with localhost/accelerated-heartbeat substitutions only.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

const page='<!doctype html><html><body><main><form>'+
  '<div id="prompt-textarea" contenteditable="true" style="display:block;min-height:44px;width:280px"></div>'+
  '<button type="button" data-testid="send-button" onclick="window.__sent++">Send</button>'+
  '</form></main><script>window.__sent=0;window.__bootReplies=[];window.__signalReplies=[];window.__holdReplies=[];window.__holdReadReplies=[];'+
  'window.addEventListener("message",e=>{if(e.data?.kind==="qa-boot-reply")window.__bootReplies.push(e.data);'+
  'if(e.data?.kind==="qa-hold-reply")window.__holdReplies.push(e.data);'+
  'if(e.data?.kind==="qa-hold-read-reply")window.__holdReadReplies.push(e.data);'+
  'if(e.data?.kind==="qa-signal-reply")window.__signalReplies.push(e.data)})</script>'+
  '</body></html>';

async function main(){
 const binary=process.env.FDE_BINARY;
 if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
   throw Error('FDE_BINARY must identify Firefox Developer Edition');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-event-page-'));
 const providerRoot=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-idle-provider-'));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-two-phase-profile-'));
 const queueUrl=()=>`http://127.0.0.1:${server.address().port}/c/real-event-page`;
 const src=path.resolve(__dirname,'..');
 const server=http.createServer((_req,res)=>{
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);
 });
 let driver,stage='setup';
 try{
   const manifest=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'),'utf8'));
   manifest.browser_specific_settings.gecko.id='chat-queue-eventpage-qa@sguzman.github';
   manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
   manifest.content_scripts[0].js.push('qa-monitor.js');
   manifest.background.scripts.unshift('qa-startup.js');
   fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
   fs.mkdirSync(path.join(root,'src'));
   fs.cpSync(path.join(src,'options'),path.join(root,'options'),{recursive:true});
   for(const file of ['core.js','signal.js','grants.js','rules.js','rule-store.js','content.js','background.js'])
     fs.copyFileSync(path.join(src,'src',file),path.join(root,'src',file));
   let bg=fs.readFileSync(path.join(root,'src/background.js'),'utf8');
   const originLine=bg.split('\n').find(x=>x.includes('sender.url || tab.url')&&x.includes('chatgpt'));
   assert.ok(originLine,'Expected production origin guard');
   bg=bg.replace(originLine,"    if (!(sender.url || tab.url || '').startsWith('http://127.0.0.1:')) return;");
   const oldNav="!change.url.startsWith('https://chatgpt.com/')";
   assert.equal(bg.split(oldNav).length,2);
   bg=bg.replace(oldNav,"!change.url.startsWith('http://127.0.0.1:')");
   fs.writeFileSync(path.join(root,'src/background.js'),bg);
   let content=fs.readFileSync(path.join(root,'src/content.js'),'utf8');
   const closed="attachShadow({mode:'closed'})";
   assert.equal(content.split(closed).length,2);
   content=content.replace(closed,"attachShadow({mode:'open'})");
   // Observe only that a publisher resync was requested after real
   // event-page recovery; there is deliberately no provider in this test.
   // QA-only metadata for completed registration, no private queue content.
   content=content.replace(
     'if(answer?.ok&&state.key===key&&routeKey()===route&&!state.destroyed){',
     "document.documentElement.dataset.qaRecoveryRegistration=String(answer?.ok===true);"+
     "if(answer?.ok&&state.key===key&&routeKey()===route&&!state.destroyed){");
   const initialRegistered='state.tabId=response.tabId;';
   assert.equal(content.split(initialRegistered).length,2);
   content=content.replace(initialRegistered,
     initialRegistered+"document.documentElement.dataset.qaInitialRegistration='true';");
   const resyncMarker='  function requestVerifiedProvider(){';
   assert.equal(content.split(resyncMarker).length,2);
   content=content.replace(resyncMarker,resyncMarker+
     "\n    document.documentElement.dataset.qaProviderSyncCount=String("+
     "Number(document.documentElement.dataset.qaProviderSyncCount||0)+1);");
   const heartbeat='const REGISTRY_HEARTBEAT_TICKS=60;';
   assert.equal(content.split(heartbeat).length,2);
   content=content.replace(heartbeat,'const REGISTRY_HEARTBEAT_TICKS=2;');
   fs.writeFileSync(path.join(root,'src/content.js'),content);
   // QA-only counter increments whenever the ACTUAL event page is created.
   fs.writeFileSync(path.join(root,'qa-startup.js'),[
     "void browser.storage.local.get('qa:eventpage-boot-count').then(v=>",
     "browser.storage.local.set({'qa:eventpage-boot-count':",
     "(v['qa:eventpage-boot-count']||0)+1}));"
   ].join(''));
   fs.writeFileSync(path.join(root,'qa-monitor.js'),[
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-boot-read')return;",
     "const nonce=event.data.nonce;",
     "browser.storage.local.get('qa:eventpage-boot-count').then(v=>",
     "window.postMessage({kind:'qa-boot-reply',nonce,",
     "count:v['qa:eventpage-boot-count']||0},'*'));",
     "});",
     // Seed only a metadata-only already-unresolved Send from a synthetic
     // earlier tab, before forcing genuine idle suspension. No prompt text.
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-seed-send-hold')return;",
     "const nonce=event.data.nonce;",
     "browser.storage.local.set({'chatqueue:send-hold:v1:real-event-page':{",
     "version:1,tabId:999,route:'/c/real-event-page',",
     "holdId:'12345678-aaaa-4444-bbbb-555555555555'}})",
     ".then(()=>window.postMessage({kind:'qa-hold-reply',nonce,ok:true},'*'))",
     ".catch(()=>window.postMessage({kind:'qa-hold-reply',nonce,ok:false},'*'));",
     "});",
     // Read browser-local hold metadata without waking or depending on the
     // event page's volatile registration. This makes the persistence check
     // independent of the separate authenticated arbitration acceptance.
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-hold-read')return;",
     "const nonce=event.data.nonce;",
     "browser.storage.local.get('chatqueue:send-hold:v1:real-event-page')",
     ".then(v=>window.postMessage({kind:'qa-hold-read-reply',nonce,",
     "record:v['chatqueue:send-hold:v1:real-event-page']||null},'*'))",
     ".catch(()=>window.postMessage({kind:'qa-hold-read-reply',nonce,record:null},'*'));",
     "});"
   ].join(''));
   // Minimal genuine SECOND add-on that authenticates as Chat Signals.
   // It never reads Queue storage or accesses the production ChatGPT origin.
   const providerId='chat-signals@sguzman.github';
   fs.writeFileSync(path.join(providerRoot,'manifest.json'),JSON.stringify({
     manifest_version:3,name:'Synthetic Signal idle QA',version:'1.0',
     browser_specific_settings:{gecko:{id:providerId}},
     background:{scripts:['background.js']},
     content_scripts:[{matches:['http://127.0.0.1/*'],
       js:['content.js'],run_at:'document_idle'}]
   }));
   fs.writeFileSync(path.join(providerRoot,'background.js'),`
     browser.runtime.onMessage.addListener((message,sender)=>{
       if(message?.type!=='qa-signal'||!Number.isInteger(sender.tab?.id))return;
       return browser.runtime.sendMessage('chat-queue-eventpage-qa@sguzman.github',{
         type:'chat-queue-signal/v1',tabId:sender.tab.id,signal:message.signal});
     });`);
   fs.writeFileSync(path.join(providerRoot,'content.js'),`
     document.documentElement.dataset.qaProviderReady='true';
     window.addEventListener('message',event=>{
       if(event.source!==window||event.data?.kind!=='qa-signal')return;
       const signal=event.data.signal;
       browser.runtime.sendMessage({type:'qa-signal',signal})
         .then(result=>window.postMessage({kind:'qa-signal-reply',
           sequence:signal.sequence,result},'*'))
         .catch(()=>window.postMessage({kind:'qa-signal-reply',
           sequence:signal.sequence,result:{ok:false}},'*'));
     });`);
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   // Two independent FDE sessions reuse only this disposable, dedicated QA
   // profile: the first proves genuine event-page idle with the saved hold,
   // the second returns to a normal background lifetime for stable Signal
   // registration. Never touch the user's existing Firefox profile.
   const build=idle=>new Builder().forBrowser('firefox').setFirefoxOptions(
     new firefox.Options().setBinary(binary)
       .addArguments('-headless','-profile',profile)
       .setPreference('xpinstall.signatures.required',false)
       .setPreference('extensions.background.idle.timeout',idle)).build();
   driver=await build(2);
   const installed=await driver.installAddon(root,true);
   assert.equal(installed,manifest.browser_specific_settings.gecko.id);
   await driver.get('http://127.0.0.1:'+server.address().port+'/c/real-event-page');
   stage='queue-registration';
   await driver.wait(async()=>await driver.executeScript(
     "return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run'))"),15000);
   await driver.executeScript(
     "const d=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft');"+
     "d.value='Synthetic retained across actual event-page idle';");
   await driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').click()");
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='1 queued'"),8000);
   let nonce=0;
   const readBoot=async()=>{
     const id=++nonce;
     await driver.executeScript('window.postMessage({kind:"qa-boot-read",nonce:arguments[0]},"*")',id);
     await driver.wait(async()=>await driver.executeScript(
       'return window.__bootReplies.some(x=>x.nonce===arguments[0])',id),4000);
     return driver.executeScript(
       'return window.__bootReplies.find(x=>x.nonce===arguments[0]).count',id);
   };
   // Install an orphan metadata-only hold BEFORE the actual Firefox event
   // page suspends. This is not a simulated background restart or a prompt
   // journal copied into privileged storage.
   stage='seed-persisted-hold';
   const seededId=++nonce;
   await driver.executeScript(
     'window.postMessage({kind:"qa-seed-send-hold",nonce:arguments[0]},"*")',seededId);
   await driver.wait(async()=>await driver.executeScript(
     'return window.__holdReplies.some(x=>x.nonce===arguments[0])',seededId),5000);
   assert.equal(await driver.executeScript(
     'return window.__holdReplies.find(x=>x.nonce===arguments[0]).ok',seededId),true);
   const readHold=async()=>{
     const id=++nonce;
     await driver.executeScript(
       'window.postMessage({kind:"qa-hold-read",nonce:arguments[0]},"*")',id);
     await driver.wait(async()=>await driver.executeScript(
       'return window.__holdReadReplies.some(x=>x.nonce===arguments[0])',id),5000);
     return driver.executeScript(
       'return window.__holdReadReplies.find(x=>x.nonce===arguments[0]).record',id);
   };
   const expectedHold={version:1,tabId:999,route:'/c/real-event-page',
     holdId:'12345678-aaaa-4444-bbbb-555555555555'};
   assert.deepEqual(await readHold(),expectedHold);
   stage='actual-event-page-idle';
   const initialResync=await driver.executeScript(
     "return Number(document.documentElement.dataset.qaProviderSyncCount||0)");
   assert.ok(initialResync>=1,'Initial assigned-route provider sync must occur');
   const before=await readBoot();
   assert.ok(before>=1,'Background must have started');
   const restarted=await driver.wait(async()=>{
     const count=await readBoot();
     return count>before?count:false;
   },47000,'Firefox event page did not suspend/reinstantiate during idle');
   assert.ok(restarted>before);
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('Signal registry restarted')"),9000);
   await driver.wait(async()=>await driver.executeScript(
     "return Number(document.documentElement.dataset.qaProviderSyncCount||0)>arguments[0]",
     initialResync),6500,'Queue did not re-request verified publisher state after event-page recovery');
   assert.equal(await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent"),'1 queued');
   assert.equal(await driver.executeScript('return window.__sent'),0);
   // The browser actually destroyed and recreated its event page above.
   // Only assert metadata durability here: the deliberately forced two-second
   // idle policy can race live tab re-registration, which is NOT authenticated
   // hold-denial acceptance. A separate FDE suite tests hold arbitration.
   stage='persisted-hold-after-actual-idle';
   assert.deepEqual(await readHold(),expectedHold);
   assert.equal(await driver.executeScript('return window.__sent'),0);
   await driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('run').click()");
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('authenticated-chat-signals-required')"),6000);
   assert.equal(await driver.executeScript('return window.__sent'),0);
   console.log('FDE real event-page restarts:',before,'to',restarted,
     '; metadata-only hold survives idle, queue preserved, no Send');

   // Browser teardown ends phase one. The temporary test add-on is
   // deliberately reinstalled by the same fixed ID in the next session.
   // Its fixed-ID add-on and storage must survive in this SAME disk profile.
   stage='normal-lifetime-restart';
   await driver.quit();driver=null;
   driver=await build(120);
   assert.equal(await driver.installAddon(root,true),installed,
     'The identical Queue temporary extension must reinstall in the same profile');
   const providerInstalled=await driver.installAddon(providerRoot,true);
   assert.equal(providerInstalled,providerId);
   await driver.get(queueUrl());
   stage='restored-addon-and-tab-registration';
   await driver.wait(async()=>await driver.executeScript(
     "return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run')) && document.documentElement.dataset.qaProviderReady==='true'"),18000);
   // Initial production registration must complete BEFORE publishing an
   // authenticated Signal. Do not use a page-script registration bypass.
   await driver.wait(async()=>await driver.executeScript(
     "return document.documentElement.dataset.qaInitialRegistration==='true'"),9000,
     'The actual content script never completed its initial registration');
   const secondSessionBoot=await readBoot();
   // In this second browser session, the Queue and independently installed
   // provider identify themselves via actual Firefox extension principals.
   // A browser page cannot send an authenticated provider envelope directly.
   const fresh={version:1,route:'/c/real-event-page',
     documentToken:'fedcba9876543210fedcba9876543210',
     sequence:1,epoch:0,phase:'idle',origin:'fresh',confidence:'observed'};
   await driver.executeScript(
     'window.postMessage({kind:"qa-signal",signal:arguments[0]},"*")',fresh);
   try{
     await driver.wait(async()=>await driver.executeScript(
       'return window.__signalReplies.some(x=>x.sequence===1 && x.result?.ok===true)'),12000,
       'Registered synthetic provider could not authenticate a new idle epoch');
   }catch(error){
     // Fixed-schema fixture diagnostics only: no queue contents, transcript,
     // extension storage, browser profile, or user data in public CI output.
     const diagnostic=await driver.executeScript(() => ({
       replies:window.__signalReplies.map(x=>({
         sequence:x.sequence,ok:x.result?.ok,error:x.result?.error||null})),
       queueMounted:Boolean(document.querySelector('#chat-queue-extension-root')),
       queueStatus:document.querySelector('#chat-queue-extension-root')?.shadowRoot
         ?.getElementById('status')?.textContent?.slice(0,120)||null,
       providerReady:document.documentElement.dataset.qaProviderReady||null,
       initialRegistered:document.documentElement.dataset.qaInitialRegistration||null,
       recoveryRegistered:document.documentElement.dataset.qaRecoveryRegistration||null
     }));
     throw new Error(error.message+'; boot='+secondSessionBoot+
       '→'+await readBoot()+'; '+JSON.stringify(diagnostic));
   }
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('Signal: idle •')"),8000);
   assert.deepEqual(await readHold(),expectedHold,
     'Unresolved hold must survive the entire browser restart in the same profile');
   const count=await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent");
   if(count==='0 queued'){
     await driver.executeScript(
       "const d=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft');d.value='Synthetic second-session competing message';");
     await driver.executeScript(
       "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').click()");
     await driver.wait(async()=>await driver.executeScript(
       "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='1 queued'"),8000);
   }else assert.equal(count,'1 queued');
   stage='authenticated-competing-tab-denied';
   await driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('run').click()");
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('Previous Send may be unresolved; review its hold')"),9000);
   assert.equal(await driver.executeScript('return window.__sent'),0);
   assert.deepEqual(await readHold(),expectedHold);
   const clickReview=()=>driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('hold-review').click()");
   stage='manual-review-across-browser-lifetime';
   await clickReview();
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('Check the ChatGPT transcript')"),9000);
   assert.deepEqual(await readHold(),expectedHold,
     'A first review click is not permission to release the hold');
   await clickReview();
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('Prior Send hold released')"),9000);
   assert.equal(await readHold(),null);
   assert.equal(await driver.executeScript('return window.__sent'),0,
     'Review does not retry or resume Send');
   console.log('FDE two-phase same-profile hold denied with authenticated provider; explicit review did not Send');
   await driver.uninstallAddon(providerInstalled);
   await driver.uninstallAddon(installed);
 }catch(error){
   throw new Error(stage+': '+error.message);
 }finally{
   if(driver)await driver.quit();
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(root,{recursive:true,force:true});
   fs.rmSync(providerRoot,{recursive:true,force:true});
   fs.rmSync(profile,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error('FDE event-page QA failed:',error.message);process.exitCode=1});
