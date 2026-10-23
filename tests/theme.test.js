const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const content=fs.readFileSync(new URL('../src/content.js',`file://${__filename}`),'utf8');
const options=fs.readFileSync(new URL('../options/options.js',`file://${__filename}`),'utf8');
const html=fs.readFileSync(new URL('../options/options.html',`file://${__filename}`),'utf8');

test('HUD exposes three theme values and system is the default',()=>{
  assert.match(content,/theme:\s*'system'/);
  assert.match(content,/value="system">System/);
  assert.match(content,/value="light">Light/);
  assert.match(content,/value="dark">Dark/);
  assert.match(content,/prefers-color-scheme:dark/);
  assert.match(content,/:host\(\[data-theme="dark"\]\)/);
  assert.match(content,/--panel:/);
  assert.match(content,/background:var\(--panel\)/);
});

test('HUD preferences are local and visible to another open Chat Queue tab',()=>{
  assert.match(content,/api\.storage\.local\.set\(\{'chatqueue:settings:v1'/);
  assert.match(content,/api\.storage\.onChanged\.addListener/);
  assert.match(content,/host\.dataset\.theme=state\.theme/);
  assert.match(options,/THEMES=new Set\(\['system','light','dark'\]\)/);
  assert.match(options,/api\.storage\.local\.set\(\{'chatqueue:settings:v1'/);
  assert.match(html,/System \(default\)/);
  assert.match(html,/@media\(prefers-color-scheme:dark\)/);
});
