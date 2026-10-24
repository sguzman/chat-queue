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

test('bounded deterministic adversarial IPC corpus never forwards or discloses text',async()=>{
  const x=fixture();
  const secret='SYNTHETIC-NONPUBLIC-PROMPT';
  const samples=[null,undefined,false,0,'bad',[],{},{type:'other',action:'enqueue'},
    {type:'chat-queue/v1',action:null},
    {type:'chat-queue/v1',action:123},
    {type:'chat-queue/v1',action:[]},
    {type:'chat-queue/v1',action:{x:'enqueue'}}];
  for(let i=0;i<128;i++){
    const actions=['unsupported-'+i,'enqueue','previewRules','update','remove','capabilities','listTabs'];
    const body=[null,secret,{text:secret},[secret],{deep:{nested:[secret]}}][i%5];
    // The queue is never registered in this fixture, so even typed mutation
    // frames with a plausible tabId cannot dispatch to a content script.
    samples.push({type:i%3===0?'chat-queue/v1':'untrusted',
      action:actions[i%actions.length],tabId:i%2===0?5:-1,
      payload:body,extraneous:i%11===0?'Z'.repeat(35000):undefined});
  }
  for(const candidate of samples){
    const reply=await x.listeners.external(candidate,{id:'approved@example.test'});
    assert.notEqual(reply?.ok,true,'malformed peer frame must not be accepted');
    assert.equal(x.forwards,0);
    assert.equal(JSON.stringify(reply??{}).includes(secret),false,
      'rejection must not echo private prompt text');
  }
});
