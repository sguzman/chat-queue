'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('published documentation paths are valid and future broken links fail closed',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-queue-docs-'));
  const copy=path.join(dir,'repo');
  try{
    fs.cpSync(root,copy,{recursive:true,filter:source=>{
      const parts=path.relative(root,source).split(path.sep);
      return !parts.some(p=>['.git','node_modules','dist'].includes(p));
    }});
    const verify=()=>spawnSync(process.execPath,['scripts/docs-audit.mjs'],
      {cwd:copy,encoding:'utf8',timeout:10000});
    const baseline=verify();
    assert.equal(baseline.status,0,baseline.stderr);
    assert.match(baseline.stdout,/Documentation audit:/);
    fs.appendFileSync(path.join(copy,'README.md'),
      '\n[Missing local guide](docs/nonexistent-guide.md)\n');
    const broken=verify();
    assert.notEqual(broken.status,0);
    assert.match(broken.stderr,/broken local link/);
    fs.writeFileSync(path.join(copy,'README.md'),
      fs.readFileSync(path.join(root,'README.md'),'utf8'));
    fs.rmSync(path.join(copy,'docs','QA.md'));
    const missing=verify();
    assert.notEqual(missing.status,0);
    assert.match(missing.stderr,/Missing required guide/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
