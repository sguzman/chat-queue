'use strict';
// Real source-to-consumer Firefox transport; disposable localhost substitutions
// are restricted to this fixture. No account login, prompt upload or profile access.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder,By,Key}=require('selenium-webdriver');
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
  // QA-only: expire idle authority quickly on a dedicated test route.
  // The production 15-second freshness guard stays unchanged.
  qaQueueContent=patch(qaQueueContent,
    'performance.now()-state.trustedAt<15000',
    "performance.now()-state.trustedAt<(['/c/expired-provider','/c/expired-finished'].includes(routeKey())?1000:15000)");
  // QA-only: simulate loss of Queue's background registry after first
  // completion in a two-message conversation. The real publisher and browser
  // remain independent, and only the disposable localhost fixture gets this
  // narrowly guarded message bridge. The production content script has none.
  qaQueueContent=patch(qaQueueContent,
    "  function publish() {",
    "  window.addEventListener('message',event=>{"+
    "if(event.source!==window||event.origin!==location.origin||"+
    "event.data?.kind!=='qa-force-queue-registry-loss'||"+
    "routeKey()!=='/c/sequence-after-registry-loss')return;"+
    "void recoverRegistry();"+
    "});\n  function publish() {");
  // QA-only: the page's native click handler accepts Send, then the caller
  // faults before .click() returns. This must preserve the durable hold even
  // though the ordinary clicked=true statement is never reached. No fault
  // injection is present in the production content script.
  qaQueueContent=patch(qaQueueContent,
    "      clickStarted=true;send.click(); clicked=true;",
    "      clickStarted=true;send.click();"+
    "if(routeKey()==='/c/postclick-throws')throw new Error('QA fault after Send invocation');"+
    "clicked=true;");
  // QA ONLY: delay the earliest ownership preflight, before any queue
  // text reaches the real editable site field. A genuine WebDriver keypress
  // must revoke Queue control during this asynchronous boundary.
  qaQueueContent=patch(qaQueueContent,
    "      const ownership=await api.runtime.sendMessage({type:'chat-queue-internal/v1',",
    "      if(routeKey()==='/c/trusted-human-edit-during-ownership'){"+
    "document.documentElement.dataset.qaOwnershipDelay='yes';"+
    "await new Promise(resolve=>setTimeout(resolve,2400));"+
    "}"+
    "      const ownership=await api.runtime.sendMessage({type:'chat-queue-internal/v1',");
  // QA ONLY: widen the interval immediately before sealed Send authority
  // so WebDriver can perform a genuinely trusted edit to ChatGPT's composer.
  // This latency is present on one localhost route and never in production.
  qaQueueContent=patch(qaQueueContent,
    "      const permission=await api.runtime.sendMessage({type:'chat-queue-internal/v1',",
    "      if(['/c/trusted-human-edit-during-seal','/c/trusted-human-click-during-seal','/c/authorized-append-during-seal','/c/route-change-during-seal','/c/route-aba-after-journal','/c/site-script-click-during-seal','/c/page-form-submit-during-seal'].includes(routeKey())){"+
    "document.documentElement.dataset.qaSealDelay='yes';"+
    "document.documentElement.dataset.qaSealStarted=String(performance.now());"+
    "await new Promise(resolve=>setTimeout(resolve,"+
    "(routeKey()==='/c/route-aba-after-journal'?7600:2400)));"+
    "}"+
    "      const permission=await api.runtime.sendMessage({type:'chat-queue-internal/v1',");
  // QA-only: hold after Queue filled the real editor and RESERVED its
  // durable Send marker but BEFORE waitForSend can locate a ready button.
  // This creates the asynchronous gap where an earlier direct listener on
  // the Send button could miss a competing site click or requestSubmit().
  qaQueueContent=patch(qaQueueContent,
    "      send=await waitForSend(current.form,()=>state.running&&sameAttempt()&&",
    "      if(['/c/page-click-before-send-ready','/c/page-submit-before-send-ready','/c/keyboard-enter-before-send-ready','/c/keyboard-shift-enter-before-send-ready'].includes(routeKey())){"+
    "document.documentElement.dataset.qaSendReadyGap='yes';"+
    "await new Promise(resolve=>setTimeout(resolve,2400));"+
    "}"+
    "      send=await waitForSend(current.form,()=>state.running&&sameAttempt()&&");
  // Localhost fixture only: privately inspect whether a real metadata-only
  // Send hold was committed, without sending its UUID or stored prompts to
  // the page. Production Queue never offers this inspection bridge.
  qaQueueContent=patch(qaQueueContent,
    "  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.",
    "  window.addEventListener('message',event=>{"+
    "if(event.source!==window||event.origin!==location.origin||"+
    "event.data?.kind!=='qa-inspect-durable-hold')return;"+
    "const id=contract.assignedConversationId(routeKey());"+
    "const key='chatqueue:send-hold:v1:'+id;"+
    "void api.storage.local.get(key).then(data=>{"+
    "const h=data[key];"+
    "document.documentElement.dataset.qaDurableHold=String(Boolean("+
    "h&&h.version===1&&h.route===routeKey()&&"+
    "typeof h.holdId==='string'&&/^[a-f0-9-]{36}$/i.test(h.holdId)));"+
    "}).catch(()=>{document.documentElement.dataset.qaDurableHold='error';});"+
    "});\n"+
    "  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.");
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
    JSON.stringify(cid)+":['control','append']}}});");
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
    "if(!Number.isInteger(sender.tab?.id))"+
    "return {ok:false,error:'invalid-fixture-origin'};"+
    "const action=request?.type==='qa-authorized-start'?'start':"+
    "(request?.type==='qa-authorized-enqueue'?'enqueue':null);"+
    "if(!action)return {ok:false,error:'invalid-fixture-action'};"+
    "return browser.runtime.sendMessage("+JSON.stringify(qid)+
    ",{type:'chat-queue/v1',action,tabId:sender.tab.id,"+
    "...(action==='enqueue'?{payload:{text:request.text}}:{})});"+
    "});");
  fs.writeFileSync(path.join(dir,'content.js'),
    "window.addEventListener('message',event=>{"+
    "if(event.source!==window||event.origin!==location.origin||"+
    "!['qa-authorized-start','qa-authorized-enqueue'].includes(event.data?.kind))return;"+
    "browser.runtime.sendMessage({type:event.data.kind,text:event.data.text})"+
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
window.__sentPayloads=[];
window.__buttonClicks=0;
function qaSiteSend(){
  const editor=document.getElementById('prompt-textarea');
  window.__sentPayloads.push(editor.innerText||editor.textContent||'');
  window.__sendCount++;
  // The Send click is observable, but the synthetic site never produces
  // a busy/accepted response on this deliberately ambiguous test route.
  if(location.pathname==='/c/unconfirmed-click')return;
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
}
document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
  window.__buttonClicks++;
  // This route models a native <button type=submit>: the actual submit
  // handler owns the send, not a separate click callback.
  if(location.pathname!=='/c/queue-own-form-submit')qaSiteSend();
});
// Browser-trusted keyboard shortcut: a React-style host may call its
// own Send routine without firing click OR submit. This must not be
// confused with a provably safe pre-click failure by the extension.
document.getElementById('prompt-textarea').addEventListener('keydown',event=>{
  if(location.pathname!=='/c/keyboard-enter-before-send-ready'||
     event.key!=='Enter'||event.shiftKey||!event.isTrusted)return;
  event.preventDefault();
  window.__trustedShortcutSend=(window.__trustedShortcutSend||0)+1;
  qaSiteSend();
});
document.querySelector('main form').addEventListener('submit',event=>{
  if(!['/c/page-form-submit-during-seal','/c/page-submit-before-send-ready','/c/queue-own-form-submit'].includes(location.pathname))return;
  event.preventDefault();
  window.__submitCount=(window.__submitCount||0)+1;
  qaSiteSend();
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
      `return ${hud('status')}?.textContent.includes('Signal: finished (historical)')`),12000);
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic restored-epoch queued message';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Historical response is not Send authorization')`),8000);
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
    stage='two-message-manual-continuation-after-registry-loss';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/sequence-after-registry-loss');
    await ready();
    for(const [index,message] of ['First provider-authenticated queue item',
      'Second provider-authenticated queue item'].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,message);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${hud('count')}.textContent===arguments[0]+' queued'`,index+1),9000);
    }
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='2 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Waiting for confirmed response completion')`),9000);
    // Explicitly pause while a genuine attributed response is generating:
    // the in-flight response still completes, but pending item 2 cannot Send.
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Paused')`),7000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('history')}.textContent.includes('finished: First provider-authenticated queue item')`),13000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),8000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['First provider-authenticated queue item']);
    await driver.sleep(500);
    // The callback below executes exactly the production registry-loss
    // recovery path, without spoofing provider authorization or touching a
    // browser profile. Real event-page restart is separately tested.
    await driver.executeScript(
      "window.postMessage({kind:'qa-force-queue-registry-loss'},location.origin)");
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Signal registry restarted; manually resume after reconnect')`),8000);
    await driver.sleep(850);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Registry recovery must not auto-send the remaining message');
    assert.equal(await driver.executeScript(
      `return ${hud('count')}.textContent`),'1 queued',
      'Pending second item must survive registration recovery');
    // Only a subsequent explicit Start, reauthenticated with the real Chat
    // Signals publisher, can dispatch the second queued message.
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===2'),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['First provider-authenticated queue item','Second provider-authenticated queue item'],
      'Two messages must be sent in exact order exactly once');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),14000);
    assert.equal(await driver.executeScript('return window.__sendCount'),2,
      'No duplicate Send after completing the two-message recovery');
    stage='expired-idle-revalidated-by-deliberate-start';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/expired-provider');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Resynced authenticated idle reply';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    // There is NO provider heartbeat. Start must ask the real extension
    // publisher for a new verified snapshot instead of treating this expired
    // prior idle as durable Send authority or forcing the user to race.
    await driver.sleep(1800);
    const priorSequence=Number(await driver.executeScript(
      "return document.documentElement.dataset.qaPublishedSequence||0"));
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    const nextSequence=Number(await driver.executeScript(
      "return document.documentElement.dataset.qaPublishedSequence||0"));
    assert.ok(nextSequence>priorSequence,
      'Start after stale idle must receive an authenticated new publisher event');
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'An authenticated refresh must authorize at most one actual synthetic Send');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),12000);
    stage='expired-fresh-finished-revalidated-on-Start';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/expired-finished');
    await ready();
    await driver.executeScript(
      "document.getElementById('prompt-textarea').textContent='Manual preceding response';"+
      "document.querySelector('[data-testid=send-button]').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),10000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Signal: finished')`),12000);
    assert.equal(await driver.executeScript(
      `return ${hud('status')}.textContent.includes('(historical)')`),false,
      'Unreloaded current reply must have a fresh response epoch');
    await driver.executeScript(
      `const d=${hud('draft')};d.value='Queue after expired live finish';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    // This observed finished state is expired, but NOT historical. A single
    // explicit Start should resync fresh independent publisher evidence.
    await driver.sleep(1800);
    const finishedBefore=Number(await driver.executeScript(
      "return document.documentElement.dataset.qaPublishedSequence||0"));
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===2'),12000);
    const finishedAfter=Number(await driver.executeScript(
      "return document.documentElement.dataset.qaPublishedSequence||0"));
    assert.ok(finishedAfter>finishedBefore,
      'Expired current finished epoch must be revalidated through Chat Signals');
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Manual preceding response','Queue after expired live finish']);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),14000);
    stage='empty-prosemirror-break-must-not-be-treated-as-draft';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/empty-rich-editor');
    await ready();
    const emptyShape=await driver.executeScript(() => {
      const editor=document.getElementById('prompt-textarea');
      editor.innerHTML='<p><br class="ProseMirror-trailingBreak"></p>';
      return {textContent:editor.textContent,innerText:editor.innerText,
        structure:editor.querySelectorAll('p > br.ProseMirror-trailingBreak').length};
    });
    assert.equal(emptyShape.textContent,'');
    assert.equal(emptyShape.structure,1);
    assert.ok(emptyShape.innerText.length>0,
      'Native Firefox should reproduce nonempty innerText from an empty ProseMirror break');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript(`const d=${hud('draft')};d.value='Empty rich-text paragraph must permit Send';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Empty rich-text paragraph must permit Send']);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    stage='react-send-enables-after-input';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/react-late-send');
    await ready();
    await driver.executeScript(() => {
      const editor=document.getElementById('prompt-textarea');
      editor.addEventListener('input',()=>{
        const send=document.querySelector('[data-testid="send-button"]');
        send.disabled=true;
        setTimeout(()=>{send.disabled=false;},400);
      },{once:true});
    });
    await driver.executeScript(`const d=${hud('draft')};d.value='Wait for React enabled Send';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Wait for React enabled Send'],
      'The same Start gesture must wait for exact Send readiness, without retry');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);

    stage='queue-hud-obscures-site-send';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/queue-covers-send');
    await ready();
    const overlap=await driver.executeScript(() => {
      const host=document.getElementById('chat-queue-extension-root');
      const rect=host.getBoundingClientRect();
      const button=document.querySelector('[data-testid="send-button"]');
      button.style.position='fixed';
      button.style.left=(rect.left+18)+'px';
      button.style.top=(rect.top+80)+'px';
      button.style.zIndex='1';
      const bounds=button.getBoundingClientRect();
      return {hostHit:document.elementFromPoint(
        bounds.left+bounds.width/2,bounds.top+bounds.height/2)===host,
        top:rect.top,sendTop:bounds.top};
    });
    assert.equal(overlap.hostHit,true,
      'The production HUD must initially intercept the site Send pointer');
    await driver.executeScript(`const d=${hud('draft')};d.value='Uncover the site Send button safely';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Uncover the site Send button safely']);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);

    stage='three-epochs-no-stale-terminal-advancement';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/provider-test-123');
    await ready();
    const exactMessages=['Synthetic first message','  Síntesis — العربية 😀  ','Synthetic third message'];
    for(const [i,text] of exactMessages.entries()){
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
    // Capture what the actual synthetic Send button read BEFORE its handler
    // cleared the editor, rather than trusting the queue's own postcondition.
    // The test includes Unicode plus leading/trailing spaces; normalization
    // is limited to the exact browser NBSP/CRLF normalization permitted by
    // the production adapter. These are generated fixture strings only.
    const submitted=await driver.executeScript(()=>
      window.__sentPayloads.map(text=>text.replaceAll(String.fromCharCode(160),' ')
        .replaceAll(String.fromCharCode(13),'')));
    assert.deepEqual(submitted,exactMessages,
      'Queue must insert exactly the queued characters into the intended editor');
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
        if(e.source!==window||e.origin!==location.origin||
           e.data?.kind!=='qa-authorized-result')return;
        window.__qaControlResults.push(e.data);
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
    stage='authorized-peer-append-during-sealed-send-rejected';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/authorized-append-during-seal');
    await ready();
    await driver.executeScript(() => {
      window.__qaControlResults=[];
      window.addEventListener('message',e=>{
        if(e.source!==window||e.origin!==location.origin||
           e.data?.kind!=='qa-authorized-result')return;
        window.__qaControlResults.push(e.data);
      });
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      shadow.getElementById('draft').value='First authorized-append race item';
      shadow.getElementById('add').click();
    });
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSealDelay==='yes'),10000);
    // A real separately installed, Firefox-authenticated peer submits the
    // Append while Queue is holding the durable uncertainty journal and
    // waiting for its sealed Send authorization. It must not mutate the
    // queue record or cause a second Send while the first attempt is active.
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-authorized-enqueue',nonce:2,
        text:'Rejected peer write during Send seal'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      window.__qaControlResults.some(x=>x.nonce===2)),10000);
    assert.deepEqual(await driver.executeScript(()=>
      window.__qaControlResults.find(x=>x.nonce===2).result),
      {ok:false,error:'dispatch-in-progress'},
      'Authorized peer cannot append during the in-flight Send journal');
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A concurrent rejected Append must not induce an early Send');
    await driver.wait(async()=>driver.executeScript('return window.__sendCount===1'),12000);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes('Waiting for confirmed response completion')),11000);
    // Once Queue has committed the first Send and is waiting for its real
    // publisher-confirmed terminal event, the same authorized peer may
    // enqueue a NEW item, but never send it before that event.
    stage='authorized-peer-append-while-generating-waits-for-completion';
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-authorized-enqueue',nonce:3,
        text:'Peer appended during first response'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      window.__qaControlResults.some(x=>x.nonce===3)),10000);
    assert.equal(await driver.executeScript(()=>
      window.__qaControlResults.find(x=>x.nonce===3).result?.ok),true,
      'Authorized peer must be able to append after the Send journal settles');
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),9000);
    await driver.sleep(650);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['First authorized-append race item'],
      'The peer item must wait for the first response to finish');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>driver.executeScript('return window.__sendCount===2'),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['First authorized-append race item','Peer appended during first response'],
      'Only the authorized post-journal peer item may be sent next, in order');
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes('Queue completed')),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),2,
      'No hidden replay after consecutive provider-confirmed responses');
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
    // The failed first Queue Send remains a durable, potentially accepted
    // remote action. A later *human* ChatGPT Send does not certify whether
    // that earlier prompt was delivered. Explicit transcript review is now
    // required before another automatic Queue Send in this conversation.
    stage='real-provider-recovery-reviewed-prior-send-hold';
    await driver.executeScript(`return ${hud('hold-review')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Check the ChatGPT transcript')`),9000);
    await driver.executeScript(`return ${hud('hold-review')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Prior Send hold released after deliberate review')`),9000);
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
      `return ${hud('status')}.textContent.includes('Response cancelled; review prior Send hold')`),10000);
    await driver.sleep(900);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'A trusted Stop action cannot resume or retry subsequent queued messages');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    // A Stop means the first queued prompt was already clicked. Closing
    // its response does NOT prove it never reached ChatGPT. The transcript
    // must be deliberately reviewed before a separate Start may proceed.
    await driver.executeScript(`return ${hud('hold-review')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Check the ChatGPT transcript')`),9000);
    await driver.executeScript(`return ${hud('hold-review')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Prior Send hold released after deliberate review')`),9000);
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
    // Real pinned Chat Signals is installed. A normal, browser-authorized
    // Queue click reaches the page's Send handler exactly once, but this
    // fixture deliberately does NOT clear the composer or emit a busy phase.
    // Thus neither a click nor elapsed time may be called acceptance. The
    // private uncertainty journal and durable hold must prevent blind retry
    // of this potentially delivered prompt, including after actual reload.
    stage='real-provider-unconfirmed-click-never-retries';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/unconfirmed-click');
    await ready();
    for(const [index,text] of [
      'Synthetic possibly accepted first click',
      'Synthetic following item must remain paused'
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
      `return ${hud('status')}.textContent.includes('Submission not confirmed; manual review required')`),11000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Synthetic possibly accepted first click'],
      'One ambiguous click must not dispatch the next queued message');
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'After a click without trusted busy evidence, the first item is uncertain');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued',
      'No item is silently dropped on failed acceptance');
    await driver.sleep(950);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Idle time must not trigger an automatic retry after an ambiguous click');
    // The site can report a response AFTER Queue has already timed out and
    // journaled the Send as uncertain (for example, during a long network
    // interruption). Drive real Chat Signals observation from late site DOM,
    // not by forging a provider message. Neither a fresh busy epoch nor a
    // later terminal event may resurrect the revoked Queue run grant.
    stage='late-real-provider-response-after-unconfirmed-click';
    await driver.executeScript(() => {
      const form=document.querySelector('main form');
      const stop=document.createElement('button');
      stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';
      form.append(stop);
      const turn=document.createElement('article');
      turn.dataset.testid='conversation-turn-1';
      const assistant=document.createElement('div');
      assistant.dataset.messageAuthorRole='assistant';
      turn.append(assistant);
      document.getElementById('response-turns').append(turn);
      document.getElementById('prompt-textarea').textContent='';
    });
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.chatSignalsState==='generating'),10000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.chatSignalsState==='finished'),10000);
    await driver.sleep(800);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'A late real-publisher terminal must never dispatch or replay an ambiguous Send');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length),1,
      'A late site response cannot silently resolve the uncertain journal');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('status')}) && ${hud('count')}?.textContent==='2 queued'`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Reload must not replay the potentially accepted Send');
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    await driver.sleep(800);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Restored provider idle cannot retry an unconfirmed previous click');

    stage='send-click-returns-with-error-never-releases-durable-hold';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/postclick-throws');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Post-click exception must not replay';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      "return window.__sendCount===1"),11000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('QA fault after Send invocation')`),11000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Post-click exception must not replay']);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'Exception after the actual Send invocation must keep the item uncertain');
    await driver.sleep(750);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'No automatic retry after the click path threw');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('status')}) && ${hud('count')}?.textContent==='1 queued'`),13000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'Uncertain journal must survive real document reload');
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Restored registration must never replay the already-clicked item');
    await driver.executeScript(`return ${hud('hold-review')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Check the ChatGPT transcript for a prior Send')`),9000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A surviving durable hold must require explicit second review before release');
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
    // These non-actionable ancestors must override the layout rects of the
    // editor. Attribute and disabled fieldset semantics are checked too.
    for(const mode of ['opacity','aria-hidden','aria-disabled','inert','fieldset','offscreen']){
      await driver.executeScript(mode=>{
        const form=document.querySelector('main form');
        const editor=document.getElementById('prompt-textarea');
        if(editor.parentElement?.id==='qa-disabled-fieldset'){
          editor.parentElement.replaceWith(editor);
        }
        editor.style.visibility='visible';
        editor.style.position='';
        editor.style.left='';
        form.style.opacity='';
        form.removeAttribute('aria-hidden');
        form.removeAttribute('aria-disabled');
        form.removeAttribute('inert');
        if(mode==='opacity')form.style.opacity='0';
        if(mode==='aria-hidden')form.setAttribute('aria-hidden','TRUE');
        if(mode==='aria-disabled')form.setAttribute('aria-disabled','true');
        if(mode==='inert')form.setAttribute('inert','');
        if(mode==='fieldset'){
          const fieldset=document.createElement('fieldset');
          fieldset.id='qa-disabled-fieldset';fieldset.disabled=true;
          editor.replaceWith(fieldset);fieldset.append(editor);
        }
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

    // The Send button starts enabled, but the page reacts to Queue's
    // insertion by disabling it in the editor's native input event. This
    // mutation happens AFTER composer selection and BEFORE the guarded
    // button lookup: a cached initial Send state would click unsafely.
    stage='real-provider-send-disabled-during-insertion';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/late-disabled-send');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic late-disabled button';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(()=>{
      const editor=document.getElementById('prompt-textarea');
      editor.addEventListener('input',()=>{
        if(editor.innerText==='Synthetic late-disabled button')
          document.querySelector('[data-testid="send-button"]').disabled=true;
      });
    });
    assert.equal(await driver.executeScript(
      "return document.querySelector('[data-testid=send-button]').disabled"),false,
      'Send must initially be actionable to exercise the late disable');
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelector('[data-testid=send-button]').disabled"),11000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Send button missing, disabled or ambiguous')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A button disabled by composer input must never be clicked');
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),[],
      'No Send payload may reach the site handler');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');
    await driver.executeScript(
      "document.querySelector('[data-testid=send-button]').disabled=false");
    await driver.sleep(750);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Re-enabling the control cannot revive the rejected dispatch');

    stage='pre-click-failure-releases-hold-after-durable-uncertain-save';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/preclick-hold');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Recover after provably pre-click failure';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(
      "document.querySelector('[data-testid=send-button]').disabled=true");
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Send button missing, disabled or ambiguous')`),11000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // The app must keep the item uncertain until explicit human review, but
    // the durable cross-tab hold was provably not a clicked Send.
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    const retryPreclick=await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item.uncertain [aria-label=\\\"Allow manually requested retry\\\"]')");
    await retryPreclick.click();
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Retry marked pending; press Start separately')`),10000);
    // Human independently reviews and clears text left by the aborted fill.
    await driver.executeScript(() => {
      document.getElementById('prompt-textarea').textContent='';
      document.querySelector('[data-testid=send-button]').disabled=false;
    });
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      'return window.__sendCount===1'),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Recover after provably pre-click failure']);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Manual retry after pre-click failure must never duplicate Send');

    stage='trusted-human-edit-before-ownership-never-overwrites';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/trusted-human-edit-during-ownership');
    await ready();
    await driver.executeScript(() => {
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      shadow.getElementById('draft').value='Queue should not replace my draft';
      shadow.getElementById('add').click();
    });
    await driver.wait(async()=>driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='1 queued'),9000);
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('run').click());
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaOwnershipDelay==='yes'),10000);
    await driver.findElement(By.id('prompt-textarea')).sendKeys('HUMAN DRAFT');
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('status')?.textContent
        .includes('Human interaction before composer handoff; no Send attempted')),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.equal(await driver.executeScript(
      "return document.getElementById('prompt-textarea').textContent"),'HUMAN DRAFT');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent),'1 queued');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length),0,
      'No uncertain journal is necessary when the preflight never reached the composer');
    await driver.sleep(450);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    stage='trusted-human-edit-during-sealed-preclick-never-sends';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/trusted-human-edit-during-seal');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Original Queue submission';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaSealDelay==='yes'"),10000);
    const siteEditor=await driver.findElement(By.id('prompt-textarea'));
    await siteEditor.sendKeys(' USER ADDED');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Dispatch context changed; no send attempted')`),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A human physically typing before sealed Send authority must cancel Queue');
    assert.equal(await driver.executeScript(
      "return document.getElementById('prompt-textarea').textContent.includes('USER ADDED')"),true,
      'Queue must preserve the human change rather than replacing the site draft');
    assert.equal(await driver.executeScript(
      `return ${hud('count')}.textContent`),'1 queued');
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'Interrupted preparation stays uncertain, never silently retries');
    await driver.sleep(500);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    stage='trusted-human-site-Send-during-Queue-seal-no-second-click';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/trusted-human-click-during-seal');
    await ready();
    await driver.executeScript(() => {
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      shadow.getElementById('draft').value='Human click while Queue waiting';
      shadow.getElementById('add').click();
    });
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),9000);
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('run').click());
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSealDelay==='yes'),10000);
    // This must be a REAL browser-generated user click, NOT executeScript
    // invoking element.click(). It races with the pending Queue seal.
    await driver.findElement(By.css('[data-testid="send-button"]')).click();
    await driver.wait(async()=>driver.executeScript(()=>
      window.__sendCount===1),9000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Human click while Queue waiting']);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length===1),12000);
    await driver.sleep(700);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Queue must not issue a SECOND site click after the human already clicked');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent),'1 queued');
    await driver.executeScript('window.qaFinish()');
    await driver.sleep(650);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'A terminal provider event cannot retry the human-submitted prompt');
    // A human Send also may have reached the network, even though Queue
    // itself never entered the scripted .click() path.
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);
    // Browser page-owned Send triggers an isTrusted=false click. The
    // competing activation can have remote effects even though it is not
    // a browser-trusted human gesture. Preserve uncertainty and metadata.
    stage='page-script-send-click-during-sealed-preflight';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/site-script-click-during-seal');
    await ready();
    for(const [index,text] of [
      'Synthetic page-script-initiated first Send',
      'Synthetic second item must never silently follow'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>driver.executeScript(expected=>
        document.querySelector('#chat-queue-extension-root').shadowRoot
          .getElementById('count').textContent===expected,
        (index+1)+' queued'),10000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSealDelay==='yes'),10000);
    const pageClickTrusted=await driver.executeScript(() => {
      const send=document.querySelector('[data-testid="send-button"]');
      let trusted=null;
      send.addEventListener('click',event=>{trusted=event.isTrusted;},{once:true});
      send.click(); // Script-origin click, not Selenium WebDriver user input.
      return trusted;
    });
    assert.equal(pageClickTrusted,false,
      'The test must demonstrate an untrusted script-initiated Send click');
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes(
          'Another Send may have submitted this prompt; review uncertain message')),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Synthetic page-script-initiated first Send'],
      'A separate script click may submit exactly one site message');
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Queue must not click a second time after the page script');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length),1);
    await driver.executeScript('window.qaFinish()');
    await driver.sleep(650);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Late authenticated terminal cannot resume the abandoned Queue attempt');
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);
    // Confirm the UUID hold was persisted rather than merely held in memory.
    // No hold-release confirmation or Retry is invoked by this test.
    await driver.navigate().refresh();
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='2 queued'),14000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Inspecting persisted Send hold never dispatches either prompt');

    // Queue had already filled its intended text and persisted a Send
    // hold. A competing site action arrives BEFORE React's send-button
    // readiness promise is allowed to settle; neither button.click() nor
    // form.requestSubmit() may release the potentially accepted Send hold.
    for(const kind of ['click','submit']){
      stage='foreign-'+kind+'-during-pre-send-readiness';
      const raceRoute='/c/page-'+kind+'-before-send-ready';
      await driver.get('http://127.0.0.1:'+server.address().port+raceRoute);
      await ready();
      const first='Synthetic pre-ready '+kind+' payload';
      for(const [index,text] of [first,'Keep second item pending'].entries()){
        await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
        await driver.executeScript(`return ${hud('add')}.click()`);
        await driver.wait(async()=>driver.executeScript(expected=>
          document.querySelector('#chat-queue-extension-root').shadowRoot
            .getElementById('count').textContent===expected,
          (index+1)+' queued'),10000);
      }
      await driver.executeScript(`return ${hud('run')}.click()`);
      await driver.wait(async()=>driver.executeScript(()=>
        document.documentElement.dataset.qaSendReadyGap==='yes' &&
        document.getElementById('prompt-textarea').innerText.length>0),11000);
      if(kind==='click'){
        await driver.executeScript(()=>
          document.querySelector('[data-testid="send-button"]').click());
      }else{
        await driver.executeScript(()=>
          document.querySelector('main form').requestSubmit());
        assert.equal(await driver.executeScript('return window.__submitCount'),1);
      }
      assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),[first]);
      await driver.wait(async()=>driver.executeScript(()=>
        document.querySelector('#chat-queue-extension-root').shadowRoot
          .getElementById('status').textContent.includes(
            'Another Send may have submitted this prompt; review uncertain message')),12000);
      assert.equal(await driver.executeScript('return window.__sendCount'),1,
        'The pre-ready foreign '+kind+' must not cause Queue to Send twice');
      assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued');
      assert.equal(await driver.executeScript(()=>
        document.querySelector('#chat-queue-extension-root').shadowRoot
          .querySelectorAll('.item.uncertain').length),1);
      await driver.executeScript(()=>
        window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
      await driver.wait(async()=>driver.executeScript(()=>
        document.documentElement.dataset.qaDurableHold==='true'),10000);
      await driver.executeScript('window.qaFinish()');
      await driver.sleep(550);
      assert.equal(await driver.executeScript('return window.__sendCount'),1);
      await driver.navigate().refresh();
      await driver.wait(async()=>driver.executeScript(()=>
        document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('count')?.textContent==='2 queued'),13000);
      assert.equal(await driver.executeScript('return window.__sendCount'),0);
      await driver.executeScript(()=>
        window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
      await driver.wait(async()=>driver.executeScript(()=>
        document.documentElement.dataset.qaDurableHold==='true'),10000);
    }
    stage='trusted-Enter-shortcut-during-pre-ready-retains-durable-hold';
    await driver.get('http://127.0.0.1:'+server.address().port+
      '/c/keyboard-enter-before-send-ready');
    await ready();
    for(const [index,text] of [
      'Synthetic keyboard shortcut Send',
      'Never follow an ambiguous keyboard Send'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>driver.executeScript(expected=>
        document.querySelector('#chat-queue-extension-root').shadowRoot
          .getElementById('count').textContent===expected,
        (index+1)+' queued'),10000);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSendReadyGap==='yes' &&
      document.getElementById('prompt-textarea').innerText.length>0),11000);
    // A REAL WebDriver-generated Enter, not dispatchEvent(new KeyboardEvent)
    // or a fabricated page Signal. This fixture's page handler calls its
    // Send routine without any button click or native submit event.
    await driver.findElement(By.id('prompt-textarea')).sendKeys(Key.ENTER);
    assert.equal(await driver.executeScript('return window.__trustedShortcutSend'),1,
      'A trusted browser keyboard event must invoke the synthetic site shortcut');
    assert.equal(await driver.executeScript('return window.__buttonClicks'),0);
    assert.equal(await driver.executeScript('return window.__submitCount||0'),0);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Synthetic keyboard shortcut Send']);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes(
          'Another Send may have submitted this prompt; review uncertain message')),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Queue must not add a second Send after a trusted keyboard shortcut');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length),1);
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);
    await driver.executeScript('window.qaFinish()');
    await driver.sleep(650);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    await driver.navigate().refresh();
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='2 queued'),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);

    stage='trusted-Shift-Enter-pre-ready-does-not-create-false-Send-hold';
    await driver.get('http://127.0.0.1:'+server.address().port+
      '/c/keyboard-shift-enter-before-send-ready');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='A human inserts a newline';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),10000);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSendReadyGap==='yes' &&
      document.getElementById('prompt-textarea').innerText.length>0),11000);
    await driver.findElement(By.id('prompt-textarea'))
      .sendKeys(Key.chord(Key.SHIFT,Key.ENTER));
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes(
          'Dispatch context changed; no send attempted')),12000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Shift+Enter is normal editing: it must never authorize a Queue Send');
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='false'),10000);
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'1 queued');

    stage='page-requestSubmit-during-sealed-Queue-preflight';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/page-form-submit-during-seal');
    await ready();
    for(const [index,text] of [
      'Synthetic form-submitted first prompt',
      'Second form-race prompt must stay paused'
    ].entries()){
      await driver.executeScript(`const d=${hud('draft')};d.value=arguments[0];`,text);
      await driver.executeScript(`return ${hud('add')}.click()`);
      await driver.wait(async()=>driver.executeScript(expected=>
        document.querySelector('#chat-queue-extension-root').shadowRoot
          .getElementById('count').textContent===expected,
        (index+1)+' queued'),9500);
    }
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSealDelay==='yes'),10000);
    // requestSubmit() fires submit without a Send button click. This is
    // a distinct site-owned submission channel, not the previous regression
    // which exercises script-driven button.click().
    await driver.executeScript(()=>document.querySelector('main form').requestSubmit());
    assert.equal(await driver.executeScript('return window.__submitCount'),1);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Synthetic form-submitted first prompt']);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes(
          'Another Send may have submitted this prompt; review uncertain message')),11000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Queue cannot issue a second click after a competing form submission');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'2 queued');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length),1);
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);
    await driver.executeScript('window.qaFinish()');
    await driver.sleep(700);
    assert.equal(await driver.executeScript('return window.__sendCount'),1);
    await driver.navigate().refresh();
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='2 queued'),14000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript(()=>
      window.postMessage({kind:'qa-inspect-durable-hold'},location.origin));
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaDurableHold==='true'),10000);
    stage='Queue-own-submit-button-does-not-trigger-foreign-submission';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/queue-own-form-submit');
    await ready();
    await driver.executeScript(()=>{
      document.querySelector('[data-testid="send-button"]').type='submit';
    });
    await driver.executeScript(`const d=${hud('draft')};d.value='Queue native submit button payload';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),9500);
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>driver.executeScript(()=>
      window.__sendCount===1 && window.__submitCount===1),12000);
    assert.deepEqual(await driver.executeScript('return window.__sentPayloads'),
      ['Queue native submit button payload'],
      'Queue-owned click must generate exactly one native submit event');
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes(
          'Waiting for confirmed response completion')),11000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent.includes('Queue completed')),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),1,
      'Normal Queue submit must not be mistaken for a competing form submission');
    assert.equal(await driver.executeScript(`return ${hud('count')}.textContent`),'0 queued');
    stage='real-provider-route-change-during-sealed-send';
    const originalSealedRoute='/c/route-change-during-seal';
    const destinationSealedRoute='/g/g-p-route-race/c/other-sealed-conversation';
    await driver.get('http://127.0.0.1:'+server.address().port+originalSealedRoute);
    await ready();
    await driver.executeScript(() => {
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      shadow.getElementById('draft').value='Never dispatch across sealed route change';
      shadow.getElementById('add').click();
    });
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),9000);
    await driver.executeScript(()=>document.querySelector('#chat-queue-extension-root')
      .shadowRoot.getElementById('run').click());
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSealDelay==='yes'),10000);
    // Production Queue has already committed its uncertainty journal and
    // acquired the durable hold. While the final browser-owned Send check
    // is delayed ONLY in this disposable fixture, simulate a React SPA chat
    // switch without discarding the document or forging a provider envelope.
    await driver.executeScript(route=>{
      history.pushState({},'',route);
      document.getElementById('prompt-textarea').textContent='';
      document.getElementById('response-turns').replaceChildren();
    },destinationSealedRoute);
    await driver.wait(async()=>driver.executeScript(route=>
      location.pathname===route &&
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='0 queued',destinationSealedRoute),12000);
    await driver.sleep(2650);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Queued text prepared for a previous chat must not Send in destination');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent),'0 queued',
      'Destination must never inherit original conversation queue contents');
    stage='real-provider-return-to-sealed-source-remains-uncertain';
    await driver.executeScript(route=>history.pushState({},'',route),originalSealedRoute);
    await driver.wait(async()=>driver.executeScript(route=>
      location.pathname===route &&
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='1 queued' &&
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length===1,originalSealedRoute),12000);
    await driver.sleep(700);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Returning to original route cannot reactivate an obsolete Send grant');
    assert.match(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent),/Paused|Conversation changed/,
      'Original queue must remain paused for deliberate uncertainty review');

    stage='real-provider-aba-route-switch-after-uncertain-journal';
    const abaOriginal='/c/route-aba-after-journal';
    const abaOther='/g/g-p-aba-test/c/route-aba-other';
    await driver.get('http://127.0.0.1:'+server.address().port+abaOriginal);
    await ready();
    await driver.executeScript(() => {
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      shadow.getElementById('draft').value='Old sealed authorization must not survive ABA';
      shadow.getElementById('add').click();
    });
    await driver.wait(async()=>driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent==='1 queued'),9000);
    await driver.executeScript(()=>document.querySelector('#chat-queue-extension-root')
      .shadowRoot.getElementById('run').click());
    await driver.wait(async()=>driver.executeScript(()=>
      document.documentElement.dataset.qaSealDelay==='yes' &&
      Number.isFinite(Number(document.documentElement.dataset.qaSealStarted))),10000);
    const sealedStart=Number(await driver.executeScript(
      'return document.documentElement.dataset.qaSealStarted'));
    // The old dispatch has already journaled uncertainty, reserved a real
    // durable hold, and filled the page. Leave and REENTER the exact original
    // URL while its deliberately held browser-owned seal is unresolved.
    await driver.executeScript(route=>{
      history.pushState({},'',route);
      document.getElementById('prompt-textarea').textContent='';
      document.getElementById('response-turns').replaceChildren();
    },abaOther);
    await driver.wait(async()=>driver.executeScript(route=>
      location.pathname===route &&
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='0 queued',abaOther),12000);
    await driver.executeScript(route=>history.pushState({},'',route),abaOriginal);
    await driver.wait(async()=>driver.executeScript(route=>
      location.pathname===route &&
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='1 queued' &&
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length===1,abaOriginal),12000);
    assert.ok(await driver.executeScript(
      'return performance.now()-arguments[0]<7600',sealedStart),
      'Return to the same route must occur BEFORE the old sealed permission resolves');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.wait(async()=>driver.executeScript(start=>
      performance.now()-start>=8000,sealedStart),11000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A/B/A route reuse cannot restore the earlier attempt Send authorization');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item.uncertain').length),1,
      'The prior uncertainty journal must survive ABA navigation unchanged');
    assert.match(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('status').textContent),/Conversation changed; manually start queue/,
      'The revoked old attempt cannot overwrite the current route status');
    stage='real-provider-aba-source-never-autoresumes';
    await driver.sleep(600);
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'A new verified provider state after ABA cannot automatically retry');

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

    // A malicious or simply rerendering page can redirect focus from the
    // otherwise visible ChatGPT composer to a different contenteditable.
    // execCommand('insertText') operates on the active selection, so Queue
    // must fail BEFORE leaking a private queued prompt to that other editor.
    stage='real-provider-diverted-composer-focus-never-inserts';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/focus-diverted');
    await ready();
    await driver.executeScript(`const d=${hud('draft')};d.value='Synthetic focus-ownership message';`);
    await driver.executeScript(`return ${hud('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('count')}.textContent==='1 queued'`),9000);
    await driver.executeScript(() => {
      const unrelated=document.createElement('div');
      unrelated.id='qa-unrelated-editor';
      unrelated.setAttribute('contenteditable','true');
      unrelated.textContent='Independent user draft';
      document.body.append(unrelated);
      const composer=document.getElementById('prompt-textarea');
      composer.addEventListener('focus',()=>unrelated.focus());
    });
    await driver.executeScript(`return ${hud('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}.textContent.includes('Composer focus diverted; no insertion')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.equal(await driver.executeScript(
      "return document.getElementById('qa-unrelated-editor').textContent"),
      'Independent user draft','Focus redirection must never receive Queue text');
    assert.equal(await driver.executeScript(
      "return document.getElementById('prompt-textarea').textContent"),'',
      'The composer remains empty after a diverted focus');
    assert.equal(await driver.executeScript(
      `return ${hud('count')}.textContent`),'1 queued',
      'Unsent prompt must remain journaled for explicit review');

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
  }catch(error){
    let diagnosis='';
    if(driver){
      try{diagnosis=JSON.stringify(await driver.executeScript(() => ({
        phase:document.documentElement.dataset.chatSignalsState||null,
        sendCount:window.__sendCount??null,
        status:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('status')?.textContent?.slice(-155)||null,
        queueCount:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('count')?.textContent||null
      })));}catch{}
    }
    throw Error('stage '+stage+': '+error.message+(diagnosis?' meta='+diagnosis:''));
  }
  finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE real provider failed:',error.message);process.exitCode=1});
