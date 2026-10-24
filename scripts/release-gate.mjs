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
const ids=new Set(tasks.map(t=>t?.id));
if(tasks.length!==96||ids.size!==96||ids.has(undefined)||
   !/^\d+\.\d+\.\d+$/.test(manifest.version||'')||
   manifest.browser_specific_settings?.gecko?.id!=='chat-queue@sguzman.github'){
  process.stderr.write('Release blocked: task inventory or manifest identity changed\n');
  process.exit(1);
}
const unfinished=tasks.filter(t=>t.status!=='verified'||
  !Array.isArray(t.evidence)||!t.evidence.length||
  t.evidence.some(e=>typeof e!=='string'||!e.trim()));
if(unfinished.length){
  const ids=unfinished.slice(0,8).map(t=>t.id).join(', ');
  process.stderr.write(`Release blocked: ${unfinished.length}/${tasks.length} tasks missing verified acceptance evidence; first: ${ids}\n`);
  process.exit(1);
}
process.stdout.write('Release ledger gate passed: all 96 verified with evidence. Manual source/security and signing gates remain separate.\n');
