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
    let qaContent=content.replace(closed,"attachShadow({mode:'open'})");
    // QA-only storage bridge to simulate an unresolved Send hold, restricted
    // to this disposable localhost fixture and absent from production.
    const qaHoldAnchor="  const UI_KEY='chatqueue:ui:v1';";
    assert.equal(qaContent.split(qaHoldAnchor).length,2);
    qaContent=qaContent.replace(qaHoldAnchor,qaHoldAnchor+"\n  window.addEventListener('message',async event=>{\n    if(event.source!==window||event.origin!==location.origin||\n       location.pathname!=='/c/full-browser-restart')return;\n    const data=event.data;\n    if(!data||!Number.isSafeInteger(data.nonce)||\n       !['qa-crash-hold-seed','qa-crash-hold-read'].includes(data.kind))return;\n    const key='chatqueue:send-hold:v1:full-browser-restart';\n    let record=null,ok=false;\n    try{\n      if(data.kind==='qa-crash-hold-seed')await api.storage.local.set({\n        [key]:{version:1,tabId:999,route:'/c/full-browser-restart',\n          holdId:'12345678-aaaa-4444-bbbb-555555555555'}\n      });\n      record=(await api.storage.local.get(key))[key]??null;\n      ok=true;\n    }catch{}\n    window.postMessage({kind:'qa-crash-hold-reply',nonce:data.nonce,ok,record},'*');\n  });\n");
    fs.writeFileSync(contentFile,qaContent);
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
    // Unlike driver.quit(), an abrupt process death does not flush Firefox's
    // session via the normal shutdown lifecycle. Restrict SIGKILL to exactly
    // this disposable -profile process, never another browser or geckodriver.
    // The seed/read bridge is deliberately restricted to this direct route.
    await driver.switchTo().window(originalWindow);
    await driver.wait(async()=>driver.executeScript(`return Boolean(${el('count')})`),8000);
    stage='seed-potentially-clicked-send-hold-before-crash';
    const holdRequest=kind=>driver.executeAsyncScript((eventKind,done)=>{
      const nonce=Math.floor(Math.random()*1e9);
      const timer=setTimeout(()=>{window.removeEventListener('message',receive);
        done({ok:false,error:'hold-request-timeout'});},5000);
      function receive(event){
        if(event.source!==window||event.origin!==location.origin||
           event.data?.kind!=='qa-crash-hold-reply'||
           event.data.nonce!==nonce)return;
        clearTimeout(timer);window.removeEventListener('message',receive);
        done(event.data);
      }
      window.addEventListener('message',receive);
      window.postMessage({kind:eventKind,nonce},location.origin);
    },kind);
    const expectedHold={version:1,tabId:999,route:'/c/full-browser-restart',
      holdId:'12345678-aaaa-4444-bbbb-555555555555'};
    let holdReply=await holdRequest('qa-crash-hold-seed');
    assert.equal(holdReply.ok,true,'QA metadata hold must persist before click');
    assert.deepEqual(holdReply.record,expectedHold);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    await driver.executeScript(()=>{
      const input=document.getElementById('prompt-textarea');
      input.textContent='Synthetic accepted site click before abrupt shutdown';
      document.querySelector('[data-testid="send-button"]').click();
    });
    assert.equal(await driver.executeScript('return window.__sent'),1,
      'The synthetic site click was accepted before process death');
    stage='unexpected-browser-process-death';
    const firefoxProfilePids=()=>{
      const matches=[];
      for(const name of fs.readdirSync('/proc')){
        if(!/^\d+$/.test(name))continue;
        let args;
        try{args=fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\0');}
        catch{continue;}
        const flag=args.findIndex((arg,index)=>['-profile','--profile'].includes(arg)&&
          args[index+1]===profile);
        if(flag<0||args.some(arg=>arg==='-contentproc'))continue;
        matches.push(Number(name));
      }
      return matches;
    };
    const targetPids=firefoxProfilePids();
    assert.equal(targetPids.length,1,
      'Refuse to kill Firefox unless one browser owns the exact disposable profile: '+
      JSON.stringify(targetPids));
    process.kill(targetPids[0],'SIGKILL');
    try{await driver.quit();}catch{/* Browser has deliberately crashed. */}
    driver=null;
    stage='relaunch-after-unexpected-process-death';
    driver=await open();
    assert.equal(await driver.installAddon(addon,true),
      manifest.browser_specific_settings.gecko.id);
    await driver.get(url);
    await driver.wait(async()=>driver.executeScript(
      `return Boolean(${el('count')})`),15000);
    stage='durable-send-hold-after-process-death';
    holdReply=await holdRequest('qa-crash-hold-read');
    assert.equal(holdReply.ok,true,'Extension storage readable after SIGKILL');
    assert.deepEqual(holdReply.record,expectedHold,
      'Potentially clicked Send hold must survive process death');
    const afterCrash=await driver.executeScript(`return ${el('count')}.textContent`);
    assert.ok(['0 queued','1 queued'].includes(afterCrash),
      'Unrecognized queue state after abrupt shutdown: '+afterCrash);
    if(afterCrash==='0 queued'){
      // A new browser tab key never adopts another tab's private prompts
      // automatically, even after a crash. Recovery is a deliberate copy.
      await driver.executeScript(
        `document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true;${el('recovery-find')}.click()`);
      await driver.wait(async()=>driver.executeScript(
        `return ${el('recovery-confirm')}?.hidden===false`),11000);
      await driver.executeScript(`return ${el('recovery-confirm')}.click()`);
      await driver.wait(async()=>driver.executeScript(
        `return /^\\d+ queued$/.test(${el('count')}.textContent)&&${el('count')}.textContent!=='0 queued'`),11000);
      assert.equal(await driver.executeScript(`return [...${shadow}.querySelectorAll('.item')].every(
        item=>item.classList.contains('uncertain'))`),true,
        'Only uncertain manual review is permitted when copying after crash');
    }
    assert.match(await driver.executeScript(`return ${el('status')}.textContent`),/Paused/);
    assert.equal(await driver.executeScript('return window.__sent'),0);
    await driver.executeScript(`return ${el('run')}.click()`);
    await new Promise(resolve=>setTimeout(resolve,900));
    assert.equal(await driver.executeScript('return window.__sent'),0,
      'Unexpected Firefox process death must not authorize or replay any Send');
    console.log('Full Firefox Developer Edition restart: graceful shutdown and SIGKILL, '+
      'relaunch retained or explicitly recovered private prompts, paused, zero Send');
  }catch(error){
    throw new Error(stage+': '+error.message);
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE browser-restart QA failed:',error.message);process.exitCode=1});
