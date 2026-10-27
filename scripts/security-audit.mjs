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
// Exact manifest surfaces: additions such as world:"MAIN", extra content
// scripts, background workers, or URL-matching fallback modes must require
// a deliberate audit update, not silently ride along with a benign diff.
function exactKeys(value,keys,description){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     !exactly(Object.keys(value).sort(),keys.slice().sort()))
    fail(description+' changed');
}
exactKeys(manifest,[
  'manifest_version','name','version','description','permissions',
  'background','options_ui','content_scripts','browser_specific_settings',
  'web_accessible_resources'
],'manifest execution/privilege surface');
exactKeys(manifest.background,['scripts'],'background context');
exactKeys(manifest.options_ui,['page','open_in_tab'],'Options context');
if(manifest.options_ui.open_in_tab!==true)fail('Options tab presentation changed');
exactKeys(manifest.content_scripts?.[0],
  ['matches','js','run_at','all_frames'],'content script injection context');
if(manifest.content_scripts[0].run_at!=='document_idle')
  fail('content script insertion lifecycle changed');
if(!exactly(manifest.background.scripts,
  ['src/signal.js','src/grants.js','src/rules.js','src/background.js']))
  fail('unreviewed Firefox background entrypoint');
if(!exactly(manifest.content_scripts[0].js,
  ['src/core.js','src/signal.js','src/rules.js','src/rule-store.js',
   'src/content.js']))
  fail('unreviewed Firefox content entrypoint');
if(!exactly(manifest.permissions,['storage']))fail('Firefox permission scope changed');
if('host_permissions' in manifest||'optional_permissions' in manifest||
   'optional_host_permissions' in manifest)fail('new host or optional permissions');
if('externally_connectable' in manifest)
  fail('new page-reachable extension surface');
if(!exactly(manifest.web_accessible_resources,[{
  resources:['ui/draft.html','ui/draft.js'],matches:['https://chatgpt.com/*']
}]))fail('isolated draft resource scope changed');
if('content_security_policy' in manifest)fail('custom CSP needs a separate review');
if(manifest.browser_specific_settings?.gecko?.id!=='chat-queue@sguzman.github')
  fail('stable Firefox add-on ID changed');
exactKeys(manifest.browser_specific_settings,['gecko'],
  'Firefox-specific manifest fields');
exactKeys(manifest.browser_specific_settings?.gecko,
  ['id','data_collection_permissions'],'Firefox identity and update policy');
exactKeys(manifest.browser_specific_settings?.gecko?.data_collection_permissions,
  ['required'],'Mozilla data collection disclosure fields');
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
  'src/rule-store.js','options/rule-preview.js','options/options.js','ui/draft.js'
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
  if(!/^(src|options|ui)\/[a-z0-9-]+\.js$/.test(p))fail('unreviewed script path '+p);
  const body=read(p);
  for(const [regex,label] of forbidden)if(regex.test(body))fail(label+' added to '+p);
  const urls=body.match(/https?:\/\/[^\s"'`<>)]*/g)||[];
  if(urls.some(url=>url!=='https://chatgpt.com'&&!url.startsWith('https://chatgpt.com/')))
    fail('non-ChatGPT URL literal in '+p);
}
const html=read('options/options.html');
if(/\b(?:src|href|action|formaction)\s*=\s*["'](?:https?:|\/\/)/i.test(html)||
   /@import\b/i.test(html)||
   /\b(?:url|image-set|cross-fade|image)\s*\(/i.test(html)||
   /(?:^|[\s"'(])\/\/[a-z0-9.-]+/i.test(html)||
   /<script\b(?![^>]*\bsrc\s*=)/i.test(html)||
   /\bon(?:load|error|click|submit|change)\s*=/i.test(html))
  fail('remote assets or inline executable Options HTML');
// Every local Options script must be on the already-audited production list.
const optionsScripts=[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
  .map(match=>path.posix.normalize(path.posix.join('options',match[1])));
if(!optionsScripts.length||optionsScripts.some(file=>!allJs.includes(file)))
  fail('unreviewed local Options script');
const draftHtml=read('ui/draft.html');
// The iframe is web-accessible on chatgpt.com and owns unsent private text.
// Do not let a future HTML edit silently create another network/resource
// channel, e.g. CSS @import/url, IMG, LINK, META refresh or a form target.
// The only allowed tags are the audited textarea, its local script, and
// static markup/CSS; new controls need an explicit security review.
const draftTags=[...draftHtml.matchAll(/<\s*\/?\s*([a-z][a-z0-9-]*)\b[^>]*>/gi)]
  .map(match=>match[1].toLowerCase());
const draftAllowlist=new Set(['html','head','meta','style','body','textarea','script']);
const draftScripts=[...draftHtml.matchAll(/<script\b[^>]*>/gi)];
if(draftTags.some(tag=>!draftAllowlist.has(tag))||
   draftScripts.length!==1||
   !/^<script src="draft\.js">$/i.test(draftScripts[0][0])||
   !/<\/script\s*>/i.test(draftHtml)||
   !/<textarea\s+id="draft"(?:\s|>)/i.test(draftHtml)||
   /\bon[a-z][\w-]*\s*=/i.test(draftHtml)||
   /\bhttp-equiv\s*=/i.test(draftHtml)||
   /@import\b|\b(?:url|image-set|cross-fade|image)\s*\(/i.test(draftHtml)||
   /(?:^|[\s\"'(])\/\/[a-z0-9.-]+/i.test(draftHtml)||
   /\b(?:href|srcset|action|formaction|background|poster)\s*=/i.test(draftHtml)||
   /\b(?:https?:|javascript:|data:)\/\//i.test(draftHtml))
  fail('isolated draft HTML contract changed');
if(pkg.private!==true||pkg.dependencies||pkg.devDependencies)
  fail('runtime dependency or package publication policy changed');
console.log('Security audit: narrow ChatGPT scope, storage-only permission, local assets, no runtime network or dynamic JS passed');
