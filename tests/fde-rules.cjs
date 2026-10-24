'use strict';
// Runs the production rules UI in real headless Firefox Developer Edition with
// only a test-only, no-network storage stub. Never authenticates ChatGPT.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Builder,By}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');
const root=path.resolve(__dirname,'..');
const STUB=`<script>window.browser={storage:{local:{
 get:async k=>({[k]:JSON.parse(sessionStorage.getItem(k)||'null') ?? undefined}),
 set:async value=>{for(const [k,v] of Object.entries(value))sessionStorage.setItem(k,JSON.stringify(v));},
 remove:async k=>sessionStorage.removeItem(k)
 },onChanged:{addListener:()=>{}}}}</script>`;
const files={
 '/options/rule-preview.js':{name:'options/rule-preview.js',mime:'application/javascript'},
 '/options/options.js':{name:'options/options.js',mime:'application/javascript'},
 '/src/signal.js':{name:'src/signal.js',mime:'application/javascript'},
 '/src/rules.js':{name:'src/rules.js',mime:'application/javascript'},
 '/src/rule-store.js':{name:'src/rule-store.js',mime:'application/javascript'}
};
async function main(){
 const binary=process.env.FDE_BINARY;
 if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('FDE_BINARY must identify Firefox Developer Edition');
 const server=http.createServer((req,res)=>{
  const f=files[req.url];
  if(f){res.writeHead(200,{'content-type':f.mime});res.end(fs.readFileSync(path.join(root,f.name)));return;}
  if(req.url==='/options/options.html'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
   const source=fs.readFileSync(path.join(root,'options/options.html'),'utf8');
   res.end(source.replace('<title>Chat Queue preferences</title>', '<title>Chat Queue preferences</title>'+STUB));return;
  }
  res.writeHead(404);res.end('Not found');
 });
 let driver;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  driver=await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options().setBinary(binary).addArguments('-headless')).build();
  await driver.get(`http://127.0.0.1:${server.address().port}/options/options.html`);
  await driver.wait(async()=>await driver.executeScript('return Boolean(window.ChatQueueRules && document.querySelector("#rule-form"))'),15000);
  await driver.findElement(By.id('rule-id')).clear();
  await driver.findElement(By.id('rule-id')).sendKeys('synthetic-rule');
  await driver.findElement(By.id('rule-phase')).sendKeys('Failed');
  await driver.findElement(By.id('rule-action')).sendKeys('Pause');
  await driver.findElement(By.id('rule-min-duration')).sendKeys('5000');
  await driver.findElement(By.id('rule-max-duration')).sendKeys('8000');
  await driver.findElement(By.id('rule-add')).click();
  await driver.wait(async()=>/1 saved preview rule/.test(await driver.findElement(By.id('rule-message')).getText()),7000);
  assert.equal(await driver.findElement(By.css('#rule-list li')).getText().then(x=>x.includes('synthetic-rule')),true);
  await driver.findElement(By.id('preview-phase')).sendKeys('Failed');
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/no-match/);
  await driver.findElement(By.id('preview-duration')).sendKeys('6000');
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/Would propose pausing/);
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/already-considered/);
  await driver.findElement(By.id('preview-reset')).click();
  await driver.findElement(By.id('preview-origin')).sendKeys('Restored');
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/not-actionable/);
  await driver.executeScript('document.getElementById("preview-origin").value="fresh"; document.getElementById("preview-phase").value="failed"; document.getElementById("preview-confidence").value="observed"; document.getElementById("preview-epoch").value="2"; document.getElementById("rule-action").value="propose"; document.getElementById("rule-action").dispatchEvent(new Event("change"));');
  const injection='<img src=x onerror="window.__previewXss=1">';
  await driver.executeScript('document.querySelector("#rule-text").value=arguments[0]',injection);
  await driver.findElement(By.id('rule-add')).click();
  await driver.wait(async()=>/Saved synthetic-rule/.test(await driver.findElement(By.id('rule-message')).getText()),7000);
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.equal(await driver.executeScript('return window.__previewXss===undefined'),true);
  assert.equal(await driver.executeScript('return document.querySelectorAll("#preview-output img").length'),0);
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/onerror/);
  const privateFreeAudit=await driver.executeScript('return document.getElementById("preview-audit").textContent');
  assert.match(privateFreeAudit,/finished|failed/);
  assert.doesNotMatch(privateFreeAudit,/onerror|<img|synthetic-preview|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(await driver.executeScript('return document.querySelectorAll("#preview-audit img").length'),0);
  await driver.executeScript(()=>{
    const form=document.getElementById('preview-form');
    for(let i=0;i<25;i++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
  const auditRows=await driver.executeScript(
    'return document.getElementById("preview-audit").textContent.split("\\n").length');
  assert.equal(auditRows,20,'Preview audit must remain bounded to 20 ephemeral outcomes');
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return /1 saved/.test(document.querySelector("#rule-message").textContent)'),15000);
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,1,'Saved rule definitions should persist across reload');
  assert.match(await driver.findElement(By.css('#rule-list li')).getText(),/synthetic-rule/);
  assert.match(await driver.findElement(By.css('#rule-list li')).getText(),/5000 ms/);
  // No rules evaluate by themselves after refresh, even with saved proposals.
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/no queue action/i);
  assert.match(await driver.executeScript('return document.getElementById("preview-audit").textContent'),/No previews recorded/,
    'audit trace must not survive page reload or enter persistent rule storage');
  // Change a saved rule after reload and verify its durable action changes.
  await driver.findElement(By.css('#rule-list li button[aria-label^="Edit"]')).click();
  assert.equal(await driver.findElement(By.id('rule-min-duration')).getAttribute('value'),'5000');
  await driver.findElement(By.id('rule-action')).sendKeys('Pause');
  await driver.findElement(By.id('rule-add')).click();
  await driver.wait(async()=>/Saved synthetic-rule/.test(await driver.findElement(By.id('rule-message')).getText()),5000);
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return /1 saved/.test(document.querySelector("#rule-message").textContent)'),10000);
  assert.match(await driver.findElement(By.css('#rule-list li')).getText(),/pause/);
  // Arming Clear then editing something else must cancel that confirmation.
  await driver.findElement(By.id('rule-clear')).click();
  await driver.findElement(By.css('#rule-list li button[aria-label^="Edit"]')).click();
  assert.equal(await driver.findElement(By.id('rule-clear')).getText(),'Clear saved rules');
  // Destructive removal is explicitly two-step and cannot silently execute.
  await driver.findElement(By.id('rule-clear')).click();
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,1);
  await driver.findElement(By.id('rule-clear')).click();
  await driver.wait(async()=>0===(await driver.findElements(By.css('#rule-list li'))).length,5000);
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return /0 saved/.test(document.querySelector("#rule-message").textContent)'),10000);
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,0);
  // The preview dependency/skip controls are simulations, not authorization.
  // Build three saved rules and assert deterministic precedence via the real
  // Firefox Options UI; no queue extension or ChatGPT page is involved.
  const installRule=async({id,priority,depends='',skip=''})=>{
    await driver.executeScript((data)=>{
      document.getElementById('rule-id').value=data.id;
      document.getElementById('rule-priority').value=String(data.priority);
      document.getElementById('rule-phase').value='failed';
      document.getElementById('rule-action').value='pause';
      document.getElementById('rule-depends').value=data.depends;
      document.getElementById('rule-skip').value=data.skip;
      document.getElementById('rule-min-duration').value='';
      document.getElementById('rule-max-duration').value='';
      document.getElementById('rule-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    },{id,priority,depends,skip});
    await driver.wait(async()=>new RegExp('Saved '+id).test(
      await driver.findElement(By.id('rule-message')).getText()),7000);
  };
  await installRule({id:'root',priority:10});
  await installRule({id:'gated',priority:60,depends:'root'});
  await installRule({id:'skip',priority:90,skip:'root'});
  await driver.executeScript(()=>{
    document.getElementById('preview-epoch').value='8';
    document.getElementById('preview-phase').value='failed';
    document.getElementById('preview-origin').value='fresh';
    document.getElementById('preview-confidence').value='observed';
    document.getElementById('preview-completed').value='';
    document.getElementById('preview-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/via skip/);
  await driver.executeScript(()=>{
    document.getElementById('preview-reset').click();
    document.getElementById('preview-completed').value='root';
    document.getElementById('preview-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/via gated/);
  await driver.navigate().refresh();
  await driver.wait(async()=>/3 saved/.test(
    await driver.findElement(By.id('rule-message')).getText()),10000);
  assert.match(await driver.findElement(By.css('#rule-list li')).getText(),/skip after root/);
  await driver.executeScript(()=>{
    const edit=document.querySelector('[aria-label="Edit gated"]');edit.click();
  });
  assert.equal(await driver.findElement(By.id('rule-depends')).getAttribute('value'),'root');
  // A missing dependency makes a removal invalid: the stored library is not
  // changed, and the UI reports a hard rejection rather than auto-relinking.
  await driver.executeScript(()=>{
    const remove=document.querySelector('[aria-label="Remove root"]');remove.click();
  });
  await driver.wait(async()=>/Rejected: invalid-dependency/.test(
    await driver.findElement(By.id('rule-message')).getText()),7000);
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,3);
  await driver.findElement(By.id('rule-clear')).click();
  await driver.findElement(By.id('rule-clear')).click();
  await driver.wait(async()=>0===(await driver.findElements(By.css('#rule-list li'))).length,7000);
  assert.equal(await driver.executeScript('return document.querySelectorAll("#preview-output img").length'),0);

  // Corrupt or future-version definitions remain in local storage untouched.
  await driver.executeScript('sessionStorage.setItem("chatqueue:conditional-rules:v1",JSON.stringify({version:99,rules:[]}))');
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return /unsupported-rule-library/.test(document.querySelector("#rule-message").textContent)'),10000);
  assert.equal(await driver.findElement(By.id('rule-add')).isEnabled(),false);
  assert.equal(await driver.executeScript('return JSON.parse(sessionStorage.getItem("chatqueue:conditional-rules:v1")).version'),99);
  console.log('FDE rules sandbox: typed rule preview, replay suppression, restored rejection, XSS inertness, versioned persistence, edit and confirmed delete pass');
 }finally{
  if(driver)await driver.quit();
  await new Promise(resolve=>server.close(resolve));
 }
}
main().catch(e=>{console.error('FDE rules sandbox failed:',e.stack||e);process.exitCode=1});
