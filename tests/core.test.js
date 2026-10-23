const {test} = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/core.js');
const items = [{id:'aaaaaaaa',text:'a'},{id:'bbbbbbbb',text:'b'},{id:'cccccccc',text:'c'}];
test('queued messages retain stable, explicit order',()=>{
  assert.deepEqual(q.nextPosition(items,'bbbbbbbb',-1).map(x=>x.id),['bbbbbbbb','aaaaaaaa','cccccccc']);
  assert.deepEqual(q.moveTo(items,'cccccccc','aaaaaaaa').map(x=>x.id),['cccccccc','aaaaaaaa','bbbbbbbb']);
  assert.deepEqual(q.moveTo(items,'aaaaaaaa',null).map(x=>x.id),['bbbbbbbb','cccccccc','aaaaaaaa']);
});
test('unknown and failure states never authorize sending',()=>{
  for(const phase of ['unknown','submitted','generating','verifying','interrupted','failed','limit'])assert.equal(q.mayDispatch(phase,false,false),false,phase);
  assert.equal(q.mayDispatch('finished',true,true),false);
  assert.equal(q.mayDispatch('finished',false,false),true);
  assert.equal(q.mayDispatch('idle',false,false),true);
});
test('only a busy-seen finished response clears waiting',()=>{
  for(const phase of q.PHASES)for(const busy of [true,false]){
    assert.equal(q.completionArrived(phase,true,busy),phase==='finished'&&busy);
  }
});
test('malformed and overlength messages rejected',()=>{
  assert.equal(q.validText(''),false);
  assert.equal(q.validText('x'.repeat(q.MAX_CHARS+1)),false);
  assert.throws(()=>q.makeItem('a','!!!'));
  assert.deepEqual(q.normalizeSaved({items:[{id:'aaaaaaaa',text:'hi'},{id:'aaaaaaaa',text:'dup'},{id:'bbbbbbbb',text:''}]}),[{id:'aaaaaaaa',text:'hi',status:'pending'}]);
});

test('exact permutation rejects duplicates, foreign IDs, truncation and excessive queues',()=>{
  const valid=items.map(x=>x.id);
  assert.equal(q.exactPermutation(items,[valid[2],valid[0],valid[1]]),true);
  for(const bad of [null,[],[valid[0],valid[0],valid[1]],[valid[0],valid[1],'foreignxx'],[valid[0],valid[1]],[valid[0],valid[1],null]])
    assert.equal(q.exactPermutation(items,bad),false);
  assert.equal(q.exactPermutation([{...items[0]},{...items[0]}],[items[0].id,items[0].id]),false);
  const oversized=Array.from({length:q.MAX_ITEMS+1},(_,i)=>({id:'x'+i}));
  assert.equal(q.exactPermutation(oversized,oversized.map(x=>x.id)),false);
  assert.deepEqual(items.map(x=>x.id),valid,'validation must not mutate queue items');
});
