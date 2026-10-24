const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const content=fs.readFileSync(require.resolve('../src/content.js'),'utf8');
const signal=require('../src/signal.js');
const a={version:1,route:'/c/synthetic',documentToken:'e'.repeat(32),
  epoch:4,sequence:10,phase:'finished',origin:'fresh',confidence:'inferred'};
const frame=x=>({type:signal.TYPE,signal:x});
test('provider protocol rejects malformed and unknown-version envelopes',()=>{
  for(const next of [{...a,version:2},{...a,epoch:-1},{...a,sequence:0},
    {...a,documentToken:'a'},{...a,route:'https://example.test/'},
    {...a,phase:'ready'},{...a,origin:'guessed'},{...a,confidence:'certain'}]){
    assert.equal(signal.parse(frame(next)),null);
  }
  assert.deepEqual(signal.parse(frame(a)),a);
});
test('historical completion and unrelated busy work cannot authorize advancement',()=>{
  assert.equal(signal.ready(a,a.route),true);
  assert.equal(signal.ready({...a,origin:'restored'},a.route),false);
  assert.equal(signal.ready({...a,confidence:'unknown'},a.route),false);
  assert.equal(signal.ready(a,'/c/unrelated'),false);
  const busy={...a,epoch:5,sequence:11,phase:'generating'};
  assert.equal(signal.newBusy(busy,a),true);
  assert.equal(signal.newBusy({...busy,epoch:4},a),false);
  assert.equal(signal.newBusy({...busy,origin:'restored'},a),false);
  assert.equal(signal.newBusy({...busy,confidence:'unknown'},a),false);
  assert.equal(signal.completed({...a,epoch:5,sequence:12},busy),true);
  assert.equal(signal.completed({...a,epoch:4,sequence:12},busy),false);
  assert.equal(signal.completed({...a,epoch:5,sequence:11},busy),false);
  assert.equal(signal.completed({...a,epoch:5,sequence:12,origin:'restored'},busy),false);
  assert.equal(signal.completed({...a,epoch:5,sequence:12,confidence:'unknown'},busy),false);
  assert.equal(signal.completed({...a,epoch:5,sequence:12,documentToken:'f'.repeat(32)},busy),false);
});
test('queue executor does not use page-controlled status as dispatch authorization',()=>{
  assert.match(content,/contract\.ready\(state\.trusted,routeKey\(\)\)/);
  assert.match(content,/authenticated-chat-signals-required/);
  assert.match(content,/signalFromPage\(\)/);
  assert.doesNotMatch(content,/core\.mayDispatch\(state\.signal/);
  assert.match(content,/item\.status='uncertain';\s*await save\(\);/);
  assert.match(content,/state\.key!==attemptKey\|\|storageKey\(\)!==attemptKey/);
});

test('only concrete conversation routes can anchor guarded dispatch',()=>{
  const good=['/c/synthetic','/c/1','/c/ff82-abc_123',
    '/g/g-project-123/c/ff82-abc_123'];
  const bad=['/','/c','/c/','/c/id/extra','/c//','/new','/g/g-test',
    '/g/g-test/c','/g/g-test/c/','/share/abc','/s/abc',
    '/search','/tasks','/g/g-test/c/one/two',
    '/c/id%2Fother','/c/id?other=1','//c/id'];
  for(const route of good)assert.equal(signal.assignedConversationRoute(route),true,route);
  for(const route of bad)assert.equal(signal.assignedConversationRoute(route),false,route);
  assert.equal(signal.assignedConversationRoute(null),false);
});
