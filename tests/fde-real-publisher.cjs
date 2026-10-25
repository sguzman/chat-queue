'use strict';
// Real source-to-consumer Firefox transport; disposable localhost substitutions
// are restricted to this fixture. No account login, prompt upload or profile access.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder,By}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const qid='chat-queue@sguzman.github',sid='chat-signals@sguzman.github';
const cid='qa-queue-control@sguzman.github';
const origin=String.raw`if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;`;
const localOrigin=String.raw`if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url || tab.url || '')) return;`;
function patch(src,old,next){
  assert.equal(src.split(old).length,2,'QA substitution must match exactly one source declaration: '+old.slice(0,75));
  return src.replace(old,next);
}
function stageQueue(dir,root){
  const m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(m.browser_specific_settings.gecko.id,qid);
  m.content_scripts[0].matches=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  fs.cpSync(path.join(root,'options'),path.join(dir,'options'),{recursive:true});
  const cp=path.join(dir,'src/content.js');
  let qaQueueContent=patch(fs.readFileSync(cp,'utf8'),
    "attachShadow({mode:'closed'})","attachShadow({mode:'open'})");
  // QA-only: distinguish optimistic HUD count from completed storage write.
  qaQueueContent=patch(qaQueueContent,"    void write.then(()=>{",
    "    void write.then(()=>{"+
    "document.documentElement.dataset.qaSavedRoute=key;"+
    "document.documentElement.dataset.qaSavedItems=String(data.items.length);");
  // QA-only ephemeral policy for one intentionally selected test route.
  // Production rules still require the user's explicit saved Options policy.
  qaQueueContent=patch(qaQueueContent,
    "  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.",
    "  if(location.pathname==='/c/real-rule-deadline') {"+
    "void api.storage.local.set({'chatqueue:conditional-rules:v1':"+
    JSON.stringify({version:1,rules:[{version:1,id:'qa-real-timed-deadline',enabled:true,priority:90,when:{phase:'finished',minDurationMs:250,approvalDeadlineMs:3500},then:{type:'propose',text:'Synthetic real-provider deadline reply'}}]})+
    "}).then(()=>document.documentElement.dataset.qaDeadlineSeeded='yes');"+
    "}\n"+
    "  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.");
  qaQueueContent=patch(qaQueueContent,
    "  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.",
    "  if(location.pathname==='/c/real-active-deadline') {"+
    "void api.storage.local.set({'chatqueue:conditional-rules:v1':"+
    JSON.stringify({version:1,rules:[{version:1,id:'qa-real-generation-wait',enabled:true,priority:90,
      when:{phase:'generating',minDurationMs:1200},then:{type:'pause'}}]})+
    "}).then(()=>document.documentElement.dataset.qaActiveDeadlineSeeded='yes');"+
    "}\n"+
    "  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.");
  new Function(qaQueueContent); // Syntactic acceptance before temporary addon installation.
  fs.writeFileSync(cp,qaQueueContent);
  const bp=path.join(dir,'src/background.js');
  let bg=patch(fs.readFileSync(bp,'utf8'),origin,localOrigin);
  bg=patch(bg,"!change.url.startsWith('https://chatgpt.com/')",
    "!change.url.startsWith('http://127.0.0.1:')");
  // Deliberately allow the real publisher to emit its initial idle event
  // before Queue has a tab registration. Its one-shot sync must recover
  // that race without polling or granting a page-origin phase authority.
  bg=patch(bg,"      return currentRoute(sender).then(live=>{\n        if(live!==message.route)",
    "      return currentRoute(sender).then(async live=>{\n        if(message.route==='/c/sync-late')await new Promise(resolve=>setTimeout(resolve,1900));\n        if(live!==message.route)");
  // TEST-ONLY fixture seed. Production Queue still obtains all external
  // control grants from its explicit, durable user Options permission policy.
  bg=patch(bg,"  const grants = globalThis.ChatQueueGrants;",
    "  const grants = globalThis.ChatQueueGrants;\n"+
    "  void api.storage.local.set({[grants.KEY]:{version:2,grants:{"+
    JSON.stringify(cid)+":['control']}}});");
  // QA-only saved library. No rules are enabled without an explicit
  // per-conversation click on the real Queue preview opt-in control.
  bg=patch(bg,"  const RULE_PREFIX='chatqueue:external-rules:v1:';",
    "  void api.storage.local.set({'chatqueue:conditional-rules:v1':"+
    JSON.stringify({"version":1,"rules":[{"version":1,"id":"qa-real-complete","enabled":true,"priority":60,"when":{"phase":"finished"},"then":{"type":"propose","text":"Synthetic approved reply"}},{"version":1,"id":"qa-real-failure","enabled":true,"priority":50,"when":{"phase":"failed"},"then":{"type":"pause"}},{"version":1,"id":"qa-real-limit","enabled":true,"priority":40,"when":{"phase":"limit"},"then":{"type":"pause"}},{"version":1,"id":"qa-real-interrupt","enabled":true,"priority":30,"when":{"phase":"interrupted"},"then":{"type":"pause"}}]})+"});\n"+
    "  const RULE_PREFIX='chatqueue:external-rules:v1:';");
  fs.writeFileSync(bp,bg);
}
function stageProvider(dir,root){
  const m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(m.browser_specific_settings.gecko.id,sid);
  assert.ok(m.background.scripts.includes('src/queue-publisher.js'));
  assert.ok(m.content_scripts[0].js.includes('src/queue-publisher.js'));
  m.content_scripts[0].matches=['http://127.0.0.1/*'];
  m.host_permissions=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
  fs.cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  if(fs.existsSync(path.join(root,'icons')))fs.cpSync(path.join(root,'icons'),path.join(dir,'icons'),{recursive:true});
  const cp=path.join(dir,'src/color.js');
  fs.writeFileSync(cp,patch(fs.readFileSync(cp,'utf8'),
    "if(u.protocol!=='https:'||u.hostname!=='chatgpt.com')return null;",
    "if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')return null;"));
  const bp=path.join(dir,'src/background.js');
  let bg=patch(fs.readFileSync(bp,'utf8'),
    String.raw`!/^https:\/\/chatgpt\.com\//.test(sender.url||sender.tab.url||'')`,
    String.raw`!/^http:\/\/127\.0\.0\.1:\d+\//.test(sender.url||sender.tab.url||'')`);
  bg=patch(bg,"url.protocol==='https:'&&url.hostname==='chatgpt.com'?",
    "url.protocol==='http:'&&url.hostname==='127.0.0.1'?");
  fs.writeFileSync(bp,bg);
  // QA-only browser-visible metadata; never included in the real provider.
  const qaContentPath=path.join(dir,'src/content.js');
  let qaContent=fs.readFileSync(qaContentPath,'utf8');
  qaContent=patch(qaContent,
    "    lastQueuePublished=-1; // the next reconcile republishes the current epoch",
    "    document.documentElement.dataset.qaSyncReceived='yes';\n"+
    "    lastQueuePublished=-1; // the next reconcile republishes the current epoch");
  qaContent=patch(qaContent,"        queueSequence++;lastQueuePublished=r.changed;",
    "        queueSequence++;document.documentElement.dataset.qaPublishedSequence=String(queueSequence);lastQueuePublished=r.changed;");
  fs.writeFileSync(qaContentPath,qaContent);
}
// A third, disposable Firefox extension holds the positive control grant.
// Its page bridge exists only in this localhost fixture; Queue does not
// accept page-origin commands, and the native API verifies sender.id.
function stageAuthorizedClient(dir){
  const manifest={
    manifest_version:2,name:'Chat Queue CI authorized-control principal',
    version:'0.0.1',browser_specific_settings:{gecko:{id:cid}},
    background:{scripts:['background.js']},
    content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js']}]
  };
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir,'background.js'),
    "browser.runtime.onMessage.addListener((request,sender)=>{"+
    "if(request?.type!=='qa-authorized-start'||!Number.isInteger(sender.tab?.id))"+
    "return {ok:false,error:'invalid-fixture-origin'};"+
    "return browser.runtime.sendMessage("+JSON.stringify(qid)+
    ",{type:'chat-queue/v1',action:'start',tabId:sender.tab.id});"+
    "});");
  fs.writeFileSync(path.join(dir,'content.js'),
    "window.addEventListener('message',event=>{"+
    "if(event.source!==window||event.data?.kind!=='qa-authorized-start')return;"+
    "browser.runtime.sendMessage({type:'qa-authorized-start'})"+
    ".then(result=>window.postMessage({kind:'qa-authorized-result',"+
    "nonce:event.data.nonce,result},'*'))"+
    ".catch(()=>window.postMessage({kind:'qa-authorized-result',"+
    "nonce:event.data.nonce,result:{ok:false,error:'fixture-ipc-failed'}},'*'));"+
    "});");
}
const page=`<!doctype html><html><head><title>Provider Fixture</title></head><body>
<main><form><div id="prompt-textarea" role="textbox" contenteditable="true"></div>
<button type="button" data-testid="send-button">Send</button></form>
<section id="response-turns"></section></main>
<script>
window.__sendCount=0;
document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
  window.__sendCount++;
  const form=document.querySelector('main form');
  const stop=document.createElement('button');
  stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';
  form.append(stop);
  const turn=document.createElement('article');
  turn.dataset.testid='conversation-turn-'+window.__sendCount;
  const assistant=document.createElement('div');
  assistant.dataset.messageAuthorRole='assistant';
  turn.append(assistant);document.getElementById('response-turns').append(turn);
  document.getElementById('prompt-textarea').textContent='';
});
window.qaFinish=()=>{
  document.querySelector('[data-testid="stop-button"]')?.remove();
  const last=document.querySelector('#response-turns article:last-child [data-message-author-role="assistant"]');
  if(!last)throw Error('No response exists');
  const copy=document.createElement('button');copy.type='button';copy.setAttribute('aria-label','Copy');
  last.append(copy);
};
</script></body></html>`;
const hud=id=>`document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById(${JSON.stringify(id)})`;
async function main(){
  const binary=process.env.FDE_BINARY,provider=process.env.CHAT_SIGNALS_PROVIDER_SOURCE;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY required');
  if(!provider||!path.isAbsolute(provider)||!fs.existsSync(path.join(provider,'manifest.json')))
    throw Error('CHAT_SIGNALS_PROVIDER_SOURCE must be a checked-out pinned Chat Signals commit');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chatqueue-real-provider-'));
  const qdir=path.join(temp,'queue'),sdir=path.join(temp,'provider'),
    cdir=path.join(temp,'authorized-client');
  fs.mkdirSync(qdir);fs.mkdirSync(sdir);fs.mkdirSync(cdir);
  stageQueue(qdir,path.resolve(__dirname,'..'));
  stageProvider(sdir,provider);
  stageAuthorizedClient(cdir);
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);
  });
  let driver,stage='bootstrap';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    driver=await new Builder().forBrowser('firefox')
      .setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments('-headless')).build();
    assert.equal(await driver.installAddon(qdir,true),qid);
    assert.equal(await driver.installAddon(sdir,true),sid);
    assert.equal(await driver.installAddon(cdir,true),cid);
    const ready=async()=>driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}?.textContent.includes('Signal: idle') &&
        !${hud('status')}.textContent.includes('(unverified)')`),15000);
    // Firefox may activate a temporary add-on slightly after WebDriver
    // installAddon resolves. Preflight on an UNUSED route and retry boundedly
    // rather than mistaking a missing content script for a sync-protocol bug.
    // The real delayed-registration test still uses a fresh subsequent route.
    stage='temporary-addons-activation-preflight';
    let activated=false;
    for(let attempt=0;attempt<3&&!activated;attempt++){
      await driver.get('http://127.0.0.1:'+server.address().port+
        '/c/activation-preflight-'+attempt);
      try{
        await driver.wait(async()=>await driver.executeScript(() =>
          Boolean(document.querySelector('#chat-queue-extension-root')) &&
          Boolean(document.documentElement.dataset.chatSignalsState)),6500);
        activated=true;
      }catch{/* retry fresh synthetic route; do not Send */}
    }
    if(!activated)throw Error('Disposable Firefox add-ons did not both activate');
    stage='provider-published-before-queue-registration';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/sync-late');
    try{await ready();}
    catch(error){
      const diagnosis=await driver.executeScript(() => ({
        providerPhase:document.documentElement.dataset.chatSignalsState||null,
        providerReason:document.documentElement.dataset.chatSignalsReason||null,
        providerSyncReceived:document.documentElement.dataset.qaSyncReceived||null,
        publisherSequence:document.documentElement.dataset.qaPublishedSequence||null,
        queueMounted:Boolean(document.querySelector('#chat-queue-extension-root')),
        queueStatus:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('status')?.textContent?.slice(0,180)||null
      }));
      throw new Error('One-shot sync unverified: '+JSON.stringify(diagnosis)+'; '+error.message);
    }
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A missed initial provider event must recover through a one-shot sync, not Send');
    stage='restored-terminal-does-not-authorize-send';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/restored-history-123');
    await ready();
    // A genuine prior response populates the provider's own persisted state
    // ledger; a reload of the SAME tab must restore its historical terminal
    // epoch. No patched persistence code, synthetic records or fake events.
    await driver.executeScript(
      "document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),10000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='finished'"),10000);
    await driver.sleep(500);
    await driver.navigate().refresh();
    try{await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='finished'"),12000);}
    catch(error){
      const details=await driver.executeScript(() => ({
        providerPhase:document.documentElement.dataset.chatSignalsState||null,
        providerReason:document.documentElement.dataset.chatSignalsReason||null,
        providerSequence:document.documentElement.dataset.qaPublishedSequence||null,
        queueMounted:Boolean(document.querySelector('#chat-queue-extension-root')),
        queueStatus:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('status')?.textContent?.slice(0,160)||null
      }));
      throw Error('Historical provider state not restored: '+JSON.stringify(details)+'; '+error.message);
    }
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}?.textContent.includes('Signal: finished')`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic restored-epoch queued message';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('authenticated-chat-signals-required')`),8000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A historically restored terminal epoch cannot authorize a Queue Send');
    // A genuinely new user-response epoch is evidence of a fresh session.
    await driver.executeScript("document.getElementById('prompt-textarea').textContent='Synthetic manual send';document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='finished'"),9000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===2'),10000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/provider-test-123');
    stage='browser-attested-initial-phase';
    try{await ready();}
    catch(error){
      // Fixed-schema metadata only. Never include queue prompts or page text
      // in public CI diagnostics if source registration fails.
      const diagnostic=await driver.executeScript(() => ({
        providerPhase:document.documentElement.dataset.chatSignalsState||null,
        providerConfidence:document.documentElement.dataset.chatSignalsConfidence||null,
        queueMounted:Boolean(document.querySelector('#chat-queue-extension-root')),
        queueStatus:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('status')?.textContent?.replace(/\\s+/g,' ').slice(0,180)||null
      }));
      throw new Error('Verified source idle missing: '+JSON.stringify(diagnostic)+'; '+error.message);
    }
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    stage='three-epochs-no-stale-terminal-advancement';
    for(const [i,text] of ['Synthetic first message','Synthetic second message','Synthetic third message'].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('draft')}.value==='' && ${hud('count')}.textContent===arguments[0]`,
        (i+1)+' queued'),9000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===1'),11000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.sleep(900);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Second message cannot Send while first response remains active');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===2'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    // First reply's Copy control remains mounted, but belongs to an
    // earlier epoch. Its presence cannot authorize a third Send.
    await driver.sleep(900);
    assert.equal(await driver.executeScript('return window.__sendCount'),2,
      'Stale first-reply Copy cannot finish the second response epoch');
    assert.equal(await driver.executeScript(
      'return document.documentElement.dataset.chatSignalsState'),'generating');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===3'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.sleep(900);
    assert.equal(await driver.executeScript('return window.__sendCount'),3,
      'Two earlier Copy controls cannot finish the third response');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}?.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),3,
      'Three guarded Send clicks require three distinct terminal epochs');
    stage='long-running-provider-epoch-without-automatic-retry';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/long-provider-response');
    await ready();
    for(const [index,text] of [
      'Synthetic long response first item',
      'Synthetic long response pending item'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0]`,
        (index+1)+' queued'),9500);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),10500);
    // The sender has legitimately been generating for >15s. Its absence
    // of newer events is not evidence that the first response completed;
    // it also must not cause any queued retry or premature second Send.
    await driver.sleep(16600);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Long generating response cannot advance, duplicate or retry');
    assert.equal(await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState"),'generating');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===2'),13000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9500);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),2);
    stage='authorized-third-party-control-start';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/authorized-api-123');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic authorized control API prompt';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A queued item cannot start before a human or authorized client acts');
    await driver.executeScript(() => {
      window.__qaControlResults=[];
      window.addEventListener('message',e=>{
        if(e.data?.kind==='qa-authorized-result')window.__qaControlResults.push(e.data);
      });
      window.postMessage({kind:'qa-authorized-start',nonce:1},'*');
    });
    await driver.wait(async()=>await driver.executeScript(
      "return window.__qaControlResults.some(x=>x.nonce===1)"),10000);
    const authorized=await driver.executeScript(
      "return window.__qaControlResults.find(x=>x.nonce===1).result");
    assert.equal(authorized?.ok,true,
      'Granted control principal must be able to explicitly Start');
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    await driver.uninstallAddon(cid);
    stage='real-provider-success-conditional-review';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/conditional-real-success');
    await ready();
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews enabled')`),9000);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
    await driver.executeScript("document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),9000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /Synthetic approved reply/);
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /offered · qa-real-complete · finished · propose/);
    assert.equal(await driver.executeScript(
      `return ${hud('rules-audit')}.textContent.includes('Synthetic approved reply')`),false,
      'Conditional metadata audit must omit proposed prompt text');
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued',
      'Provider completion alone cannot enqueue or Send proposed text');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued' &&
        ${hud('rules-approve')}.hidden`),9000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Only explicit Approval may enqueue; it never clicks Send');
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews disabled')`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===2'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),12000);

    stage='real-provider-failure-conditional-review';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/conditional-real-failure');
    await ready();
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews enabled')`),9000);
    await driver.executeScript("document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript(()=>{
      const alert=document.createElement('div');
      alert.setAttribute('role','alert');alert.textContent='Error in input stream.';
      document.querySelector('main').prepend(alert);
    });
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),9000);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /qa-real-failure/);
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /offered · qa-real-failure · failed · pause/);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional pause approved')`),9000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
    for(const [phase,notice,ruleId] of [
      ['limit','You have reached the maximum conversation length.','qa-real-limit'],
      ['interrupted','Connection interrupted. Waiting for the complete answer.','qa-real-interrupt']
    ]){
      stage='real-provider-'+phase+'-conditional-review';
      await driver.get('http://127.0.0.1:'+server.address().port+'/c/conditional-real-'+phase);
      await ready();
      await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('status')}.textContent.includes('Conditional previews enabled')`),9500);
      await driver.executeScript("document.querySelector('[data-testid=send-button]').click()");
      await driver.wait(async()=>await driver.executeScript(
        "return document.documentElement.dataset.chatSignalsState==='generating'"),9500);
      await driver.executeScript(text=>{
        const alert=document.createElement('div');
        alert.setAttribute('role','alert');alert.textContent=text;
        document.querySelector('main').prepend(alert);
      },notice);
      await driver.wait(async()=>await driver.executeScript(
        `return !${hud('rules-approve')}.hidden`),10000);
      assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
        new RegExp(ruleId));
      assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
        new RegExp('offered · '+ruleId+' · '+phase+' · pause'));
      assert.equal(await driver.executeScript('return window.__sendCount'),1);
      await driver.executeScript(`return ${hud('rules-approve')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('status')}.textContent.includes('Conditional pause approved')`),9500);
      assert.equal(await driver.executeScript('return window.__sendCount'),1,
        'Conditional review cannot send another prompt without separate Start');
      assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
    }
    stage='real-provider-manual-failure-recovery';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/manual-rule-recovery');
    await ready();
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews enabled')`),9000);
    for(const [index,text] of [
      'Synthetic response deliberately failed',
      'Synthetic pending after manually approved recovery'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0] &&
          ${hud('draft')}.value==='' `,(index+1)+' queued'),10000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),11000);
    await driver.executeScript(()=>{
      const alert=document.createElement('div');
      alert.id='qa-recovery-error';alert.setAttribute('role','alert');
      alert.textContent='Error in input stream.';
      document.querySelector('main').prepend(alert);
    });
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden &&
        ${hud('rules-note')}.textContent.includes('qa-real-failure')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Failure must not automatically retry an already-clicked message');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional pause approved')`),9000);
    await driver.sleep(500);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    // A failed Chat Signals epoch is not fresh ready authority. Recovery
    // requires a distinct trusted manual submission that itself completes;
    // the Queue must neither fabricate idle nor retry the failed prompt.
    stage='real-provider-recovery-user-submission';
    await driver.executeScript(()=>{
      document.getElementById('qa-recovery-error').remove();
      document.querySelectorAll('[data-testid="stop-button"]').forEach(x=>x.remove());
      document.getElementById('prompt-textarea').textContent='Synthetic manual recovery message';
    });
    await (await driver.findElement(By.css('[data-testid="send-button"]'))).click();
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===2'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),11000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='finished'"),11000);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.sleep(550);
    assert.equal(await driver.executeScript('return window.__sendCount'),2,
      'Manual source recovery must not autonomously send the queued next item');
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews disabled')`),9000);
    stage='real-provider-recovery-explicit-queue-start';
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===3'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),3,
      'Exactly one additional Queue Send is permitted after manual recovery and Start');
    stage='scoped-project-route-isolation';
    // The preceding controlled-API and long-response scenarios navigate to
    // other chats. Set an explicit known starting route instead of inheriting
    // whichever route a previous case left selected.
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/provider-test-123');
    await ready();
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='0 queued'`),9000);
    // An unsubmitted prompt from the prior chat must remain local when
    // navigating to a project conversation with an independently attested
    // provider route and document.
    stage='scoped-origin-queue-durable';
    await driver.executeScript(`const d=${hud('draft')};d.value='Pending in previous synthetic chat';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued' &&
        document.documentElement.dataset.qaSavedRoute?.endsWith('/c/provider-test-123') &&
        document.documentElement.dataset.qaSavedItems==='1'`),9000);
    stage='scoped-spa-project-transition';
    const projectRoute='/g/g-p-synthetic123/c/project-chat-123';
    const priorSendClicks=await driver.executeScript('return window.__sendCount');
    // Model a React/History API route transition inside the SAME document.
    // A trusted link click settles pushState after 90ms; neither add-on may
    // confuse the old document's queue with the new project's scoped route.
    await driver.executeScript(route=>{
      const link=document.createElement('a');
      link.id='qa-project-navigation';link.href=route;
      link.textContent='Synthetic project destination';
      link.addEventListener('click',event=>{
        event.preventDefault();
        setTimeout(()=>{
          history.pushState({},'',route);
          document.getElementById('response-turns').replaceChildren();
        },90);
      });
      document.body.append(link);
    },projectRoute);
    await (await driver.findElement(By.id('qa-project-navigation'))).click();
    await driver.wait(async()=>await driver.executeScript(
      `return location.pathname===arguments[0] &&
        ${hud('count')}?.textContent==='0 queued' &&
        ${hud('status')}?.textContent.includes('Signal: idle') &&
        !${hud('status')}.textContent.includes('(unverified)')`,projectRoute),16000);
    assert.equal(await driver.executeScript('return window.__sendCount'),priorSendClicks,
      'A SPA route transition must never send the old queued item');
    stage='scoped-project-queue-durable';
    await driver.executeScript(`const d=${hud('draft')};d.value='Single scoped project prompt';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued' &&
        document.documentElement.dataset.qaSavedRoute?.endsWith('/c/project-chat-123') &&
        document.documentElement.dataset.qaSavedItems==='1'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===arguments[0]',priorSendClicks+1),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),priorSendClicks+1);
    stage='scoped-return-retains-original-queue';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/provider-test-123');
    await ready();
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued',
      'Original conversation retains its own unsubmitted queue after project visit');
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Returning to another route must not automatically send its pending prompt');
    // Switch to an unused conversation for the disconnected-provider check,
    // preserving all previous queues without editing or clearing them.
    stage='manual-pause-does-not-resume';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/manual-pause-123');
    await ready();
    for(const [index,text] of [
      'Synthetic before manual pause','Synthetic after manual pause'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0]`,
        (index+1)+' queued'),9000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    // Pausing during initial post-click verification is intentionally
    // ambiguous. Exercise the separate, confirmed-awaiting response case.
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),9500);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Manually paused')`),7000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Signal: finished')`),10000);
    await driver.sleep(850);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Manually paused Queue cannot automatically send the next prompt on completion');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===2'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),2,
      'An explicit second Start resumes once; it never duplicates either Send');
    stage='trusted-user-stop-keeps-queue-paused';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/cancel-response-123');
    await ready();
    for(const [index,text] of [
      'Synthetic user-cancelled response','Synthetic item held after Stop'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0]`,
        (index+1)+' queued'),9000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),9500);
    // Real WebDriver user interaction, not a fabricated provider message:
    // the Stop control triggers Chat Signals' cancellation observer.
    await (await driver.findElement(By.css('[data-testid="stop-button"]'))).click();
    await driver.executeScript("document.querySelector('[data-testid=stop-button]')?.remove()");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Response cancelled; press Start to continue')`),10000);
    await driver.sleep(900);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'A trusted Stop action cannot resume or retry subsequent queued messages');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    // A deliberate second Start must work after cancellation; retaining the
    // old awaiting flag would strand the next item indefinitely.
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===2'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),2);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')}) && ${hud('count')}.textContent==='0 queued'`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Reload after cancellation and deliberate restart must not replay Sends');
    // These are actual provider-classified visible response failures, not
    // forged extension events. Existing response authorization must be
    // cancelled, and neither a new terminal nor an old Start may send again.
    for(const [phase,notice] of [
      ['failed','Error in input stream.'],
      ['interrupted','Connection interrupted. Waiting for the complete answer.'],
      ['limit','You have reached the maximum conversation length.']
    ]){
      stage='visible-provider-'+phase+'-pauses-active-queue';
      await driver.get('http://127.0.0.1:'+server.address().port+'/c/source-error-'+phase);
      await ready();
      for(const [index,text] of [
        'Synthetic source-'+phase+' first item',
        'Synthetic source-'+phase+' pending next item'
      ].entries()){
        await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
        await driver.executeScript(`return ${hud('add')}.click()`);
        await driver.wait(async()=>await driver.executeScript(
          `return ${hud('count')}.textContent===arguments[0]`,
          (index+1)+' queued'),9000);
      }
      await driver.executeScript(`return ${hud('run')}.click()`);
      await driver.wait(async()=>await driver.executeScript('return window.__sendCount===1'),12000);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),9500);
      await driver.executeScript(text=>{
        const alert=document.createElement('div');
        alert.setAttribute('role','alert');
        alert.textContent=text;
        document.querySelector('main').prepend(alert);
      },notice);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('status')}.textContent.includes(arguments[0])`,
        'Paused on '+phase),13000);
      await driver.sleep(800);
      assert.equal(await driver.executeScript('return window.__sendCount'),1,
        phase+' must not dispatch the next queued item');
      assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),
        '1 queued','The already-clicked message must not be retried');
      await driver.navigate().refresh();
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}?.textContent==='1 queued'`),13000);
      assert.equal(await driver.executeScript('return window.__sendCount'),0,
        phase+' must remain paused and not retry on reload');
    }
    stage='real-provider-inflight-reload-does-not-resume';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/inflight-reload-123');
    await ready();
    for(const [index,text] of [
      'Synthetic first response interrupted by page reload',
      'Synthetic next prompt must not start automatically'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0]`,
        (index+1)+' queued'),9000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),12000);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    // A real page reload discards the volatile run grant while retaining the
    // already-clicked item in submitted history. A new provider registration
    // may report idle, but it must not reactivate the second queued Send.
    await driver.navigate().refresh();
    // A generating response can restore as historical/uncertain, not fresh
    // idle. Only require the HUD and durable pending queue to reappear;
    // no provider phase can reinstate the previous volatile Start grant.
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('status')}) && ${hud('count')}?.textContent==='1 queued'`),13000);
    assert.match(await driver.executeScript(`return ${hud('status')}.textContent`),/Paused/);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.sleep(900);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Reload during an attributable response cannot auto-send the remaining prompt');
    stage='real-provider-hidden-composer-never-sends';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/hidden-composer');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic hidden-composer test';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    // visibility:hidden retains layout rectangles but is not a usable editor.
    await driver.executeScript(
      "document.getElementById('prompt-textarea').style.visibility='hidden'");
    assert.equal(await driver.executeScript(
      "return document.getElementById('prompt-textarea').getClientRects().length>0"),true);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Composer is missing or ambiguous')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    // Neither an opacity-zero ancestor nor aria-hidden/inert form is an
    // actionable composer, even though the editor itself has layout rects.
    for(const mode of ['opacity','aria-hidden','inert','offscreen']){
      await driver.executeScript(mode=>{
        const form=document.querySelector('main form');
        const editor=document.getElementById('prompt-textarea');
        editor.style.visibility='visible';
        editor.style.position='';
        editor.style.left='';
        form.style.opacity='';
        form.removeAttribute('aria-hidden');
        form.removeAttribute('inert');
        if(mode==='opacity')form.style.opacity='0';
        if(mode==='aria-hidden')form.setAttribute('aria-hidden','TRUE');
        if(mode==='inert')form.setAttribute('inert','');
        if(mode==='offscreen'){editor.style.position='fixed';editor.style.left='-10000px';}
      },mode);
      await driver.executeScript(`return ${hud('run')}.click()`);
      // A previous iteration leaves the same error text in the HUD.
      // Let the 350ms dispatch timer execute before accepting that note as
      // evidence of this iteration's denial, not merely the old one.
      await driver.sleep(600);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('status')}.textContent.includes('Composer is missing or ambiguous')`),9500);
      assert.equal(await driver.executeScript('return window.__sendCount'),0,
        'Non-actionable editor must never Send: '+mode);
    }

    stage='real-provider-hidden-send-never-clicks';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/hidden-send');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic hidden-button test';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(
      "document.querySelector('[data-testid=send-button]').style.visibility='hidden'");
    assert.equal(await driver.executeScript(
      "return document.querySelector('[data-testid=send-button]').getClientRects().length>0"),true);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Send button missing, disabled or ambiguous')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A script click on a hidden Send is forbidden');
    assert.equal(await driver.executeScript(
      `return ${hud('count')}.textContent`),'1 queued');
    await driver.executeScript(
      "document.querySelector('[data-testid=send-button]').style.visibility='visible'");
    await driver.sleep(700);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Revealing Send must not silently retry the uncertain item');

    stage='real-provider-transparent-send-never-clicks';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/transparent-send');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic transparent-button test';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(
      "document.querySelector('main form').style.opacity='0'");
    assert.equal(await driver.executeScript(
      "return document.querySelector('[data-testid=send-button]').getClientRects().length>0"),true);
    // The form is transparent but contenteditable also inherits its full
    // dispatch preflight. It must fail before journal or Send, preserving text.
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Composer is missing or ambiguous')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');

    // A script-triggered button.click() bypasses overlays. A covered editor
    // or Send control must never become a valid queue dispatch target.
    stage='real-provider-overlaid-composer-never-sends';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/overlaid-editor');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic overlaid editor';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    const cover=target=>driver.executeScript(selector=>{
      const el=document.querySelector(selector),rect=el.getBoundingClientRect();
      const overlay=document.createElement('div');
      overlay.id='qa-pointer-interceptor';
      Object.assign(overlay.style,{position:'fixed',left:rect.left+'px',
        top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',
        zIndex:'999999',pointerEvents:'auto'});
      document.body.append(overlay);
      return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.id;
    },target);
    assert.equal(await cover('#prompt-textarea'),'qa-pointer-interceptor');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Composer is missing or ambiguous')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');

    stage='real-provider-overlaid-send-never-clicks';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/overlaid-send');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic overlaid Send';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    assert.equal(await cover('[data-testid="send-button"]'),'qa-pointer-interceptor');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Send button missing, disabled or ambiguous')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Script clicks may not bypass an overlay covering Send');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.executeScript("document.getElementById('qa-pointer-interceptor').remove()");
    await driver.sleep(650);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Uncovering Send cannot retry an uncertain attempt automatically');

    stage='real-provider-sixteen-tabs-hidden-retention';
    const sixteenStartTab=await driver.getWindowHandle();
    const loadTabs=[];
    for(let i=0;i<16;i++){
      await driver.switchTo().newWindow('tab');
      const tab=await driver.getWindowHandle();
      loadTabs.push(tab);
      const route='/c/fde-sixteen-'+String(i).padStart(2,'0');
      await driver.get('http://127.0.0.1:'+server.address().port+route);
      await ready();
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,
        'Synthetic tab-isolated message '+i);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}?.textContent==='1 queued' &&
          document.documentElement.dataset.qaSavedRoute?.endsWith(arguments[0]) &&
          document.documentElement.dataset.qaSavedItems==='1'`,route),12000);
      assert.equal(await driver.executeScript('return window.__sendCount'),0,
        'A freshly registered hidden-tab candidate cannot Send automatically');
    }
    // The first tab has remained hidden through fifteen subsequent live
    // provider registrations and independent local storage writes.
    await driver.switchTo().window(loadTabs[0]);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}?.textContent==='1 queued'`),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Returning to an older tab must never replay an unstarted queue');
    assert.equal(await driver.executeScript(
      "return location.pathname"),'/c/fde-sixteen-00');
    await driver.switchTo().window(sixteenStartTab);
    stage='real-provider-authenticated-duration-and-approval-deadline';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/real-rule-deadline');
    await ready();
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaDeadlineSeeded==='yes'"),9500);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews enabled')`),9500);
    await driver.executeScript("document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),10000);
    await driver.sleep(550);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),9500);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /qa-real-timed-deadline/);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional proposal deadline expired')`),8500);
    assert.equal(await driver.executeScript(`return ${hud('rules-approve')}.hidden`),true);
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /expired · qa-real-timed-deadline · finished · propose/);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Expiring a real provider timed offer never Sends a proposed prompt');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued',
      'Expiring a real provider offer never enqueues text');
    stage='real-provider-active-generation-duration-review';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/real-active-deadline');
    await ready();
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaActiveDeadlineSeeded==='yes'"),10000);
    await driver.executeScript(`return ${hud('rules-toggle')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional previews enabled')`),9500);
    await driver.executeScript("document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),10000);
    await driver.wait(async()=>await driver.executeScript(
      `return !${hud('rules-approve')}.hidden`),8500);
    assert.match(await driver.executeScript(`return ${hud('rules-note')}.textContent`),
      /qa-real-generation-wait/);
    assert.match(await driver.executeScript(`return ${hud('rules-audit')}.textContent`),
      /offered · qa-real-generation-wait · generating · pause/);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Observed generation timeout may only offer review, never click Send');
    await driver.executeScript(`return ${hud('rules-approve')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Conditional pause approved')`),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.sleep(550);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Terminal response cannot resume a manually approved timeout pause');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
    stage='provider-removed-no-replay';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/provider-gone-123');
    await ready();
    await driver.uninstallAddon(sid);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${hud('run')})`),13000);
    await driver.executeScript(`const d=${hud('draft')};d.value='No provider no Send';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript("document.documentElement.dataset.chatSignalsState='finished'");
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('authenticated-chat-signals-required')`),8000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Without publisher, page-forged phase cannot authorize Send');
    await driver.uninstallAddon(qid);
    console.log('Actual Chat Signals publisher -> Chat Queue metadata, ordered synthetic sends, and missing-provider denial pass');
  }catch(error){throw Error('stage '+stage+': '+error.message);}
  finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE real provider failed:',error.message);process.exitCode=1});
