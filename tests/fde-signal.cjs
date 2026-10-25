'use strict';
// Actual Firefox extension-to-extension messaging with QA-only synthetic
// Signal producer. This does NOT test the real Chat Signals publisher.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder,By,Key}=require('selenium-webdriver');
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
 const clear=()=>{editor.textContent='';editor.dispatchEvent(new Event('input',{bubbles:true}));};
 // Deliberately keep the draft occupied until the provider has published
 // both busy and terminal events. QA then simulates React clearing it.
 if(location.pathname==='/c/rapid-terminal')window.__qaPendingClear=clear;
 else clear();
});
window.addEventListener('message',event=>{if(event.data?.kind==='qa-provider-ack')window.__acks.push(event.data)});
</script></body></html>`;
const hud=id=>`document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById(${JSON.stringify(id)})`;
function copy(source,dest){fs.copyFileSync(source,dest);}
function prepareQueue(dir,source){
  const m=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
  m.browser_specific_settings.gecko.id=queueId;
  // QA-only local rule definitions; production Options libraries are never
  // auto-enabled or read until the user explicitly opts in per document.
  m.background.scripts.unshift('qa-rules-seed.js');
  m.content_scripts[0].js.push('qa-rule-config-change.js');
  m.content_scripts[0].matches=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
  for(const part of ['src','options'])fs.cpSync(path.join(source,part),path.join(dir,part),{recursive:true});
  fs.writeFileSync(path.join(dir,'qa-rules-seed.js'),`
    browser.storage.local.set({'chatqueue:conditional-rules:v1':{
      version:1,rules:[{version:1,id:'synthetic-followup',enabled:true,
        priority:50,when:{phase:'finished'},
        then:{type:'propose',text:'Synthetic approved follow-up'}}]
    }});`);
  fs.writeFileSync(path.join(dir,'qa-rule-config-change.js'),`
    document.documentElement.dataset.qaRuleMutationReady='yes';
    window.addEventListener('message',event=>{
      if(event.source!==window||event.data?.kind!=='qa-change-rule-config')return;
      const phase=['failed','interrupted','limit'].includes(event.data.phase)
        ? event.data.phase:'failed';
      const then=event.data.action==='propose'
        ? {type:'propose',text:'Synthetic delayed approval'}
        : {type:'pause'};
      const rules=event.data.mode==='dependencies'?[
        {version:1,id:'first-approval',enabled:true,priority:100,
          when:{phase:'failed'},then:{type:'pause'}},
        {version:1,id:'dependent',enabled:true,priority:90,
          when:{phase:'finished',dependsOn:['first-approval']},
          then:{type:'propose',text:'Synthetic dependent approved text'}},
        {version:1,id:'skip-until-approved',enabled:true,priority:80,
          when:{phase:'finished',skipIf:['first-approval']},
          then:{type:'pause'}}
      ]:event.data.mode==='persisted-dependency'?[
        {version:1,id:'durable-first',enabled:true,priority:100,
          when:{phase:'failed'},then:{type:'propose',text:'Synthetic durable prerequisite'}},
        {version:1,id:'durable-next',enabled:true,priority:90,
          when:{phase:'finished',dependsOn:['durable-first']},then:{type:'pause'}},
        {version:1,id:'durable-fallback',enabled:true,priority:80,
          when:{phase:'finished',skipIf:['durable-first']},then:{type:'pause'}}
      ]:event.data.mode==='duration-only'?[
        {version:1,id:'duration-frozen',enabled:true,priority:100,
          when:{phase:'finished',minDurationMs:3000},then:{type:'pause'}}
      ]:event.data.mode==='duration'?[
        {version:1,id:'duration-observed',enabled:true,priority:90,
          when:{phase:'finished',minDurationMs:250},then:{type:'pause'}},
        {version:1,id:'duration-fallback',enabled:true,priority:40,
          when:{phase:'finished'},then:{type:'pause'}}
      ]:[{version:1,id:'synthetic-changed',enabled:true,
        priority:10,when:{phase},then}];
      browser.storage.local.set({'chatqueue:conditional-rules:v1':{
        version:1,rules
      }}).then(()=>document.documentElement.dataset.qaRuleMutationDone='yes')
        .catch(()=>document.documentElement.dataset.qaRuleMutationDone='failed');
    });`);
  const contentPath=path.join(dir,'src/content.js');
  const original=fs.readFileSync(contentPath,'utf8');
  assert.equal(original.split("attachShadow({mode:'closed'})").length,2);
  fs.writeFileSync(contentPath,original.replace("attachShadow({mode:'closed'})","attachShadow({mode:'open'})")
    // Widen only the rapid-terminal fixture's confirmation polling interval.
    .replace('const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));',
      "const delay=ms=>new Promise(resolve=>setTimeout(resolve,routeKey()==='/c/rapid-terminal'?1800:['/c/post-click-user','/c/post-click-file'].includes(routeKey())?850:ms));")
    // QA-only short freshness horizon and delayed queue timer. This simulates
    // timer throttling in an inactive Firefox tab without 15+ seconds of wait.
    .replace("performance.now()-state.trustedAt<15000",
      "performance.now()-state.trustedAt<(routeKey()==='/c/provider-stale'?2000:15000)")
    .replace("    },350);",
      "    },routeKey()==='/c/provider-stale'?3000:350);")
    // QA-only deferred policy read: expose the race where an onChanged
    // invalidation arrives before a previously initiated read settles.
    .replace('const data=await api.storage.local.get(ruleStore.KEY);',
      "const data=await (routeKey()==='/c/rule-config-race'?new Promise(resolve=>setTimeout(resolve,1200)).then(()=>api.storage.local.get(ruleStore.KEY)):api.storage.local.get(ruleStore.KEY));")
    .replace('api.storage.local.set({[key]:data})',
      "((routeKey()==='/c/rule-dependency-persistence'&&document.documentElement.dataset.qaRejectRuleAppend==='yes')?Promise.reject(new Error('qa-rejected-write')):((routeKey()==='/c/rule-approval-route-race'&&document.documentElement.dataset.qaDelayRuleApproval==='yes')?new Promise(resolve=>setTimeout(resolve,1500)).then(()=>api.storage.local.set({[key]:data})):api.storage.local.set({[key]:data})))")
    .replace("if(!response?.ok)throw new Error('Registration unavailable');",
      "if(!response?.ok){document.documentElement.dataset.qaRegisterFailure=String(response?.error||'no-response');throw new Error('Registration unavailable');}")
    .replace("if (!api?.runtime?.sendMessage || !core || !contract) return;",
      "document.documentElement.dataset.qaQueueRuntime=String(!!api?.runtime?.sendMessage)+','+String(!!core)+','+String(!!contract);if (!api?.runtime?.sendMessage || !core || !contract) return;")
    .replace("state.destroyed=true;signalObserver.disconnect();",
      "document.documentElement.dataset.qaRegisterFailure=String(error?.message||'unknown');state.destroyed=true;signalObserver.disconnect();"));
  // QA-only assertion at the exact composer handoff boundary: an on-disk
  // uncertain journal must predate any programmatically inserted prompt.
  const journalHandoff="      fillComposer(editor,item.text);";
  assert.equal(fs.readFileSync(contentPath,'utf8').split(journalHandoff).length,2);
  fs.writeFileSync(contentPath,fs.readFileSync(contentPath,'utf8').replace(journalHandoff,
    "      const qaStored=await api.storage.local.get(state.key);"+
    "if(qaStored[state.key]?.items?.find(x=>x.id===item.id)?.status!=='uncertain')"+
    "throw new Error('QA: composer handoff preceded durable uncertain journal');\n"+
    journalHandoff));
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
  // QA-only delay on the second authorization check for a later message:
  // actual production check logic still runs after the pause.
  const delayedAuth="      return currentRoute(sender).then(live=>{\n        if(live!==message.route || SIGNALS.get(tab.id)!==last ||";
  assert.equal(bg.split(delayedAuth).length,2);
  bg=bg.replace(delayedAuth,
    "      return currentRoute(sender).then(async live=>{\n"+
    "        if(message.sequence===27){globalThis.__qaLateChecks=(globalThis.__qaLateChecks||0)+1;"+
    "if(globalThis.__qaLateChecks===2)await new Promise(resolve=>setTimeout(resolve,1800));}\n"+
    "        if(message.sequence===30){globalThis.__qaRouteChecks=(globalThis.__qaRouteChecks||0)+1;"+
    "if(globalThis.__qaRouteChecks===2)await new Promise(resolve=>setTimeout(resolve,1800));}\n"+
    "        if(message.sequence===50){globalThis.__qaFileChecks=(globalThis.__qaFileChecks||0)+1;"+
    "if(globalThis.__qaFileChecks===2)await new Promise(resolve=>setTimeout(resolve,1800));}\n"+
    "        if(message.sequence===60){globalThis.__qaEditorChecks=(globalThis.__qaEditorChecks||0)+1;"+
    "if(globalThis.__qaEditorChecks===2)await new Promise(resolve=>setTimeout(resolve,1800));}\n"+
    "        if(live!==message.route || SIGNALS.get(tab.id)!==last ||");
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
  let qaStage='bootstrap';
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
    const emit=async(phase,epoch,sequence,confidence='observed',origin='fresh',route='/c/synthetic')=>{
      const signal={version:1,documentToken:token,route,epoch,sequence,
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
    qaStage='draft-attachment-preflight';
    await emit('idle',0,1);
    await waitNote('Signal: idle');
    // Whitespace alone is still a user's composer draft: do not replace it.
    await driver.executeScript("document.getElementById('prompt-textarea').textContent='   '");
    await start.click();
    await waitNote('Composer contains a draft; preserved it');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').textContent"),'   ');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    await driver.wait(async()=>await driver.executeScript(
      "return !document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item .controls button:nth-child(4)').disabled"),5000);
    await driver.executeScript("document.getElementById('prompt-textarea').textContent=''");
    // An occupied draft must be preserved byte-for-byte; the queue stays
    // pending and cannot send merely because authenticated Signals is ready.
    await driver.executeScript("document.getElementById('prompt-textarea').textContent='Human draft remains here'");
    await start.click();
    await waitNote('Composer contains a draft; preserved it');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').textContent"),'Human draft remains here');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    await driver.wait(async()=>await driver.executeScript(
      "return !document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item .controls button:nth-child(4)').disabled"),5000);
    await driver.executeScript("document.getElementById('prompt-textarea').textContent=''");
    // Use a real local Firefox file input, not a fabricated FileList, to
    // exercise the production existing-attachment guard.
    // First file input is empty. A later selected input must still block.
    await driver.executeScript("const empty=document.createElement('input');empty.type='file';empty.id='qa-empty-attachment';document.querySelector('main form').append(empty)");
    const fixtureAttachment=path.join(tmp,'harmless-attachment.txt');
    fs.writeFileSync(fixtureAttachment,'synthetic attachment fixture');
    const attachment=await driver.executeScript(
      "const el=document.createElement('input');el.type='file';el.id='qa-existing-attachment';document.querySelector('main form').append(el);return el");
    await attachment.sendKeys(fixtureAttachment);
    assert.equal(await driver.executeScript("return document.querySelector('#qa-existing-attachment').files.length"),1);
    await start.click();
    await waitNote('Composer has attachments');
    assert.equal(await driver.executeScript("return document.querySelector('#qa-existing-attachment').files.length"),1);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    await driver.wait(async()=>await driver.executeScript(
      "return !document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item .controls button:nth-child(4)').disabled"),5000);
    await driver.executeScript("document.querySelector('#qa-existing-attachment').remove();document.querySelector('#qa-empty-attachment').remove()");
    await start.click();
    qaStage='first-response-attribution';
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
    qaStage='manual-uncertain-retry';
    await input.sendKeys('Synthetic unsent D');
    await add.click();
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),8000);
    // Keep the pending item's editor open across a failed authorization.
    // An earlier Save callback must not rewrite an uncertain submission.
    await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item .controls button[aria-label=\"Edit message\"]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return !!document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('textarea[aria-label=\"Edit queued message\"]')"),5000);
    await emit('idle',3,10);
    await start.click();
    await waitNote('Signal authority lost');
    assert.equal(await driver.executeScript('return window.__sent.length'),3,
      'Lost provider authorization must prevent the fourth Send');
    const uncertain=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item')?.textContent||''");
    assert.match(uncertain,/uncertain/i,'Interrupted attempt must not requeue an unverified submission');
    const protectedRow=await driver.executeScript(()=>{
      const root=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const row=root.querySelector('.item.uncertain');
      return {editorOpen:!!row.querySelector('textarea'),editDisabled:
        row.querySelector('button[aria-label="Edit message"]').disabled,
        originalText:row.querySelector('.preview')?.textContent.includes('Synthetic unsent D')};
    });
    assert.deepEqual(protectedRow,{editorOpen:false,editDisabled:true,originalText:true},
      'A previously open edit must close when a Send becomes uncertain');
    // A later ready event must not revive an uncertain attempt by itself.
    await emit('idle',3,11);
    assert.equal(await driver.executeScript('return window.__sent.length'),3);
    const draftBefore=await driver.executeScript("return document.getElementById('prompt-textarea').innerText");
    assert.equal(draftBefore,'Synthetic unsent D','Blocked preflight retains prepared draft for user review');
    // A user must inspect/clear the occupied composer; the extension will
    // never replace it automatically on Retry after an uncertain attempt.
    await driver.executeScript("const el=document.getElementById('prompt-textarea');el.textContent='';el.dispatchEvent(new Event('input',{bubbles:true}))");
    const retry=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item.uncertain .controls button[aria-label=\"Allow manually requested retry\"]')");
    assert.equal(await retry.getText(),'Retry');
    await retry.click(); // explicit manual decision, never background retry
    await waitNote('Retry marked pending; press Start separately');
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

    qaStage='same-conversation-lease';
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
    await emit('generating',1,25);
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',1,26,'inferred');
    await waitNote('Queue completed');
    // While the second pre-Send authorization is in flight, simulate real
    // human input that restores the exact original text. Equality alone would
    // miss the user interaction; a trusted-input marker must stop the click.
    qaStage='trusted-edit-after-send-click';
    const priorTrustedRaceTab=await driver.getWindowHandle();
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/post-click-user');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    for(const text of ['Synthetic first post-click message','Synthetic second protected message']){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(`return ${hud('draft')}.value==='' && ${hud('count')}.textContent===arguments[0]`,text.includes('first')?'1 queued':'2 queued'),10000);
    }
    await emit('idle',0,580,'observed','fresh','/c/post-click-user');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await driver.executeScript("window.__qaPostClickTrusted=0;document.getElementById('prompt-textarea').addEventListener('input',e=>{if(e.isTrusted)window.__qaPostClickTrusted++})");
    const postClickEditor=await driver.findElement(By.id('prompt-textarea'));
    await postClickEditor.sendKeys('X',Key.BACK_SPACE);
    assert.ok(await driver.executeScript('return window.__qaPostClickTrusted')>0,
      'The Firefox input event after the Queue click must be browser-trusted');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').innerText.trim()"),'',
      'The human typed and deleted before the provider produced busy evidence');
    await emit('generating',1,581,'observed','fresh','/c/post-click-user');
    await emit('finished',1,582,'observed','fresh','/c/post-click-user');
    await waitNote('Human interaction during submission verification; manual review required');
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'A later provider completion must not dispatch the second item');
    await driver.sleep(700);
    assert.equal(await driver.executeScript('return window.__sent.length'),1);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'The single attempted Send requires manual uncertainty resolution');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued');
    await driver.switchTo().window(priorTrustedRaceTab);

    qaStage='file-attachment-after-send-click';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/post-click-file');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic file-attachment race';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('draft')}.value===''&&${hud('count')}.textContent==='1 queued'`),10000);
    await emit('idle',0,585,'observed','fresh','/c/post-click-file');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    const postClickAttachmentInput=await driver.executeScript(() => {
      window.__qaPostClickFileChanges=0;
      const form=document.querySelector('main form');
      form.addEventListener('change',e=>{if(e.isTrusted)window.__qaPostClickFileChanges++},true);
      const input=document.createElement('input');
      input.id='qa-post-click-file';input.type='file';form.append(input);
      return input;
    });
    await postClickAttachmentInput.sendKeys(fixtureAttachment);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#qa-post-click-file').files.length"),1);
    await emit('generating',1,586,'observed','fresh','/c/post-click-file');
    await emit('finished',1,587,'observed','fresh','/c/post-click-file');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('manual review required')`),9000);
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'An attachment added after the Queue click cannot trigger a second Send');
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#qa-post-click-file').files.length"),1,
      "The user-selected attachment must remain untouched");
    await driver.switchTo().window(priorTrustedRaceTab);

    qaStage='trusted-user-edit-race';
    const lateDraft=await driver.executeScript(`return ${hud('draft')}`);
    const lateAdd=await driver.executeScript(`return ${hud('add')}`);
    await lateDraft.sendKeys('Synthetic human-edit race');
    await lateAdd.click();
    await emit('idle',1,27);
    await waitNote('Signal: idle');
    await driver.executeScript("window.__trustedInputCount=0;document.getElementById('prompt-textarea').addEventListener('input',e=>{if(e.isTrusted)window.__trustedInputCount++})");
    await contenderStart.click();
    await driver.wait(async()=>await driver.executeScript(
      "return document.getElementById('prompt-textarea').innerText==='Synthetic human-edit race'"),10000);
    const siteEditor=await driver.findElement(By.id('prompt-textarea'));
    await siteEditor.sendKeys(Key.END,'X',Key.BACK_SPACE);
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').innerText"),'Synthetic human-edit race');
    assert.ok(await driver.executeScript('return window.__trustedInputCount')>0,'Firefox must produce trusted manual input events');
    await waitNote('Dispatch context changed; no send attempted');
    assert.deepEqual(await driver.executeScript('return window.__sent'),['Synthetic competing message']);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'An interrupted composer handoff must preserve uncertainty');
    qaStage='history-route-race';
    // Navigate during an intentionally delayed final authorization; a
    // prepared prompt must never be sent to the new conversation.
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/route-race`);
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    const routeDraft=await driver.executeScript(`return ${hud('draft')}`);
    await routeDraft.sendKeys('Synthetic route-race prompt');
    await driver.executeScript(`return ${hud('add')}.click()`);
    await emit('idle',0,30,'observed','fresh','/c/route-race');
    await waitNote('Signal: idle');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      "return document.getElementById('prompt-textarea').innerText==='Synthetic route-race prompt'"),10000);
    await driver.executeScript("history.pushState({},'', '/c/another-conversation')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='0 queued'`),10000);
    await driver.sleep(2000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'A delayed Send must be cancelled after History API route change');
    await driver.executeScript("history.pushState({},'', '/c/route-race')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'The source conversation must retain its uncertain pre-Send journal');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    qaStage='stale-provider-ready-timer-does-not-resume';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/provider-stale');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Must not send after stale ready signal';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('draft')}.value==='' && ${hud('count')}.textContent==='1 queued'`),10000);
    await emit('idle',0,610,'observed','fresh','/c/provider-stale');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Running')`),4500);
    await waitNote('Authenticated Signal stale; manually Start to resume');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    // A new fresh phase after the stale timer must not silently revive the
    // old Start command or schedule an unrelated new prompt.
    await emit('finished',1,611,'observed','fresh','/c/provider-stale');
    await driver.sleep(1000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'After stale provider authority, fresh terminal alone cannot Send');
    assert.match(await driver.executeScript(`return ${hud('status')}.textContent`),/Paused/);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');

    qaStage='authenticated-unknown-phase-pauses-ongoing-response';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/unknown-interrupt');
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('draft')})`),12000);
    for(const [index,text] of ['Synthetic initially sent','Synthetic must stay queued'].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0]`,(index+1)+' queued'),10000);
    }
    await emit('idle',0,620,'observed','fresh','/c/unknown-interrupt');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await emit('generating',1,621,'observed','fresh','/c/unknown-interrupt');
    await waitNote('Waiting for confirmed response completion');
    await emit('unknown',1,622,'unknown','fresh','/c/unknown-interrupt');
    await waitNote('Paused on unknown');
    await driver.sleep(800);
    assert.equal(await driver.executeScript('return window.__sent.length'),1);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await emit('finished',1,623,'inferred','fresh','/c/unknown-interrupt');
    await driver.sleep(800);
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'Unknown provider state must not resume on later terminal evidence');
    assert.match(await driver.executeScript(`return ${hud('status')}.textContent`),/Paused/);

    qaStage='unknown-confidence-safety';
    // Authenticated but unknown-confidence phase events are not proof of
    // accepted Send or completed response; they can only pause/withhold progress.
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/uncertain-confidence`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('draft')})`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Do not trust unknown busy';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await emit('idle',0,36,'observed','fresh','/c/uncertain-confidence');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await emit('generating',1,37,'unknown','fresh','/c/uncertain-confidence');
    try{
      await waitNote('Submission not confirmed; manual review required');
    }catch(error){
      const diagnostic=await driver.executeScript(
        "return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status').textContent");
      throw new Error('Unknown-confidence completion did not settle: '+diagnostic+'; '+error.message);
    }
    assert.equal(await driver.executeScript('return window.__sent.length'),1);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    // In another conversation, a known busy event permits attribution but
    // an unknown-confidence finish cannot advance the next queued prompt.
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/unknown-finish`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('draft')})`),12000);
    for(const text of ['Accepted synthetic A','Blocked synthetic B']){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
    }
    await emit('idle',0,40,'observed','fresh','/c/unknown-finish');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await emit('generating',1,41,'observed','fresh','/c/unknown-finish');
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',1,42,'unknown','fresh','/c/unknown-finish');
    await driver.sleep(650);
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'Unknown-confidence finish cannot advance queue');
    await emit('finished',1,43,'inferred','fresh','/c/unknown-finish');
    await waitSends(2);
    await emit('generating',2,44,'observed','fresh','/c/unknown-finish');
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',2,45,'observed','fresh','/c/unknown-finish');
    await waitNote('Queue completed');
    assert.deepEqual(await driver.executeScript('return window.__sent'),
      ['Accepted synthetic A','Blocked synthetic B']);
    qaStage='late-file-attachment';
    // A file selected during the asynchronous pre-click provider check
    // must never get bundled into an automatic queued prompt.
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/late-attachment`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('draft')})`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Never send newly attached file';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await emit('idle',0,50,'observed','fresh','/c/late-attachment');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      "return document.getElementById('prompt-textarea').innerText==='Never send newly attached file'"),10000);
    await driver.executeScript("const empty=document.createElement('input');empty.type='file';empty.id='qa-late-empty-file';document.querySelector('main form').append(empty)");
    const lateFile=await driver.executeScript(
      "const file=document.createElement('input');file.type='file';file.id='qa-late-selected-file';document.querySelector('main form').append(file);return file");
    await lateFile.sendKeys(fixtureAttachment);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Composer changed before Send; no send attempted') ||
        ${hud('status')}.textContent.includes('Dispatch context changed; no send attempted')`),10000);
    assert.equal(await driver.executeScript("return document.querySelector('#qa-late-selected-file').files.length"),1);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'Late selected file input must block queued Send');
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    // A React-style rerender can leave the prepared editor connected but
    // hidden, while a different visible editor replaces it in the same form.
    // Presence of a single visible editor is insufficient; identity must match.
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/replaced-editor`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('draft')})`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Must not send from an old editor';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await emit('idle',0,60,'observed','fresh','/c/replaced-editor');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      "return document.getElementById('prompt-textarea').textContent==='Must not send from an old editor'"),10000);
    await driver.executeScript(
      "const old=document.getElementById('prompt-textarea');old.style.display='none';"+
      "const replacement=document.createElement('div');replacement.id='qa-replacement-editor';"+
      "replacement.setAttribute('contenteditable','true');replacement.setAttribute('role','textbox');"+
      "old.after(replacement)");
    await waitNote('Composer changed before Send; no send attempted');
    assert.equal(await driver.executeScript(
      "return document.querySelectorAll('[contenteditable=true][role=textbox]').length"),2);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    qaStage='cross-route-collision-lease';
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/c/cross-route-owner`);
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Owner of exact synthetic conversation ID';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await emit('idle',0,70,'observed','fresh','/c/cross-route-owner');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await emit('generating',1,71,'observed','fresh','/c/cross-route-owner');
    await waitNote('Waiting for confirmed response completion');
    const crossRouteOwner=await driver.getWindowHandle();
    await driver.switchTo().newWindow('tab');
    const alternateRoute='/g/g-project/c/cross-route-owner';
    await driver.get(`http://127.0.0.1:${server.address().port}${alternateRoute}`);
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Project-route competing prompt';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    const crossRouteContender=await driver.getWindowHandle();
    await emit('idle',0,72,'observed','fresh',alternateRoute);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitNote('Another tab owns this conversation');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').textContent"),'');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.switchTo().window(crossRouteOwner);
    await emit('finished',1,72,'inferred','fresh','/c/cross-route-owner');
    await waitNote('Queue completed');
    await driver.switchTo().window(crossRouteContender);
    await emit('idle',0,73,'observed','fresh',alternateRoute);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await emit('generating',1,74,'observed','fresh',alternateRoute);
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',1,75,'inferred','fresh',alternateRoute);
    await waitNote('Queue completed');
    assert.deepEqual(await driver.executeScript('return window.__sent'),
      ['Project-route competing prompt']);

    qaStage='rapid-authenticated-terminal';
    // In this synthetic route, polling is deliberately slower than the
    // arrival of the two authenticated epoch transitions.
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rapid-terminal');
    await driver.wait(async()=>await driver.executeScript('return Boolean('+hud('run')+')&&document.documentElement.dataset.qaSignalProviderReady==="true"'),12000);
    for(const [index,prompt] of ['Rapid synthetic A','Rapid synthetic B'].entries()){
      await driver.executeScript('const el='+hud('draft')+';el.value=arguments[0];el.dispatchEvent(new Event("input",{bubbles:true}))',prompt);
      await driver.executeScript('return '+hud('add')+'.click()');
      // Don't start a two-prompt scenario while the test itself has only
      // submitted one asynchronous Add operation to extension storage.
      await driver.wait(async()=>await driver.executeScript(
        'return '+hud('count')+'.textContent===arguments[0]',(index+1)+' queued'),9000);
    }
    await emit('idle',0,80,'observed','fresh','/c/rapid-terminal');
    await driver.executeScript('return '+hud('run')+'.click()');
    qaStage='rapid-first-send';
    await waitSends(1);
    qaStage='rapid-first-provider';
    await emit('generating',1,81,'observed','fresh','/c/rapid-terminal');
    await emit('finished',1,82,'observed','fresh','/c/rapid-terminal');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').innerText"),
      'Rapid synthetic A','Authenticated busy and terminal must precede React clearing');
    await driver.executeScript('window.__qaPendingClear()');
    qaStage='rapid-second-send';
    await waitSends(2);
    await emit('generating',2,83,'observed','fresh','/c/rapid-terminal');
    await emit('finished',2,84,'observed','fresh','/c/rapid-terminal');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').innerText"),
      'Rapid synthetic B','Second response proof must be captured before clear');
    await driver.executeScript('window.__qaPendingClear()');
    qaStage='rapid-final-completion';
    await waitNote('Queue completed');
    assert.deepEqual(await driver.executeScript('return window.__sent'),
      ['Rapid synthetic A','Rapid synthetic B']);

    qaStage='manual-authenticated-rule-proposal';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/manual-rule-review');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
    await driver.executeScript("document.documentElement.dataset.chatSignalsState='finished'");
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'A forged page DOM phase must not create a conditional action');
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'Opting in must not replay a prior unverified page status');
    await emit('finished',1,90,'observed','fresh','/c/manual-rule-review');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /Synthetic approved follow-up/);
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /offered · synthetic-followup · finished · propose/);
    assert.equal(await driver.executeScript(`return ${hud('rules-audit')}.textContent.includes('Synthetic approved follow-up')`),false,
      'Audit cannot contain proposed message text');
    assert.equal(await driver.executeScript(`return ${hud('rules-audit')}.textContent.includes('/c/manual-rule-review')`),false);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued',
      'Authenticated proposal cannot enqueue without explicit local approval');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued' && ${hud('rules-approve')}.hidden`),10000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'Approval queues the proposed text but cannot click Send');
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /approved · synthetic-followup · finished · propose/);
    await driver.executeScript("history.pushState({},'', '/c/rule-other-chat')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='0 queued' && ${hud('rules-toggle')}.textContent==='Enable previews'`),10000);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'SPA navigation must invalidate consent and any pending proposal');
    assert.equal(await driver.executeScript(`return ${hud('rules-audit-count')}.textContent`),'0',
      'Metadata audit from an earlier conversation cannot appear after SPA navigation');
    await driver.executeScript("history.pushState({},'', '/c/manual-rule-review')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(`return ${hud('rules-toggle')}.textContent`),
      'Enable previews','Returning to a chat requires fresh preview consent');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='1 queued'`),12000);
    assert.equal(await driver.executeScript(`return ${hud('rules-toggle')}.textContent`),
      'Enable previews','Rule previews must require fresh opt-in after browser reload');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);


    qaStage='conditional-proposal-preempts-next-send';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-preempts-next');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    for(const [index,prompt] of ['Original synthetic A','Original synthetic B'].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];d.dispatchEvent(new Event('input',{bubbles:true}));`,prompt);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0] && ${hud('draft')}.value===''`,
        (index+1)+' queued'),10000);
    }
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('idle',0,100,'observed','fresh','/c/rule-preempts-next');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitSends(1);
    await emit('generating',1,101,'observed','fresh','/c/rule-preempts-next');
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',1,102,'observed','fresh','/c/rule-preempts-next');
    await waitNote('Conditional proposal awaiting approval; queue paused');
    await driver.sleep(1000); // More than the executor's 350-ms next-send delay
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'Awaiting a user-reviewed conditional decision must cancel next Send');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    assert.equal(await driver.executeScript(`return !${hud('rules-approve')}.hidden`),true);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await waitNote('review-conditional-proposal');
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'Explicit Start cannot bypass pending conditional review');
    assert.equal(await driver.executeScript(`return !${hud('rules-approve')}.hidden`),true,
      'Denied Start must not dismiss or approve the offer');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='2 queued' && ${hud('rules-approve')}.hidden`),10000);
    assert.equal(await driver.executeScript('return window.__sent.length'),1,
      'Explicit approval adds a proposed message but never resumes dispatch');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='2 queued'`),12000);
    assert.equal(await driver.executeScript(`return ${hud('rules-toggle')}.textContent`),'Enable previews');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);



    qaStage='superseded-authenticated-rule-proposal';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-expiry');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('finished',1,120,'observed','fresh','/c/rule-expiry');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    await emit('generating',2,121,'observed','fresh','/c/rule-expiry');
    await waitNote('Conditional proposal expired');
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /expired · synthetic-followup · finished · propose/);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'A newer response epoch must revoke the prior proposal');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued',
      'A stale, programmatically clicked approval must not enqueue anything');
    await emit('finished',2,122,'observed','fresh','/c/rule-expiry');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);

    qaStage='inflight-rule-library-revocation';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-config-race');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaRuleMutationReady==='yes'&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('rules-toggle')}.textContent==='Loading rules'`),4000);
    await driver.executeScript("window.postMessage({kind:'qa-change-rule-config'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),5000);
    await driver.sleep(1500);
    assert.equal(await driver.executeScript(`return ${hud('rules-toggle')}.textContent`),
      'Enable previews','A stale read must never resurrect revoked policy consent');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
    await emit('finished',1,110,'observed','fresh','/c/rule-config-race');
    await driver.sleep(400);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'Policy mutation while reading must not produce a stale rule offer');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    qaStage='obsolete-policy-read-must-not-cancel-new-opt-in';
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('rules-toggle')}.textContent==='Loading rules'`),4000);
    await driver.executeScript(
      "document.documentElement.dataset.qaRuleMutationDone='pending';"+
      "window.postMessage({kind:'qa-change-rule-config',phase:'limit'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),5000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('rules-toggle')}.textContent==='Enable previews'`),4000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('rules-toggle')}.textContent==='Disable previews'`),4500);
    // The now-obsolete first read must not revoke this new consent while
    // its delayed callback catches up.
    await driver.sleep(1500);
    assert.equal(await driver.executeScript(`return ${hud('rules-toggle')}.textContent`),
      'Disable previews','Superseded rule-store reads cannot disable a later explicit opt-in');
    await emit('limit',2,111,'observed','fresh','/c/rule-config-race');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),/synthetic-changed/);
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);

    qaStage='authenticated-failure-interruption-limit-previews';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-terminal-errors');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaRuleMutationReady==='yes'&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    for(const [index,phase] of ['failed','interrupted','limit'].entries()){
      qaStage='conditional-'+phase+'-preview';
      await driver.executeScript(
        "document.documentElement.dataset.qaRuleMutationDone='pending';"+
        "window.postMessage({kind:'qa-change-rule-config',phase:arguments[0]},'*')",phase);
      await driver.wait(async()=>await driver.executeScript(
        "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),6000);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('rules-toggle')}.textContent==='Enable previews'`),7000);
      await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
      await waitNote('Conditional previews enabled');
      const epoch=index+1,seq=200+index*10;
      await emit(phase,epoch,seq,'observed','restored','/c/rule-terminal-errors');
      assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
        'A restored '+phase+' event cannot create a preview');
      await emit(phase,epoch,seq+1,'observed','fresh','/c/rule-terminal-errors');
      await driver.wait(async()=>await driver.executeScript(
        `return !${hud('rules-approve')}.hidden`),8000);
      assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
        /proposes pausing/);
      assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
      assert.equal(await driver.executeScript('return window.__sent.length'),0,
        'No terminal error branch may Send autonomously');
      await driver.executeScript(`return ${hud('rules-approve')}.click()`);
      await waitNote('Conditional pause approved');
      assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
      await emit(phase,epoch,seq+2,'observed','fresh','/c/rule-terminal-errors');
      assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
        'Duplicate terminal phase must not repeatedly propose actions');
      assert.equal(await driver.executeScript('return window.__sent.length'),0);
    }


    assert.equal(await driver.executeScript(`return ${hud('rules-audit-count')}.textContent`),'6',
      'Three offers and three explicit approvals produce only bounded metadata');
    assert.equal(await driver.executeScript(`return ${hud('rules-audit')}.textContent.includes('/c/')`),false);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    qaStage='conditional-audit-bounded';
    for(let n=0;n<8;n++){
      await emit('limit',4+n,300+n,'observed','fresh','/c/rule-terminal-errors');
      await driver.wait(async()=>await driver.executeScript(
        `return !${hud('rules-dismiss')}.hidden`),8000);
      await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    }
    const boundedAudit=await driver.executeScript(`return [...${hud('rules-audit')}.children].map(x=>x.textContent)`);
    assert.equal(boundedAudit.length,20,'Only the 20 most recent review outcomes may remain');
    assert.match(boundedAudit[0],/offered · synthetic-changed · interrupted · pause/,
      'Oldest metadata is discarded without changing newer events');
    assert.equal(boundedAudit.some(x=>x.includes('/c/')||x.includes('Synthetic delayed approval')),false);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);

    qaStage='conditional-approval-route-privacy';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-approval-route-race');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    // Put a synthetic propose rule back; this is a QA-only storage write
    // through the temporary rule configuration fixture, never a production
    // extension change or a request to the real provider.
    await driver.executeScript(
      "document.documentElement.dataset.qaRuleMutationDone='pending';"+
      "window.postMessage({kind:'qa-change-rule-config',phase:'failed',action:'propose'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),6000);
    // This QA-only configuration proposes a bounded synthetic message.
    // The delayed durable enqueue permits an actual route transition race.
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('failed',1,240,'observed','fresh','/c/rule-approval-route-race');
    await driver.wait(async()=>await driver.executeScript(`return !${hud('rules-approve')}.hidden`),8000);
    await driver.executeScript(
      "document.documentElement.dataset.qaDelayRuleApproval='yes';"+
      `${hud('rules-approve')}.click();`+
      "history.pushState({},'', '/c/rule-approval-new-chat');"+
      "window.dispatchEvent(new PopStateEvent('popstate'));");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='0 queued' && ${hud('rules-toggle')}.textContent==='Enable previews'`),10000);
    assert.equal(await driver.executeScript(`return ${hud('rules-audit-count')}.textContent`),'0',
      'Async old-route approval must not leak its audit into a new chat');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    await driver.executeScript("history.pushState({},'', '/c/rule-approval-route-race');window.dispatchEvent(new PopStateEvent('popstate'))");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='1 queued' && ${hud('rules-toggle')}.textContent==='Enable previews'`),10000);
    assert.equal(await driver.executeScript(`return ${hud('rules-audit-count')}.textContent`),'0');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);


    qaStage='conditional-dependency-and-skip-approval';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-dependency-approvals');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaRuleMutationReady==='yes'&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(
      "document.documentElement.dataset.qaRuleMutationDone='pending';"+
      "window.postMessage({kind:'qa-change-rule-config',mode:'dependencies'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),6000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('finished',1,401,'observed','fresh','/c/rule-dependency-approvals');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /skip-until-approved/,
      'Without a manually approved prerequisite, the skipIf candidate should be eligible');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    await emit('failed',2,402,'observed','fresh','/c/rule-dependency-approvals');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /first-approval/);
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await waitNote('Conditional pause approved');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
    await emit('finished',3,403,'observed','fresh','/c/rule-dependency-approvals');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /dependent/,
      'A successful explicit approval should satisfy dependsOn and suppress skipIf');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'A satisfied dependency can only enqueue; it can never implicitly Send');
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews disabled');
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('finished',4,404,'observed','fresh','/c/rule-dependency-approvals');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /skip-until-approved/,
      'A new opt-in must not inherit approved prerequisites from the previous policy session');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);


    qaStage='authenticated-monotonic-duration-preview';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-duration');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaRuleMutationReady==='yes'&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(
      "document.documentElement.dataset.qaRuleMutationDone='pending';"+
      "window.postMessage({kind:'qa-change-rule-config',mode:'duration'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),6000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    // Without an authenticated preceding busy phase, no duration value may
    // be manufactured from the terminal event or wall clock.
    await emit('finished',1,450,'observed','fresh','/c/rule-duration');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /duration-fallback/);
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    await emit('generating',2,451,'observed','fresh','/c/rule-duration');
    await driver.sleep(380);
    await emit('finished',2,452,'observed','fresh','/c/rule-duration');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /duration-observed/,
      'Only a fresh same-epoch busy-to-terminal interval may satisfy minDurationMs');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    await emit('finished',2,453,'observed','fresh','/c/rule-duration');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'Repeated terminal phase cannot initiate an additional timed proposal');
    await emit('generating',3,454,'observed','fresh','/c/rule-duration');
    await driver.sleep(380);
    await emit('finished',3,455,'observed','restored','/c/rule-duration');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
    await emit('finished',3,456,'observed','fresh','/c/rule-duration');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /duration-fallback/,
      'A restored terminal invalidates prior duration evidence for its response epoch');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    // A restored terminal closes epoch 4 without authentic busy-duration
    // evidence. A later busy under that SAME epoch cannot change history
    // into a newly timed completion; only the untimed fallback is eligible.
    await emit('finished',4,457,'observed','restored','/c/rule-duration');
    await emit('generating',4,458,'observed','fresh','/c/rule-duration');
    await driver.sleep(380);
    await emit('finished',4,459,'observed','fresh','/c/rule-duration');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /duration-fallback/,
      'Restored terminal must forbid reopening timed evidence in its old epoch');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    assert.equal(await driver.executeScript('return window.__sent.length'),0,
      'Authenticated timing evidence must never directly authorize Send');


    qaStage='conditional-durable-prerequisite';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-dependency-persistence');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaRuleMutationReady==='yes'&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(
      "document.documentElement.dataset.qaRuleMutationDone='pending';"+
      "window.postMessage({kind:'qa-change-rule-config',mode:'persisted-dependency'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),6000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('failed',1,470,'observed','fresh','/c/rule-dependency-persistence');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),/durable-first/);
    await driver.executeScript(
      "document.documentElement.dataset.qaRejectRuleAppend='yes';"+
      `${hud('rules-approve')}.click();`);
    await waitNote('Conditional proposal was not queued: queue-save-failed');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
    await emit('finished',2,471,'observed','fresh','/c/rule-dependency-persistence');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-dismiss')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /durable-fallback/,
      'A failed durable append must NOT satisfy a dependent rule or skip another');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    await driver.executeScript("document.documentElement.dataset.qaRejectRuleAppend='no'");
    await emit('failed',3,472,'observed','fresh','/c/rule-dependency-persistence');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),10000);
    await emit('finished',4,473,'observed','fresh','/c/rule-dependency-persistence');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /durable-next/,
      'Only a successfully saved prerequisite may unlock downstream proposals');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);


    qaStage='duration-freeze-on-first-terminal';
    await driver.switchTo().newWindow('tab');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rule-duration-freeze');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('rules-toggle')})&&document.documentElement.dataset.qaRuleMutationReady==='yes'&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    await driver.executeScript(
      "document.documentElement.dataset.qaRuleMutationDone='pending';"+
      "window.postMessage({kind:'qa-change-rule-config',mode:'duration-only'},'*')");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaRuleMutationDone==='yes'"),6000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await waitNote('Conditional previews enabled');
    await emit('generating',1,490,'observed','fresh','/c/rule-duration-freeze');
    await emit('finished',1,491,'observed','fresh','/c/rule-duration-freeze');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'A prompt completion faster than the minimum duration cannot trigger the rule');
    await driver.sleep(3250);
    await emit('finished',1,492,'observed','fresh','/c/rule-duration-freeze');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'The frozen first terminal duration cannot grow while already finished');
    assert.equal(await driver.executeScript(`return ${hud('rules-audit-count')}.textContent`),'0');
    assert.equal(await driver.executeScript('return window.__sent.length'),0);

    // A provider that resumes busy AFTER the first terminal using the SAME
    // response epoch must never manufacture fresh elapsed-time authority.
    // Previously this re-entry reset the clock, allowing a later same-epoch
    // terminal to satisfy minDurationMs despite the response already ending.
    await emit('generating',1,493,'observed','fresh','/c/rule-duration-freeze');
    await driver.sleep(3250);
    await emit('finished',1,494,'observed','fresh','/c/rule-duration-freeze');
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true,
      'Reopened busy in an already terminal epoch cannot create timed action');
    assert.equal(await driver.executeScript(`return ${hud('rules-audit-count')}.textContent`),'0',
      'Closed-epoch busy re-entry must not offer a review outcome');
    // A genuinely NEW response epoch may still establish its own interval.
    await emit('generating',2,495,'observed','fresh','/c/rule-duration-freeze');
    await driver.sleep(3250);
    await emit('finished',2,496,'observed','fresh','/c/rule-duration-freeze');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /duration-frozen/,
      'Next response epoch may independently qualify by elapsed duration');
    await driver.executeScript(`return ${hud('rules-dismiss')}.click()`);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);

    console.log('Headless FDE synthetic Signal: authenticated opt-in proposals, preemptive pause, and guarded sending and rule-revocation races, and failed/limit/interrupted policy review, and approved dependency/skip enforcement, and monotonic bounded duration evidence, and durable prerequisite rollback, and terminal clock freeze');
  }catch(error){
    let diagnostics='';
    if(qaStage.startsWith('rapid-')&&driver){
      try{diagnostics=JSON.stringify(await driver.executeScript(() => ({
        sent:window.__sent?.length,acks:window.__acks?.map(x=>({sequence:x.sequence,ok:x.result?.ok})),
        status:document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('status')?.textContent,
        queueCount:document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('count')?.textContent,
        editorLength:document.getElementById('prompt-textarea')?.innerText?.length,
        hasPendingClear:typeof window.__qaPendingClear==='function'
      })));}catch{}
    }
    throw new Error('stage '+qaStage+': '+error.message+(diagnostics?' diagnostic='+diagnostics:''));
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE Signal integration failed:',error.message);process.exitCode=1;});
