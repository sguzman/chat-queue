#!/usr/bin/env node
// Local documentation integrity gate: no network access or private source data.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const required=[
  'README.md','ROADMAP.md','AGENTS.md','API.md',
  'docs/ARCHITECTURE.md','docs/QA.md','docs/SECURITY.md',
  'docs/BACKUP.md','docs/SIGNAL-CONTRACT.md',
  'docs/CONDITIONAL-RULES.md','docs/MOZILLA-SIGNING.md'
];
const fail=[];
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const files=[
  ...fs.readdirSync(root).filter(p=>p.endsWith('.md')),
  ...fs.readdirSync(path.join(root,'docs')).filter(p=>p.endsWith('.md')).map(p=>'docs/'+p)
];
const readme=read('README.md');
for(const rel of required){
  if(!fs.existsSync(path.join(root,rel)))fail.push('Missing required guide '+rel);
  else if(rel!=='README.md'&&!readme.includes(']('+rel+')'))
    fail.push('README has no navigation link to '+rel);
}
for(const file of files){
  const source=read(file);
  const links=/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for(const match of source.matchAll(links)){
    const link=match[1];
    if(/^(https?:|mailto:|data:|#)/i.test(link))continue;
    const raw=link.split('#')[0].split('?')[0];
    if(!raw)continue;
    let clean;
    try{clean=decodeURIComponent(raw);}catch{fail.push(file+': undecodable link '+link);continue;}
    if(path.isAbsolute(clean)){fail.push(file+': absolute local link '+link);continue;}
    const full=path.resolve(root,path.dirname(file),clean);
    if(!full.startsWith(root+path.sep)&&full!==root){
      fail.push(file+': local link escapes repository '+link);
    }else if(!fs.existsSync(full)){
      fail.push(file+': broken local link '+link);
    }
  }
}
if(fail.length){
  for(const error of fail)console.error('Documentation audit: '+error);
  process.exitCode=1;
}else{
  console.log('Documentation audit: '+files.length+
    ' Markdown files, required guides and local links passed');
}
