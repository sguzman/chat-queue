'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../src/core.js');
const record=(text,status='pending')=>({version:1,items:[
  {id:'example-id-123',text,status}]});
test('recovery only discovers exact same-conversation tab records',()=>{
  const records={
    'chatqueue:v1:tab:17:/c/alpha':record('prior alpha'),
    'chatqueue:v1:tab:18:/c/alphabet':record('other route'),
    'chatqueue:v1:tab:19:/c/beta':record('other conversation'),
    'chatqueue:v1:tab:20:/c/alpha':record('current alpha'),
    'chatqueue:v1:tab:nonnumeric:/c/alpha':record('invalid tab identifier'),
    'chatqueue:v1:tab:21:/c/alpha?session=other':record('not exact pathname')
  };
  const result=core.recoveryCandidates(records,'/c/alpha','chatqueue:v1:tab:20:/c/alpha');
  assert.deepEqual(result,[{key:'chatqueue:v1:tab:17:/c/alpha',count:1}]);
  assert.equal(JSON.stringify(result).includes('prior alpha'),false,'discovery must be metadata-only');
});
test('unknown future versions and unreadable orphan records are not recovered',()=>{
  const items={
    'chatqueue:v1:tab:1:/c/current':{version:99,items:[{id:'legacy-id-123',text:'future',status:'pending'}]},
    'chatqueue:v1:tab:2:/c/current':{version:1,items:'invalid'},
    'chatqueue:v1:tab:3:/c/current':{version:1,items:[]},
    'chatqueue:v1:tab:4:/c/current':record('recoverable')
  };
  assert.deepEqual(core.recoveryCandidates(items,'/c/current','chatqueue:v1:tab:8:/c/current'),
    [{key:'chatqueue:v1:tab:4:/c/current',count:1}]);
});
test('already-reviewed recovery keys cannot be offered twice in same queue',()=>{
  const old='chatqueue:v1:tab:42:/c/matched';
  assert.equal(core.recoveryCandidates({[old]:record('kept')},'/c/matched',
    'chatqueue:v1:tab:99:/c/matched',[old]).length,0);
});
test('older unknown or submitted statuses are never automatically pending',()=>{
  const old={version:1,items:[
    {id:'legacy-id-123',text:'possibly sent',status:'submitted'},
    {id:'legacy-id-456',text:'not yet submitted',status:'pending'}]};
  const normalized=core.normalizeSaved(old);
  assert.deepEqual(normalized.map(x=>x.status),['uncertain','pending']);
  const manuallyRestored=normalized.map(x=>({...x,status:'uncertain'}));
  assert.deepEqual(manuallyRestored.map(x=>x.status),['uncertain','uncertain']);
});
