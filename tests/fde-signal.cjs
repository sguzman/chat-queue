'use strict';
// Actual Firefox extension-to-extension messaging with QA-only synthetic
// Signal producer. This does NOT test the real Chat Signals publisher.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const queueId='chat-queue-signal-qa@sguzman.github';
const signalId='chat-signals@sguzman.github';
const token='e'.repeat(32);
const page=`<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head>
<body><main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button">Send</button></form></main><script>
window.__sent=[];window.__acks=[];
document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
 const editor=document.getElementById('prompt-textarea');
 window.__sent.push(editor.innerText);
 editor.textContent='';editor.dispatchEvent(new Event('input',{bubbles:true}));
});
window.addEventListener('message',event=>{if(event.data?.kind==='qa-provider-ack')window.__acks.push(event.data)});
</script></body></html>`;
const hud=id=>`document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById(${JSON.stringify(id)})`;
function copy(source,dest){fs.copyFileSync(source,dest);}
function prepareQueue(dir,source){
  const m=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
  m.browser_specific_settings.gecko.id=queueId;
  m.content_scripts[0].matches=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
  for(const part of ['src','options'])fs.cpSync(path.join(source,part),path.join(dir,part),{recursive:true});
  const contentPath=path.join(dir,'src/content.js');
  const original=fs.readFileSync(contentPath,'utf8');
  assert.equal(original.split("attachShadow({mode:'closed'})").length,2);
  fs.writeFileSync(contentPath,original.replace("attachShadow({mode:'closed'})","attachShadow({mode:'open'})")
    .replace("if(!response?.ok)throw new Error('Registration unavailable');",
      "if(!response?.ok){document.documentElement.dataset.qaRegisterFailure=String(response?.error||'no-response');throw new Error('Registration unavailable');}")
    .replace("if (!api?.runtime?.sendMessage || !core || !contract) return;",
      "document.documentElement.dataset.qaQueueRuntime=String(!!api?.runtime?.sendMessage)+','+String(!!core)+','+String(!!contract);if (!api?.runtime?.sendMessage || !core || !contract) return;")
    .replace("state.destroyed=true;signalObserver.disconnect();",
      "document.documentElement.dataset.qaRegisterFailure=String(error?.message||'unknown');state.destroyed=true;signalObserver.disconnect();"));
  // Only QA origin allowlist changes; production background is otherwise intact.
  const bgPath=path.join(dir,'src/background.js');
  let bg=fs.readFileSync(bgPath,'utf8');
  const before=String.raw`if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;`;
  const after=String.raw`if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url || tab.url || '')) return;`;
  assert.equal(bg.split(before).length,2,'QA origin substitution must match one location');
  bg=bg.replace(before,after);
  const oldNav="!change.url.startsWith('https://chatgpt.com/')";
  assert.equal(bg.split(oldNav).length,2);
  bg=bg.replace(oldNav,"!change.url.startsWith('http://127.0.0.1:')");
  // QA-only fault injection: forget the provider ledger exactly at the
  // fourth attempt's pre-send authorization. Production code is unchanged.
  const preflight="    if (message.action === 'dispatch-check') {";
  assert.equal(bg.split(preflight).length,2);
  bg=bg.replace(preflight,
    "    if (message.action === 'dispatch-check' && message.sequence===10) {"+
    "globalThis.__qaFourthChecks=(globalThis.__qaFourthChecks||0)+1;"+
    "if(globalThis.__qaFourthChecks===2) SIGNALS.clear();}\n"+preflight);
  fs.writeFileSync(bgPath,bg);
}
function prepareProvider(dir){
  const m={manifest_version:3,name:'Synthetic Signal QA Provider',version:'1.0',
    browser_specific_settings:{gecko:{id:signalId}},
    background:{scripts:['background.js']},
    content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js'],run_at:'document_idle'}]};
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
  fs.writeFileSync(path.join(dir,'background.js'),`
    browser.runtime.onMessage.addListener((message,sender)=>{
      if(message?.type!=='qa-provider-signal'||!Number.isInteger(sender.tab?.id))return;
      return browser.runtime.sendMessage('${queueId}',
        {type:'chat-queue-signal/v1',tabId:sender.tab.id,signal:message.signal});
    });`);
  fs.writeFileSync(path.join(dir,'content.js'),`
    document.documentElement.dataset.qaSignalProviderReady='true';
    window.addEventListener('message',event=>{
      if(event.source!==window||event.data?.kind!=='qa-provider-signal')return;
      const signal=event.data.signal;
      browser.runtime.sendMessage({type:'qa-provider-signal',signal})
        .then(result=>window.postMessage({kind:'qa-provider-ack',sequence:signal.sequence,result},'*'))
        .catch(()=>window.postMessage({kind:'qa-provider-ack',sequence:signal.sequence,result:{ok:false}},'*'));
    });`);
}
async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY required');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-dual-fde-'));
  const qdir=path.join(tmp,'queue'),pdir=path.join(tmp,'provider');
  fs.mkdirSync(qdir);fs.mkdirSync(pdir);
  prepareQueue(qdir,path.resolve(__dirname,'..'));prepareProvider(pdir);
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);});
  let driver=null;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    driver=await new Builder().forBrowser('firefox')
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments('-headless')).build();
    assert.equal(await driver.installAddon(qdir,true),queueId);
    assert.equal(await driver.installAddon(pdir,true),signalId);
    await driver.get(`http://127.0.0.1:${server.address().port}/c/synthetic`);
    try {
      await driver.wait(async()=>await driver.executeScript(
        `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    } catch(error) {
      const diag=await driver.executeScript('return {path:location.pathname,providerReady:document.documentElement.dataset.qaSignalProviderReady||null,queueRoot:!!document.querySelector("#chat-queue-extension-root"),queueHud:!!document.querySelector("#chat-queue-extension-root")?.shadowRoot?.getElementById("run"),registerFailure:document.documentElement.dataset.qaRegisterFailure||null,queueRuntime:document.documentElement.dataset.qaQueueRuntime||null}');
      throw new Error('synthetic dual add-on registration gate: '+JSON.stringify(diag)+'; '+error.message);
    }
    const input=await driver.executeScript(`return ${hud('draft')}`);
    const add=await driver.executeScript(`return ${hud('add')}`);
    await input.sendKeys('Synthetic queued A');await add.click();
    await input.sendKeys('Synthetic queued B');await add.click();
    const start=await driver.executeScript(`return ${hud('run')}`);
    await start.click();
    await driver.wait(async()=>await driver.executeScript(`return ${hud('status')}.textContent.includes('authenticated-chat-signals-required')`),7000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    const emit=async(phase,epoch,sequence,confidence='observed',origin='fresh')=>{
      const signal={version:1,documentToken:token,route:'/c/synthetic',epoch,sequence,
        phase,origin,confidence};
      await driver.executeScript('window.postMessage({kind:"qa-provider-signal",signal:arguments[0]},"*")',signal);
      await driver.wait(async()=>await driver.executeScript(
        'return window.__acks.some(x=>x.sequence===arguments[0])',sequence),8000);
      const ack=await driver.executeScript('return window.__acks.find(x=>x.sequence===arguments[0]).result',sequence);
      assert.equal(ack.ok,true,`provider event ${sequence} rejected: ${ack.error}`);
    };
    const waitNote=async text=>driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes(arguments[0])`,text),10000);
    const waitSends=async amount=>driver.wait(async()=>await driver.executeScript(
      'return window.__sent.length===arguments[0]',amount),10000);
    await emit('idle',0,1);
    await waitNote('Signal: idle');
    await start.click();
    await waitSends(1);
    // A restored terminal from the previous response cannot confirm a fresh
    // Send, even though it arrives after the dispatch attempt began.
    await emit('finished',0,2,'inferred','restored');
    assert.equal(await driver.executeScript('return window.__sent.length'),1);
    await emit('generating',1,3);
    await waitNote('Waiting for confirmed response completion');
    assert.equal(await driver.executeScript('return window.__sent.length'),1);
    // While awaiting a response, editing and reordering the pending queue
    // must remain possible. The in-flight item cannot be sent again.
    await input.sendKeys('Synthetic queued C');
    await add.click();
    const up=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2) .controls button:first-child')");
    await up.click();
    const pending=await driver.executeScript("return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)");
    assert.deepEqual(pending,['Synthetic queued C','Synthetic queued B']);
    await emit('finished',1,4,'inferred');
    await waitSends(2);
    // A terminal replay from the previous response may be fresh evidence of
    // the previous epoch, but must not complete the second queue item.
    await emit('finished',1,5,'inferred');
    assert.equal(await driver.executeScript('return window.__sent.length'),2);
    await emit('generating',2,6);
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',2,7,'inferred');
    await waitSends(3);
    await emit('generating',3,8);
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',3,9,'inferred');
    await waitNote('Queue completed');
    assert.deepEqual(await driver.executeScript('return window.__sent'),
      ['Synthetic queued A','Synthetic queued C','Synthetic queued B']);
    await input.sendKeys('Synthetic unsent D');
    await add.click();
    await emit('idle',3,10);
    await start.click();
    await waitNote('Signal authority lost');
    assert.equal(await driver.executeScript('return window.__sent.length'),3,
      'Lost provider authorization must prevent the fourth Send');
    const uncertain=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item')?.textContent||''");
    assert.match(uncertain,/uncertain/i,'Interrupted attempt must not requeue an unverified submission');
    // A later ready event must not revive an uncertain attempt by itself.
    await emit('idle',3,11);
    assert.equal(await driver.executeScript('return window.__sent.length'),3);
    const draftBefore=await driver.executeScript("return document.getElementById('prompt-textarea').innerText");
    assert.equal(draftBefore,'Synthetic unsent D','Blocked preflight retains prepared draft for user review');
    // A user must inspect/clear the occupied composer; the extension will
    // never replace it automatically on Retry after an uncertain attempt.
    await driver.executeScript("const el=document.getElementById('prompt-textarea');el.textContent='';el.dispatchEvent(new Event('input',{bubbles:true}))");
    const retry=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item.uncertain .controls button:last-child')");
    assert.equal(await retry.getText(),'Retry');
    await retry.click(); // explicit manual decision, never background retry
    assert.equal(await driver.executeScript('return window.__sent.length'),3);
    await start.click(); // explicit user Start after resolving uncertainty
    await waitSends(4);
    await emit('generating',4,12);
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',4,13,'inferred');
    await waitNote('Queue completed');
    assert.deepEqual(await driver.executeScript('return window.__sent'),
      ['Synthetic queued A','Synthetic queued C','Synthetic queued B','Synthetic unsent D']);
    // Requeue is a deliberate queue edit, never a Send authorization.
    const historySize=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.historyitem').length");
    assert.ok(historySize>=4&&historySize<=20,'Recent history must be visible and bounded');
    const historyDisclosure=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details summary')");
    await historyDisclosure.click();
    const requeue=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.historyitem:first-child button')");
    await requeue.click();
    await driver.wait(async()=>await driver.executeScript(`return ${hud('count')}.textContent==='1 queued'`),5000);
    assert.deepEqual(await driver.executeScript("return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)"),['Synthetic unsent D']);
    assert.equal(await driver.executeScript('return window.__sent.length'),4,'Requeue must not automatically Send');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${hud('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,'Reload cannot perform an automatic send');

    // Two live tabs at the exact same conversation route may each hold queue
    // items, but only one may pass the authenticated dispatch preflight.
    const ownerWindow=await driver.getWindowHandle();
    await emit('idle',0,20);
    await waitNote('Signal: idle');
    const ownerStart=await driver.executeScript(`return ${hud('run')}`);
    await ownerStart.click();await waitSends(1);
    await emit('generating',1,21);
    await waitNote('Waiting for confirmed response completion');

    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/synthetic`);
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    const contenderWindow=await driver.getWindowHandle();
    const contenderInput=await driver.executeScript(`return ${hud('draft')}`);
    const contenderAdd=await driver.executeScript(`return ${hud('add')}`);
    await contenderInput.sendKeys('Synthetic competing message');
    await contenderAdd.click();
    await emit('idle',0,22);
    await waitNote('Signal: idle');
    const contenderStart=await driver.executeScript(`return ${hud('run')}`);
    await contenderStart.click();
    await waitNote('Another tab owns this conversation');
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'Competing tab cannot Send or gain ownership');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').textContent"),'',
      'Rejected ownership must preserve the empty ChatGPT composer');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');

    await driver.switchTo().window(ownerWindow);
    const pauseOwner=await driver.executeScript(`return ${hud('run')}`);
    await pauseOwner.click();
    await driver.switchTo().window(contenderWindow);
    await emit('idle',0,23);
    await contenderStart.click();
    await waitNote('Another tab owns this conversation');
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'Pausing while awaiting a response must retain the route lease');

    await driver.switchTo().window(ownerWindow);
    await emit('finished',1,22,'inferred');
    await waitNote('Response finished; control returned');
    await driver.sleep(250);
    await driver.switchTo().window(contenderWindow);
    await emit('idle',0,24);
    await contenderStart.click();
    await waitSends(1);
    assert.deepEqual(await driver.executeScript('return window.__sent'),['Synthetic competing message']);
    console.log('Headless FDE synthetic Signal: requeue, same-conversation single-owner gate, paused-awaiting lock and manual takeover');
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE Signal integration failed:',error.message);process.exitCode=1;});
