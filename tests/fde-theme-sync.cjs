'use strict';
// Disposable Firefox Developer Edition add-on test: settings synchronize,
// while messages remain scoped to exact ChatGPT-style conversation routes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

const page=`<!doctype html><html><head><meta charset="utf-8"><title>Queue fixture</title></head>
<body><main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button" onclick="window.__sendCount++">Send</button>
</form></main><script>window.__sendCount=0</script></body></html>`;
const get=id=>`document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById(${JSON.stringify(id)})`;
async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY must identify Firefox Developer Edition');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-themes-'));
  const root=path.resolve(__dirname,'..');
  const server=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(page);});
  let driver,stage='startup';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
    manifest.browser_specific_settings.gecko.id='chat-queue-themes-qa@sguzman.github';
    manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
    manifest.background.scripts=['qa-background.js'];
    fs.writeFileSync(path.join(temp,'manifest.json'),JSON.stringify(manifest));
    fs.mkdirSync(path.join(temp,'src'));
    for(const name of ['core.js','signal.js'])fs.copyFileSync(path.join(root,'src',name),path.join(temp,'src',name));
    let content=fs.readFileSync(path.join(root,'src/content.js'),'utf8');
    const marker="attachShadow({mode:'closed'})";
    assert.equal(content.split(marker).length,2);
    content=content.replace(marker,"attachShadow({mode:'open'})");
    fs.writeFileSync(path.join(temp,'src/content.js'),content);
    fs.writeFileSync(path.join(temp,'qa-background.js'),
      `browser.runtime.onMessage.addListener((msg,sender)=>{if(msg?.type!=='chat-queue-internal/v1')return; if(msg.action==='register')return Promise.resolve({ok:true,tabId:sender.tab.id});if(msg.action==='state')return Promise.resolve({ok:true});});`);
    const options=new firefox.Options().setBinary(binary).addArguments('-headless');
    driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
    const addon=await driver.installAddon(temp,true);
    const origin=`http://127.0.0.1:${server.address().port}`;
    stage='first-navigation';
    await driver.get(`${origin}/c/theme-first`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${get('theme')})`),15000);
    assert.equal(await driver.executeScript(`return ${get('theme')}.value`),'system');
    const first=await driver.getWindowHandle();
    await driver.executeScript(`const el=${get('draft')};el.value='';el.textContent='Synthetic queued prompt';el.dispatchEvent(new Event('input',{bubbles:true}));`);
    await driver.executeScript(`return ${get('add')}.click()`);
    stage='first-enqueue';
    await driver.wait(async()=>await driver.executeScript(`return ${get('count')}.textContent==='1 queued'`),5000);
    await driver.executeScript(`const el=${get('theme')};el.value='dark';el.dispatchEvent(new Event('change',{bubbles:true}));`);
    await driver.wait(async()=>await driver.executeScript(`return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='dark'`),5000);
    await driver.switchTo().newWindow('tab');
    stage='second-navigation';
    await driver.get(`${origin}/c/theme-second`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${get('theme')})`),15000);
    stage='second-initial-dark';
    await driver.wait(async()=>await driver.executeScript(`return ${get('theme')}.value==='dark'`),7000);
    assert.equal(await driver.executeScript(`return ${get('count')}.textContent`),'0 queued');
    const second=await driver.getWindowHandle();
    await driver.switchTo().window(first);
    await driver.executeScript(`const el=${get('theme')};el.value='light';el.dispatchEvent(new Event('change',{bubbles:true}));`);
    await driver.wait(async()=>await driver.executeScript(`return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='light'`),5000);
    await driver.switchTo().window(second);
    stage='second-live-light';
    await driver.wait(async()=>await driver.executeScript(`return ${get('theme')}.value==='light'`),7000);
    assert.equal(await driver.executeScript(`return ${get('count')}.textContent`),'0 queued');
    await driver.switchTo().window(first);
    assert.equal(await driver.executeScript(`return ${get('count')}.textContent`),'1 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.uninstallAddon(addon);
    console.log('FDE themes: system default, shared live light/dark preference, independent conversation queues and no Send');
  }catch(error){
    console.error('FDE theme-sync stage:',stage,'reason:',error.message);
    throw error;
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error('FDE theme-sync failed:',err.message);process.exitCode=1;});