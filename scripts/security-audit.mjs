#!/usr/bin/env node
// Production-only static permission/privacy regression gate, not a security
// certification. In particular, it does not test live ChatGPT or peer add-ons.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const fail=message=>{throw new Error('Security audit: '+message);};
const manifest=JSON.parse(read('manifest.json'));
const pkg=JSON.parse(read('package.json'));
const exactly=(actual,expected)=>JSON.stringify(actual)===JSON.stringify(expected);

if(manifest.manifest_version!==3)fail('unexpected manifest schema');
if(!exactly(manifest.permissions,['storage']))fail('Firefox permission scope changed');
if('host_permissions' in manifest||'optional_permissions' in manifest||
   'optional_host_permissions' in manifest)fail('new host or optional permissions');
if('externally_connectable' in manifest||'web_accessible_resources' in manifest)
  fail('new page-reachable extension surface');
if('content_security_policy' in manifest)fail('custom CSP needs a separate review');
if(manifest.browser_specific_settings?.gecko?.id!=='chat-queue@sguzman.github')
  fail('stable Firefox add-on ID changed');
if(!exactly(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,['none']))
  fail('data collection disclosure changed');
if(!Array.isArray(manifest.content_scripts)||manifest.content_scripts.length!==1||
   !exactly(manifest.content_scripts[0].matches,['https://chatgpt.com/*'])||
   manifest.content_scripts[0].all_frames!==false)
  fail('content script reach broadened');
if(manifest.options_ui?.page!=='options/options.html')fail('unexpected Options entrypoint');
const allJs=[
  ...(manifest.background?.scripts||[]),
  ...(manifest.content_scripts?.[0]?.js||[]),
  'src/rule-store.js','options/rule-preview.js','options/options.js'
];
if(!Array.isArray(manifest.background?.scripts)||!manifest.background.scripts.length)
  fail('missing Firefox background script entries');
const forbidden=[
  [/(^|\W)fetch\s*\(/,'network fetch'],
  [/\bXMLHttpRequest\b/,'XMLHttpRequest'],
  [/\bWebSocket\b/,'WebSocket'],
  [/\bsendBeacon\s*\(/,'beacon upload'],
  [/\beval\s*\(/,'dynamic eval'],
  [/new\s+Function\s*\(/,'dynamic Function'],
  [/\bimport\s*\(/,'dynamic import']
];
for(const p of new Set(allJs)){
  if(!/^(src|options)\/[a-z0-9-]+\.js$/.test(p))fail('unreviewed script path '+p);
  const body=read(p);
  for(const [regex,label] of forbidden)if(regex.test(body))fail(label+' added to '+p);
  const urls=body.match(/https?:\/\/[^\s"'`<>)]*/g)||[];
  if(urls.some(url=>!url.startsWith('https://chatgpt.com/')))
    fail('non-ChatGPT URL literal in '+p);
}
const html=read('options/options.html');
if(/\b(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i.test(html)||
   /@import\b/i.test(html)||
   /<script\b(?![^>]*\bsrc\s*=)/i.test(html)||
   /\bon(?:load|error|click|submit|change)\s*=/i.test(html))
  fail('remote assets or inline executable Options HTML');
// Every local Options script must be on the already-audited production list.
const optionsScripts=[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
  .map(match=>path.posix.normalize(path.posix.join('options',match[1])));
if(!optionsScripts.length||optionsScripts.some(file=>!allJs.includes(file)))
  fail('unreviewed local Options script');
if(pkg.private!==true||pkg.dependencies||pkg.devDependencies)
  fail('runtime dependency or package publication policy changed');
console.log('Security audit: narrow ChatGPT scope, storage-only permission, local assets, no runtime network or dynamic JS passed');
