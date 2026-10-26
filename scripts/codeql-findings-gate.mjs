#!/usr/bin/env node
// Release-supporting security gate: do not mistake a successful CodeQL
// ANALYSIS job for a zero-findings result. Never print SARIF snippets,
// file paths, code excerpts or other report content.
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2];
if(process.argv.length!==3||!root||!path.isAbsolute(root)){
  process.stderr.write('CodeQL gate: missing absolute SARIF directory\n');
  process.exit(1);
}
let names;
try{
  names=fs.readdirSync(root).filter(f=>f.endsWith('.sarif')).sort();
  if(names.length!==1)throw Error('expected exactly one report');
  const filename=path.join(root,names[0]);
  if(!fs.lstatSync(filename).isFile())throw Error('not a regular report');
  const sarif=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(sarif.version!=='2.1.0'||!Array.isArray(sarif.runs)||sarif.runs.length<1)
    throw Error('invalid report');
  let checked=0,findings=0;
  for(const run of sarif.runs){
    if(run.tool?.driver?.name!=='CodeQL'||!Array.isArray(run.results))
      throw Error('invalid CodeQL run');
    checked++;
    findings+=run.results.length;
  }
  if(findings){
    process.stderr.write('CodeQL gate blocked: '+findings+
      ' analyzer findings across '+checked+' run(s); review archived SARIF\n');
    process.exit(1);
  }
  process.stdout.write('CodeQL gate: 0 findings across '+checked+' CodeQL run(s)\n');
}catch{
  process.stderr.write('CodeQL gate blocked: missing, unreadable or malformed SARIF\n');
  process.exit(1);
}
