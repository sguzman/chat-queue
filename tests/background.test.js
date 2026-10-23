const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync(require.resolve('../src/background.js'),'utf8');
function create() {
  const listeners={};
  const forwards=[];
  const browser={
    runtime:{onMessage:{addListener:fn=>listeners.internal=fn},onMessageExternal:{addListener:fn=>listeners.external=fn},onConnectExternal:{addListener:fn=>listeners.connect=fn}},
    tabs:{sendMessage:async(tabId,message)=>{forwards.push({tabId,message});return {ok:true};},onRemoved:{addListener:fn=>listeners.removed=fn},onUpdated:{addListener:fn=>listeners.updated=fn}},
    storage:{local:{get:async()=>({allowedExtensionIds:['approved@example.test']})},onChanged:{addListener:fn=>listeners.changed=fn}}
  };
  vm.runInNewContext(src,{browser});
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
