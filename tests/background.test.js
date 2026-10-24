const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync(require.resolve('../src/background.js'),'utf8');
const signals=fs.readFileSync(require.resolve('../src/signal.js'),'utf8');
const grants=fs.readFileSync(require.resolve('../src/grants.js'),'utf8');
const rules=fs.readFileSync(require.resolve('../src/rules.js'),'utf8');
function create() {
  const listeners={};
  const forwards=[];
  const liveUrls=new Map();
  const state={'chatqueue:api-grants:v2':{version:2,grants:{
    'approved@example.test':['discover','read','append','edit','control'],
    'observer@example.test':['discover'],
    'poster@example.test':['append'],
    'sandbox@example.test':['rules']}}};
  const browser={
    runtime:{onMessage:{addListener:fn=>listeners.internal=(message,sender)=>{
      if(sender?.tab&&!liveUrls.has(sender.tab.id))liveUrls.set(sender.tab.id,sender.tab.url);
      return fn(message,sender);
    }},onMessageExternal:{addListener:fn=>listeners.external=fn},onConnectExternal:{addListener:fn=>listeners.connect=fn}},
    tabs:{get:async tabId=>({id:tabId,url:liveUrls.get(tabId)}),
      sendMessage:async(tabId,message)=>{forwards.push({tabId,message});return {ok:true};},
      onRemoved:{addListener:fn=>listeners.removed=fn},
      onUpdated:{addListener:fn=>listeners.updated=(id,change)=>{
        if(change.url)liveUrls.set(id,change.url);
        return fn(id,change);
      }}},
    storage:{local:{get:async()=>state},onChanged:{addListener:fn=>listeners.changed=fn}}
  };
  const context=vm.createContext({browser,URL});
  vm.runInContext(signals,context);
  vm.runInContext(grants,context);
  vm.runInContext(rules,context);
  vm.runInContext(src,context);
  return {listeners,forwards,state,context};
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
  assert.equal(capabilities.protocolVersion,1);
  assert.equal(capabilities.grantVersion,2);
  assert.equal(capabilities.version,2,'legacy version field remains permission-policy version');
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
  assert.equal(seen[0].protocolVersion,1);
  assert.equal(seen[0].type,'chat-queue/v1');
  assert.equal(disconnected,0);
  const syntheticTab={tab:{id:72,url:'https://chatgpt.com/c/synthetic'},url:'https://chatgpt.com/c/synthetic'};
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/synthetic'},syntheticTab);
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'generating',size:3,running:true,awaiting:true,revision:5},syntheticTab);
  const change=seen.find(x=>x.event==='stateChanged');
  assert.equal(change?.protocolVersion,1);
  assert.equal(change?.state?.size,3);
  assert.equal(change?.state?.phase,'generating');
  assert.equal('items' in change?.state,false);
  assert.equal('history' in change?.state,false);
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
  listeners.updated(2,{url:'https://chatgpt.com/c/new'});
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

test('unregistered and stale SPA state updates cannot repopulate the public tab list',async()=>{
  const {listeners}=create();
  const old={tab:{id:91,url:'https://chatgpt.com/c/old'},url:'https://chatgpt.com/c/old'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'finished'},old)).error,'route-mismatch');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/old'},old)).ok,true);
  listeners.updated(91,{url:'https://chatgpt.com/c/new'});
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'finished'},old)).error,'route-mismatch');
  const list=await listeners.external({type:'chat-queue/v1',action:'listTabs'},{id:'approved@example.test'});
  assert.deepEqual(Array.from(list.tabs),[]);
});

test('Firefox live tab URL overrides stale document sender URL after SPA navigation',async()=>{
  const {listeners}=create();
  const initial={tab:{id:32,url:'https://chatgpt.com/c/first'},url:'https://chatgpt.com/c/first'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/first'},initial)).ok,true);
  listeners.updated(32,{url:'https://chatgpt.com/c/second'});
  const second={tab:{id:32,url:'https://chatgpt.com/c/second'},url:'https://chatgpt.com/c/first'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/second'},second)).ok,true);
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'unknown'},second)).ok,true);
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/first'},second)).error,'route-mismatch');
});

