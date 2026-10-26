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
     .setPreference('extensions.background.idle.timeout',2);
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
