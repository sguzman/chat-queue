#!/usr/bin/env node
// Deliberate unlisted Mozilla signing only. No profile modification, browser
// launch, automated publishing, or credential persistence. Disabled by the
// acceptance ledger until all 95 pre-tag tasks have verified evidence.
// Tagging is M7-12 and follows signing and artifact review.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(command,args,options={})=>spawnSync(command,args,{
  cwd:root,stdio:'inherit',shell:false,timeout:20*60*1000,...options
});
// Preflight tools do not need Mozilla credentials. Strip them even when the
// caller has opted into signing; only web-ext sign receives them.
const preflightEnv=Object.fromEntries(
  Object.entries(process.env).filter(([key])=>!key.startsWith('WEB_EXT_'))
);
const signingEnv={...preflightEnv,
  WEB_EXT_API_KEY:process.env.WEB_EXT_API_KEY,
  WEB_EXT_API_SECRET:process.env.WEB_EXT_API_SECRET
};
const gate=run(process.execPath,['scripts/release-gate.mjs'],{env:preflightEnv});
if(gate.status!==0){
  process.stderr.write('Signing refused: release acceptance ledger is not complete.\n');
  process.exit(1);
}
if(!process.env.WEB_EXT_API_KEY||!process.env.WEB_EXT_API_SECRET){
  process.stderr.write('Signing refused: Mozilla API credentials are required in WEB_EXT_API_KEY and WEB_EXT_API_SECRET.\n');
  process.exit(1);
}
const check=run('npm',['run','check'],{env:preflightEnv});
if(check.status!==0){
  process.stderr.write('Signing refused: local source, permission and regression checks failed.\n');
  process.exit(1);
}
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-unlisted-'));
const artifacts=path.join(root,'dist','signed');
try{
  const files=new Set([
    'manifest.json',
    ...(manifest.background?.scripts||[]),
    ...(manifest.content_scripts||[]).flatMap(script=>script.js||[]),
    manifest.options_ui?.page,
    'src/rule-store.js','options/options.js','options/rule-preview.js',
    'ui/draft.html','ui/draft.js'
  ]);
  for(const rel of files){
    if(typeof rel!=='string'||!/^(manifest\.json|(?:src|options|ui)\/[a-z0-9-]+\.(?:js|html))$/.test(rel))
      throw Error('Unapproved signing source: '+String(rel));
    const from=path.join(root,rel),to=path.join(stage,rel);
    // A symlinked allowlisted script could otherwise copy unrelated private
    // bytes into the uploaded XPI. Check every source directory, then open
    // the exact file once without following final-component symlinks.
    for(const part of rel.split('/').slice(0,-1)){
      const dir=path.join(root,part);
      const st=fs.lstatSync(dir);
      if(!st.isDirectory()||st.isSymbolicLink())
        throw Error('Unsafe signing source directory: '+part);
    }
    let fd;
    try{
      fd=fs.openSync(from,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      if(!fs.fstatSync(fd).isFile())
        throw Error('Not a regular signing source');
      fs.mkdirSync(path.dirname(to),{recursive:true});
      fs.writeFileSync(to,fs.readFileSync(fd),{flag:'wx',mode:0o600});
    }catch{
      // Do not print system paths or source bytes in public failure logs.
      throw Error('Unapproved or unreadable signing source: '+rel);
    }finally{
      if(fd!==undefined)fs.closeSync(fd);
    }
  }
  fs.mkdirSync(artifacts,{recursive:true});
  const runner=['exec','--yes','--package=web-ext@10.8.0','--','web-ext'];
  const lint=run('npm',[...runner,'lint','--no-config-discovery',
    '--source-dir',stage,'--self-hosted','--warnings-as-errors','--boring'],{env:preflightEnv});
  if(lint.status!==0)throw Error('Mozilla source lint rejected staged signing bundle');
  // web-ext reads WEB_EXT_API_KEY and WEB_EXT_API_SECRET from environment.
  // Never place secrets in arguments, persistent files or console output.
  const signed=run('npm',[...runner,'sign','--no-config-discovery',
    '--source-dir',stage,'--artifacts-dir',artifacts,
    '--channel','unlisted','--amo-base-url','https://addons.mozilla.org/api/v5/',
    '--no-input'],{env:signingEnv});
  if(signed.status!==0)throw Error('Mozilla unlisted signing did not complete');
  process.stdout.write('Unlisted signed XPI requested. Inspect dist/signed; do not install or release without independent artifact review.\n');
}catch(error){
  process.stderr.write('Signing stopped: '+error.message+'\n');
  process.exitCode=1;
}finally{
  fs.rmSync(stage,{recursive:true,force:true});
}
