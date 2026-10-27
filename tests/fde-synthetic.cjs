'use strict';
// Disposable FDE behavioral fixture; no ChatGPT account or network endpoint.
// Only test-only manifest origin, mock background and open Shadow DOM differ.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder,By,Key}=require('selenium-webdriver');
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
  const downloads=path.join(root,'qa-downloads');fs.mkdirSync(downloads);
  const src=path.resolve(__dirname,'..');
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);});
  let driver;
  let qaStage='setup';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const manifest=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'),'utf8'));
    manifest.browser_specific_settings.gecko.id='chat-queue-qa@sguzman.github';
    manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
    manifest.background.scripts=['qa-background.js'];
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
    fs.mkdirSync(path.join(root,'src'));
    for(const name of ['core.js','signal.js','rules.js','rule-store.js'])fs.copyFileSync(path.join(src,'src',name),path.join(root,'src',name));
    let content=fs.readFileSync(path.join(src,'src/content.js'),'utf8');
    const marker="attachShadow({mode:'closed'})";
    assert.equal(content.split(marker).length,2,'QA must make exactly one scoped Shadow DOM substitution');
    content=content.replace(marker,"attachShadow({mode:'open'})");
    // Test-only optimistic-token diagnostics. Never bundled in production.
    const renderStart="  function render() {";
    assert.equal(content.split(renderStart).length,2);
    content=content.replace(renderStart,
      "  function render() { document.documentElement.dataset.qaRenderedEtag=state.etag;");
    const writeToken="state.revision++;state.etag=uid();const key=state.key;";
    assert.equal(content.split(writeToken).length,2);
    content=content.replace(writeToken,
      "state.revision++;state.etag=uid();document.documentElement.dataset.qaWriteEtag=state.etag;const key=state.key;");
    // QA-only error injection in the queue write boundary. This never changes
    // the production content script or accesses the user's browser profile.
    const persistence="api.storage.local.set({[key]:data})";
    assert.equal(content.split(persistence).length,2);
    content=content.replace(persistence,
      "(document.documentElement.dataset.qaRejectQueueSave==='yes' ? Promise.reject(new Error('qa-storage-rejected')) : document.documentElement.dataset.qaRejectQueueSave==='delay-reject' ? new Promise((_,reject)=>setTimeout(()=>reject(new Error('qa-storage-rejected')),1500)) : document.documentElement.dataset.qaRejectQueueSave==='delay' ? new Promise(resolve=>setTimeout(resolve,2500)).then(()=>api.storage.local.set({[key]:data})) : api.storage.local.set({[key]:data}))");
    const defaultHeartbeat='const REGISTRY_HEARTBEAT_TICKS=60;';
    assert.equal(content.split(defaultHeartbeat).length,2);
    content=content.replace(defaultHeartbeat,'const REGISTRY_HEARTBEAT_TICKS=2;');
    // QA-only registration race: the old route is rejected after a route change.
    const bootstrapRegister="api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:initialRoute,registrationVersion:2})";
    assert.equal(content.split(bootstrapRegister).length,2);
    content=content.replace(bootstrapRegister,
      "(initialRoute==='/c/bootstrap-register-old' ? (document.documentElement.dataset.qaBootstrapRegisterPending='yes', api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:initialRoute,registrationVersion:2})) : api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:initialRoute,registrationVersion:2}))");
    // QA-only delayed initial storage tests SPA route changes before HUD mount.
    const bootstrapLoad="api.storage.local.get([state.key,'chatqueue:settings:v1',UI_KEY])";
    assert.equal(content.split(bootstrapLoad).length,2);
    content=content.replace(bootstrapLoad,
      "(state.key.endsWith('/c/bootstrap-old') ? (document.documentElement.dataset.qaBootstrapLoadPending='yes', new Promise(resolve=>setTimeout(resolve,1700)).then(()=>api.storage.local.get([state.key,'chatqueue:settings:v1',UI_KEY]))) : api.storage.local.get([state.key,'chatqueue:settings:v1',UI_KEY]))");
    // QA-only slow async read reproduces A -> B -> A while B is still loading.
    const navigationLoad='api.storage.local.get(newKey)';
    assert.equal(content.split(navigationLoad).length,2);
    content=content.replace(navigationLoad,
      "(newKey.endsWith('/c/route-delay') ? new Promise(resolve=>setTimeout(resolve,5000)).then(()=>api.storage.local.get(newKey)) : newKey.endsWith('/c/bootstrap-new') ? new Promise(resolve=>setTimeout(resolve,2500)).then(()=>api.storage.local.get(newKey)) : newKey.endsWith('/c/load-fail') ? Promise.reject(new Error('qa-read-failure')) : api.storage.local.get(newKey))");
    // Test-only source tampering between Find and Confirm; the installed
    // production script contains only the read/revalidation guard.
    const recoveryRead='latest=await api.storage.local.get(draft.sourceKey);';
    assert.equal(content.split(recoveryRead).length,2);
    content=content.replace(recoveryRead,
      "if(document.documentElement.dataset.qaMutateRecoverySource==='future')"+
      "await api.storage.local.set({[draft.sourceKey]:{version:99,items:[]}});"+
      recoveryRead);
    fs.writeFileSync(path.join(root,'src/content.js'),content);
    // No provider and no real queue execution: just enough background for HUD registration.
    fs.writeFileSync(path.join(root,'qa-background.js'),
      `let qaRegistryMissing=true,qaHeartbeatStates=0,qaStaleReplyPending=true;
      browser.runtime.onMessage.addListener((msg,sender)=>{
        if(msg?.type!=='chat-queue-internal/v1')return;
        if(msg.action==='register'){
          if(msg.route==='/c/bootstrap-register-old')
            return new Promise(resolve=>setTimeout(
              ()=>resolve({ok:false,error:'route-mismatch'}),1400));
          if(msg.route==='/c/bootstrap-old'){
            const key='chatqueue:v1:tab:'+sender.tab.id+':'+msg.route;
            return browser.storage.local.get(key).then(saved=>{
              if(Object.hasOwn(saved,key))return {ok:true,tabId:sender.tab.id};
              return browser.storage.local.set({[key]:{version:1,items:[
                {id:'bootstrap-old-item',text:'Private old bootstrap prompt',status:'pending'}]}})
                .then(()=>({ok:true,tabId:sender.tab.id}));
            });
          }
          if(msg.route==='/g/qa/c/recovery-alias'){
            const oldKey='chatqueue:v1:tab:987654321:/c/recovery-alias';
            const lookalike='chatqueue:v1:tab:987654322:/c/recovery-alias2';
            return browser.storage.local.get([oldKey,lookalike]).then(saved=>{
              if(Object.hasOwn(saved,oldKey))return {ok:true,tabId:sender.tab.id};
              return browser.storage.local.set({
                [oldKey]:{version:1,items:[
                  {id:'aliasorphan01',text:'Synthetic prior alias message',status:'pending'}]},
                [lookalike]:{version:1,items:[
                  {id:'aliasother01',text:'Different conversation must remain secret',status:'pending'}]}
              }).then(()=>({ok:true,tabId:sender.tab.id}));
            });
          }
          if(msg.route==='/c/recovery-record'||msg.route==='/c/recovery-mutate'||msg.route==='/c/recovery-save-fail'){
            const oldKey='chatqueue:v1:tab:987654321:'+msg.route;
            return browser.storage.local.get(oldKey).then(saved=>{
              if(Object.hasOwn(saved,oldKey))return {ok:true,tabId:sender.tab.id};
              const oldRecord={version:1,items:[
                {id:'orphan0001',text:'Previously queued message',status:'pending'}]};
              return browser.storage.local.set({[oldKey]:oldRecord})
                .then(()=>({ok:true,tabId:sender.tab.id}));
            });
          }
          if(msg.route==='/c/future-record'||msg.route==='/c/legacy-record'||msg.route==='/c/history-record'||msg.route==='/c/history-fail-record'||msg.route==='/c/history-concurrent-fail'||msg.route==='/c/corrupt-record'||msg.route==='/c/metadata-corrupt'||msg.route==='/c/null-record'){
            const key='chatqueue:v1:tab:'+sender.tab.id+':'+msg.route;
            return browser.storage.local.get(key).then(saved=>{
              if(Object.hasOwn(saved,key))return {ok:true,tabId:sender.tab.id};
              const record=msg.route==='/c/future-record'
                ? {version:99,items:[{id:'future0001',text:'Synthetic retained prompt',status:'pending'}]}
                : msg.route==='/c/history-record'||msg.route==='/c/history-fail-record'||msg.route==='/c/history-concurrent-fail'
                  ? {version:1,items:[],history:[{id:'historyfixture',text:'Synthetic completed prompt',status:'finished',at:1730000000000}]}
                  : msg.route==='/c/metadata-corrupt'
                    ? {version:1,items:[{id:'metadata01',text:'Retain historical metadata',status:'pending'}],
                      history:[{id:'oldentry01',text:'Do not silently drop malformed history',at:'invalid',status:'finished'}],
                      recoveredSources:['chatqueue:v1:tab:9:/c/metadata-corrupt']}
                  : msg.route==='/c/corrupt-record'
                    ? {version:1,items:[
                      {id:'corrupt0001',text:'Preserve full synthetic record',status:'pending'},
                      {id:'corrupt0001',text:'Duplicate ID must not be silently discarded',status:'pending'}]}
                    : msg.route==='/c/null-record' ? null
                    : {items:[{id:'legacy0001',text:'Synthetic legacy prompt',status:'pending'}]};
              return browser.storage.local.set({[key]:record}).then(()=>({ok:true,tabId:sender.tab.id}));
            });
          }
          if(msg.route==='/c/max-queue-performance'){
            const key='chatqueue:v1:tab:'+sender.tab.id+':'+msg.route;
            return browser.storage.local.get(key).then(saved=>{
              if(Object.hasOwn(saved,key))return {ok:true,tabId:sender.tab.id};
              const items=Array.from({length:100},(_,i)=>({
                id:'perf-item-'+String(i).padStart(4,'0'),
                text:'Synthetic performance message '+i+': '+'x'.repeat(800),
                status:'pending'
              }));
              return browser.storage.local.set({[key]:{version:1,items}})
                .then(()=>({ok:true,tabId:sender.tab.id}));
            });
          }
          return Promise.resolve({ok:true,tabId:sender.tab.id});
        }
        if(msg.action==='state'){
          if(qaStaleReplyPending && sender.tab.url.includes('/c/stale-meta-home') && msg.size===1){
            qaStaleReplyPending=false;
            return new Promise(resolve=>setTimeout(()=>resolve({ok:false,error:'route-mismatch'}),2500));
          }
          if(sender.tab.url.includes('/c/heartbeat-loss') && msg.size===0){
            qaHeartbeatStates++;
            if(qaHeartbeatStates===2)return Promise.resolve({ok:false,error:'route-mismatch'});
          }
          if(qaRegistryMissing && sender.tab.url.includes('/c/registry-loss') && msg.size===1){
            qaRegistryMissing=false;
            return Promise.resolve({ok:false,error:'route-mismatch'});
          }
          return Promise.resolve({ok:true});
        }
       });`);
    // Exercise actual Firefox reduced-motion preference, not a mocked media query.
    const options=new firefox.Options().setBinary(binary).addArguments('-headless')
      .setPreference('ui.prefersReducedMotion',1)
      .setPreference('browser.download.folderList',2)
      .setPreference('browser.download.dir',downloads)
      .setPreference('browser.download.useDownloadDir',true)
      .setPreference('browser.helperApps.neverAsk.saveToDisk','application/json');
    driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
    const id=await driver.installAddon(root,true);
    assert.equal(id,manifest.browser_specific_settings.gecko.id);
    await driver.get(`http://127.0.0.1:${server.address().port}/c/synthetic`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('run')})`),15000);
    const theme=await driver.executeScript(`return ${jsEl('theme')}`);
    assert.equal(await theme.getAttribute('value'),'system');
    const input=await driver.executeScript(`return ${jsEl('draft')}`);
    const add=await driver.executeScript(`return ${jsEl('add')}`);
    // Reproduce host-page global shortcut behavior seen on authenticated
    // ChatGPT: a document-level key/pointer handler that focuses the site's
    // own composer whenever it hears typing or clicking in an extension HUD.
    // Native Firefox must keep the keyboard in the Shadow DOM textarea.
    qaStage='host-page-shortcut-must-not-steal-HUD-draft-focus';
    await driver.executeScript(() => {
      window.__qaHostCaptureCount=0;
      window.__qaHostBubbleCount=0;
      // Capturing listeners run BEFORE the Shadow DOM boundary. This is the
      // class of global site shortcut that the first bubble-only fix missed.
      const steal=(event)=>{
        if(event.key.length!==1||event.ctrlKey||event.altKey||event.metaKey)return;
        window.__qaHostCaptureCount++;
        document.getElementById('prompt-textarea').focus();
      };
      const bubble=()=>{window.__qaHostBubbleCount++;};
      window.__qaHostShortcutListener=steal;
      window.__qaHostBubbleListener=bubble;
      document.addEventListener('keydown',steal,true);
      document.addEventListener('keydown',bubble);
    });
    await input.click();
    await input.sendKeys('HUD focus stays here');
    const isolation=await driver.executeScript(() => {
      const root=document.querySelector('#chat-queue-extension-root').shadowRoot;
      return {draft:root.getElementById('draft').value,
        focused:root.activeElement===root.getElementById('draft'),
        hostCaptureEvents:window.__qaHostCaptureCount,
        hostBubbleEvents:window.__qaHostBubbleCount,
        siteDraft:document.getElementById('prompt-textarea').textContent};
    });
    assert.deepEqual(isolation,{draft:'HUD focus stays here',focused:true,
      hostCaptureEvents:'HUD focus stays here'.length,hostBubbleEvents:0,siteDraft:''},
      'Even a capture-phase site shortcut must not redirect HUD typing into ChatGPT');
    await input.clear();
    // Site shortcuts must still function when the user genuinely types into
    // the ChatGPT editor; only the extension-local interaction is shielded.
    await driver.executeScript(() => {
      document.getElementById('prompt-textarea').dispatchEvent(
        new KeyboardEvent('keydown',{key:'x',bubbles:true}));
    });
    assert.equal(await driver.executeScript('return window.__qaHostCaptureCount'),
      'HUD focus stays here'.length+1,
      'Keyboard events originating in the website must remain website-owned');
    // Actual pointer navigation OUTSIDE the queue must also relinquish focus.
    await driver.executeScript(() => {
      document.getElementById('prompt-textarea').dispatchEvent(
        new PointerEvent('pointerdown',{bubbles:true}));
      document.getElementById('prompt-textarea').focus();
    });
    assert.equal(await driver.executeScript(() =>
      document.activeElement===document.getElementById('prompt-textarea')),true,
      'Intentional outside interaction must not be trapped by focus recovery');
    // Remove hostile site listeners before the independent HUD workflows.
    await driver.executeScript(() => {
      document.removeEventListener('keydown',window.__qaHostShortcutListener,true);
      document.removeEventListener('keydown',window.__qaHostBubbleListener);
      delete window.__qaHostShortcutListener;
      delete window.__qaHostBubbleListener;
    });
    await input.sendKeys('Synthetic first message');await add.click();
    await input.sendKeys('Synthetic second message');await add.click();
    const count=await driver.executeScript(`return ${jsEl('count')}.textContent`);
    assert.equal(count,'2 queued');
    // Accessible names must describe actions rather than exposing only
    // pictographic arrows; verify the actual Firefox ShadowRoot controls.
    const names=await driver.executeScript(()=>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .controls button')]
        .map(button=>({visible:button.textContent,name:button.getAttribute('aria-label')})));
    assert.equal(names.length,8);
    assert.ok(names.every(entry=>entry.name&&entry.name.length>=9),
      'Each interactive queue action requires a descriptive accessible name');
    assert.ok(names.some(entry=>entry.visible==='↑'&&entry.name==='Move earlier'));
    assert.ok(names.some(entry=>entry.visible==='↓'&&entry.name==='Move later'));
    assert.ok(names.some(entry=>entry.name==='Remove message'));
    // Edit queue contents without overwriting the HUD input or ChatGPT draft.
    await input.sendKeys('Synthetic unsaved HUD draft');
    await driver.executeScript("document.getElementById('prompt-textarea').textContent='Synthetic site draft'");
    const edit=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(3)')");
    await edit.click();
    let editField=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child textarea')");
    await editField.clear();await editField.sendKeys('Synthetic edited first message');
    // A page-side unverified Signal may redraw status, but must not replace
    // the user's focused editor or discard any unsaved queued-message draft.
    await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      window.__qaEditingNode=sh.querySelector('.item:first-child textarea');
      document.documentElement.dataset.chatSignalsState='generating';
    });
    await driver.wait(async()=>await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('generating (unverified)')),4000);
    const editPreserved=await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const field=sh.querySelector('.item:first-child textarea');
      return {same:window.__qaEditingNode===field,
        focused:sh.activeElement===field,value:field?.value};
    });
    assert.deepEqual(editPreserved,{same:true,focused:true,value:'Synthetic edited first message'},
      'Signal-only updates must preserve the actual focused textarea, not merely its text');
    let saveEdit=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:first-child')");
    await saveEdit.click();
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic edited first message'"),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('draft')}.value`),'Synthetic unsaved HUD draft');
    assert.equal(await driver.executeScript("return document.getElementById('prompt-textarea').textContent"),'Synthetic site draft');
    const editAgain=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(3)')");
    await editAgain.click();
    editField=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child textarea')");
    await editField.clear();await editField.sendKeys('Synthetic first message');
    saveEdit=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:first-child')");
    await saveEdit.click();
    let order=await driver.executeScript(`return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)`);
    assert.deepEqual(order,['Synthetic first message','Synthetic second message']);
    const up=await driver.executeScript(`return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2) .controls button:first-child')`);
    await up.click();
    order=await driver.executeScript(`return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)`);
    assert.deepEqual(order,['Synthetic second message','Synthetic first message']);
    // Keyboard activation of Down must reverse a pointer-driven reorder.
    const down=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(1) .controls button:nth-child(2)')");
    await down.sendKeys(Key.ENTER);
    order=await driver.executeScript("return [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')].map(x=>x.textContent)");
    assert.deepEqual(order,['Synthetic first message','Synthetic second message']);
    const focusedAfterKeyboardMove=await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const focused=sh.activeElement;
      return {item:focused?.closest('.item')?.querySelector('.preview')?.textContent,
        action:focused?.getAttribute('aria-label'),disabled:focused?.disabled};
    });
    assert.deepEqual(focusedAfterKeyboardMove,
      {item:'Synthetic second message',action:'Move earlier',disabled:false},
      'Keyboard reorder must retain focus on the moved message at boundaries');
    qaStage='native-pointer-before';
    // Exercise native Firefox pointer drag, not synthetic JS drag/drop.
    await driver.executeScript(`window.__qaDragEvents=[];
      const root=document.querySelector('#chat-queue-extension-root').shadowRoot;
      for(const name of ['dragstart','dragover','drop','dragend'])
        root.addEventListener(name,event=>{
          if(window.__qaDragEvents.length<100)window.__qaDragEvents.push(name+':'+event.target.tagName);
        },true);`);
    // Start over the text preview, not the interactive controls in the
    // draggable row, and drop in the first row's upper half.
    const dragSource=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2) .preview')");
    const dragTarget=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(1) .preview')");
    // Firefox requires drag motion and a hover interval before release;
    // WebDriver's single-hop dragAndDrop can emit dragstart but no drop.
    await driver.actions({async:true})
      .move({origin:dragSource}).press().pause(200)
      .move({origin:dragTarget,duration:850}).pause(350)
      .release().perform();
    try{
      await driver.wait(async()=>await driver.executeScript(
        "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic second message'"),6000);
    }catch(error){
      const diag=await driver.executeScript(`return {events:window.__qaDragEvents,
        rows:[...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')].map(x=>x.textContent)}`);
      throw new Error('Native Firefox drag before row did not reorder: '+JSON.stringify(diag)+'; '+error.message);
    }
    // Reverse the drag through the keyboard alternative; future reload must
    // preserve this explicit final order.
    const downAfterDrag=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(2)')");
    await downAfterDrag.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic first message'"),5000);
    qaStage='native-pointer-after';
    // The lower half of the last row must insert AFTER it, not before it.
    const dragFirst=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')");
    const dropLast=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2)')");
    const dropRect=await dropLast.getRect();
    await driver.actions({async:true})
      .move({origin:dragFirst}).press().pause(200)
      .move({origin:dropLast,x:0,y:Math.max(7,Math.floor(dropRect.height/4)),duration:750}).pause(250)
      .release().perform();
    try {
      await driver.wait(async()=>await driver.executeScript(
        "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic second message'"),6000);
    }catch(error){
      const diag=await driver.executeScript(`const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
        return {rows:[...sh.querySelectorAll('.item')].map(x=>({preview:x.querySelector('.preview')?.textContent,rect:x.getBoundingClientRect().toJSON()})),
          list:sh.getElementById('items').getBoundingClientRect().toJSON(),body:sh.getElementById('body').getBoundingClientRect().toJSON()}`);
      throw new Error('Native Firefox drag after row failed: '+JSON.stringify(diag)+'; '+error.message);
    }
    const upAfterLowerDrop=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2) .controls button:first-child')");
    await upAfterLowerDrop.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic first message'"),5000);
    qaStage='accessible-queue-positions';
    const accessibleOrder=await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const list=sh.getElementById('items');
      return {role:list.getAttribute('role'),label:list.getAttribute('aria-label'),
        rows:[...list.querySelectorAll('.item')].map(row=>({
          role:row.getAttribute('role'),
          position:row.getAttribute('aria-posinset'),
          size:row.getAttribute('aria-setsize'),
          text:row.querySelector('.preview')?.textContent
        }))};
    });
    assert.deepEqual(accessibleOrder,{
      role:'list',label:'Queued messages',rows:[
        {role:'listitem',position:'1',size:'2',text:'Synthetic first message'},
        {role:'listitem',position:'2',size:'2',text:'Synthetic second message'}
      ]},
      'Firefox must expose exact keyboard/pointer-sorted queue positions');
    qaStage='keyboard-edit-cancel-focus';
    // Editing a row rebuilds its buttons. Keyboard activation must hand
    // focus directly to the new textarea; Cancel must restore focus to the
    // same item's Edit button and discard the unsaved text.
    const originalFirst=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child .preview')?.textContent);
    const firstEdit=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child button[aria-label="Edit message"]'));
    await firstEdit.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const editor=sh.querySelector('.item:first-child textarea[aria-label="Edit queued message"]');
      return Boolean(editor && sh.activeElement===editor);
    }),6000);
    const unsavedEditor=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child textarea[aria-label="Edit queued message"]'));
    await unsavedEditor.sendKeys(' - unsaved edit');
    const cancelEdit=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child button[aria-label="Cancel edit"]'));
    await cancelEdit.sendKeys(Key.ENTER);
    assert.deepEqual(await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const row=sh.querySelector('.item:first-child');
      return {
        preview:row.querySelector('.preview')?.textContent,
        active:sh.activeElement?.getAttribute('aria-label'),
        sameRow:row.contains(sh.activeElement),
        editing:!!row.querySelector('textarea')
      };
    }),{preview:originalFirst,active:'Edit message',sameRow:true,editing:false},
    'Keyboard Cancel must retain item context and discard unsaved edits');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='keyboard-save-focus-after-async-persistence';
    // Save traverses two serialized storage/render boundaries before closing
    // the editor. A keyboard user should land on the same item's Edit
    // button, not the document body or an unrelated queue item.
    const keyboardSaveEditAgain=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child button[aria-label="Edit message"]'));
    await keyboardSaveEditAgain.sendKeys(Key.ENTER);
    const savedEditor=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child textarea[aria-label="Edit queued message"]'));
    await savedEditor.sendKeys(' - saved edit');
    const keyboardSaveAction=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child button[aria-label="Save edit"]'));
    await keyboardSaveAction.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript((expected)=>{
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const row=sh.querySelector('.item:first-child');
      return row.querySelector('.preview')?.textContent===expected &&
        sh.activeElement===row.querySelector('button[aria-label="Edit message"]');
    },originalFirst+' - saved edit'),9000);
    // Undo the saved text using the same keyboard edit/Save lifecycle, so
    // subsequent ordering assertions see the exact original fixture.
    const reopen=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child button[aria-label="Edit message"]'));
    await reopen.sendKeys(Key.ENTER);
    const undoEditor=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child textarea[aria-label="Edit queued message"]'));
    await undoEditor.clear();
    await undoEditor.sendKeys(originalFirst);
    const restoreSave=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child button[aria-label="Save edit"]'));
    await restoreSave.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(expected=>{
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const row=sh.querySelector('.item:first-child');
      return row.querySelector('.preview')?.textContent===expected &&
        sh.activeElement===row.querySelector('button[aria-label="Edit message"]');
    },originalFirst),9000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='keyboard-delete-focus';
    // Real keyboard Delete destroys its own button. Focus must stay in HUD:
    // the nearest remaining queue action, then draft when none survives.
    const preservedDraftOnDelete=await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('draft').value);
    const keyboardDeleteLast=await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:last-child button[aria-label="Remove message"]'));
    await keyboardDeleteLast.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const row=sh.querySelector('.item');
      return sh.getElementById('count').textContent==='1 queued' &&
        row?.querySelector('.preview')?.textContent==='Synthetic first message' &&
        row.contains(sh.activeElement) &&
        sh.activeElement?.getAttribute('aria-label')==='Edit message' &&
        sh.getElementById('status').textContent.includes('Queued message removed.');
    }),8000,'Keyboard Delete must announce removal and focus surviving row');
    const keyboardDeleteOnly=await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item button[aria-label="Remove message"]'));
    await keyboardDeleteOnly.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      return sh.getElementById('count').textContent==='0 queued' &&
        sh.activeElement===sh.getElementById('draft') &&
        sh.getElementById('status').textContent.includes('Queued message removed.');
    }),8000,'Deleting final row must focus draft, not host ChatGPT');
    for(const restored of ['Synthetic first message','Synthetic second message']){
      await driver.executeScript(message => {
        const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
        sh.getElementById('draft').value=message;sh.getElementById('add').click();
      },restored);
      await driver.wait(async()=>await driver.executeScript(message => {
        const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
        return [...sh.querySelectorAll('.item .preview')].some(
          row=>row.textContent===message);
      },restored),8000);
    }
    assert.deepEqual(await driver.executeScript(() =>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('.item .preview')].map(row=>row.textContent)),
      ['Synthetic first message','Synthetic second message']);
    await driver.executeScript(draft => {
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('draft').value=draft;
    },preservedDraftOnDelete);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='accessible-names-and-live-status';
    const aria=await driver.executeScript(() => {
      const root=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const panel=root.querySelector('.panel');
      const controls=[...root.querySelectorAll('button,select,textarea,summary,[tabindex]')];
      const visible=controls.filter(el=>!el.hidden&&el.getClientRects().length>0&&
        getComputedStyle(el).visibility!=='hidden');
      const names=visible.map(el=>({
        kind:el.tagName.toLowerCase(),
        name:String(el.getAttribute('aria-label')||
          el.labels?.[0]?.textContent||el.textContent||el.title||'').trim()
      }));
      return {region:panel.getAttribute('aria-label'),
        statusRole:root.getElementById('status').getAttribute('role'),
        dataLive:root.getElementById('data-note').getAttribute('aria-live'),
        ruleLive:root.getElementById('rules-note').getAttribute('aria-live'),
        unlabeled:names.filter(entry=>!entry.name),
        visibleCount:names.length};
    });
    assert.equal(aria.region,'Chat Queue');
    assert.equal(aria.statusRole,'status','Response updates must be announced semantically');
    assert.equal(aria.dataLive,'polite');
    assert.equal(aria.ruleLive,'polite');
    assert.ok(aria.visibleCount>=10,'Expected visible keyboard-operable HUD controls');
    assert.deepEqual(aria.unlabeled,[],
      'Every visible actionable HUD element needs an accessible name');
    // Firefox's accessibility engine (W3C computed role/name), not only
    // literal aria-label attributes, must see the private HUD controls.
    qaStage='computed-accessible-roles-and-names';
    const accessElements=await driver.executeScript(() => {
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      return [
        shadow.querySelector('.panel'),
        shadow.getElementById('status'),
        shadow.getElementById('theme'),
        shadow.getElementById('draft'),
        shadow.getElementById('add'),
        shadow.getElementById('toggle')
      ];
    });
    const computed=await Promise.all(accessElements.map(async element=>({
      role:await element.getAriaRole(),
      name:await element.getAccessibleName()
    })));
    assert.deepEqual(computed.map(x=>x.role),
      ['region','status','combobox','textbox','button','button'],
      'Firefox must expose functional roles for the closed-HUD-equivalent fixture');
    assert.equal(computed[0].name,'Chat Queue');
    assert.equal(computed[2].name,'Chat Queue theme');
    assert.equal(computed[3].name,'Add queued message');
    assert.equal(computed[4].name,'Add to queue');
    assert.equal(computed[5].name,'Collapse queue');
    // Exact status text varies with provider epochs. Status role, not its
    // current phrase, is the accessibility acceptance requirement.
    assert.equal(typeof computed[1].name,'string');
    qaStage='toggle';
    assert.deepEqual(await driver.executeScript(() => {
      const b=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('toggle');
      return {controls:b.getAttribute('aria-controls'),
        expanded:b.getAttribute('aria-expanded')};
    }),{controls:'body status',expanded:'true'},
    'The expanded queue control must name its controlled regions');
    const toggle=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('toggle')");
    await toggle.sendKeys(Key.ENTER);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('body').hidden"),true);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('toggle').getAttribute('aria-expanded')"),'false',
      'Keyboard collapse must announce collapsed state');
    await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      window.__qaCollapsedRow=sh.querySelector('.item:first-child');
      document.documentElement.dataset.chatSignalsState='finished';
    });
    await driver.wait(async()=>await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('finished (unverified)')),4000);
    assert.equal(await driver.executeScript(() =>
      window.__qaCollapsedRow===document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child')),
      true,'Collapsed status changes must avoid replacing hidden queue rows');
    await toggle.sendKeys(Key.ENTER);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('body').hidden"),false);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('toggle').getAttribute('aria-expanded')"),'true',
      'Keyboard expansion must announce expanded state');
    await driver.executeScript(`const el=${jsEl('theme')};el.value='light';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='light'"),5000);
    const lightToken=await driver.executeScript("return getComputedStyle(document.querySelector('#chat-queue-extension-root')).getPropertyValue('--panel').trim()");
    // Normal-size warning text on an enabled Danger button must meet
    // WCAG AA 4.5:1 in the browser's *resolved* theme colors. Raw token
    // inequality is not evidence that a warning is legible.
    const warningContrast=async()=>driver.executeScript(() => {
      const styles=getComputedStyle(document.querySelector('#chat-queue-extension-root'));
      const rgb=token=>{
        const value=styles.getPropertyValue(token).trim();
        if(!/^#[0-9a-f]{6}$/i.test(value))throw Error('non-hex QA theme token');
        return [1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255);
      };
      const luminance=triplet=>{
        const linear=triplet.map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
        return linear[0]*0.2126+linear[1]*0.7152+linear[2]*0.0722;
      };
      const foreground=luminance(rgb('--warning'));
      const background=luminance(rgb('--button'));
      return (Math.max(foreground,background)+0.05)/
        (Math.min(foreground,background)+0.05);
    });
    assert.ok((await warningContrast())>=4.5,
      'Light warning text against enabled Danger button must meet 4.5:1 contrast');
    await driver.executeScript(`const el=${jsEl('theme')};el.value='dark';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='dark'"),5000);
    const darkToken=await driver.executeScript("return getComputedStyle(document.querySelector('#chat-queue-extension-root')).getPropertyValue('--panel').trim()");
    assert.ok((await warningContrast())>=4.5,
      'Dark warning text against enabled Danger button must meet 4.5:1 contrast');
    assert.notEqual(lightToken,darkToken,'Light and Dark must apply independent semantic color tokens');
    await driver.executeScript(`const el=${jsEl('theme')};el.value='system';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='system'"),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('theme')}.value`),'system');
    await driver.executeScript(`const el=${jsEl('theme')};el.value='dark';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='dark'"),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('run')})`),15000);
    assert.equal(await driver.executeScript(`return ${jsEl('theme')}.value`),'dark');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'2 queued');
    qaStage='layout-reload';
    // Keyboard-positioned HUD placement and collapse persist across reload.
    const header=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.top')");
    const startRight=Number.parseInt(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right"),10);
    await header.sendKeys(Key.ARROW_LEFT);
    await driver.wait(async()=>Number.parseInt(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right"),10)>startRight,5000);
    const movedRight=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right");
    const collapse=await driver.executeScript(`return ${jsEl('toggle')}`);
    await collapse.click();
    assert.equal(await driver.executeScript(`return ${jsEl('body')}.hidden`),true);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('run')})`),15000);
    assert.equal(await driver.executeScript(`return ${jsEl('body')}.hidden`),true);
    assert.equal(await driver.executeScript(`return ${jsEl('toggle')}.getAttribute('aria-expanded')`),'false',
      'Restored collapsed layout must retain its accessible state');
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right"),movedRight);
    const reset=await driver.executeScript(`return ${jsEl('reset')}`);
    await reset.click();
    assert.equal(await driver.executeScript(`return ${jsEl('body')}.hidden`),false);
    assert.equal(await driver.executeScript(`return ${jsEl('toggle')}.getAttribute('aria-expanded')`),'true',
      'Reset must restore the expanded accessible state');
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right"),'20px');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'2 queued');
    await driver.executeScript("document.documentElement.dataset.chatSignalsState='finished'");
    const start=await driver.executeScript(`return ${jsEl('run')}`);
    await start.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),7000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='geometry-zoom';
    // Firefox geometry at a constrained desktop viewport and 175% page zoom.
    const oldRect=await driver.manage().window().getRect();
    await driver.manage().window().setRect({width:440,height:640});
    await driver.executeScript('document.documentElement.style.zoom="1.75";window.dispatchEvent(new Event("resize"))');
    const geometry=await driver.executeScript(`const host=document.querySelector('#chat-queue-extension-root');
      const rect=host.getBoundingClientRect(); const top=host.shadowRoot.querySelector('.top');
      return {x:rect.left,y:rect.top,right:rect.right,bottom:rect.bottom,w:innerWidth,h:innerHeight,
      topPadding:parseFloat(getComputedStyle(top).paddingLeft)};`);
    assert.ok(geometry.w>0&&geometry.h>0);
    assert.ok(geometry.x>=-1&&geometry.right<=geometry.w+1,JSON.stringify(geometry));
    assert.ok(geometry.y>=-1&&geometry.bottom<=geometry.h+1,JSON.stringify(geometry));
    assert.ok(geometry.topPadding>=8,'Header needs usable padding at zoom');
    // WCAG 1.4.10 reflow-level stress: 400% zoom at 1280 physical px is
    // approximately a 320 CSS-pixel content width. The private HUD must
    // remain entirely inside the viewport and not clip its interactive
    // controls horizontally; no authentication or Send is involved.
    qaStage='geometry-400-percent-reflow';
    await driver.manage().window().setRect({width:1280,height:900});
    await driver.executeScript('document.documentElement.style.zoom="4";window.dispatchEvent(new Event("resize"))');
    const fourX=await driver.executeScript(() => {
      const host=document.querySelector('#chat-queue-extension-root');
      const shadow=host.shadowRoot,panel=shadow.querySelector('.panel');
      const box=host.getBoundingClientRect();
      const controls=[...shadow.querySelectorAll('.top button,.top select,.footrow button')]
        .filter(element=>!element.disabled&&element.getClientRects().length);
      return {viewport:{width:innerWidth,height:innerHeight},
        host:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},
        panel:{scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth},
        controlOverflow:controls.some(element=>{
          const r=element.getBoundingClientRect();
          return r.left<box.left-1||r.right>box.right+1;
        }),
        controlCount:controls.length};
    });
    assert.ok(fourX.host.left>=-1&&fourX.host.right<=fourX.viewport.width+1,
      'HUD must reflow within the 400% zoom viewport: '+JSON.stringify(fourX));
    assert.ok(fourX.host.top>=-1&&fourX.host.bottom<=fourX.viewport.height+1,
      'HUD must remain vertically visible at 400% zoom: '+JSON.stringify(fourX));
    assert.ok(fourX.panel.scrollWidth<=fourX.panel.clientWidth+1,
      'HUD panel must not clip content horizontally at 400% zoom: '+JSON.stringify(fourX));
    assert.ok(fourX.controlCount>=4&&!fourX.controlOverflow,
      'Interactive HUD actions must remain horizontally reachable at 400% zoom: '+
      JSON.stringify(fourX));
    await driver.manage().window().setRect({width:440,height:640});
    await driver.executeScript('document.documentElement.style.zoom="1.75";window.dispatchEvent(new Event("resize"))');

    // The HUD should obey a real Firefox preference for reduced motion.
    const motion=await driver.executeScript(`const root=document.querySelector('#chat-queue-extension-root');
      const panel=root.shadowRoot.querySelector('.panel');
      panel.style.transition='transform 2s linear';
      return {prefersReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionDuration:getComputedStyle(panel).transitionDuration};`);
    assert.equal(motion.prefersReduced,true,'Fixture must actually enable Firefox reduced motion');
    assert.ok(motion.transitionDuration.split(',').every(x=>Number.parseFloat(x)===0),
      'HUD animation must be disabled under reduced-motion preference');
    // The resolved light and dark foreground/background pairs must keep body
    // text legible at a WCAG-like 4.5:1 contrast threshold.
    const colors=[];
    for(const themeValue of ['light','dark']){
      await driver.executeScript(`const h=document.querySelector('#chat-queue-extension-root');h.dataset.theme=arguments[0];`,themeValue);
      colors.push(await driver.executeScript(`const x=getComputedStyle(document.querySelector('#chat-queue-extension-root'));
        return [x.getPropertyValue('--panel').trim(),x.getPropertyValue('--text').trim()];`));
    }
    const expandHex=hex=>{
      assert.match(hex,/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
      return hex.length===4?'#'+Array.from(hex.slice(1),ch=>ch+ch).join(''):hex;
    };
    const rgb=value=>{const hex=expandHex(value);return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);};
    const lum=hex=>rgb(hex).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0);
    for(const [bg,fg] of colors){
      const a=lum(bg),b=lum(fg);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${bg}/${fg} contrast`);
    }
    await driver.executeScript('document.documentElement.style.zoom="1";window.dispatchEvent(new Event("resize"))');
    await driver.manage().window().setRect(oldRect);
    // Screenshots contain ONLY hard-coded synthetic fixture strings, never a
    // real user session or private prompts. Uploaded for visual acceptance.
    if(process.env.CQ_QA_SCREENSHOT_DIR){
      fs.mkdirSync(process.env.CQ_QA_SCREENSHOT_DIR,{recursive:true});
      for(const themeName of ['light','dark']){
        await driver.executeScript(`const el=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('theme');
          el.value=arguments[0];el.dispatchEvent(new Event('change',{bubbles:true}));`,themeName);
        await driver.wait(async()=>await driver.executeScript(`
          const host=document.querySelector('#chat-queue-extension-root');
          return host.dataset.theme===arguments[0] && host.shadowRoot.getElementById('theme').value===arguments[0]`,themeName),5000);
        const png=await driver.takeScreenshot();
        fs.writeFileSync(path.join(process.env.CQ_QA_SCREENSHOT_DIR,'hud-'+themeName+'.png'),Buffer.from(png,'base64'));
      }
    }
    qaStage='clear-confirmation';
    // A scrollable list must never clip the primary add/clear/start controls.
    const footerGeometry=await driver.executeScript(`
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const panel=shadow.querySelector('.panel').getBoundingClientRect();
      return ['add','clear','run'].map(id=>{
        const rect=shadow.getElementById(id).getBoundingClientRect();
        return {id,top:rect.top,bottom:rect.bottom,panelTop:panel.top,panelBottom:panel.bottom};
      });`);
    for(const entry of footerGeometry)
      assert.ok(entry.top>=entry.panelTop && entry.bottom<=entry.panelBottom-2,
        'HUD action must be fully visible: '+JSON.stringify(entry));
    // Verify individual deletion, then require two separate clicks to clear.
    const del=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2) .controls button:nth-child(4)')");
    await del.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='1 queued'`),5000);
    const clear=await driver.executeScript(`return ${jsEl('clear')}`);
    await clear.click();
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'1 queued');
    assert.equal(await driver.executeScript(`return ${jsEl('clear')}.textContent`),'Confirm clear');
    await clear.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='0 queued'`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // Local JSON import is a paused, explicit two-step operation. This
    // fixture uses Firefox's native file-input upload, never remote fetches.
    qaStage='backup-import';
    const backupPath=path.join(root,'synthetic-import.json');
    fs.writeFileSync(backupPath,JSON.stringify({kind:'chat-queue-message-backup',version:1,items:[
      {text:'Imported fixture pending',status:'pending'},
      {text:'Imported fixture uncertain',status:'uncertain'}
    ]}));
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    const backupFile=await driver.executeScript(`return ${jsEl('backup-file')}`);
    // WebDriver needs a visible QA input to supply an explicit fixture path;
    // the production control remains hidden behind its Import JSON button.
    await driver.executeScript(`const el=${jsEl('backup-file')};el.hidden=false`);
    await backupFile.sendKeys(backupPath);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('backup-confirm')}&&! ${jsEl('backup-confirm')}.hidden`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    // Delay the first write and click twice in the same browser task.
    // Only one staging confirmation may be consumed; no duplicate queue items
    // and no start/control mutation while the save is pending.
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='delay'");
    const importLock=await driver.executeScript(`
      const button=${jsEl('backup-confirm')};button.click();button.click();
      return {count:${jsEl('count')}.textContent,
        locked:${jsEl('add')}.disabled && ${jsEl('run')}.disabled};
    `);
    assert.deepEqual(importLock,{count:'2 queued',locked:true},
      'Confirmation must synchronously lock queue actions before yielding to storage');
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='no'");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('data-note')}.textContent.includes('Imported 2 messages') && !${jsEl('add')}.disabled`),9000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'2 queued');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='2 queued'`),10000);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // Retry uses the same guarded action as the external API and cannot
    // trigger a Send without another, separate Start.
    const retryImported=await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item.uncertain .controls button[aria-label=\"Allow manually requested retry\"]')");
    assert.equal(await retryImported.getText(),'Retry');
    await retryImported.click();
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length===0"),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    assert.match(await driver.executeScript(`return ${jsEl('status')}.textContent`),/Paused/);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='2 queued'`),10000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),0);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    const exportButton=await driver.executeScript(`return ${jsEl('backup-export')}`);
    await exportButton.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}.textContent.includes('download requested')`),5000);
    const downloaded=path.join(downloads,'chat-queue-messages.json');
    await driver.wait(async()=>fs.existsSync(downloaded),10000);
    assert.deepEqual(JSON.parse(fs.readFileSync(downloaded,'utf8')),{kind:'chat-queue-message-backup',version:1,items:[
      {text:'Imported fixture pending',status:'pending'},
      {text:'Imported fixture uncertain',status:'pending'}
    ]},'Actual Firefox download must contain parseable, metadata-free JSON');
    // Clean up fixture queue using the normal confirmed UI.
    const clearImported=await driver.executeScript(`return ${jsEl('clear')}`);
    await clearImported.click();await clearImported.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='0 queued'`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // A staged backup becomes stale as soon as the current queue changes.
    // Confirmation must not silently append to a queue different from the
    // one the user reviewed.
    qaStage='stale-backup-confirmation';
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`const input=${jsEl('backup-file')};input.hidden=false;input.value=''`);
    await (await driver.executeScript(`return ${jsEl('backup-file')}`)).sendKeys(backupPath);
    await driver.wait(async()=>await driver.executeScript(`return !${jsEl('backup-confirm')}.hidden`),5000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Queue changed after preview';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='1 queued'`),5000);
    await driver.executeScript(`return ${jsEl('backup-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Queue changed since import preview')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'1 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    const clearStale=await driver.executeScript(`return ${jsEl('clear')}`);
    await clearStale.click();await clearStale.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='0 queued'`),5000);
    // The import itself must roll back on a rejected durable write, disarm its
    // one-use confirmation, and remain empty after a real Firefox reload.
    qaStage='rejected-backup-persistence';
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`const input=${jsEl('backup-file')};input.hidden=false;input.value=''`);
    await (await driver.executeScript(`return ${jsEl('backup-file')}`)).sendKeys(backupPath);
    await driver.wait(async()=>await driver.executeScript(`return !${jsEl('backup-confirm')}.hidden`),5000);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='yes'");
    await driver.executeScript(`return ${jsEl('backup-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Import could not be stored')`),6000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript(`return ${jsEl('backup-confirm')}.hidden`),true);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    const importTokens=await driver.executeScript(() => ({
      write:document.documentElement.dataset.qaWriteEtag,
      rendered:document.documentElement.dataset.qaRenderedEtag
    }));
    assert.ok(importTokens.write && importTokens.rendered);
    assert.notEqual(importTokens.rendered,importTokens.write,
      'A rejected speculative save must invalidate its optimistic etag');
    // Storage is available again. An explicit fresh file selection and
    // confirmation may retry the local import, but not resume dispatch.
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='no'");
    await driver.executeScript(`const input=${jsEl('backup-file')};input.value=''`);
    await (await driver.executeScript(`return ${jsEl('backup-file')}`)).sendKeys(backupPath);
    await driver.wait(async()=>await driver.executeScript(`return !${jsEl('backup-confirm')}.hidden`),5000);
    await driver.executeScript(`return ${jsEl('backup-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('data-note')}.textContent.includes('Imported 2 messages') && ${jsEl('count')}.textContent==='2 queued'`),8000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // This backup contains an uncertain entry: review it explicitly before
    // clearing the remaining pending one; bulk Clear must not erase it.
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('[aria-label="Discard uncertain submission after review"]').click());
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='1 queued'`),8000);
    const clearAfterRecovery=await driver.executeScript(`return ${jsEl('clear')}`);
    await clearAfterRecovery.click();await clearAfterRecovery.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='0 queued'`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='0 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='backup-import-editor-lock';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/import-edit-lock`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript(`const draft=${jsEl('draft')};draft.value='Original before backup import';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='1 queued'`),8000);
    await driver.executeScript(
      "document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(3)').click()");
    await driver.wait(async()=>await driver.executeScript(
      "return Boolean(document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child textarea'))"),5000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`const input=${jsEl('backup-file')};input.hidden=false;input.value=''`);
    await (await driver.executeScript(`return ${jsEl('backup-file')}`)).sendKeys(backupPath);
    await driver.wait(async()=>await driver.executeScript(`return !${jsEl('backup-confirm')}.hidden`),5000);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='delay'");
    await driver.executeScript(`return ${jsEl('backup-confirm')}.click()`);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:first-child').disabled"),true,
      'An already-open edit Save must lock during backup persistence');
    assert.equal(await driver.executeScript(`return ${jsEl('add')}.disabled && ${jsEl('run')}.disabled`),true);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='no'");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='3 queued' && !${jsEl('add')}.disabled`),9000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child textarea').value"),'Original before backup import');
    await driver.executeScript(
      "document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(2)').click()");
    // The imported uncertain item must be deliberately discarded first;
    // ordinary Clear is valid only for the two remaining pending entries.
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('[aria-label="Discard uncertain submission after review"]').click());
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='2 queued'`),8000);
    const clearLocked=await driver.executeScript(`return ${jsEl('clear')}`);
    await clearLocked.click();await clearLocked.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='0 queued'`),8000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // QA seeds the unsupported record only once. If a queue edit clobbers
    // it, a reload will reveal that corruption instead of resetting the test.
    await driver.get(`http://127.0.0.1:${server.address().port}/c/future-record`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    await driver.executeScript(`const el=${jsEl('draft')};el.value='Synthetic should not replace future data';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}.textContent.includes('unsupported-saved-queue')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // A supported v1 record with duplicate IDs is not safe to normalize:
    // restore the entire original record read-only rather than dropping items.
    qaStage='malformed-persisted-queue-read-only';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/corrupt-record`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    await driver.executeScript(`const el=${jsEl('draft')};el.value='Never overwrite damaged queue';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('unsupported-saved-queue')`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='malformed-history-read-only';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/metadata-corrupt`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Must not discard prior history';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('unsupported-saved-queue')`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='explicit-null-saved-queue-read-only';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/null-record`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Never overwrite saved null';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('unsupported-saved-queue')`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Unsupported saved queue')`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // A recognizable versionless legacy record remains readable. Saving a
    // second queued item writes an accepted v1 record, which reload preserves.
    await driver.get(`http://127.0.0.1:${server.address().port}/c/legacy-record`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('status')}.textContent.includes('Unsupported saved queue')`),false);
    await driver.executeScript(`const el=${jsEl('draft')};el.value='Synthetic legacy migrated';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='2 queued'`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='2 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='forget-history';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/history-record`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('history')})`),10000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('history')}.querySelectorAll('.historyitem').length===1`),5000);
    const forget=await driver.executeScript(`return ${jsEl('history-clear')}`);
    await forget.click();
    assert.equal(await driver.executeScript(`return ${jsEl('history-clear')}.textContent`),'Confirm forget');
    assert.equal(await driver.executeScript(`return ${jsEl('history')}.querySelectorAll('.historyitem').length`),1);
    await forget.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('history')}.querySelectorAll('.historyitem').length===0`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('history')})`),10000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    assert.equal(await driver.executeScript(`return ${jsEl('history')}.querySelectorAll('.historyitem').length`),0,'History deletion must survive reload');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='failed-history-clear-render-rollback';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/history-fail-record');
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('history')
        ?.querySelectorAll('.historyitem').length===1),10000);
    await driver.executeScript(() => {
      document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true;
      document.documentElement.dataset.qaRejectQueueSave='yes';
    });
    const failedForget=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('history-clear'));
    await failedForget.click();
    await failedForget.click();
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('Could not save queue')),7000);
    // The rejected write restores history in memory. An unchanged revision
    // is NOT sufficient to reuse the blank cached history DOM.
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('history')
        .querySelectorAll('.historyitem').length),1,
      'Rejected history deletion must repaint the restored history immediately');
    const historyTokens=await driver.executeScript(() => ({
      write:document.documentElement.dataset.qaWriteEtag,
      rendered:document.documentElement.dataset.qaRenderedEtag
    }));
    assert.ok(historyTokens.write && historyTokens.rendered);
    assert.notEqual(historyTokens.rendered,historyTokens.write,
      'A rejected speculative save must invalidate its optimistic etag');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('history')
        ?.querySelectorAll('.historyitem').length===1),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='explicit-orphan-recovery';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/recovery-record`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('recovery-find')})`),10000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    const findOld=await driver.executeScript(`return ${jsEl('recovery-find')}`);
    const confirmOld=await driver.executeScript(`return ${jsEl('recovery-confirm')}`);
    await findOld.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('recovery-confirm')}.hidden===false`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued',
      'Discovery alone must never modify the active queue');
    // A double click must only copy the source once, even though the first
    // handler yields during its source recheck.
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='delay'");
    const recoveryLock=await driver.executeScript(`
      const button=${jsEl('recovery-confirm')};button.click();button.click();
      const locked=${jsEl('add')}.disabled && ${jsEl('clear')}.disabled &&
        ${jsEl('run')}.disabled && ${jsEl('backup-export')}.disabled;
      const d=${jsEl('draft')};d.value='Must not race recovery';
      ${jsEl('add')}.click();
      return {locked,queued:${jsEl('count')}.textContent};
    `);
    assert.deepEqual(recoveryLock,{locked:true,queued:'0 queued'},
      'Recovery must synchronously lock all mutations before the source recheck yields');
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='1 queued' && !${jsEl('add')}.disabled`),9000);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='no'");
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1,
      'A prior tab pending message must become uncertain on explicit recovery');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('data-note')}.textContent.includes('No other compatible queue')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('recovery-confirm')}.hidden`),true);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // Rejected recovery persistence must roll back both restored messages
    // and source-consumption markers, permitting only a *fresh* user retry.
    qaStage='project-alias-explicit-uncertain-recovery';
    await driver.get('http://127.0.0.1:'+server.address().port+'/g/qa/c/recovery-alias');
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('recovery-find')})`),10000);
    await driver.executeScript(
      "document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued',
      'A project URL must not silently inherit queued prompts from a direct URL');
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('recovery-confirm')}.hidden===false`),5000);
    assert.ok((await driver.executeScript(`return ${jsEl('data-note')}.textContent`))
      .includes('1 earlier queue(s)'),
      'Find may identify only the same exact conversation ID, not lookalikes');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued',
      'Find alone must never import across URL aliases');
    await driver.executeScript(`return ${jsEl('recovery-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='1 queued'`),8000);
    const aliasPreview=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item.uncertain .preview')?.textContent);
    assert.ok(aliasPreview?.endsWith('Synthetic prior alias message') &&
      aliasPreview.includes('Submission uncertain') &&
      !aliasPreview.includes('Different conversation must remain secret'),
      'Only matching previous-tab text appears, under an uncertainty warning');
    assert.equal(await driver.executeScript('return window.__sendCount'),0,
      'Explicit recovery must not imply Send or resume');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    await driver.executeScript(
      "document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('data-note')}.textContent.includes('No other compatible queue')`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='recovery-write-rejected';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/recovery-save-fail`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('recovery-find')})`),10000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('recovery-confirm')}?.hidden===false`),5000);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='yes'");
    await driver.executeScript(`return ${jsEl('recovery-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Recovery could not be saved') && !${jsEl('add')}.disabled`),6000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript(`return ${jsEl('recovery-confirm')}.hidden`),true);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    const recoveryTokens=await driver.executeScript(() => ({
      write:document.documentElement.dataset.qaWriteEtag,
      rendered:document.documentElement.dataset.qaRenderedEtag
    }));
    assert.ok(recoveryTokens.write && recoveryTokens.rendered);
    assert.notEqual(recoveryTokens.rendered,recoveryTokens.write,
      'A rejected speculative save must invalidate its optimistic etag');
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='no'");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('recovery-confirm')}?.hidden===false`),5000);
    await driver.executeScript(`return ${jsEl('recovery-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='1 queued' && !${jsEl('add')}.disabled`),8000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item.uncertain').length"),1);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='uncertain-message-explicit-resolution-only';
    const uncertainBefore=await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item.uncertain .preview').textContent);
    const lockedUncertain=await driver.executeScript(() => {
      const root=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const row=root.querySelector('.item.uncertain');
      return {
        editDisabled:row.querySelector('[aria-label="Edit message"]').disabled,
        deleteDisabled:row.querySelector('[aria-label="Remove message"]').disabled,
        retryEnabled:!row.querySelector('[aria-label="Allow manually requested retry"]').disabled,
        discardEnabled:!row.querySelector('[aria-label="Discard uncertain submission after review"]').disabled
      };
    });
    assert.deepEqual(lockedUncertain,{
      editDisabled:true,deleteDisabled:true,retryEnabled:true,discardEnabled:true
    },'Uncertain items can only be explicitly resolved, not silently edited or deleted');
    await driver.executeScript(() => {
      const clear=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('clear');
      clear.click();clear.click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('resolve-uncertain-message')),6000);
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item.uncertain .preview').textContent),uncertainBefore,
      'Bulk clear must not destroy an uncertain submission');
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('[aria-label="Discard uncertain submission after review"]').click());
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count')
        .textContent==='0 queued'),9000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('count')
        ?.textContent==='0 queued'),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='recovery-source-mutated-after-discovery';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/recovery-mutate`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('recovery-find')})`),10000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('recovery-confirm')}?.hidden===false`),5000);
    await driver.executeScript("document.documentElement.dataset.qaMutateRecoverySource='future'");
    await driver.executeScript(`return ${jsEl('recovery-confirm')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Earlier queue changed')`),6000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued',
      'A changed future-version source must not be imported');
    assert.equal(await driver.executeScript(`return ${jsEl('recovery-confirm')}.hidden`),true);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('recovery-find')})`),10000);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('data-note')}.textContent.includes('No other compatible queue')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='storage-failure';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/storage-fail`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='yes'");
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Message with failed persistence';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('queue-save-failed')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript(`return ${jsEl('draft')}.value`),'Message with failed persistence',
      'Rejected Add must preserve the draft for deliberate retry');
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    assert.equal(await driver.executeScript(`return ${jsEl('backup-export')}.disabled`),true,
      'Failed storage write must disable exporting unsaved in-memory data');
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('storage-unavailable')`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    // A subsequent explicitly requested Add clears the fault and saves only
    // that new item; the rejected Add must never become a phantom entry.
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='no'");
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Second saved message';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Storage restored')`),5000);
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='pending-storage-write';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/slow-storage`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript("document.documentElement.dataset.qaRejectQueueSave='delay'");
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Slow local save must finish first';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('backup-export')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Backup unavailable while queue changes')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('backup-export')}.disabled`),true);
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('queue-save-pending')`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('draft')}.value===''`),8000);
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),5000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='event-page-registry-loss';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/registry-loss`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Registered metadata only';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Signal registry restarted')`),6000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'1 queued');
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='idle-registry-heartbeat-recovery';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/heartbeat-loss`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('run')})`),10000);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Signal registry restarted')`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('queue-empty')`),5000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='rapid-aba-conversation-navigation';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/aba-home`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),12000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Preserved home queue';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='1 queued'`),8000);
    await driver.executeScript("history.pushState({},'', '/c/route-delay')");
    await driver.wait(async()=>await driver.executeScript(
      "return getComputedStyle(document.getElementById('chat-queue-extension-root')).visibility==='hidden'"),4000);
    // The old chat's queue remains stored, but must be invisible while
    // the new conversation's storage read is deliberately delayed.
    assert.equal(await driver.executeScript(
      "return getComputedStyle(document.getElementById('chat-queue-extension-root')).visibility"),'hidden');
    await driver.executeScript("history.pushState({},'', '/c/aba-home')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Conversation changed; manually start queue')`),7500);
    assert.equal(await driver.executeScript(
      "return getComputedStyle(document.getElementById('chat-queue-extension-root')).visibility"),'visible',
      'Only the winning loaded conversation may restore the HUD');
    await driver.executeScript(`const d=${jsEl('draft')};d.value='After interrupted navigation';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='2 queued'`),8000);
    // The delayed B load must not overwrite A when it eventually resolves.
    await driver.sleep(4300);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'2 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript("history.pushState({},'', '/c/route-delay')");
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='0 queued'`),8500);
    await driver.executeScript("history.pushState({},'', '/c/aba-home')");
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='2 queued'`),8000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='failed-navigation-storage-read';
    await driver.executeScript("history.pushState({},'', '/c/load-fail')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Could not load conversation queue; reload to retry')`),7000);
    assert.equal(await driver.executeScript(
      "return getComputedStyle(document.getElementById('chat-queue-extension-root')).visibility"),'visible',
      'Failed storage load must show only the empty read-only failure HUD');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Must never overwrite unreadable queue';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('unsupported-saved-queue')`),6000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript("history.pushState({},'', '/c/aba-home')");
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='2 queued'`),7000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='delayed-old-route-metadata-rejection';
    await driver.get(`http://127.0.0.1:${server.address().port}/c/stale-meta-home`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Saved in original conversation';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='1 queued'`),7000);
    await driver.executeScript("history.pushState({},'', '/c/stale-meta-new')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Conversation changed; manually start queue')`),7500);
    await driver.sleep(2700);
    assert.equal(await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('Signal registry restarted')`),false,
      'Delayed route-mismatch from earlier pathname must not re-register new queue');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    await driver.executeScript("history.pushState({},'', '/c/stale-meta-home')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}.textContent==='1 queued'`),8000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='unassigned-conversation-start-gate';
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Unassigned route cannot send';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}.textContent==='1 queued' && ${jsEl('draft')}.value===''`),8000);
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('conversation-not-assigned')`),7000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('count')}?.textContent==='1 queued'`),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    qaStage='unassigned-route-previous-tab-recovery-denied';
    const homeOwner=await driver.getWindowHandle();
    await driver.switchTo().newWindow('tab');
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${jsEl('recovery-find')})`),10000);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),
      '0 queued','An unassigned new tab must not implicitly adopt the earlier home queue');
    await driver.executeScript("document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('details').open=true");
    await driver.executeScript(`return ${jsEl('recovery-find')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('data-note')}.textContent.includes('Recovery requires an assigned conversation URL')`),5000);
    assert.equal(await driver.executeScript(`return ${jsEl('recovery-confirm')}.hidden`),true,
      'A home route cannot offer another tab\'s unrelated new-chat messages for recovery');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.close();
    await driver.switchTo().window(homeOwner);
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'1 queued',
      'Denied cross-tab home recovery must preserve the original queue');
    qaStage='unassigned-route-variants';
    for(const route of ['/g/g-synthetic','/g/g-synthetic/c','/share/synthetic','/search','/c/synthetic/extra']){
      await driver.get(`http://127.0.0.1:${server.address().port}${route}`);
      await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
      await driver.executeScript(`const d=${jsEl('draft')};d.value='Never send on unassigned route';`);
      await driver.executeScript(`return ${jsEl('add')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${jsEl('count')}.textContent==='1 queued' && ${jsEl('draft')}.value===''`),8000);
      await driver.executeScript(`return ${jsEl('run')}.click()`);
      await driver.wait(async()=>await driver.executeScript(
        `return ${jsEl('status')}.textContent.includes('conversation-not-assigned')`),7000);
      assert.equal(await driver.executeScript('return window.__sendCount'),0,
        'Unassigned page must never dispatch: '+route);
    }
    // A project-associated existing conversation route is acceptable as a
    // shape, but still requires a separate authenticated provider event.
    await driver.get(`http://127.0.0.1:${server.address().port}/g/g-synthetic/c/project-chat`);
    await driver.wait(async()=>await driver.executeScript(`return Boolean(${jsEl('draft')})`),10000);
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Still requires provider';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('draft')}.value===''`),8000);
    await driver.executeScript(`return ${jsEl('run')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),7000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='initial-register-route-race';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/bootstrap-register-old');
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaBootstrapRegisterPending==='yes'"),7000);
    await driver.executeScript("history.pushState({},'', '/c/bootstrap-register-new')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('status')}?.textContent.includes('Paused; press Start')`),10000);
    assert.equal(await driver.executeScript(
      `return ${jsEl('count')}.textContent`),'0 queued');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='initial-load-route-privacy';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/bootstrap-old');
    await driver.wait(async()=>await driver.executeScript(
      "return document.documentElement.dataset.qaBootstrapLoadPending==='yes'"),7000);
    await driver.executeScript("history.pushState({},'', '/c/bootstrap-new')");
    await driver.sleep(2000);
    const bootstrapProbe=await driver.executeScript(() => {
      const host=document.querySelector('#chat-queue-extension-root');
      return {mounted:Boolean(host),privateRowPresent:Boolean(
        host?.shadowRoot?.textContent.includes('Private old bootstrap prompt')),
        hidden:host?getComputedStyle(host).visibility==='hidden':null};
    });
    assert.equal(bootstrapProbe.mounted,true,'Old read finishes before the new route read');
    assert.equal(bootstrapProbe.privateRowPresent,false,
      'A previous conversation must never enter the new route HUD DOM');
    assert.equal(bootstrapProbe.hidden,true,
      'The new route must remain hidden until its own storage is loaded');
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}?.textContent==='0 queued' &&
        getComputedStyle(document.getElementById('chat-queue-extension-root')).visibility==='visible'`),8500);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    await driver.executeScript("history.pushState({},'', '/c/bootstrap-old')");
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}?.textContent==='1 queued'`),8000);
    assert.deepEqual(await driver.executeScript(() =>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')]
        .map(x=>x.textContent)),['Private old bootstrap prompt'],
      'Original route retains its saved queue after return');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='inflight-add-draft-preservation';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/inflight-add-draft');
    await driver.wait(async()=>await driver.executeScript(()=>
      Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft'))),10000);
    await driver.executeScript(() => {
      const root=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const draft=root.getElementById('draft');
      draft.value='First slow synthetic prompt';
      draft.dispatchEvent(new Event('input',{bubbles:true}));
      document.documentElement.dataset.qaRejectQueueSave='delay';
      root.getElementById('add').click();
      // The same slow Add receives a rapid second click. One deliberate
      // action must enqueue only one prompt, never two duplicates.
      root.getElementById('add').click();
      if(!root.getElementById('add').disabled)
        throw new Error('Add must lock synchronously until the first save settles');
      // A newer user draft arrives while the first save is still delayed.
      draft.value='Second protected synthetic draft';
      draft.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await driver.sleep(2950);
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent),
      '1 queued','Rapid duplicate clicks must not enqueue a second copy');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').disabled),
      false,'Durable first Add should unlock the control');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft').value),
      'Second protected synthetic draft',
      'Earlier Add completion must never clear the newer draft');
    await driver.executeScript(() => {
      document.documentElement.dataset.qaRejectQueueSave='';
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='2 queued'),9000);
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft').value===''),9000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('count')?.textContent==='2 queued'),9000);
    assert.deepEqual(await driver.executeScript(() =>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')]
        .map(x=>x.textContent)),
      ['First slow synthetic prompt','Second protected synthetic draft']);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);



    qaStage='rejected-add-write-and-manual-retry';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/rejected-add-rollback');
    await driver.wait(async()=>await driver.executeScript(()=>
      Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft'))),10000);
    await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const draft=sh.getElementById('draft');
      draft.value='Synthetic append must survive manual retry once';
      draft.dispatchEvent(new Event('input',{bubbles:true}));
      document.documentElement.dataset.qaRejectQueueSave='yes';
      sh.getElementById('add').click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('queue-save-failed')),8000);
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent),
      '0 queued','Rejected Add cannot retain an unsaved phantom queue item');
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft').value),
      'Synthetic append must survive manual retry once');
    await driver.executeScript(() => {
      document.documentElement.dataset.qaRejectQueueSave='';
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft').value==='' &&
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='1 queued'),9000);
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('count')?.textContent==='1 queued'),10000);
    assert.deepEqual(await driver.executeScript(()=>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.preview')]
        .map(x=>x.textContent)),
      ['Synthetic append must survive manual retry once']);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);


    qaStage='route-scoped-unsaved-hud-drafts';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/draft-route-a');
    await driver.wait(async()=>await driver.executeScript(()=>
      Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft'))),10000);
    await driver.executeScript(() => {
      const draft=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft');
      draft.value='Volatile unsent draft for conversation A';
      draft.dispatchEvent(new Event('input',{bubbles:true}));
      history.pushState({},'', '/c/draft-route-b');
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('status')
        ?.textContent.includes('Conversation changed; manually start queue') &&
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft').value===''),10000);
    // B must never inherit A's private unsubmitted text or queued messages.
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent),
      '0 queued');
    await driver.executeScript(() => {
      const draft=document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft');
      draft.value='Independent unsent draft for conversation B';
      draft.dispatchEvent(new Event('input',{bubbles:true}));
      history.pushState({},'', '/c/draft-route-a');
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft')
        ?.value==='Volatile unsent draft for conversation A'),10000);
    await driver.executeScript("history.pushState({},'', '/c/draft-route-b')");
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft')
        ?.value==='Independent unsent draft for conversation B'),10000);
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('add').click());
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft')?.value==='' &&
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent==='1 queued'),9000);
    await driver.executeScript("history.pushState({},'', '/c/draft-route-a')");
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft')
        ?.value==='Volatile unsent draft for conversation A'),10000);
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('count').textContent),
      '0 queued','B committed item cannot appear in A');
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='100-item-status-render-workload';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/max-queue-performance');
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent==='100 queued'),12000);
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('items').querySelectorAll('.item').length),100);
    const perf=await driver.executeAsyncScript(function(){
      const done=arguments[arguments.length-1];
      const shadow=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const items=shadow.getElementById('items'),first=items.firstElementChild;
      let rowMutations=0;
      const observer=new MutationObserver(records=>{
        for(const record of records)rowMutations+=record.addedNodes.length+record.removedNodes.length;
      });
      observer.observe(items,{childList:true});
      const start=performance.now();
      (async()=>{
        for(let i=0;i<80;i++){
          document.documentElement.dataset.chatSignalsState=i%2?'generating':'finished';
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        await new Promise(resolve=>setTimeout(resolve,60));
        observer.disconnect();
        done({elapsedMs:Math.round(performance.now()-start),rowMutations,
          sameFirst:first===items.firstElementChild,
          count:items.querySelectorAll('.item').length});
      })().catch(err=>done({error:String(err)}));
    });
    assert.equal(perf.error,undefined,'Performance workload must execute');
    assert.equal(perf.count,100);
    assert.equal(perf.rowMutations,0,
      'Unverified Signal-only phase changes must not churn 100 queue rows');
    assert.equal(perf.sameFirst,true);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
    console.log('FDE 100-item Signal status workload (80 changes): '+JSON.stringify(perf));


    qaStage='hud-edit-delete-reorder-storage-rollback';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/ui-rollback');
    await driver.wait(async()=>await driver.executeScript(()=>
      Boolean(document.querySelector('#chat-queue-extension-root')?.shadowRoot?.getElementById('draft'))),10000);
    for(const prompt of ['First durable synthetic item','Second durable synthetic item']){
      await driver.executeScript(text=>{
        const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
        sh.getElementById('draft').value=text;
        sh.getElementById('add').click();
      },prompt);
      await driver.wait(async()=>await driver.executeScript(()=>
        document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('draft').value===''),10000);
    }
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child .controls button:nth-child(3)').click());
    await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      const editor=sh.querySelector('.item:first-child textarea');
      editor.value='Rejected synthetic edited text';
      document.documentElement.dataset.qaRejectQueueSave='yes';
      sh.querySelector('.item:first-child .controls button:first-child').click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('queue-save-failed')),7000);
    assert.equal(await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child textarea').value),'Rejected synthetic edited text');
    await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child .controls button:nth-child(2)').click());
    assert.deepEqual(await driver.executeScript(()=>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')]
        .map(x=>x.textContent)),
      ['First durable synthetic item','Second durable synthetic item'],
      'Rejected local Edit must leave original item text unchanged');
    await driver.executeScript(() => {
      document.documentElement.dataset.qaRejectQueueSave='yes';
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:first-child .controls button:nth-child(4)').click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('queue-save-failed') &&
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')]
        .map(x=>x.textContent).join('|')==='First durable synthetic item|Second durable synthetic item'),7000);
    assert.deepEqual(await driver.executeScript(()=>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')]
        .map(x=>x.textContent)),
      ['First durable synthetic item','Second durable synthetic item'],
      'Rejected local Delete must restore the removed item immediately');
    await driver.executeScript(() => {
      document.documentElement.dataset.qaRejectQueueSave='yes';
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelector('.item:nth-child(2) .controls button:first-child').click();
    });
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('status')
        .textContent.includes('queue-save-failed') &&
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')]
        .map(x=>x.textContent).join('|')==='First durable synthetic item|Second durable synthetic item'),7000);
    assert.deepEqual(await driver.executeScript(()=>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')]
        .map(x=>x.textContent)),
      ['First durable synthetic item','Second durable synthetic item'],
      'Rejected local Reorder must restore previous order');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(()=>
      document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.querySelectorAll('.item .preview').length===2),10000);
    assert.deepEqual(await driver.executeScript(()=>
      [...document.querySelector('#chat-queue-extension-root').shadowRoot.querySelectorAll('.item .preview')]
        .map(x=>x.textContent)),
      ['First durable synthetic item','Second durable synthetic item']);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='history-clear-overlapping-failed-add';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/history-concurrent-fail');
    await driver.wait(async()=>await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root')?.shadowRoot;
      return sh?.querySelectorAll('#history .historyitem').length===1;
    }),10000);
    await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      sh.getElementById('draft').value='Rejected concurrent synthetic Add';
      document.documentElement.dataset.qaRejectQueueSave='delay-reject';
      sh.getElementById('add').click();
      // Guard inside the click handler must reject both premature clicks.
      sh.getElementById('history-clear').click();
      sh.getElementById('history-clear').click();
    });
    assert.equal(await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('history-clear').textContent),'Forget history',
      'Pending Add must not arm or execute a history deletion');
    await driver.wait(async()=>await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root').shadowRoot;
      return sh.getElementById('status').textContent.includes('queue-save-failed');
    }),6500);
    assert.equal(await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .getElementById('count').textContent),'0 queued',
      'Rejected Add must be fully rolled back');
    assert.equal(await driver.executeScript(() =>
      document.querySelector('#chat-queue-extension-root').shadowRoot
        .querySelectorAll('#history .historyitem').length),1,
      'History stays intact when overlapping deletion is refused');
    await driver.navigate().refresh();
    await driver.wait(async()=>await driver.executeScript(() => {
      const sh=document.querySelector('#chat-queue-extension-root')?.shadowRoot;
      return sh?.getElementById('count')?.textContent==='0 queued' &&
        sh?.querySelectorAll('#history .historyitem').length===1;
    }),10000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);

    qaStage='untrusted-browser-lifecycle-events';
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/pagehide-spoof');
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${jsEl('draft')}) && window.__sendCount===0`),10000);
    // Temporary Firefox add-on content scripts can mount the HUD before the
    // localhost test page's inline counter is ready. This guard avoids
    // interpreting an uninitialized QA variable as a failed no-Send check.
    // A hostile page must not deactivate Queue by forging lifecycle events.
    await driver.executeScript(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Still active after untrusted event';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}?.textContent==='1 queued' && window.__sendCount===0`),9000,
      'Forged lifecycle event must neither clear the queue nor Send');
    await driver.get('http://127.0.0.1:'+server.address().port+'/c/pagehide-away');
    await driver.navigate().back();
    // Firefox may instantiate a new document or resume a bfcache document.
    // Both paths must restore the persisted message but never an old Run.
    await driver.wait(async()=>await driver.executeScript(
      `return ${jsEl('count')}?.textContent==='1 queued' && window.__sendCount===0`),15000);
    // A bfcache pageshow may schedule a forced fresh reload just AFTER the
    // HUD first appears. Do not edit a transient restored document. Require
    // the same complete document to retain its queue across two real WebDriver
    // samples separated by a browser scheduling interval.
    const pageSnapshot=()=>driver.executeScript(() => ({
      origin:performance.timeOrigin,
      ready:document.readyState==='complete',
      count:document.querySelector('#chat-queue-extension-root')?.shadowRoot
        ?.getElementById('count')?.textContent||null,
      sends:window.__sendCount
    }));
    await driver.wait(async()=>{
      try{
        const first=await pageSnapshot();
        if(!first.ready||first.count!=='1 queued'||first.sends!==0)return false;
        await driver.sleep(650);
        const second=await pageSnapshot();
        return second.ready&&second.count==='1 queued'&&second.sends===0&&
          second.origin===first.origin;
      }catch{return false;}
    },16000,'Firefox restored page did not settle before queue editing');
    await driver.executeScript(`const d=${jsEl('draft')};d.value='Editable after back navigation';`);
    await driver.executeScript(`return ${jsEl('add')}.click()`);
    try{
      await driver.wait(async()=>await driver.executeScript(
        `return ${jsEl('count')}?.textContent==='2 queued' && window.__sendCount===0`),11000,
        'Back-navigation cannot resurrect a prior Send grant');
    }catch(error){
      let snapshot=null;
      try{snapshot=await driver.executeScript(() => ({
        href:location.href,ready:document.readyState,origin:performance.timeOrigin,
        sends:window.__sendCount??null,
        count:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('count')?.textContent||null,
        note:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('status')?.textContent||null,
        draft:document.querySelector('#chat-queue-extension-root')?.shadowRoot
          ?.getElementById('draft')?.value||null
      }));}catch{}
      throw new Error('Back-navigation delivery diagnostic '+JSON.stringify(snapshot)+
        ': '+error.message);
    }

    qaStage='teardown';
    await driver.uninstallAddon(id);
    console.log('FDE synthetic: HUD, layout geometry/contrast, placement persistence, reorder, themes and fail-closed behavior pass');
  }catch(error){
    throw new Error('stage '+qaStage+': '+error.message);
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE synthetic failed:',error.message);process.exitCode=1;});
