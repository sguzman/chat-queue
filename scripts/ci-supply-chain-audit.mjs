#!/usr/bin/env node
// Verify the complete public workflow inventory, not just the main check.
// Immutable allowlisted action references and least-privilege token policy
// are necessary but not sufficient upstream provenance guarantees.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const folder=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.github/workflows');
const allowedFiles=['check.yml','codeql.yml','qa-launcher.yml'];
const present=fs.readdirSync(folder).filter(f=>/\.ya?ml$/.test(f)).sort();
const fail=[];
if(JSON.stringify(present)!==JSON.stringify(allowedFiles))
  fail.push('Unexpected or missing workflow inventory: '+present.join(', '));
const required=new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'browser-actions/setup-firefox',
  'browser-actions/setup-geckodriver'
]);
const codeqlRequired=new Set([
  'actions/checkout','github/codeql-action/init','github/codeql-action/analyze'
]);
const codeqlSha='6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee';
let total=0;
for(const name of allowedFiles){
  if(!fs.existsSync(path.join(folder,name))){
    fail.push('Missing workflow: '+name);
    continue;
  }
  const workflow=fs.readFileSync(path.join(folder,name),'utf8');
  const uses=[...workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map(x=>x[1]);
  total+=uses.length;
  if(name==='check.yml'&&uses.length<required.size)
    fail.push(name+': missing required audited actions');
  if(name==='qa-launcher.yml'&&uses.length!==1)
    fail.push(name+': expected only one reviewed checkout action');
  if(name==='codeql.yml'&&(uses.length!==3||
     [...codeqlRequired].some(x=>!uses.some(ref=>ref.startsWith(x+'@')))))
    fail.push(name+': expected exact checkout, CodeQL init and analysis');
  for(const action of uses){
    const match=/^([a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)@([0-9a-f]{40})$/.exec(action);
    if(!match){fail.push(name+': nonimmutable or unrecognized action '+action);continue;}
    if(!(name==='codeql.yml'?codeqlRequired:required).has(match[1]))
      fail.push(name+': unreviewed action owner/repository '+match[1]);
    if(name==='codeql.yml'&&match[1].startsWith('github/codeql-action/')&&
       match[2]!==codeqlSha)
      fail.push(name+': CodeQL action must use reviewed exact release SHA');
    if(name==='qa-launcher.yml'&&match[1]!=='actions/checkout')
      fail.push(name+': unexpected QA launcher action '+match[1]);
  }
  if(name==='check.yml')
    for(const action of required)
      if(!uses.some(x=>x.startsWith(action+'@')))
        fail.push(name+': required action missing '+action);
  const approvedPermissions=(name==='codeql.yml'
    ?['permissions:','  contents: read','  security-events: write','  actions: read','']
    :['permissions:','  contents: read','']).join(String.fromCharCode(10));
  if(!workflow.includes(approvedPermissions))
    fail.push(name+': approved exact permissions missing');
  // Only the pinned CodeQL action may request security-events:write.
  // Every other write permission and dangerous trigger is prohibited.
  const rest=workflow.replace(approvedPermissions,'');
  if(/^\s+[a-z_-]+:\s*write\b/m.test(rest)||
     /^\s*pull_request_target\s*:/m.test(workflow)||
     /^\s*permissions\s*:\s*write-all\b/m.test(workflow))
    fail.push(name+': dangerous trigger or unreviewed write permission');
}
if(fail.length){
  for(const item of fail)console.error('CI supply-chain audit: '+item);
  process.exitCode=1;
}else{
  console.log('CI supply-chain audit: '+allowedFiles.length+' audited workflows, '+
    total+' immutable allowlisted references, reviewed least-privilege tokens');
}
