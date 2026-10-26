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
  '</form></main><script>window.__sent=0;window.__bootReplies=[];window.__signalReplies=[];window.__holdReplies=[];'+
  'window.addEventListener("message",e=>{if(e.data?.kind==="qa-boot-reply")window.__bootReplies.push(e.data);'+
  'if(e.data?.kind==="qa-hold-reply")window.__holdReplies.push(e.data);'+
  'if(e.data?.kind==="qa-signal-reply")window.__signalReplies.push(e.data)})</script>'+
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
   const heartbeat='const REGISTRY_HEARTBEAT_TICKS=60;';
   assert.equal(content.split(heartbeat).length,2);
   content=content.replace(heartbeat,'const REGISTRY_HEARTBEAT_TICKS=2;');
   // Only accelerate detection of a genuine idle restart. The contender
   // stage should use the production heartbeat interval instead of causing
   // artificial provider invalidation every two seconds.
   const watchCheck='++heartbeatTicks>=REGISTRY_HEARTBEAT_TICKS';
   assert.equal(content.split(watchCheck).length,2);
   content=content.replace(watchCheck,
     "++heartbeatTicks>=(localStorage.getItem('__qaHeartbeatNormal')==='yes'?60:REGISTRY_HEARTBEAT_TICKS)");
   fs.writeFileSync(path.join(root,'src/content.js'),content);
   // QA-only counter increments whenever the ACTUAL event page is created.
   fs.writeFileSync(path.join(root,'qa-startup.js'),[
     "void browser.storage.local.get('qa:eventpage-boot-count').then(v=>",
     "browser.storage.local.set({'qa:eventpage-boot-count':",
     "(v['qa:eventpage-boot-count']||0)+1}));",
     "browser.runtime.onMessage.addListener((message,sender)=>{",
     "if(message?.type==='qa-keepalive'&&",
     "String(sender.url||sender.tab?.url||'').startsWith('http://127.0.0.1:'))return Promise.resolve({ok:true});",
     "});"
   ].join(''));
   fs.writeFileSync(path.join(root,'qa-monitor.js'),[
     "let qaKeepaliveTimer=null;",
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-keepalive')return;",
     "if(event.data.active!==true){clearInterval(qaKeepaliveTimer);qaKeepaliveTimer=null;return;}",
     "if(qaKeepaliveTimer!==null)return;",
     "const pulse=()=>{",
     "void browser.runtime.sendMessage({type:'qa-keepalive'}).then(reply=>{",
     "if(reply?.ok)document.documentElement.dataset.qaKeepaliveAcks=String(",
     "Number(document.documentElement.dataset.qaKeepaliveAcks||0)+1);",
     "}).catch(()=>{});",
     "};",
     "pulse();qaKeepaliveTimer=setInterval(pulse,250);",
     "});",
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
     .setPreference('extensions.background.idle.timeout',1);
   driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
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
   await driver.executeScript(
     "document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('run').click()");
   await driver.wait(async()=>await driver.executeScript(
     "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent.includes('authenticated-chat-signals-required')"),6000);
   assert.equal(await driver.executeScript('return window.__sent'),0);
   console.log('FDE real event-page restarts:',before,'to',restarted,
     '; queue preserved and Send denied');
   // Now isolate the *durable hold* claim: it must persist through another
   // genuine idle termination and refuse a SECOND tab whose independent,
   // browser-attested Signal is fresh. Missing-provider denial is not enough.
   stage='seed-metadata-only-hold-before-idle';
   const seedNonce=++nonce;
   await driver.executeScript(
     'window.postMessage({kind:"qa-seed-send-hold",nonce:arguments[0]},"*")',seedNonce);
   await driver.wait(async()=>await driver.executeScript(
     'return window.__holdReplies.some(x=>x.nonce===arguments[0])',seedNonce),7000);
   assert.equal(await driver.executeScript(
     'return window.__holdReplies.find(x=>x.nonce===arguments[0]).ok',seedNonce),true);
   const heldBoot=await readBoot();
   stage='hold-survives-real-event-page-idle';
   const heldRestart=await driver.wait(async()=>{
     const count=await readBoot();
     return count>heldBoot?count:false;
   },47000,'Firefox event page did not suspend while durable hold was persisted');
   assert.ok(heldRestart>heldBoot);
   await driver.executeScript(
     "localStorage.setItem('__qaHeartbeatNormal','yes');document.documentElement.dataset.qaNormalHeartbeat='true'");
   // The event-page restart has already been observed. Keep the CURRENT tab
   // connected before installing a second add-on and opening a new tab: with
   // a 1-second synthetic idle timeout it could otherwise suspend midway
   // through the contender's first Queue registration.
   await driver.executeScript(
     'window.postMessage({kind:"qa-keepalive",active:true},"*")');
   await driver.wait(async()=>await driver.executeScript(
     'return Number(document.documentElement.dataset.qaKeepaliveAcks||0)>=2'),9000,
     'Original tab did not establish QA keepalive after true idle');
   stage='authenticated-contender-refused-after-idle';
   const installedProvider=await driver.installAddon(providerRoot,true);
   assert.equal(installedProvider,'chat-signals@sguzman.github');
   await driver.switchTo().newWindow('tab');
   await driver.get('http://127.0.0.1:'+server.address().port+'/c/real-event-page');
   const hud=id=>"document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('"+id+"')";
   await driver.wait(async()=>await driver.executeScript(
     `return Boolean(${hud('run')})&&document.documentElement.dataset.qaProviderReady==='true'`),14000);
   // The contender is a NEW document; the first tab's QA heartbeat flag
   // does not propagate into it. Avoid spurious synthetic 2-second registry
   // invalidation during the independently authenticated Send probe.
   await driver.executeScript(
     "localStorage.setItem('__qaHeartbeatNormal','yes');document.documentElement.dataset.qaNormalHeartbeat='true'");
   await driver.executeScript(
     `const d=${hud('draft')};d.value='Synthetic contender after real event-page idle';`);
   await driver.executeScript(`return ${hud('add')}.click()`);
   await driver.wait(async()=>await driver.executeScript(
     `return ${hud('count')}.textContent==='1 queued'`),9000);
   let signalSequence=0;
   const emitIdle=async()=>{
     // Firefox's deliberately one-second QA idle policy may terminate an
     // event page between a newly created tab's initial register and its
     // provider callback. A tab-not-registered reply is NOT an authenticated
     // Signal; reload the QA tab to perform a fresh real registration rather
     // than treating a stale publisher event as dispatch authority.
     for(let attempt=0;attempt<4;attempt++){
       const sequence=++signalSequence;
       const signal={version:1,documentToken:'b'.repeat(32),
         route:'/c/real-event-page',epoch:0,sequence,phase:'idle',
         origin:'fresh',confidence:'observed'};
       await driver.executeScript(
         'window.postMessage({kind:"qa-signal",signal:arguments[0]},"*")',signal);
       await driver.wait(async()=>await driver.executeScript(
         'return window.__signalReplies.some(x=>x.sequence===arguments[0])',sequence),9000);
       const ack=await driver.executeScript(
         'return window.__signalReplies.find(x=>x.sequence===arguments[0]).result',sequence);
       if(ack?.ok){
         await driver.wait(async()=>await driver.executeScript(
           `return ${hud('status')}.textContent.includes('Signal: idle')`),8000);
         return;
       }
       assert.equal(ack?.error,'tab-not-registered',
         'unexpected denial from independent authenticated publisher');
       await driver.navigate().refresh();
       await driver.wait(async()=>await driver.executeScript(
         `return Boolean(${hud('run')})&&document.documentElement.dataset.qaProviderReady==='true'`),14000);
       await driver.wait(async()=>await driver.executeScript(
         `return ${hud('count')}.textContent==='1 queued'`),9000);
       await driver.executeScript(
         'window.postMessage({kind:"qa-keepalive",active:true},"*")');
       await driver.wait(async()=>await driver.executeScript(
         'return Number(document.documentElement.dataset.qaKeepaliveAcks||0)>=2'),9000);
     }
     throw Error('No fresh authenticated Signal after bounded tab re-registration');
   };
   // Only AFTER proving a true idle suspension, keep the QA event page
   // awake during this separate publisher-authorized dispatch arbitration.
   await driver.executeScript(
     'window.postMessage({kind:"qa-keepalive",active:true},"*")');
   await driver.wait(async()=>await driver.executeScript(
     'return Number(document.documentElement.dataset.qaKeepaliveAcks||0)>=2'),9000,
     'QA background keepalive did not acknowledge at least two heartbeats');
   await emitIdle();
   await driver.executeScript(`return ${hud('run')}.click()`);
   await driver.wait(async()=>await driver.executeScript(
     `return ${hud('status')}.textContent.includes('Previous Send may be unresolved; review its hold')`),12000);
   assert.equal(await driver.executeScript('return window.__sent'),0,
     'a truly suspended-and-restarted event page must enforce persisted hold');
   stage='explicit-review-unlocks-new-start-after-idle';
   await driver.executeScript(`return ${hud('hold-review')}.click()`);
   await driver.wait(async()=>await driver.executeScript(
     `return ${hud('status')}.textContent.includes('Check the ChatGPT transcript')`),9000);
   await driver.executeScript(`return ${hud('hold-review')}.click()`);
   await driver.wait(async()=>await driver.executeScript(
     `return ${hud('status')}.textContent.includes('Prior Send hold released')`),9000);
   assert.equal(await driver.executeScript('return window.__sent'),0,
     'review is not an automatic retry');
   await emitIdle();
   await driver.executeScript(`return ${hud('run')}.click()`);
   await driver.wait(async()=>await driver.executeScript(
     'return window.__sent===1'),12000);
   assert.equal(await driver.executeScript('return window.__sent'),1,
     'only an explicit new Start is authorized after review');
   await driver.executeScript(
     'window.postMessage({kind:"qa-keepalive",active:false},"*")');
   console.log('FDE real event-page idle with metadata Send hold:',heldBoot,
     'to',heldRestart,'; authenticated competing Send refused until explicit review');
   await driver.uninstallAddon(installedProvider);
   await driver.uninstallAddon(installed);
 }catch(error){
   let diagnosis='';
   if(driver){
     try{diagnosis=JSON.stringify(await driver.executeScript(() => ({
       hud:document.querySelector('#chat-queue-extension-root')?.shadowRoot
         ?.getElementById('status')?.textContent?.slice(-175)||null,
       count:document.querySelector('#chat-queue-extension-root')?.shadowRoot
         ?.getElementById('count')?.textContent||null,
       sent:window.__sent??null,
       publisherReady:document.documentElement.dataset.qaProviderReady||null,
       signalAcks:window.__signalReplies?.map(x=>({
         sequence:x.sequence,ok:x.result?.ok,error:x.result?.error}))||[]
     })));}catch{}
   }
   throw new Error(stage+': '+error.message+(diagnosis?' meta='+diagnosis:''));
 }finally{
   if(driver)await driver.quit();
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(root,{recursive:true,force:true});
   fs.rmSync(providerRoot,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error('FDE event-page QA failed:',error.message);process.exitCode=1});
