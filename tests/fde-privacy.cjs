'use strict';
// Production closed-shadow and content-script isolation in disposable FDE.
// This does not test malicious privileged extensions or authenticated ChatGPT.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const SECRET='Synthetic queue-only prompt never rendered into page text';
const page=`<!doctype html><html><head><meta charset="utf-8"><title>Privacy fixture</title></head>
<body><main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button" onclick="window.__sends++">Send</button></form></main>
<script>window.__sends=0</script></body></html>`;
async function main(){
 const binary=process.env.FDE_BINARY;
 if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
   throw Error('FDE_BINARY must be Firefox Developer Edition');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-private-shadow-'));
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((req,res)=>{
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);
 });
 let driver=null;
 try{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  manifest.browser_specific_settings.gecko.id='chat-queue-privacy-qa@sguzman.github';
  manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
  manifest.background.scripts=['qa-background.js'];
  fs.writeFileSync(path.join(base,'manifest.json'),JSON.stringify(manifest));
  fs.mkdirSync(path.join(base,'src'));
  for(const file of ['core.js','signal.js','rules.js','rule-store.js','content.js']){
    const source=fs.readFileSync(path.join(root,'src',file),'utf8');
    if(file==='content.js')assert.ok(source.includes("attachShadow({mode:'closed'})"),
      'Privacy QA must keep the production closed shadow, not override it');
    fs.writeFileSync(path.join(base,'src',file),source);
  }
  fs.writeFileSync(path.join(base,'qa-background.js'),`
    browser.runtime.onMessage.addListener((message,sender)=>{
      if(message?.type!=='chat-queue-internal/v1')return;
      if(message.action==='register'){
        const key='chatqueue:v1:tab:'+sender.tab.id+':'+message.route;
        const saved={version:1,items:[{id:'synthetic-private-id',
          text:${JSON.stringify(SECRET)},status:'pending'}]};
        return browser.storage.local.set({[key]:saved})
          .then(()=>({ok:true,tabId:sender.tab.id}));
      }
      if(message.action==='state')return Promise.resolve({ok:true});
      return Promise.resolve({ok:false,error:'qa-denied'});
    });`);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  driver=await new Builder().forBrowser('firefox').setFirefoxOptions(
    new firefox.Options().setBinary(binary).addArguments('-headless')).build();
  const id=await driver.installAddon(base,true);
  await driver.get(`http://127.0.0.1:${server.address().port}/c/synthetic-private`);
  await driver.wait(async()=>await driver.executeScript(
    'return Boolean(document.getElementById("chat-queue-extension-root"))'),15000);
  const before=await driver.executeScript((secret)=>{
    const host=document.getElementById('chat-queue-extension-root');
    return {
      closed:host.shadowRoot===null,
      hostText:host.textContent.includes(secret),
      pageText:document.body.innerText.includes(secret),
      serialized:document.documentElement.outerHTML.includes(secret),
      extraTextarea:document.querySelectorAll('textarea').length,
      pageCore:typeof window.ChatQueueCore,
      pageSignal:typeof window.ChatQueueSignal,
      sends:window.__sends
    };
  },SECRET);
  assert.deepEqual(before,{
    closed:true,hostText:false,pageText:false,serialized:false,
    extraTextarea:0,pageCore:'undefined',pageSignal:'undefined',sends:0
  });
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript(
    'return Boolean(document.getElementById("chat-queue-extension-root"))'),12000);
  assert.equal(await driver.executeScript(
    'return document.getElementById("chat-queue-extension-root").shadowRoot'),null);
  assert.equal(await driver.executeScript('return window.__sends'),0);
  await driver.uninstallAddon(id);
  console.log('FDE privacy: real closed Shadow DOM, no page-text exposure, isolated modules, no Send');
 }finally{
  if(driver)await driver.quit();
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(base,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error('FDE privacy QA failed:',error.message);process.exitCode=1});
