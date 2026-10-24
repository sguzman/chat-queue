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
  assert.deepEqual(q.normalizeSaved({items:[{id:'aaaaaaaa',text:'hi'},{id:'aaaaaaaa',text:'dup'},{id:'bbbbbbbb',text:''}]}),[{id:'aaaaaaaa',text:'hi',status:'uncertain'}]);
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

test('unknown persisted states fail closed as uncertain, without automatic retry',()=>{
  const saved={version:1,items:[
    {id:'aaaaaaaa',text:'pending',status:'pending'},
    {id:'bbbbbbbb',text:'in flight',status:'submitted'},
    {id:'cccccccc',text:'legacy',status:'sent'},
    {id:'dddddddd',text:'no state'},
    {id:'eeeeeeee',text:'known uncertain',status:'uncertain'}
  ]};
  const restored=q.normalizeSaved(saved);
  assert.deepEqual(restored.map(x=>x.status),['pending','uncertain','uncertain','uncertain','uncertain']);
  assert.deepEqual(restored.map(x=>x.id),saved.items.map(x=>x.id));
  assert.equal(saved.items[1].status,'submitted','source state is not mutated');
});

test('unrecognized future queue schemas are explicitly read-only; legacy records remain readable',()=>{
  assert.deepEqual(q.savedRecordSupport(undefined),{ok:true});
  assert.deepEqual(q.savedRecordSupport({version:1,items:[]}),{ok:true});
  assert.deepEqual(q.savedRecordSupport({items:[{id:'aaaaaaaa',text:'legacy'}]}),{ok:true});
  for(const bad of [{version:2,items:[]},{version:'1',items:[]},{version:1,items:null},[],42,'bad']){
    assert.deepEqual(q.savedRecordSupport(bad),{ok:false,error:'unsupported-saved-queue'});
  }
  // Inspecting malformed records must never write to or mutate them.
  const future={version:2,items:[{id:'aaaaaaaa',text:'keep this',status:'pending'}]};
  q.savedRecordSupport(future);
  assert.equal(future.items[0].text,'keep this');
});

test('queue backup excludes route identifiers and preserves uncertain statuses',()=>{
  const original=[
    {id:'aaaaaaaa',text:'Synthetic pending prompt',status:'pending'},
    {id:'bbbbbbbb',text:'Synthetic uncertain prompt',status:'uncertain'}
  ];
  const payload=q.backupItems(original);
  assert.deepEqual(payload,{kind:q.BACKUP_KIND,version:1,items:[
    {text:'Synthetic pending prompt',status:'pending'},
    {text:'Synthetic uncertain prompt',status:'uncertain'}
  ]});
  assert.deepEqual(q.parseBackup(JSON.parse(JSON.stringify(payload))),payload.items);
  assert.equal(JSON.stringify(payload).includes('aaaaaaaa'),false);
  assert.notEqual(payload.items[0],original[0]);
});
test('malformed, oversize, and future backup versions fail closed without mutating data',()=>{
  const valid=q.backupItems([{id:'aaaaaaaa',text:'Fixture',status:'pending'}]);
  for(const bad of [
    null,[],{}, {...valid,version:2}, {...valid,kind:'other'},
    {...valid,items:[{text:'',status:'pending'}]},
    {...valid,items:[{text:'fixture',status:'sent'}]},
    {...valid,items:[{text:'fixture',status:'pending'},{text:'x'.repeat(q.MAX_CHARS+1),status:'pending'}]},
    {...valid,items:Array.from({length:q.MAX_ITEMS+1},()=>({text:'x',status:'pending'}))}
  ])assert.throws(()=>q.parseBackup(bad));
  assert.throws(()=>q.backupItems([{id:'aaaaaaaa',text:'no status'}]));
  assert.throws(()=>q.backupItems(Array.from({length:2},()=>({id:'aaaaaaaa',text:'same',status:'pending'}))));
  assert.equal(valid.items[0].status,'pending','validator never edits input');
});
