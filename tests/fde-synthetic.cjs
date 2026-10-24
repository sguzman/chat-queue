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
      `browser.runtime.onMessage.addListener((msg,sender)=>{
        if(msg?.type!=='chat-queue-internal/v1')return;
        if(msg.action==='register'){
          if(msg.route==='/c/future-record'||msg.route==='/c/legacy-record'){
            const key='chatqueue:v1:tab:'+sender.tab.id+':'+msg.route;
            return browser.storage.local.get(key).then(saved=>{
              if(Object.hasOwn(saved,key))return {ok:true,tabId:sender.tab.id};
              const record=msg.route==='/c/future-record'
                ? {version:99,items:[{id:'future0001',text:'Synthetic retained prompt',status:'pending'}]}
                : {items:[{id:'legacy0001',text:'Synthetic legacy prompt',status:'pending'}]};
              return browser.storage.local.set({[key]:record}).then(()=>({ok:true,tabId:sender.tab.id}));
            });
          }
          return Promise.resolve({ok:true,tabId:sender.tab.id});
        }
        if(msg.action==='state')return Promise.resolve({ok:true});
       });`);
    // Exercise actual Firefox reduced-motion preference, not a mocked media query.
    const options=new firefox.Options().setBinary(binary).addArguments('-headless')
      .setPreference('ui.prefersReducedMotion',1);
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
    // Edit queue contents without overwriting the HUD input or ChatGPT draft.
    await input.sendKeys('Synthetic unsaved HUD draft');
    await driver.executeScript("document.getElementById('prompt-textarea').textContent='Synthetic site draft'");
    const edit=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(3)')");
    await edit.click();
    let editField=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child textarea')");
    await editField.clear();await editField.sendKeys('Synthetic edited first message');
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
    // Exercise native Firefox HTML5 pointer drag, not synthetic JS drag/drop.
    const dragSource=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(2)')");
    const dragTarget=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:nth-child(1)')");
    await driver.actions({async:true}).dragAndDrop(dragSource,dragTarget).perform();
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic second message'"),6000);
    // Reverse the drag through the keyboard alternative; future reload must
    // preserve this explicit final order.
    const downAfterDrag=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .controls button:nth-child(2)')");
    await downAfterDrag.sendKeys(Key.ENTER);
    await driver.wait(async()=>await driver.executeScript(
      "return document.querySelector('#chat-queue-extension-root').shadowRoot.querySelector('.item:first-child .preview')?.textContent==='Synthetic first message'"),5000);
    const toggle=await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('toggle')");
    await toggle.sendKeys(Key.ENTER);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('body').hidden"),true);
    await toggle.sendKeys(Key.ENTER);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').shadowRoot.getElementById('body').hidden"),false);
    await driver.executeScript(`const el=${jsEl('theme')};el.value='light';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='light'"),5000);
    const lightToken=await driver.executeScript("return getComputedStyle(document.querySelector('#chat-queue-extension-root')).getPropertyValue('--panel').trim()");
    await driver.executeScript(`const el=${jsEl('theme')};el.value='dark';el.dispatchEvent(new Event('change',{bubbles:true}))`);
    await driver.wait(async()=>await driver.executeScript("return document.querySelector('#chat-queue-extension-root')?.dataset.theme==='dark'"),5000);
    const darkToken=await driver.executeScript("return getComputedStyle(document.querySelector('#chat-queue-extension-root')).getPropertyValue('--panel').trim()");
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
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right"),movedRight);
    const reset=await driver.executeScript(`return ${jsEl('reset')}`);
    await reset.click();
    assert.equal(await driver.executeScript(`return ${jsEl('body')}.hidden`),false);
    assert.equal(await driver.executeScript("return document.querySelector('#chat-queue-extension-root').style.right"),'20px');
    assert.equal(await driver.executeScript(`return ${jsEl('count')}.textContent`),'2 queued');
    await driver.executeScript("document.documentElement.dataset.chatSignalsState='finished'");
    const start=await driver.executeScript(`return ${jsEl('run')}`);
    await start.click();
    await driver.wait(async()=>await driver.executeScript(`return ${jsEl('status')}.textContent.includes('authenticated-chat-signals-required')`),7000);
    assert.equal(await driver.executeScript('return window.__sendCount'),0);
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
    await driver.uninstallAddon(id);
    console.log('FDE synthetic: HUD, layout geometry/contrast, placement persistence, reorder, themes and fail-closed behavior pass');
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE synthetic failed:',error.message);process.exitCode=1;});
