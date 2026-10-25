'use strict';
// Real source-to-consumer Firefox transport; disposable localhost substitutions
// are restricted to this fixture. No account login, prompt upload or profile access.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const qid='chat-queue@sguzman.github',sid='chat-signals@sguzman.github';
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
  fs.writeFileSync(cp,patch(fs.readFileSync(cp,'utf8'),
    "attachShadow({mode:'closed'})","attachShadow({mode:'open'})"));
  const bp=path.join(dir,'src/background.js');
  let bg=patch(fs.readFileSync(bp,'utf8'),origin,localOrigin);
  bg=patch(bg,"!change.url.startsWith('https://chatgpt.com/')",
    "!change.url.startsWith('http://127.0.0.1:')");
  // Deliberately allow the real publisher to emit its initial idle event
  // before Queue has a tab registration. Its one-shot sync must recover
  // that race without polling or granting a page-origin phase authority.
  bg=patch(bg,"      return currentRoute(sender).then(live=>{\n        if(live!==message.route)",
    "      return currentRoute(sender).then(async live=>{\n        if(message.route==='/c/sync-late')await new Promise(resolve=>setTimeout(resolve,1900));\n        if(live!==message.route)");
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
  // Seed a synthetic historical response in the real provider's own local
  // ledger during registration. QA-only: not part of the source extension.
  const historicalKey=require(path.join(root,'src/color.js')).hash('chat:restored-history-123');
  const oldStored="    const stored=(await getStateLedger())[String(tabId)];";
  const seeded="    if(key==="+JSON.stringify(historicalKey)+"){\n"+
    "      const ledger=await getStateLedger();\n"+
    "      if(!ledger[String(tabId)]){\n"+
    "        ledger[String(tabId)]={key,at:Date.now(),"+
      "state:{phase:'finished',read:'viewed',epoch:4}};\n"+
    "        await putStateLedger(ledger);\n"+
    "      }\n"+
    "    }\n"+oldStored;
  bg=patch(bg,oldStored,seeded);
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
  const qdir=path.join(temp,'queue'),sdir=path.join(temp,'provider');
  fs.mkdirSync(qdir);fs.mkdirSync(sdir);
  stageQueue(qdir,path.resolve(__dirname,'..'));
  stageProvider(sdir,provider);
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
    const ready=async()=>driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}?.textContent.includes('Signal: idle') &&
        !${hud('status')}.textContent.includes('(unverified)')`),15000);
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
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='finished'"),12000);
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
    stage='two-message-serial-send';
    for(const [i,text] of ['Synthetic first message','Synthetic second message'].entries()){
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
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript('return window.__sendCount===2'),12000);
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.chatSignalsState==='generating'"),9000);
    await driver.executeScript('window.qaFinish()');
    await driver.wait(async()=>await driver.executeScript(
      `return ${hud('status')}?.textContent.includes('Queue completed')`),13000);
    assert.equal(await driver.executeScript('return window.__sendCount'),2,
      'Exactly two synthetic Send clicks and no duplicate retries');
    stage='provider-removed-no-replay';
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
