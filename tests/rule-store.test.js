'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
require('../src/signal.js');
require('../src/rules.js');
const store=require('../src/rule-store.js');
const sample={version:1,id:'safe-example',enabled:true,priority:5,
  when:{phase:'failed',confidence:'observed'},then:{type:'pause'}};
test('rule definitions roundtrip only under an explicit versioned local library',()=>{
  assert.deepEqual(store.decode(undefined),{ok:true,rules:[],exists:false});
  const saved=store.encode([sample]);
  assert.equal(saved.ok,true);
  assert.equal(saved.value.version,1);
  assert.equal(store.decode(saved.value).rules[0].id,'safe-example');
  saved.value.rules[0].id='mutated';
  assert.equal(sample.id,'safe-example');
});
test('unknown version, unknown keys and malformed library do not silently migrate',()=>{
  for(const value of [null,[],{}, {version:2,rules:[sample]},
      {version:1,rules:[sample],autoSend:true},
      {version:1,rules:[{...sample,then:{type:'eval',text:'x'}}]},
      {version:1,rules:[sample,sample]}]){
    assert.equal(store.decode(value).ok,false);
  }
  assert.equal(store.decode({version:1,rules:[sample]}).ok,true);
});
test('rule text has a strict size budget and never yields an executable action',()=>{
  const tooLong={...sample,then:{type:'propose',text:'x'.repeat(24001)}};
  assert.equal(store.encode([tooLong]).ok,false);
  const safe={...sample,then:{type:'propose',text:'<img onerror=bad>'}};
  const result=store.decode(store.encode([safe]).value);
  assert.equal(result.rules[0].then.type,'propose');
  assert.equal(result.rules[0].then.text,'<img onerror=bad>');
});

test('linked rules roundtrip with exact references; orphaned deletion is rejected',()=>{
  const root={...sample,id:'root'};
  const child={...sample,id:'child',priority:80,
    when:{...sample.when,dependsOn:['root'],skipIf:['guard']}};
  const guard={...sample,id:'guard',priority:20};
  const saved=store.encode([child,root,guard]);
  assert.equal(saved.ok,true);
  const reloaded=store.decode(JSON.parse(JSON.stringify(saved.value)));
  assert.equal(reloaded.ok,true);
  const linked=reloaded.rules.find(rule=>rule.id==='child');
  assert.deepEqual(Array.from(linked.when.dependsOn),['root']);
  assert.deepEqual(Array.from(linked.when.skipIf),['guard']);
  assert.equal(Object.isFrozen(linked.when.dependsOn),true);
  assert.equal(store.encode(reloaded.rules.filter(rule=>rule.id!=='root')).error,'invalid-dependency');
  assert.equal(store.encode(reloaded.rules.filter(rule=>rule.id!=='guard')).error,'invalid-dependency');
});
