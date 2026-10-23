const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync(require.resolve('../src/background.js'),'utf8');
const signals=fs.readFileSync(require.resolve('../src/signal.js'),'utf8');
const grants=fs.readFileSync(require.resolve('../src/grants.js'),'utf8');
function create() {
  const listeners={};
  const forwards=[];
  const state={'chatqueue:api-grants:v2':{version:2,grants:{
    'approved@example.test':['discover','read','append','edit','control'],
    'observer@example.test':['discover'],
    'poster@example.test':['append']}}};
  const browser={
    runtime:{onMessage:{addListener:fn=>listeners.internal=fn},onMessageExternal:{addListener:fn=>listeners.external=fn},onConnectExternal:{addListener:fn=>listeners.connect=fn}},
    tabs:{sendMessage:async(tabId,message)=>{forwards.push({tabId,message});return {ok:true};},onRemoved:{addListener:fn=>listeners.removed=fn},onUpdated:{addListener:fn=>listeners.updated=fn}},
    storage:{local:{get:async()=>state},onChanged:{addListener:fn=>listeners.changed=fn}}
  };
  const context=vm.createContext({browser,URL});
  vm.runInContext(signals,context);
  vm.runInContext(grants,context);
  vm.runInContext(src,context);
  return {listeners,forwards,state};
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
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/fake'},sender)).tabId,17);
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
test('least-privilege scopes prevent read or control from discover/append grants',async()=>{
  const {listeners,forwards}=create();
  const tab={tab:{id:17,url:'https://chatgpt.com/c/example'},url:'https://chatgpt.com/c/example'};
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/example'},tab);
  const discover={id:'observer@example.test'},append={id:'poster@example.test'};
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'listTabs'},discover)).ok,true);
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'status',tabId:17},discover)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'start',tabId:17},discover)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'listTabs'},append)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'status',tabId:17},append)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'start',tabId:17},append)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'enqueue',tabId:17,payload:{text:'synthetic'}},append)).ok,true);
  assert.equal(forwards.length,1);
  const capabilities=await listeners.external({type:'chat-queue/v1',action:'capabilities'},append);
  assert.deepEqual(Array.from(capabilities.scopes),['append']);
});
test('only the authenticated Chat Signals extension can supply epochs; stale events are rejected',async()=>{
  const {listeners,forwards}=create();
  const tab={tab:{id:17,url:'https://chatgpt.com/c/example'},url:'https://chatgpt.com/c/example'};
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/example'},tab);
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
  assert.equal((await listeners.external({...msg,signal:{...signal,sequence:2,route:'/c/other'}},sender)).error,'route-mismatch');
  assert.equal((await listeners.external({...msg,signal:{...signal,sequence:2,documentToken:'b'.repeat(32)}},sender)).error,'stale-signal');
  assert.equal((await listeners.external({...msg,tabId:42},sender)).error,'tab-not-registered');
});

test('scoped API closes revoked event ports and refuses new calls',async()=>{
  const {listeners,state}=create();
  const seen=[];
  let disconnected=0;
  const port={name:'chat-queue/v1',sender:{id:'observer@example.test'},
    onDisconnect:{addListener:()=>{}},postMessage:msg=>seen.push(msg),
    disconnect:()=>disconnected++};
  listeners.connect(port);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(seen[0].event,'ready');
  assert.equal(disconnected,0);
  const oldValue=state['chatqueue:api-grants:v2'];
  const newValue={version:2,grants:{'approved@example.test':['discover','read']}};
  state['chatqueue:api-grants:v2']=newValue;
  listeners.changed({'chatqueue:api-grants:v2':{oldValue,newValue}},'local');
  assert.equal(disconnected,1);
  const response=await listeners.external({type:'chat-queue/v1',action:'listTabs'},{id:'observer@example.test'});
  assert.equal(response.error,'unauthorized');
});
test('all externally supplied API frames are size bounded, including capabilities',async()=>{
  const {listeners,forwards}=create();
  const large='x'.repeat(33000);
  const sender={id:'poster@example.test'};
  const cap=await listeners.external({type:'chat-queue/v1',action:'capabilities',padding:large},sender);
  const enqueue=await listeners.external({type:'chat-queue/v1',action:'enqueue',tabId:8,payload:{text:large}},sender);
  assert.equal(cap.error,'request-too-large');
  assert.equal(enqueue.error,'request-too-large');
  assert.equal(forwards.length,0);
});

test('Firefox tab URL updates revoke old providers and require exact re-registration',async()=>{
  const {listeners,forwards}=create();
  const sender={tab:{id:15,url:'https://chatgpt.com/c/first'},url:'https://chatgpt.com/c/first'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/first'},sender)).ok,true);
  const source={id:'chat-signals@sguzman.github'};
  const event=(route,seq)=>({type:'chat-queue-signal/v1',tabId:15,signal:{version:1,route,sequence:seq,epoch:1,documentToken:'a'.repeat(32),phase:'finished',origin:'fresh',confidence:'inferred'}});
  assert.equal((await listeners.external(event('/c/first',1),source)).ok,true);
  listeners.updated(15,{url:'https://chatgpt.com/c/first?query=unchanged'});
  assert.equal((await listeners.external(event('/c/first',2),source)).ok,true,'same pathname must not revoke route');
  listeners.updated(15,{url:'https://chatgpt.com/c/second'});
  assert.equal((await listeners.external(event('/c/first',3),source)).error,'tab-not-registered');
  assert.equal(forwards.at(-1).message.type,'chat-queue-route-changed/v1');
  const newSender={tab:{id:15,url:'https://chatgpt.com/c/second'},url:'https://chatgpt.com/c/second'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/second'},newSender)).ok,true);
  assert.equal((await listeners.external(event('/c/first',4),source)).error,'route-mismatch');
  assert.equal((await listeners.external(event('/c/second',4),source)).ok,true);
});

test('late registration from old route fails closed even if it claims new route',async()=>{
  const {listeners}=create();
  const old={tab:{id:2,url:'https://chatgpt.com/c/old'},url:'https://chatgpt.com/c/old'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/new'},old)).error,'route-mismatch');
  const newSender={tab:{id:2,url:'https://chatgpt.com/c/new'},url:'https://chatgpt.com/c/new'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/new'},newSender)).ok,true);
});

test('tab URL updates revoke route authority even if History API listener is unavailable',async()=>{
  const {listeners}=create();
  const sender={tab:{id:28,url:'https://chatgpt.com/c/one'},url:'https://chatgpt.com/c/one'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/one'},sender)).ok,true);
  listeners.updated(28,{url:'https://chatgpt.com/c/two'});
  const status=await listeners.external({type:'chat-queue/v1',action:'listTabs'},{id:'approved@example.test'});
  assert.equal(status.tabs.length,0);
});