test('dispatch preflight requires current authenticated provider and exact epoch',async()=>{
  const {listeners}=create();
  const tab={tab:{id:64,url:'https://chatgpt.com/c/preflight'},url:'https://chatgpt.com/c/preflight'};
  const probe=(sequence=1)=>listeners.internal({type:'chat-queue-internal/v1',action:'dispatch-check',
    route:'/c/preflight',documentToken:'b'.repeat(32),epoch:1,sequence},tab);
  assert.equal((await probe()).error,'signal-authority-lost');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/preflight'},tab)).ok,true);
  assert.equal((await probe()).error,'signal-authority-lost');
  const signal={version:1,route:'/c/preflight',documentToken:'b'.repeat(32),
    sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'};
  const provider={id:'chat-signals@sguzman.github'};
  assert.equal((await listeners.external({type:'chat-queue-signal/v1',tabId:64,signal},provider)).ok,true);
  assert.equal((await probe()).ok,true);
  assert.equal((await probe(2)).error,'signal-authority-lost');
  listeners.updated(64,{url:'https://chatgpt.com/c/elsewhere'});
  assert.equal((await probe()).error,'signal-authority-lost');
});

test('rules-only external client can preview synthetics but cannot enumerate or send',async()=>{
  const {listeners,forwards,context}=create();
  // Firefox deserializes extension messages into the receiver's realm.
  // The Node VM fixture must model that rather than passing outer-realm objects.
  const inReceiver=value=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(value))+')',context);
  const sender={id:'sandbox@example.test'};
  const signal={version:1,route:'/c/synthetic',documentToken:'a'.repeat(32),
    sequence:1,epoch:1,phase:'failed',origin:'fresh',confidence:'observed'};
  const rule={version:1,id:'halt',enabled:true,priority:1,when:{phase:'failed'},then:{type:'pause'}};
  const preview=await listeners.external(inReceiver({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[rule],signal}}),sender);
  assert.equal(preview.ok,true);assert.equal(preview.decision.action.type,'pause');
  assert.equal(preview.decision.approvalRequired,true);
  assert.equal(preview.audit.ruleId,'halt');
  assert.equal(preview.audit.phase,'failed');
  assert.equal(preview.audit.action,'pause');
  assert.equal(preview.audit.approvalRequired,true);
  assert.equal(JSON.stringify(preview.audit).includes(signal.documentToken),false);
  assert.equal(JSON.stringify(preview.audit).includes(signal.route),false);
  const timedRule={...rule,when:{phase:'failed',minDurationMs:5000}};
  const noDuration=await listeners.external(inReceiver({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[timedRule],signal}}),sender);
  assert.equal(noDuration.reason,'no-match');
  const enough=await listeners.external(inReceiver({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[timedRule],signal,context:{stateDurationMs:6000}}}),sender);
  assert.equal(enough.decision.ruleId,'halt');
  assert.equal((await listeners.external(inReceiver({type:'chat-queue/v1',action:'previewRules',
    payload:{rules:[timedRule],signal,context:{stateDurationMs:-5}}}),sender)).error,'invalid-context');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'listTabs'},sender)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'start',tabId:1},sender)).error,'forbidden-scope');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'status',tabId:1},sender)).error,'forbidden-scope');
  assert.equal((await listeners.external(inReceiver({type:'chat-queue/v1',action:'previewRules',payload:{rules:[{...rule,eval:'danger'}],signal}}),sender)).error,'invalid-rule');
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'previewRules',payload:{rules:[rule],signal}},
    {id:'poster@example.test'})).error,'forbidden-scope');
  assert.equal(forwards.length,0,'pure previews must not contact any queue tab');
});

