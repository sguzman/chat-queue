'use strict';
// Full Firefox Developer Edition process shutdown/relaunch on one disposable
// profile. Actual production persistence and HUD code; synthetic host only.
// A temporary add-on is deliberately reinstalled after Firefox quits.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

const page='<!doctype html><html><body><form>'+
  '<div id="prompt-textarea" role="textbox" contenteditable="true"></div>'+
  '<button type="button" data-testid="send-button" onclick="window.__sent++">Send</button>'+
  '</form><script>window.__sent=0</script></body></html>';
const shadow="document.querySelector('#chat-queue-extension-root')?.shadowRoot";
const el=id=>`${shadow}?.getElementById(${JSON.stringify(id)})`;

async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
    throw Error('FDE_BINARY must identify Firefox Developer Edition');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-restart-'));
  const addon=path.join(root,'addon'),profile=path.join(root,'profile');
  fs.mkdirSync(addon);fs.mkdirSync(profile);
  const src=path.resolve(__dirname,'..');
  const server=http.createServer((_request,response)=>{
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    response.end(page);
  });
  let driver=null,stage='setup';
  try{
    const manifest=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'),'utf8'));
    manifest.browser_specific_settings.gecko.id='chat-queue-restart-qa@sguzman.github';
    manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
    fs.writeFileSync(path.join(addon,'manifest.json'),JSON.stringify(manifest));
    fs.cpSync(path.join(src,'src'),path.join(addon,'src'),{recursive:true});
    fs.cpSync(path.join(src,'options'),path.join(addon,'options'),{recursive:true});
    const contentFile=path.join(addon,'src/content.js');
    const content=fs.readFileSync(contentFile,'utf8');
    const closed="attachShadow({mode:'closed'})";
    assert.equal(content.split(closed).length,2,'Exactly one isolated QA Shadow DOM override');
    fs.writeFileSync(contentFile,content.replace(closed,"attachShadow({mode:'open'})"));
    // The production background needs only a QA localhost origin substitution.
    const bgFile=path.join(addon,'src/background.js');
    let bg=fs.readFileSync(bgFile,'utf8');
    const original=String.raw`if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;`;
    const local=String.raw`if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url || tab.url || '')) return;`;
    assert.equal(bg.split(original).length,2,'Expected production origin gate');
    bg=bg.replace(original,local);
    const nav="!change.url.startsWith('https://chatgpt.com/')";
    assert.equal(bg.split(nav).length,2);
    fs.writeFileSync(bgFile,bg.replace(nav,"!change.url.startsWith('http://127.0.0.1:')"));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/c/full-browser-restart`;
    const aliasUrl=`http://127.0.0.1:${server.address().port}/g/restartqa/c/full-browser-restart`;
    const open=()=>new Builder().forBrowser('firefox').setFirefoxOptions(
      new firefox.Options().setBinary(binary)
        .addArguments('-headless','-profile',profile)
        .setPreference('browser.sessionstore.resume_from_crash',false)).build();
    stage='first-browser-start';
    driver=await open();
    assert.equal(await driver.installAddon(addon,true),manifest.browser_specific_settings.gecko.id);
    await driver.get(url);
    await driver.wait(async()=>driver.executeScript(`return Boolean(${el('draft')})`),15000);
    await driver.executeScript(`const d=${el('draft')};d.value='Synthetic pending queue item from prior browser process';${el('add')}.click()`);
    await driver.wait(async()=>driver.executeScript(
      `return ${el('count')}?.textContent==='1 queued' && !${el('backup-export')}.disabled`),10000);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    stage='complete-browser-shutdown';
    await driver.quit();driver=null;
    stage='second-browser-start';
    driver=await open();
    assert.equal(await driver.installAddon(addon,true),manifest.browser_specific_settings.gecko.id);
    await driver.get(url);
    await driver.wait(async()=>driver.executeScript(`return Boolean(${el('count')})`),15000);
    const count=await driver.executeScript(`return ${el('count')}.textContent`);
    let reusedTabKey=count==='1 queued';
    if(count==='0 queued'){
      // Some Firefox sessions assign a different tab ID on the first page.
      // Recover explicitly before testing a second, guaranteed-distinct tab.
      await driver.executeScript(`document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true;${el('recovery-find')}.click()`);
      await driver.wait(async()=>driver.executeScript(`return ${el('recovery-confirm')}?.hidden===false`),10000);
      await driver.executeScript(`return ${el('recovery-confirm')}.click()`);
      await driver.wait(async()=>driver.executeScript(
        `return ${el('count')}.textContent==='1 queued' && !${el('recovery-confirm')}.disabled`),10000);
      assert.equal(await driver.executeScript(
        `return ${shadow}.querySelectorAll('.item.uncertain').length`),1);
    }else{
      assert.equal(count,'1 queued','Unrecognized queue contents after Firefox relaunch');
    }
    stage='paused-after-relaunch';
    assert.match(await driver.executeScript(`return ${el('status')}.textContent`),/Paused/);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    const originalWindow=await driver.getWindowHandle();
    // Browser restarts may reuse old tab IDs. Force the changed-tab-ID path
    // in a separate actual Firefox tab, so both recovery cases are tested.
    stage='different-tab-after-browser-restart';
    await driver.switchTo().newWindow('tab');
    const secondWindow=await driver.getWindowHandle();
    assert.notEqual(secondWindow,originalWindow);
    // The second browser tab uses a DIFFERENT recognized URL shape with the
    // same assigned conversation ID. A prior direct-route tab record must
    // never auto-load, but explicit manual recovery may offer it as uncertain.
    await driver.get(aliasUrl);
    await driver.wait(async()=>driver.executeScript(`return Boolean(${el('count')})`),15000);
    assert.equal(await driver.executeScript(`return ${el('count')}.textContent`),'0 queued',
      'A new project-alias tab must not silently adopt the prior direct-route queue');
    assert.equal(await driver.executeScript('return window.__sent'),0);
    await driver.executeScript(`document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true;${el('recovery-find')}.click()`);
    await driver.wait(async()=>driver.executeScript(`return ${el('recovery-confirm')}?.hidden===false`),10000);
    assert.equal(await driver.executeScript(`return ${el('count')}.textContent`),'0 queued');
    await driver.executeScript(`return ${el('recovery-confirm')}.click()`);
    await driver.wait(async()=>driver.executeScript(
      `return ${el('count')}.textContent==='1 queued' && !${el('recovery-confirm')}.disabled`),10000);
    assert.equal(await driver.executeScript(
      `return ${shadow}.querySelectorAll('.item.uncertain').length`),1,
      'Every copied prompt must become uncertain after an actual browser restart');
    assert.match(await driver.executeScript(`return ${el('status')}.textContent`),/Paused/);
    await driver.executeScript(`return ${el('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(
      `return ${el('status')}.textContent.includes('resolve-uncertain-message')`),6000);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    // Recovery must not remove or rewrite its original tab's saved queue.
    await driver.switchTo().window(originalWindow);
    assert.equal(await driver.executeScript(`return ${el('count')}.textContent`),'1 queued');
    assert.match(await driver.executeScript(`return ${el('status')}.textContent`),/Paused/);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    await driver.switchTo().window(secondWindow);
    await driver.navigate().refresh();
    await driver.wait(async()=>driver.executeScript(`return ${el('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(
      `return ${shadow}.querySelectorAll('.item.uncertain').length`),1);
    assert.match(await driver.executeScript(`return ${el('status')}.textContent`),/Paused/);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    console.log('Full Firefox Developer Edition restart: original queue paused, reused-tab-key='+reusedTabKey+
      ', project-alias second tab explicit recovery uncertain and durable, no Send');
  }catch(error){
    throw new Error(stage+': '+error.message);
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE browser-restart QA failed:',error.message);process.exitCode=1});
