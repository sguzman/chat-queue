'use strict';
// Read-only coexistence acceptance with REAL pinned Chat Signals sources.
// This uses localhost-only QA manifests and does not access authenticated ChatGPT.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

const page=`<!doctype html><html><head><meta charset="utf-8"><title>Chat Queue Coexistence Fixture</title></head>
<body><main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button">Send</button></form></main>
<script>window.__sendCount=0;document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>window.__sendCount++)</script>
</body></html>`;
const hud=id=>`document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById(${JSON.stringify(id)})`;
function stageQueue(dir,root){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  manifest.browser_specific_settings.gecko.id='chat-queue-coexist-qa@sguzman.github';
  manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  fs.cpSync(path.join(root,'options'),path.join(dir,'options'),{recursive:true});
  const cp=path.join(dir,'src/content.js');
  const before=fs.readFileSync(cp,'utf8'),needle="attachShadow({mode:'closed'})";
  assert.equal(before.split(needle).length,2,'Queue Shadow DOM QA override must match exactly one call');
  fs.writeFileSync(cp,before.replace(needle,"attachShadow({mode:'open'})"));
  const bp=path.join(dir,'src/background.js');
  let bg=fs.readFileSync(bp,'utf8');
  const origin=String.raw`if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;`;
  const qaOrigin=String.raw`if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url || tab.url || '')) return;`;
  assert.equal(bg.split(origin).length,2,'Queue background origin QA override must match exactly one call');
  bg=bg.replace(origin,qaOrigin);
  const nav="!change.url.startsWith('https://chatgpt.com/')";
  assert.equal(bg.split(nav).length,2);
  bg=bg.replace(nav,"!change.url.startsWith('http://127.0.0.1:')");
  fs.writeFileSync(bp,bg);
  return manifest.browser_specific_settings.gecko.id;
}
function stageSignals(dir,root){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.id,'chat-signals@sguzman.github',
    'Pinned actual Chat Signals identity must not be replaced with a mock');
  assert.equal(manifest.version,'0.3.13','Review upstream changes before updating pinned Chat Signals');
  manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  if(fs.existsSync(path.join(root,'icons')))fs.cpSync(path.join(root,'icons'),path.join(dir,'icons'),{recursive:true});
  return manifest.browser_specific_settings.gecko.id;
}
async function main(){
  const binary=process.env.FDE_BINARY;
  const signals=process.env.CHAT_SIGNALS_SOURCE;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY required');
  if(!signals||!path.isAbsolute(signals)||!fs.existsSync(path.join(signals,'manifest.json')))
    throw Error('CHAT_SIGNALS_SOURCE must point to the pinned checked-out real Chat Signals source');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-coexist-'));
  const qdir=path.join(temp,'queue'),sdir=path.join(temp,'signals');
  fs.mkdirSync(qdir);fs.mkdirSync(sdir);
  const queueId=stageQueue(qdir,path.resolve(__dirname,'..'));
  const signalId=stageSignals(sdir,signals);
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page)});
  let driver;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    driver=await new Builder().forBrowser('firefox')
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments('-headless')).build();
    assert.equal(await driver.installAddon(qdir,true),queueId);
    assert.equal(await driver.installAddon(sdir,true),signalId);
    await driver.get(`http://127.0.0.1:${server.address().port}/c/real-signals`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('run')}) &&
      document.documentElement.hasAttribute('data-chat-signals-state')`),20000);
    const phase=await driver.executeScript('return document.documentElement.dataset.chatSignalsState');
    assert.match(phase,/^(idle|submitted|generating|verifying|finished|interrupted|failed|limit|unknown)$/);
    const input=await driver.executeScript(`return ${hud('draft')}`);
    await input.sendKeys('Harmless synthetic coexistence prompt');
    await (await driver.executeScript(`return ${hud('add')}`)).click();
    await (await driver.executeScript(`return ${hud('run')}`)).click();
    await driver.wait(async()=>await driver.executeScript(`return ${hud('status')}.textContent.includes('authenticated-chat-signals-required')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Real Chat Signals v0.3.13 has no authenticated publisher; Queue must refuse Send');
    // Page-origin spoofing must not become trusted, even alongside the real extension.
    await driver.executeScript("document.documentElement.dataset.chatSignalsState='finished'");
    await (await driver.executeScript(`return ${hud('run')}`)).click();
    await driver.wait(async()=>await driver.executeScript(`return ${hud('status')}.textContent.includes('authenticated-chat-signals-required')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.uninstallAddon(signalId);
    await driver.uninstallAddon(queueId);
    console.log('Actual pinned Chat Signals v0.3.13 coexists in synthetic FDE; DOM-only status cannot authorize queued Send');
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE real Chat Signals coexistence failed:',error.message);process.exitCode=1});