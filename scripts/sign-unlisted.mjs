#!/usr/bin/env node
// Deliberate unlisted Mozilla signing only. No profile modification, browser
// launch, automated publishing, or credential persistence. Disabled by the
// acceptance ledger until every verified task has evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(command,args,options={})=>spawnSync(command,args,{
  cwd:root,stdio:'inherit',shell:false,timeout:20*60*1000,...options
});
const gate=run(process.execPath,['scripts/release-gate.mjs']);
if(gate.status!==0){
  process.stderr.write('Signing refused: release acceptance ledger is not complete.\n');
  process.exit(1);
}
if(!process.env.WEB_EXT_API_KEY||!process.env.WEB_EXT_API_SECRET){
  process.stderr.write('Signing refused: Mozilla API credentials are required in WEB_EXT_API_KEY and WEB_EXT_API_SECRET.\n');
  process.exit(1);
}
const check=run('npm',['run','check']);
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
    'src/rule-store.js','options/options.js','options/rule-preview.js'
  ]);
  for(const rel of files){
    if(typeof rel!=='string'||!/^(manifest\.json|(?:src|options)\/[a-z0-9-]+\.(?:js|html))$/.test(rel))
      throw Error('Unapproved signing source: '+String(rel));
    const from=path.join(root,rel),to=path.join(stage,rel);
    if(!fs.statSync(from).isFile())throw Error('Missing signing source: '+rel);
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.copyFileSync(from,to);
  }
  fs.mkdirSync(artifacts,{recursive:true});
  const runner=['exec','--yes','--package=web-ext@10.8.0','--','web-ext'];
  const lint=run('npm',[...runner,'lint','--source-dir',stage,
    '--self-hosted','--warnings-as-errors','--boring']);
  if(lint.status!==0)throw Error('Mozilla source lint rejected staged signing bundle');
  // web-ext reads WEB_EXT_API_KEY and WEB_EXT_API_SECRET from environment.
  // Never place secrets in arguments, persistent files or console output.
  const signed=run('npm',[...runner,'sign','--source-dir',stage,
    '--artifacts-dir',artifacts,'--channel','unlisted','--no-input']);
  if(signed.status!==0)throw Error('Mozilla unlisted signing did not complete');
  process.stdout.write('Unlisted signed XPI requested. Inspect dist/signed; do not install or release without independent artifact review.\n');
}catch(error){
  process.stderr.write('Signing stopped: '+error.message+'\n');
  process.exitCode=1;
}finally{
  fs.rmSync(stage,{recursive:true,force:true});
}