test('revoking read scope during an in-flight status request withholds private prompt text',async()=>{
  const {listeners,state,context}=create();
  const page={tab:{id:83,url:'https://chatgpt.com/c/synthetic'},url:'https://chatgpt.com/c/synthetic'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/synthetic'},page)).ok,true);
  let release;
  context.browser.tabs.sendMessage=()=>new Promise(resolve=>{release=resolve;});
  const request=listeners.external({type:'chat-queue/v1',action:'status',tabId:83},{id:'approved@example.test'});
  for(let i=0;i<8&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  const oldValue=state['chatqueue:api-grants:v2'];
  const newValue={version:2,grants:{'approved@example.test':['discover','append']}};
  state['chatqueue:api-grants:v2']=newValue;
  listeners.changed({'chatqueue:api-grants:v2':{oldValue,newValue}},'local');
  release({ok:true,items:[{id:'only-in-browser',text:'synthetic private text'}]});
  const response=await request;
  assert.equal(response.error,'authorization-changed');
  assert.equal(JSON.stringify(response).includes('synthetic private text'),false);
  assert.equal((await listeners.external({type:'chat-queue/v1',action:'status',tabId:83},
    {id:'approved@example.test'})).error,'forbidden-scope');
});

test('revoking discover while a port authorization read is pending fails closed',async()=>{
  const {listeners,state,context}=create();
  const realGet=context.browser.storage.local.get;
  let resume;
  context.browser.storage.local.get=()=>new Promise(resolve=>{resume=()=>resolve(realGet());});
  let disconnects=0,posts=0;
  const port={name:'chat-queue/v1',sender:{id:'observer@example.test'},
    onDisconnect:{addListener:()=>{}},postMessage:()=>posts++,disconnect:()=>disconnects++};
  listeners.connect(port);
  assert.equal(typeof resume,'function');
  const oldValue=state['chatqueue:api-grants:v2'];
  const newValue={version:2,grants:{'approved@example.test':['discover']}};
  state['chatqueue:api-grants:v2']=newValue;
  listeners.changed({'chatqueue:api-grants:v2':{oldValue,newValue}},'local');
  resume();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(disconnects,1);
  assert.equal(posts,0);
});

test('one exact conversation route has at most one live dispatch owner',async()=>{
  const {listeners}=create();
  const senders=[17,18].map(id=>({tab:{id,url:'https://chatgpt.com/c/shared'},url:'https://chatgpt.com/c/shared'}));
  const provider={id:'chat-signals@sguzman.github'};
  const check=(index)=>listeners.internal({type:'chat-queue-internal/v1',action:'dispatch-check',
    route:'/c/shared',documentToken:(index===0?'a':'b').repeat(32),epoch:0,sequence:1},senders[index]);
  for(let i=0;i<2;i++){
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/shared'},senders[i])).ok,true);
    const sig={version:1,route:'/c/shared',documentToken:(i===0?'a':'b').repeat(32),
      epoch:0,sequence:1,phase:'idle',origin:'fresh',confidence:'observed'};
    assert.equal((await listeners.external({type:'chat-queue-signal/v1',tabId:senders[i].tab.id,signal:sig},provider)).ok,true);
  }
  // Two independent preflight callbacks compete for one route lease.
  const results=await Promise.all([check(0),check(1)]);
  assert.equal(results.filter(x=>x.ok).length,1);
  assert.equal(results.filter(x=>x.error==='conversation-owned-by-another-tab').length,1);
  const winner=results[0].ok?0:1,loser=1-winner;
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',running:false,awaiting:true,size:1,phase:'verifying'},senders[winner]);
  assert.equal((await check(loser)).error,'conversation-owned-by-another-tab',
    'pausing while a response is in flight must not unlock the route');
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',running:false,awaiting:false,size:1,phase:'finished'},senders[winner]);
  assert.equal((await check(loser)).ok,true,'confirmed terminal state frees a paused route lease');
  assert.equal((await check(winner)).error,'conversation-owned-by-another-tab');
  listeners.removed(senders[loser].tab.id);
  assert.equal((await check(winner)).ok,true,'tab closure releases the owner');
});
test('route ownership cannot persist through tab registration or unrelated routes',async()=>{
  const {listeners}=create(),provider={id:'chat-signals@sguzman.github'};
  const sender={tab:{id:17,url:'https://chatgpt.com/c/a'},url:'https://chatgpt.com/c/a'};
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/a'},sender);
  await listeners.external({type:'chat-queue-signal/v1',tabId:17,signal:{
    version:1,route:'/c/a',documentToken:'a'.repeat(32),
    epoch:0,sequence:1,phase:'idle',origin:'fresh',confidence:'observed'
  }},provider);
  const check={type:'chat-queue-internal/v1',action:'dispatch-check',route:'/c/a',
    documentToken:'a'.repeat(32),epoch:0,sequence:1};
  assert.equal((await listeners.internal(check,sender)).ok,true);
  // Re-registration invalidates previous authority; the old epoch is unusable.
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/a'},sender)).ok,true);
  assert.equal((await listeners.internal(check,sender)).error,'signal-authority-lost');
});
