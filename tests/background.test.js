const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync(require.resolve('../src/background.js'),'utf8');
const signals=fs.readFileSync(require.resolve('../src/signal.js'),'utf8');
function create() {
  const listeners={};
  const forwards=[];
  const browser={
    runtime:{onMessage:{addListener:fn=>listeners.internal=fn},onMessageExternal:{addListener:fn=>listeners.external=fn},onConnectExternal:{addListener:fn=>listeners.connect=fn}},
    tabs:{sendMessage:async(tabId,message)=>{forwards.push({tabId,message});return {ok:true};},onRemoved:{addListener:fn=>listeners.removed=fn},onUpdated:{addListener:fn=>listeners.updated=fn}},
    storage:{local:{get:async()=>({allowedExtensionIds:['approved@example.test']})},onChanged:{addListener:fn=>listeners.changed=fn}}
  };
  const context=vm.createContext({browser});
  vm.runInContext(signals,context);
  vm.runInContext(src,context);
  return {listeners,forwards};
}
test('cross-extension API is denied by default unless allowlisted',async()=>{
  const {listeners}=create();
  const answer=await listeners.external({type:'chat-queue/v1',action:'listTabs'},{id:'unapproved@example.test'});
  assert.equal(answer.ok,false);
  assert.equal(answer.error,'unauthorized');
});
test('approved senders can discover registered tabs and forward only known actions',async()=>{
  const {listeners,forwards}=create();
  const sender={tab:{id:17,url:'https://chatgpt.com/c/fake'},url:'https://chatgpt.com/c/fake'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register'},sender)).tabId,17);
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'generating',size:2,running:true},sender);
  const external={id:'approved@example.test'};
  const listed=await listeners.external({type:'chat-queue/v1',action:'listTabs'},external);
  assert.equal(listed.ok,true);
  assert.equal(listed.tabs[0].tabId,17);
  assert.equal(listed.tabs[0].phase,'generating');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'secret',tabId:17},external)).error,'invalid-request');
  const response=await listeners.external({type:'chat-queue/v1',action:'enqueue',tabId:17,payload:{text:'hello'}},external);
  assert.equal(response.ok,true);
  assert.equal(forwards[0].message.payload.text,'hello');
  assert.equal(forwards[0].tabId,17);
});
test('non-ChatGPT content cannot register as a target',async()=>{
  const {listeners}=create();
  assert.equal(listeners.internal({type:'chat-queue-internal/v1',action:'register'},
    {tab:{id:7,url:'https://example.com/'},url:'https://example.com/'}),undefined);
});
test('only the authenticated Chat Signals extension can supply epochs; stale events are rejected',async()=>{
  const {listeners,forwards}=create();
  const tab={tab:{id:17,url:'https://chatgpt.com/c/example'},url:'https://chatgpt.com/c/example'};
  await listeners.internal({type:'chat-queue-internal/v1',action:'register'},tab);
  const signal={version:1,route:'/c/example',documentToken:'a'.repeat(32),
    sequence:1,epoch:1,phase:'generating',origin:'fresh',confidence:'observed'};
  const msg={type:'chat-queue-signal/v1',tabId:17,signal};
  assert.equal((await listeners.external(msg,{id:'unapproved@example.test'})).error,'not-signal-provider');
  assert.equal(forwards.length,0);
  const sender={id:'chat-signals@sguzman.github'};
  assert.equal((await listeners.external(msg,sender)).ok,true);
  assert.equal(forwards[0].message.type,'chat-queue-signal-verified/v1');
  const listed=await listeners.external({type:'chat-queue/v1',action:'listTabs'},{id:'approved@example.test'});
  assert.equal(listed.ok,true);
  assert.equal('provider' in listed.tabs[0],false);
  assert.equal(JSON.stringify(listed).includes(signal.documentToken),false);
  assert.equal(JSON.stringify(listed).includes(signal.route),false);
  assert.equal((await listeners.external(msg,sender)).error,'stale-signal');
  assert.equal((await listeners.external({...msg,signal:{...signal,sequence:2,epoch:0}},sender)).error,'stale-signal');
  assert.equal((await listeners.external({...msg,signal:{...signal,sequence:2,route:'/c/other'}},sender)).error,'stale-signal');
  assert.equal((await listeners.external({...msg,signal:{...signal,sequence:2,documentToken:'b'.repeat(32)}},sender)).error,'stale-signal');
  assert.equal((await listeners.external({...msg,tabId:42},sender)).error,'tab-not-registered');
});
