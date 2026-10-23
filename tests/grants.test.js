const test=require('node:test');
const assert=require('node:assert/strict');
const g=require('../src/grants.js');
const policy={version:2,grants:{
  'append@example.test':['append'],
  'observer@example.test':['discover','read'],
  'malformed@example.test':['evil'],
  '__proto__':['control']
}};
test('grants are deny by default and never inherit object prototype properties',()=>{
  assert.equal(g.has({},'append@example.test','append'),false);
  assert.equal(g.has(policy,'append@example.test','append'),true);
  assert.equal(g.has(policy,'append@example.test','control'),false);
  assert.equal(g.has(policy,'malformed@example.test','read'),false);
  assert.equal(g.has(policy,'__proto__','control'),false);
});
test('granted scope strings are validated and unknown scopes discarded',()=>{
  const s=g.scopes(policy,'observer@example.test');
  assert.deepEqual(s,['discover','read']);
  assert.deepEqual(g.scopes({version:1,grants:policy.grants},'append@example.test'),[]);
  assert.equal(g.ACTION_SCOPE.status,'read');
  assert.equal(g.ACTION_SCOPE.start,'control');
  assert.equal(g.ACTION_SCOPE.enqueue,'append');
});
