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
  fs.writeFileSync(contentPath,original.replace("attachShadow({mode:'closed'})","attachShadow({mode:'open'})"));
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
    await driver.wait(async()=>await driver.executeScript(
      `return Boolean(${hud('run')})&&document.documentElement.dataset.qaSignalProviderReady==='true'`),12000);
    const input=await driver.executeScript(`return ${hud('draft')}`);
    const add=await driver.executeScript(`return ${hud('add')}`);
    await input.sendKeys('Synthetic queued A');await add.click();
    await input.sendKeys('Synthetic queued B');await add.click();
    const start=await driver.executeScript(`return ${hud('run')}`);
    await start.click();
    await driver.wait(async()=>await driver.executeScript(`return ${hud('status')}.textContent.includes('authenticated-chat-signals-required')`),7000);
    assert.equal(await driver.executeScript('return window.__sent.length'),0);
    const emit=async(phase,epoch,sequence,confidence='observed')=>{
      const signal={version:1,documentToken:token,route:'/c/synthetic',epoch,sequence,
        phase,origin:'fresh',confidence};
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
    await emit('generating',1,2);
    await waitNote('Waiting for confirmed response completion');
    assert.equal(await driver.executeScript('return window.__sent.length'),1);
    await emit('finished',1,3,'inferred');
    await waitSends(2);
    await emit('generating',2,4);
    await waitNote('Waiting for confirmed response completion');
    await emit('finished',2,5,'inferred');
    await waitNote('Queue completed');
    assert.deepEqual(await driver.executeScript('return window.__sent'),
      ['Synthetic queued A','Synthetic queued B']);
    console.log('Headless FDE cross-extension Signal fixture: two ordered sends, exact epochs, no page-spoofed send');
  }finally{
    if(driver)await driver.quit();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('FDE Signal integration failed:',error.message);process.exitCode=1;});
