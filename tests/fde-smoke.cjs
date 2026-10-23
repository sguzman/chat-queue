'use strict';
// CI-only Firefox Developer Edition install/uninstall in an anonymous profile.
// No authenticated ChatGPT, no automatic sends and no personal browser profile.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Builder}=require('selenium-webdriver');
const firefox=require('selenium-webdriver/firefox');

async function main(){
  const binary=process.env.FDE_BINARY;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))
    throw new Error('FDE_BINARY must point to the installed Firefox Developer Edition binary');
  const source=path.resolve(__dirname,'..');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-fde-'));
  for(const p of ['manifest.json'])fs.copyFileSync(path.join(source,p),path.join(root,p));
  for(const p of ['src','options'])fs.cpSync(path.join(source,p),path.join(root,p),{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.id,'chat-queue@sguzman.github');
  assert.deepEqual(manifest.content_scripts[0].matches,['https://chatgpt.com/*']);
  assert.equal(manifest.permissions.join(','),'storage');
  let driver=null;
  try{
    const opts=new firefox.Options().setBinary(binary).addArguments('-headless');
    driver=await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
    const id=await driver.installAddon(root,true);
    assert.equal(id,manifest.browser_specific_settings.gecko.id);
    const ua=await driver.executeScript('return navigator.userAgent');
    assert.match(ua,/Firefox/);
    await driver.uninstallAddon(id);
    console.log('Actual headless Firefox Developer Edition: Chat Queue production files install and uninstall cleanly');
  }finally{
    if(driver)await driver.quit();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('Firefox Developer Edition smoke failed:',error.message);process.exitCode=1;});
