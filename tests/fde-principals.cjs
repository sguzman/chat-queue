'use strict';
// Separate unapproved Firefox extension attempts to read queued prompts and
// spoof Chat Signals; production queue backend and closed HUD remain intact.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

const queueId='chat-queue-principal-qa@sguzman.github';
const intruderId='unapproved-queue-principal-qa@sguzman.github';
const SECRET='Synthetic private queue item withheld from unapproved extension';
const html='<!doctype html><html><body><main><form>'+
  '<div id="prompt-textarea" contenteditable="true"></div>'+
  '<button type="button" data-testid="send-button" onclick="window.__sends++">Send</button>'+
  '</form></main><script>window.__sends=0;window.__seedReady=false;window.__attacks=[];'+
  'window.addEventListener("message",e=>{if(e.data?.kind==="qa-seed-ready")window.__seedReady=true;'+
  'if(e.data?.kind==="qa-attack-result")window.__attacks.push(e.data.result)})</script>'+
  '</body></html>';

async function main(){
 const binary=process.env.FDE_BINARY;
 if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
   throw Error('FDE_BINARY must be Firefox Developer Edition');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-unapproved-'));
 const queue=path.join(dir,'queue'),intruder=path.join(dir,'intruder');
 fs.mkdirSync(queue);fs.mkdirSync(intruder);
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)});
 let driver,stage='setup';
 try{
   const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
   manifest.browser_specific_settings.gecko.id=queueId;
   manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
   manifest.content_scripts[0].js.push('qa-seed.js');
   fs.writeFileSync(path.join(queue,'manifest.json'),JSON.stringify(manifest));
   fs.cpSync(path.join(root,'src'),path.join(queue,'src'),{recursive:true});
   fs.cpSync(path.join(root,'options'),path.join(queue,'options'),{recursive:true});
   let bg=fs.readFileSync(path.join(queue,'src/background.js'),'utf8');
   const originLine=bg.split('\n').find(line=>line.includes('sender.url || tab.url')&&line.includes('chatgpt'));
   assert.ok(originLine);
   bg=bg.replace(originLine,"    if (!(sender.url || tab.url || '').startsWith('http://127.0.0.1:')) return;");
   const nav="!change.url.startsWith('https://chatgpt.com/')";
   assert.equal(bg.split(nav).length,2);
   bg=bg.replace(nav,"!change.url.startsWith('http://127.0.0.1:')");
   fs.writeFileSync(path.join(queue,'src/background.js'),bg);
   const content=fs.readFileSync(path.join(queue,'src/content.js'),'utf8');
   assert.ok(content.includes("attachShadow({mode:'closed'})"));
   fs.writeFileSync(path.join(queue,'qa-seed.js'),[
     'const qaPrivateText='+JSON.stringify(SECRET)+';',
     'void (async()=>{',
     "const route='/c/private-principal';",
     "const response=await browser.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route,registrationVersion:2});",
     'if(!response?.ok)return;',
     "const key='chatqueue:v1:tab:'+response.tabId+':'+route;",
     'await browser.storage.local.set({[key]:{version:1,items:[{id:"qa-private-message",text:qaPrivateText,status:"pending"}]}});',
     "window.postMessage({kind:'qa-seed-ready'},'*');",
     '})();'
   ].join('\n'));
   const maliciousManifest={
     manifest_version:3,name:'Synthetic unapproved principal',version:'1.0',
     permissions:['tabs','storage'],
     browser_specific_settings:{gecko:{id:intruderId}},
     background:{scripts:['background.js']},
     content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js'],run_at:'document_idle'}]
   };
   fs.writeFileSync(path.join(intruder,'manifest.json'),JSON.stringify(maliciousManifest));
   fs.writeFileSync(path.join(intruder,'background.js'),[
     "browser.runtime.onMessage.addListener(async request=>{",
     "if(request?.type!=='qa-external-attack')return;",
     "const tabs=await browser.tabs.query({active:true,currentWindow:true});",
     "const tabId=tabs.find(tab=>tab.url?.startsWith('http://127.0.0.1:'))?.id;",
     "if(!Number.isInteger(tabId))return {ok:false,error:'target-not-visible'};",
     "const target="+JSON.stringify(queueId)+";",
     "const read=await browser.runtime.sendMessage(target,{type:'chat-queue/v1',action:'status',tabId});",
     "const signal=await browser.runtime.sendMessage(target,{type:'chat-queue-signal/v1',tabId,signal:{version:1,route:'/c/private-principal',documentToken:'a'.repeat(32),sequence:1,epoch:1,phase:'finished',origin:'fresh',confidence:'observed'}});",
     "const owned=await browser.storage.local.get(null);",
     "return {ok:true,read,signal,privateStorageLeak:JSON.stringify(owned).includes("+JSON.stringify(SECRET)+")};",
     "});"
   ].join('\n'));
   fs.writeFileSync(path.join(intruder,'content.js'),[
     "window.addEventListener('message',event=>{",
     "if(event.source!==window||event.data?.kind!=='qa-attack-now')return;",
     "browser.runtime.sendMessage({type:'qa-external-attack'})",
     ".then(result=>window.postMessage({kind:'qa-attack-result',result},'*'))",
     ".catch(()=>window.postMessage({kind:'qa-attack-result',result:{ok:false,error:'transport'}},'*'));",
     "});"
   ].join('\n'));
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   driver=await new Builder().forBrowser('firefox').setFirefoxOptions(
     new firefox.Options().setBinary(binary).addArguments('-headless')).build();
   assert.equal(await driver.installAddon(queue,true),queueId);
   assert.equal(await driver.installAddon(intruder,true),intruderId);
   await driver.get('http://127.0.0.1:'+server.address().port+'/c/private-principal');
   stage='queue-private-storage';
   await driver.wait(async()=>await driver.executeScript('return window.__seedReady===true'),15000);
   await driver.navigate().refresh();
   await driver.wait(async()=>await driver.executeScript('return window.__seedReady===true'),15000);
   assert.equal(await driver.executeScript(
     "return document.getElementById('chat-queue-extension-root')?.shadowRoot"),null);
   assert.equal(await driver.executeScript(
     'return document.body.innerText.includes(arguments[0])',SECRET),false);
   assert.equal(await driver.executeScript('return window.__sends'),0);
   stage='unapproved-principal';
   await driver.executeScript('window.postMessage({kind:"qa-attack-now"},"*")');
   await driver.wait(async()=>await driver.executeScript('return window.__attacks.length===1'),9000);
   const result=await driver.executeScript('return window.__attacks[0]');
   assert.equal(result.ok,true);
   assert.equal(result.read.ok,false);
   assert.equal(result.read.error,'unauthorized');
   assert.equal(result.signal.ok,false);
   assert.equal(result.signal.error,'not-signal-provider');
   assert.equal(result.privateStorageLeak,false);
   assert.equal(JSON.stringify(result).includes(SECRET),false);
   assert.equal(await driver.executeScript('return window.__sends'),0);
   await driver.uninstallAddon(intruderId);
   assert.equal(await driver.executeScript('return window.__sends'),0);
   console.log('FDE unapproved principal: no private prompt read, no provider impersonation, no Send');
   await driver.uninstallAddon(queueId);
 }catch(error){
   throw new Error(stage+': '+error.message);
 }finally{
   if(driver)await driver.quit();
   await new Promise(resolve=>server.close(resolve));
   fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error('FDE unauthorized principal QA failed:',error.message);process.exitCode=1});
