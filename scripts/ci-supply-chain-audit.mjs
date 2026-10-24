#!/usr/bin/env node
// Public CI supply-chain boundary: immutable, allowlisted first-party actions.
// This is not a cryptographic provenance audit of upstream action code.
import fs from 'node:fs';
const workflow=fs.readFileSync(new URL('../.github/workflows/check.yml',import.meta.url),'utf8');
const required=new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/upload-artifact',
  'browser-actions/setup-firefox',
  'browser-actions/setup-geckodriver'
]);
const uses=[...workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map(x=>x[1]);
const fail=[];
if(uses.length<required.size)fail.push('Missing required audited actions');
for(const action of uses){
  const match=/^([a-z0-9_.-]+\/[a-z0-9_.-]+)@([0-9a-f]{40})$/.exec(action);
  if(!match){
    fail.push('Nonimmutable or unrecognized action reference '+action);
    continue;
  }
  if(!required.has(match[1]))fail.push('Action owner/repository is not reviewed: '+match[1]);
}
for(const name of required)if(!uses.some(x=>x.startsWith(name+'@')))
  fail.push('Required action missing: '+name);
if(!/^permissions:\n  contents: read\n/m.test(workflow))
  fail.push('Workflow needs explicit top-level read-only contents permission');
if(/^\s+[a-z_-]+:\s*write\b/m.test(workflow))
  fail.push('Workflow requests unreviewed write permission');
if(/^\s*pull_request_target\s*:/m.test(workflow)||
   /^\s*permissions\s*:\s*write-all\b/m.test(workflow))
  fail.push('Dangerous workflow trigger or broad permission');
if(fail.length){
  fail.forEach(x=>console.error('CI supply-chain audit: '+x));
  process.exitCode=1;
}else{
  console.log('CI supply-chain audit: '+uses.length+
    ' immutable allowlisted references, no broad write/target trigger');
}
