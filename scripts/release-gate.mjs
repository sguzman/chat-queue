#!/usr/bin/env node
// Pre-release interlock. It validates the canonical evidence ledger; it never
// signs, publishes, uploads, contacts Mozilla, or edits Firefox profiles.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const progress=JSON.parse(fs.readFileSync(path.join(root,'progress.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const milestones=progress?.milestones;
if(!Array.isArray(milestones)||milestones.length!==8){
  process.stderr.write('Release blocked: malformed milestone ledger\n');
  process.exit(1);
}
const tasks=[];
for(const milestone of milestones){
  if(!Array.isArray(milestone.phases)){
    process.stderr.write('Release blocked: malformed milestone phases\n');
    process.exit(1);
  }
  for(const phase of milestone.phases){
    if(!Array.isArray(phase.features)){
      process.stderr.write('Release blocked: malformed phase features\n');
      process.exit(1);
    }
    for(const feature of phase.features){
      if(!Array.isArray(feature.tasks)){
        process.stderr.write('Release blocked: malformed feature tasks\n');
        process.exit(1);
      }
      tasks.push(...feature.tasks);
    }
  }
}
// Reject substitution of an inconvenient acceptance task with an invented ID.
// Every milestone has exactly Mx-01 through Mx-12 in the canonical roadmap.
const ids=new Set(tasks.map(t=>t?.id));
const expectedIds=new Set(Array.from({length:8},(_,m)=>
  Array.from({length:12},(_,n)=>`M${m}-${String(n+1).padStart(2,'0')}`)).flat());
if(tasks.length!==96||ids.size!==96||
   [...expectedIds].some(id=>!ids.has(id))||
   !/^\d+\.\d+\.\d+$/.test(manifest.version||'')||
   manifest.browser_specific_settings?.gecko?.id!=='chat-queue@sguzman.github'){
  process.stderr.write('Release blocked: task inventory or manifest identity changed\n');
  process.exit(1);
}
// The SemVer tag is the LAST task: signing and independent artifact review
// must happen first. Only M7-12 can remain planned/implemented during signing.
// Once marked verified, it too requires acceptance evidence.
const tag=tasks.find(t=>t.id==='M7-12');
const validEvidence=t=>Array.isArray(t.evidence)&&t.evidence.length>0&&
  t.evidence.every(e=>typeof e==='string'&&e.trim());
const unfinished=tasks.filter(t=>t.id==='M7-12'
  ? !['planned','implemented','verified'].includes(t.status)||
    (t.status!=='planned'&&!validEvidence(t))
  : t.status!=='verified'||!validEvidence(t));
if(unfinished.length){
  const ids=unfinished.slice(0,8).map(t=>t.id).join(', ');
  process.stderr.write(`Release blocked: ${unfinished.length}/${tasks.length} tasks missing verified acceptance evidence or valid tag status; first: ${ids}\n`);
  process.exit(1);
}
process.stdout.write(`Release ledger gate passed: 95 pre-tag tasks verified with evidence; M7-12 is ${tag.status}. Manual source/security, signing and tagged-artifact verification remain separate.\n`);
