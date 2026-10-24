'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function fixture() {
  const listeners = {};
  let forwards = 0;
  const browser = {
    runtime: {
      onMessage: {addListener(fn) {listeners.internal=fn;}},
      onMessageExternal: {addListener(fn) {listeners.external=fn;}},
      onConnectExternal: {addListener(fn) {listeners.connect=fn;}}
    },
    tabs: {
      get: async id=>({id,url:'https://chatgpt.com/c/synthetic'}),
      sendMessage: async()=>{forwards++;return {ok:true};},
      onRemoved:{addListener(fn){listeners.removed=fn;}},
      onUpdated:{addListener(fn){listeners.updated=fn;}}
    },
    storage: {
      local: {get: async()=>({'chatqueue:api-grants:v2':{version:2,grants:{
        'approved@example.test':['discover','append','rules']}}})},
      onChanged:{addListener(fn){listeners.changed=fn;}}
    }
  };
  const context=vm.createContext({browser,URL});
  for(const rel of ['src/signal.js','src/grants.js','src/rules.js','src/background.js']){
    vm.runInContext(fs.readFileSync(path.resolve(__dirname,'..',rel),'utf8'),context,{filename:rel});
  }
  return {listeners,get forwards(){return forwards;}};
}
test('cyclic peer IPC is rejected with no forwarding or leaked body',async()=>{
  const x=fixture();
  const message={type:'chat-queue/v1',action:'enqueue',tabId:5,payload:{text:'PRIVATE PROMPT'}};
  message.self=message;
  const result=await x.listeners.external(message,{id:'approved@example.test'});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:false,error:'invalid-request'});
  assert.equal(x.forwards,0);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE PROMPT/);
});
test('malformed serialization fails closed without rejected callback',async()=>{
  const x=fixture();
  const message={type:'chat-queue/v1',action:'listTabs'};
  message.toJSON=()=>{throw new Error('synthetic hostile serializer');};
  const result=await x.listeners.external(message,{id:'approved@example.test'});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:false,error:'invalid-request'});
  assert.equal(x.forwards,0);
});
test('oversize messages reject before rule execution and tab forwarding',async()=>{
  const x=fixture();
  for(const action of ['enqueue','previewRules']){
    const result=await x.listeners.external(
      {type:'chat-queue/v1',action,tabId:5,payload:{text:'X'.repeat(32769)}},
      {id:'approved@example.test'});
    assert.equal(result.ok,false);
    assert.equal(result.error,'request-too-large');
  }
  assert.equal(x.forwards,0);
});
test('deny-by-default rejects unknown sender independently of payload validity',async()=>{
  const x=fixture();
  const msg={type:'chat-queue/v1',action:'enqueue',tabId:5,payload:{text:'private'}};
  msg.self=msg;
  assert.equal((await x.listeners.external(msg,{id:'unapproved@example.test'})).error,'unauthorized');
  assert.equal(x.forwards,0);
  const ok=await x.listeners.external({type:'chat-queue/v1',action:'capabilities'},
    {id:'approved@example.test'});
  assert.equal(ok.ok,true);
  assert.equal(ok.version,2);
});
