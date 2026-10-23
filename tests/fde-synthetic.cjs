'use strict';
// Disposable FDE behavioral fixture; no ChatGPT account or network endpoint.
// Only test-only manifest origin, mock background and open Shadow DOM differ.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder,By}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

const page=`<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head>
<body><main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button" onclick="window.__sendCount++">Send</button></form></main>
<script>window.__sendCount=0</script></body></html>`;
const query=`document.querySelector('#chat-queue-extension-root')?.shadowRoot`;
const jsEl=id=>`${query}?.getElementById(${JSON.stringify(id)})`;
async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY must identify Firefox Developer Edition');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-synthetic-'));
  const src=path.resolve(__dirname,'..');
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);});
  let driver;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const manifest=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'),'utf8'));
    manifest.browser_specific_settings.gecko.id='chat-queue-qa@sguzman.github';
    manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
    manifest.background.scripts=['qa-background.js'];
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
    fs.mkdirSync(path.join(root,'src'));
    for(const name of ['core.js','signal.js'])fs.copyFileSync(path.join(src,'src',name),path.join(root,'src',name));
    let content=fs.readFileSync(path.join(src,'src/content.js'),'utf8');
    const marker="attachShadow({mode:'closed'})";
    assert.equal(content.split(marker).length,2,'QA must make exactly one scoped Shadow DOM substitution');
    content=content.replace(marker,"attachShadow({mode:'open'})");
    fs.writeFileSync(path.join(root,'src/content.js'),content);
    // No provider and no real queue execution: just enough background for HUD registration.
    fs.writeFileSync(path.join(root,'qa-background.js'),
      `browser.runtime.onMessage.addListener((msg,sender)=>{if(msg?.type!=='chat-queue-internal/v1')return; if(msg.action==='register')return Promise.resolve({ok:true,tabId:sender.tab.id});if(msg.action==='state')return Promise.resolve({ok:true});});`);
    const options=new firefox.Options().setBinary(binary).addArguments('-headless');
    driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
    const id=await driver.installAddon(root,true);
    assert.equal(id,manifest.browser_specific_settings.gecko.id);
    await driver.get(`http://127.0.0.1:${server.address().port}/c/synthetic`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('run')})`),15000);
    const theme=await driver.executeScript(`return ${jsEl('theme')}`);
    assert.equal(await theme.getAttribute('value'),'system');
    const input=await driver.executeScript(`return ${jsEl('draft')}`);
    const add=await driver.executeScript(`return ${jsEl('add')}`);
    await input.sendKeys('Synthetic first message');await add.click();
    await input.sendKeys('Synthetic second message');await add.click();
    const count=await driver.executeScript(`return ${jsEl('count')}.textContent`);
    assert.equal(count,'2 queued');
    let order=await driver.executeScript(`return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)`);
    assert.deepEqual(order,['Synthetic first message','Synthetic second message']);
    const up=await driver.executeScript(`return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2) .controls button:first-child')`);
    await up.click();
    order=await driver.executeScript(`return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)`);
    assert.deepEqual(order,['Synthetic second message','Synthetic first message']);
    await driver.executeScript(`const el=${jsEl('theme')};el.value='dark';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='dark'"),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('run')})`),15000);
    assert.equal(await driver.executeScript(`return ${jsEl('theme')}.value`),'dark');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'2 queued');
    await driver.executeScript("document.documentElement.dataset.chatSignalsState='finished'");
    const start=await driver.executeScript(`return ${jsEl('run')}`);
    await start.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),7000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.uninstallAddon(id);
    console.log('FDE synthetic: HUD, persistence, reorder, theme and forged-page-Signal fail-closed behavior pass');
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE synthetic failed:',error.message);process.exitCode=1;});
