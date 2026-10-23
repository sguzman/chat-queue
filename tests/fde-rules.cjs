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
  await driver.findElement(By.id('rule-add')).click();
  await driver.wait(async()=>/1 saved preview rule/.test(await driver.findElement(By.id('rule-message')).getText()),7000);
  assert.equal(await driver.findElement(By.css('#rule-list li')).getText().then(x=>x.includes('synthetic-rule')),true);
  await driver.findElement(By.id('preview-phase')).sendKeys('Failed');
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/Would propose pausing/);
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/already-considered/);
  await driver.findElement(By.id('preview-reset')).click();
  await driver.findElement(By.id('preview-origin')).sendKeys('Restored');
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/not-actionable/);
  await driver.findElement(By.id('preview-origin')).sendKeys('Fresh');
  await driver.findElement(By.id('rule-action')).sendKeys('Text');
  const injection='<img src=x onerror="window.__previewXss=1">';
  await driver.executeScript('document.querySelector("#rule-text").value=arguments[0]',injection);
  await driver.findElement(By.id('rule-add')).click();
  await driver.findElement(By.css('#preview-form button[type="submit"]')).click();
  assert.equal(await driver.executeScript('return window.__previewXss===undefined'),true);
  assert.equal(await driver.executeScript('return document.querySelectorAll("#preview-output img").length'),0);
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/onerror/);
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return Boolean(window.ChatQueueRules && document.querySelector("#rule-form"))'),15000);
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,1,'Saved rule definitions should persist across reload');
  assert.match(await driver.findElement(By.css('#rule-list li')).getText(),/synthetic-rule/);
  // No rules evaluate by themselves after refresh, even with saved proposals.
  assert.match(await driver.findElement(By.id('preview-output')).getText(),/no queue action/i);
  // Change a saved rule after reload and verify its durable action changes.
  await driver.findElement(By.css('#rule-list li button[aria-label^="Edit"]')).click();
  await driver.findElement(By.id('rule-action')).sendKeys('Pause');
  await driver.findElement(By.id('rule-add')).click();
  await driver.wait(async()=>/Saved synthetic-rule/.test(await driver.findElement(By.id('rule-message')).getText()),5000);
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return /1 saved/.test(document.querySelector("#rule-message").textContent)'),10000);
  assert.match(await driver.findElement(By.css('#rule-list li')).getText(),/pause/);
  // Destructive removal is explicitly two-step and cannot silently execute.
  await driver.findElement(By.id('rule-clear')).click();
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,1);
  await driver.findElement(By.id('rule-clear')).click();
  await driver.wait(async()=>0===(await driver.findElements(By.css('#rule-list li'))).length,5000);
  await driver.navigate().refresh();
  await driver.wait(async()=>await driver.executeScript('return /0 saved/.test(document.querySelector("#rule-message").textContent)'),10000);
  assert.equal((await driver.findElements(By.css('#rule-list li'))).length,0);
  console.log('FDE rules sandbox: typed rule preview, replay suppression, restored rejection, XSS inertness, versioned persistence, edit and confirmed delete pass');
 }finally{
  if(driver)await driver.quit();
  await new Promise(resolve=>server.close(resolve));
 }
}
main().catch(e=>{console.error('FDE rules sandbox failed:',e.stack||e);process.exitCode=1});
