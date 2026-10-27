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
  '</form></main><script>window.__sent=0;window.__bootReplies=[];window.__signalReplies=[];window.__holdReplies=[];window.__holdReadReplies=[];window.__probeReplies=[];window.__readyReplies=[];'+
  'window.addEventListener("message",e=>{if(e.data?.kind==="qa-boot-reply")window.__bootReplies.push(e.data);'+
  'if(e.data?.kind==="qa-hold-reply")window.__holdReplies.push(e.data);'+
  'if(e.data?.kind==="qa-hold-read-reply")window.__holdReadReplies.push(e.data);'+
  'if(e.data?.kind==="qa-signal-reply")window.__signalReplies.push(e.data);'+
  'if(e.data?.kind==="qa-probe-reply")window.__probeReplies.push(e.data);'+
  'if(e.data?.kind==="qa-ready-reply")window.__readyReplies.push(e.data)})</script>'+
  '</body></html>';

async function main(){
 const binary=process.env.FDE_BINARY;
 if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
   throw Error('FDE_BINARY must identify Firefox Developer Edition');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-event-page-'));
 const providerRoot=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-idle-provider-'));
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
   const resyncMarker='  function requestVerifiedProvider(){';
   assert.equal(content.split(resyncMarker).length,2);
   content=content.replace(resyncMarker,resyncMarker+
     "\n    document.documentElement.dataset.qaProviderSyncCount=String("+
     "Number(document.documentElement.dataset.qaProviderSyncCount||0)+1);");
   // Observe the exact production hold-denial status even if the intentionally
   // accelerated idle timer subsequently overwrites the visible HUD note.
   // No prompt, conversation transcript or arbitrary status text is exposed.
   const statusNote="  function statusNote(message) { state.note = message; render();publish(); }";
   assert.equal(content.split(statusNote).length,2);
   content=content.replace(statusNote,
     "  function statusNote(message) {"+
     "if(message==='Previous Send may be unresolved; review its hold')"+
     "document.documentElement.dataset.qaHoldDenied='true';"+
     "if(message==='Signal authority lost; no Send attempted')"+
     "document.documentElement.dataset.qaAuthorityLost='true';"+
     "state.note=message;render();publish();}");
   const heartbeat='const REGISTRY_HEARTBEAT_TICKS=60;';
   assert.equal(content.split(heartbeat).length,2);
   content=content.replace(heartbeat,'const REGISTRY_HEARTBEAT_TICKS=36;');
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
     "});",
     // QA-only direct probe of production Send arbitration, never a
     // Send grant or page-accessible production IPC action.
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-hold-probe')return;",
     "const nonce=event.data.nonce;",
     "browser.runtime.sendMessage({type:'chat-queue-internal/v1',",
     "action:'dispatch-check',route:'/c/real-event-page',",
     "documentToken:'fedcba9876543210fedcba9876543210',",
     "epoch:0,sequence:1,stage:'probe'})",
     ".then(result=>window.postMessage({kind:'qa-probe-reply',nonce,",
     "result:{ok:result?.ok===true,error:result?.error||null}},'*'))",
     ".catch(()=>window.postMessage({kind:'qa-probe-reply',nonce,",
     "result:{ok:false,error:'probe-ipc-unavailable'}},'*'));",
     "});",
     // Metadata-only inspection of the actual production route registry.
     // It cannot forge registration, a trusted Signal, or Send permission.
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-registry-ready')return;",
     "const nonce=event.data.nonce;",
     "const type='chat-queue-internal/v1',route='/c/real-event-page';",
     "browser.runtime.sendMessage({type,action:'sync-provider',route})",
     ".then(async result=>{",
     "if(result?.ok)return result;",
     // A newly recreated background has lost its volatile registry. Exercise
     // the same production register action as ordinary content startup, then
     // independently require the production sync-provider route check to pass.
     // No synthetic background state, forged Signals or QA-only keepalive.
     "const registered=await browser.runtime.sendMessage({type,action:'register',route,registrationVersion:2});",
     "if(!registered?.ok)return registered;",
     "return browser.runtime.sendMessage({type,action:'sync-provider',route,registrationGeneration:registered.registrationGeneration});",
     "})",
     ".then(result=>window.postMessage({kind:'qa-ready-reply',nonce,",
     "ok:result?.ok===true},'*'))",
     ".catch(()=>window.postMessage({kind:'qa-ready-reply',nonce,ok:false},'*'));",
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
   const options=new firefox.Options().setBinary(binary).addArguments('-headless')
     .setPreference('extensions.background.idle.timeout',20);
   driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
   const installed=await driver.installAddon(root,true);
   assert.equal(installed,manifest.browser_specific_settings.gecko.id);
   await driver.get('http://127.0.0.1:'+server.address().port+'/c/real-event-page');
   stage='queue-registration';
   try{
     await driver.wait(async()=>await driver.executeScript(
       "return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run'))"),15000);
   }catch{
     // Synthetic localhost only: distinguish injection from registration
     // with boolean-only evidence, never private URLs, prompts or account data.
     const marker=await driver.executeScript(()=>{
       const host=document.querySelector('#chat-queue-extension-root');
       return {hostMounted:Boolean(host),shadowAvailable:Boolean(host?.shadowRoot),
         runButton:Boolean(host?.shadowRoot?.getElementById('run')),
         docReady:document.readyState};
     }).catch(()=>({browserUnavailable:true}));
     throw Error('queue registration not ready: '+JSON.stringify(marker));
   }
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
   // Only assert metadata durability here: the deliberately forced twenty-second
   // idle policy can race live tab re-registration, which is NOT authenticated
   // hold-denial acceptance. A separate FDE suite tests hold arbitration.
   stage='persisted-hold-after-actual-idle';
   assert.deepEqual(await readHold(),expectedHold);
   assert.equal(await driver.executeScript('return window.__sent'),0);
   await driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('run').click()");
   // The Start resync is bounded by a separate four-second timer. Firefox
   // event-page reactivation can overlap this wait and replace its status
   // text with a newer registry message. This test's guarantee is no Send
   // and a persisted hold, NOT a precise transient error string. The real
   // publisher suite checks authenticated Start error semantics separately.
   await driver.sleep(5500);
   const afterStart=await driver.executeScript(() => {
     const status=document.querySelector('#chat-queue-extension-root')
       .shadowRoot.getElementById('status').textContent;
     return {status,sent:window.__sent};
   });
   assert.equal(afterStart.sent,0,'Restarted event page must not dispatch a prompt');
   assert.match(afterStart.status,/ • Paused • /,
     'Without authenticated publisher, no Start may remain running');
   assert.deepEqual(await readHold(),expectedHold,
     'Restarted event page must not clear unresolved durable Send metadata');
   console.log('FDE real event-page restarts:',before,'to',restarted,
     '; metadata-only hold survives idle, queue preserved, no Send');

   // The previous page's event page ACTUALLY restarted, and the unresolved
   // metadata-only hold is intact. A new browser tab now registers independently
   // against the restarted background. The provider is a different real Firefox
   // extension principal, never a page-origin forged Signal.
   stage='new-competing-tab-after-actual-idle';
   const providerInstalled=await driver.installAddon(providerRoot,true);
   assert.equal(providerInstalled,providerId);
   await driver.switchTo().newWindow('tab');
   await driver.get('http://127.0.0.1:'+server.address().port+'/c/real-event-page');
   await driver.wait(async()=>await driver.executeScript(
     "return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run')) && document.documentElement.dataset.qaProviderReady==='true'"),18000);
   await driver.executeScript(
     "const d=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft');"+
     "d.value='Synthetic competing tab after real event-page idle';");
   await driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').click()");
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='1 queued' && !document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('backup-export').disabled"),8000);
   // The HUD can mount before its asynchronous Firefox tab registration
   // completes; the restarted event page can also lose the registry. Check
   // real, exact-route registration before publishing the separate provider.
   // At most two actual page reloads reattempt native content registration.
   stage='competing-tab-production-registration';
   let registered=false;
   for(let attempt=0;attempt<3&&!registered;attempt++){
     if(attempt){
       await driver.navigate().refresh();
       await driver.wait(async()=>await driver.executeScript(
         "return Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('run')) && document.documentElement.dataset.qaProviderReady==='true' && document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='1 queued'"),15000);
     }
     const id=++nonce;
     await driver.executeScript(
       'window.postMessage({kind:"qa-registry-ready",nonce:arguments[0]},"*")',id);
     await driver.wait(async()=>await driver.executeScript(
       'return window.__readyReplies.some(x=>x.nonce===arguments[0])',id),5000);
     registered=await driver.executeScript(
       'return window.__readyReplies.find(x=>x.nonce===arguments[0]).ok',id);
   }
   assert.equal(registered,true,
     'Real Queue route registry absent after bounded native tab recovery');
   const fresh={version:1,route:'/c/real-event-page',
     documentToken:'fedcba9876543210fedcba9876543210',
     sequence:1,epoch:0,phase:'idle',origin:'fresh',confidence:'observed'};
   stage='authenticated-competing-tab-fail-closed';
   // Publish a fresh idle Signal and invoke the HUD's actual Start after
   // Firefox authenticates its independent extension principal. Under this
   // deliberately extreme idle timeout, another genuine event-page restart
   // may revoke that authority BEFORE hold arbitration. Either loss of
   // authority or the persisted hold must block Send.
   const result=await driver.executeAsyncScript(
     `const signal=arguments[0],done=arguments[arguments.length-1];
     const listener=event=>{
       if(event.source!==window||event.data?.kind!=='qa-signal-reply'||
          event.data.sequence!==signal.sequence)return;
       window.removeEventListener('message',listener);
       const reply=event.data.result;
       if(reply?.ok){
         // The real provider is acknowledged before probing the production
         // arbiter; no WebDriver interprocess latency before the probe.
         window.postMessage({kind:'qa-hold-probe',nonce:7},'*');
         document.querySelector('#chat-queue-extension-root').shadowRoot
           .getElementById('run').click();
       }
       done(reply);
     };
     window.addEventListener('message',listener);
     window.postMessage({kind:'qa-signal',signal},'*');`,fresh);
   if(result?.ok){
     assert.equal(result?.ok,true,
       'A newly registered tab must receive an authenticated idle provider event: '+String(result?.error||'unknown'));
     stage='direct-persisted-arbitration-after-real-idle';
     await driver.wait(async()=>await driver.executeScript(
       'return window.__probeReplies.some(x=>x.nonce===7)'),6500,
       'QA content-script arbitration probe never returned');
     const probe=await driver.executeScript(
       'return window.__probeReplies.find(x=>x.nonce===7).result');
     assert.deepEqual(probe,{ok:false,error:'unresolved-durable-send'},
       'Fresh authenticated competing Send must be rejected specifically because of the persisted hold');
     stage='authenticated-competing-tab-fail-closed';
     try{
       await driver.wait(async()=>await driver.executeScript(
         "return document.documentElement.dataset.qaHoldDenied==='true' || document.documentElement.dataset.qaAuthorityLost==='true'"),8000);
     }catch(error){
       const diagnostic=await driver.executeScript(() => ({
         queueStatus:document.querySelector('#chat-queue-extension-root')?.shadowRoot
           ?.getElementById('status')?.textContent?.slice(0,160)||null,
         providerReplies:window.__signalReplies.map(x=>({
           sequence:x.sequence,ok:x.result?.ok,error:x.result?.error||null})),
         sent:window.__sent,
         holdDenied:document.documentElement.dataset.qaHoldDenied||null,
         authorityLost:document.documentElement.dataset.qaAuthorityLost||null,
         queued:document.querySelector('#chat-queue-extension-root')?.shadowRoot
           ?.getElementById('count')?.textContent||null
       }));
       throw Error(error.message+'; '+JSON.stringify(diagnostic));
     }
     const blocked=await driver.executeScript(() => ({
       hold:document.documentElement.dataset.qaHoldDenied==='true',
       authority:document.documentElement.dataset.qaAuthorityLost==='true'
     }));
     assert.ok(blocked.hold||blocked.authority,
       'A new tab must fail closed after real idle even with a fresh Signal');
     assert.equal(await driver.executeScript('return window.__sent'),0,
       'The independently authenticated new tab must never Send past an unresolved hold');
     assert.deepEqual(await readHold(),expectedHold,
       'An authenticated denied Send must leave the original hold unchanged');
     console.log('FDE new tab after actual idle: authenticated persisted Send-hold probe denied;',
       'HUD failed closed with',blocked.hold?'saved-hold-denial':'revoked-authority',
       '; zero Sends');
   }else{
     // The extreme MV3 idle probe can re-suspend the event page even after
     // successful real registration. This is NOT accepted hold arbitration:
     // only the separate saved-hold + zero-Send invariants are verified.
     assert.equal(result?.error,'tab-not-registered',
       'Only genuine lost Firefox registration may skip a fresh-epoch hold probe');
     assert.equal(await driver.executeScript('return window.__sent'),0,
       'No Send is permitted without Firefox-verified provider registration');
     assert.deepEqual(await readHold(),expectedHold,
       'The unresolved durable hold must survive a second registry loss');
     assert.equal(await driver.executeScript(
       "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent"),'1 queued');
     console.log('FDE post-idle provider unavailable: tab-not-registered; zero Sends;',
       'durable hold intact; exact hold arbitration NOT exercised in this run');
   }
   await driver.uninstallAddon(providerInstalled);
   await driver.uninstallAddon(installed);
 }catch(error){
   throw new Error(stage+': '+error.message);
 }finally{
   if(driver)await driver.quit();
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(root,{recursive:true,force:true});
   fs.rmSync(providerRoot,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error('FDE event-page QA failed:',error.message);process.exitCode=1});
