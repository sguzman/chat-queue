'use strict';
// Disposable REAL Firefox Developer Edition test of the extension-origin
// isolated input. This test neither visits nor authenticates with ChatGPT.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {Builder,By,Key}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const root=path.resolve(__dirname,'..');
const page=`<!doctype html><html><body>
<main><form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
<button type="button" data-testid="send-button" onclick="window.__sent++">Send</button></form></main>
<textarea id="synthetic-clipboard-source"></textarea>
<script>window.__sent=0;window.__sitePaste=0;window.__siteKeys=0;
window.__hostilePaste=(e)=>{window.__sitePaste++;document.getElementById('prompt-textarea').focus();e.preventDefault()};
window.__hostileKey=(e)=>{window.__siteKeys++;document.getElementById('prompt-textarea').focus()};
window.__activateHostile=()=>{document.addEventListener('paste',window.__hostilePaste,true);
document.addEventListener('keydown',window.__hostileKey,true)};
</script></body></html>`;
async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
    throw Error('FDE_BINARY must identify Firefox Developer Edition');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cq-frame-qa-'));
  const server=http.createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);
  });
  let driver,stage='init';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const hostOrigin='http://127.0.0.1:'+server.address().port;
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
    manifest.browser_specific_settings.gecko.id='cq-private-frame-qa@sguzman.github';
    manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
    manifest.web_accessible_resources[0].matches=['http://127.0.0.1/*'];
    manifest.background.scripts=['qa-background.js'];
    fs.writeFileSync(path.join(scratch,'manifest.json'),JSON.stringify(manifest));
    for(const dir of ['src','ui'])fs.mkdirSync(path.join(scratch,dir));
    for(const js of manifest.content_scripts[0].js)
      fs.copyFileSync(path.join(root,js),path.join(scratch,js));
    fs.copyFileSync(path.join(root,'ui/draft.html'),path.join(scratch,'ui/draft.html'));
    let frameSource=fs.readFileSync(path.join(root,'ui/draft.js'),'utf8');
    assert.equal(frameSource.split("event.origin!=='https://chatgpt.com'").length,2);
    frameSource=frameSource.replace("event.origin!=='https://chatgpt.com'",
      "event.origin!=="+JSON.stringify(hostOrigin));
    fs.writeFileSync(path.join(scratch,'ui/draft.js'),frameSource);
    let script=fs.readFileSync(path.join(scratch,'src/content.js'),'utf8');
    assert.equal(script.split("const isolatedDraft = location.origin==='https://chatgpt.com';").length,2);
    script=script.replace("const isolatedDraft = location.origin==='https://chatgpt.com';",
      'const isolatedDraft = true;');
    assert.equal(script.split("attachShadow({mode:'closed'})").length,2);
    script=script.replace("attachShadow({mode:'closed'})","attachShadow({mode:'open'})");
    fs.writeFileSync(path.join(scratch,'src/content.js'),script);
    fs.writeFileSync(path.join(scratch,'qa-background.js'),`
      browser.runtime.onMessage.addListener((message,sender)=>{
        if(message?.type!=='chat-queue-internal/v1')return;
        if(message.action==='register')return Promise.resolve({
          ok:true,tabId:sender.tab.id,registrationGeneration:crypto.randomUUID()});
        if(message.action==='state')return Promise.resolve({ok:true});
        return Promise.resolve({ok:false,error:'disconnected-qa-provider'});
      });`);
    stage='launch';
    driver=await new Builder().forBrowser('firefox').setFirefoxOptions(
      new firefox.Options().setBinary(binary).addArguments('-headless')).build();
    await driver.installAddon(scratch,true);
    await driver.get(hostOrigin+'/c/synthetic');
    stage='iframe-ready';
    await driver.wait(async()=>driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root')?.shadowRoot;
      return Boolean(sh?.getElementById('isolated-draft-frame') &&
        sh.getElementById('draft')?.hidden);
    }),15000);
    const frame=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('isolated-draft-frame'));
    // Clipboard source is copied BEFORE arming the hostile site event handler.
    stage='copy';
    const src=await driver.findElement(By.id('synthetic-clipboard-source'));
    await src.click();
    await src.sendKeys('Private clipboard fixture');
    await src.sendKeys(Key.CONTROL,'a');
    await src.sendKeys(Key.CONTROL,'c');
    await driver.executeScript('window.__activateHostile()');
    stage='keyboard-and-paste';
    await driver.switchTo().frame(frame);
    const edit=await driver.findElement(By.id('draft'));
    await edit.click();
    await edit.sendKeys('Private typed fixture');
    await edit.sendKeys(Key.CONTROL,'v');
    assert.equal(await driver.executeScript('return document.getElementById("draft").value'),
      'Private typed fixturePrivate clipboard fixture');
    await driver.switchTo().defaultContent();
    // Only the extension's in-memory, hidden mirror receives text; page
    // capture handlers never receive frame keystrokes or clipboard events.
    stage='private-bridge';
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('draft').value==='Private typed fixturePrivate clipboard fixture'),7000);
    const audit=await driver.executeScript(() => ({
      pagePaste:window.__sitePaste,pageKeys:window.__siteKeys,
      siteDraft:document.getElementById('prompt-textarea').textContent,
      sends:window.__sent
    }));
    assert.deepEqual(audit,{pagePaste:0,pageKeys:0,siteDraft:'',sends:0});
    stage='enqueue';
    await driver.executeScript(()=>document.querySelector('#chat-queue-extension-root')
      .shadowRoot.getElementById('add').click());
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),7000);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    stage='cleared-child';
    await driver.switchTo().frame(frame);
    await driver.wait(async()=>driver.executeScript(()=>
      document.getElementById('draft').value===''),7000);
    await driver.switchTo().defaultContent();
    console.log('FDE private iframe QA: physical typing, native clipboard, isolated transport, Add and zero Send pass');
  }finally{
    if(driver)await driver.quit().catch(()=>{});
    server.close();
    fs.rmSync(scratch,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('FDE isolated-draft QA failed: '+String(e.message||e));process.exitCode=1;});
