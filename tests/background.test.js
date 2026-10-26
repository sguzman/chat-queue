const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync(require.resolve('../src/background.js'),'utf8');
const signals=fs.readFileSync(require.resolve('../src/signal.js'),'utf8');
const grants=fs.readFileSync(require.resolve('../src/grants.js'),'utf8');
const rules=fs.readFileSync(require.resolve('../src/rules.js'),'utf8');
function create(persisted={}) {
  const listeners={};
  const forwards=[];
  const syncRequests=[];
  const liveUrls=new Map();
  const state={'chatqueue:api-grants:v2':{version:2,grants:{
    'approved@example.test':['discover','read','append','edit','control'],
    'observer@example.test':['discover'],
    'poster@example.test':['append'],
    'sandbox@example.test':['rules']}}};
  const browser={
    runtime:{sendMessage:(recipient,message)=>{syncRequests.push({recipient,message});return Promise.resolve({queued:true});},
      onMessage:{addListener:fn=>listeners.internal=(message,sender)=>{
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
    storage:{local:{get:async()=>state,set:async changes=>{Object.assign(state,changes);},remove:async key=>{delete state[key];}},onChanged:{addListener:fn=>listeners.changed=fn}}
  };
  Object.assign(state,persisted);
  const context=vm.createContext({browser,URL});
  vm.runInContext(signals,context);
  vm.runInContext(grants,context);
  vm.runInContext(rules,context);
  vm.runInContext(src,context);
  return {listeners,forwards,syncRequests,state,context};
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
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'generating',size:2,running:true,sequence:1},sender);
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
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'generating',size:3,running:true,awaiting:true,leasePending:true,revision:5,sequence:1},syntheticTab);
  await new Promise(resolve=>setImmediate(resolve));
  const change=seen.find(x=>x.event==='stateChanged');
  assert.equal(change?.protocolVersion,1);
  assert.equal(change?.state?.size,3);
  assert.equal(change?.state?.phase,'generating');
  assert.equal('items' in change?.state,false);
  assert.equal('history' in change?.state,false);
  assert.equal('leasePending' in change?.state,false,
    'private cross-tab ownership must not appear in discovery subscription metadata');
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
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'finished',sequence:1},old)).error,'route-mismatch');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route:'/c/old'},old)).ok,true);
  listeners.updated(91,{url:'https://chatgpt.com/c/new'});
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'finished',sequence:1},old)).error,'route-mismatch');
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
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',phase:'unknown',sequence:1},second)).ok,true);
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

test('silent persisted revocation prevents delayed external commands from reaching tabs',async()=>{
  const cases=[
    {id:'approved@example.test',action:'start',revoked:['discover','append','edit']},
    {id:'approved@example.test',action:'resolve',payload:{id:'uncertain',decision:'discard'},
      revoked:['discover','read','control']},
    {id:'poster@example.test',action:'enqueue',payload:{text:'synthetic harmless prompt'},
      revoked:[]}
  ];
  for(const fixture of cases){
    const {listeners,state,context,forwards}=create();
    const url='https://chatgpt.com/c/revoked-mutation';
    const tab={tab:{id:93,url},url};
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
      action:'register',route:'/c/revoked-mutation'},tab)).ok,true);
    const original=context.browser.storage.local.get;
    const oldPolicy=state['chatqueue:api-grants:v2'];
    let release,reads=0;
    context.browser.storage.local.get=key=>{
      if(key==='chatqueue:api-grants:v2'&&++reads===1)
        return new Promise(resolve=>{release=()=>resolve({'chatqueue:api-grants:v2':oldPolicy});});
      return original(key);
    };
    const pending=listeners.external({type:'chat-queue/v1',
      action:fixture.action,tabId:93,payload:fixture.payload},{id:fixture.id});
    assert.equal(typeof release,'function');
    state['chatqueue:api-grants:v2']={version:2,
      grants:{[fixture.id]:fixture.revoked}};
    // Durable ACL is already revoked; no storage.onChanged notification yet.
    release();
    const answer=await pending;
    assert.equal(answer.error,'authorization-changed',fixture.action);
    assert.equal(reads,2,'a second stored ACL read is mandatory before a mutation');
    assert.equal(forwards.length,0,
      fixture.action+' must not reach a tab after durable revocation');
  }
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

test('delayed private status cannot disclose prior conversation after tab navigation',async()=>{
  for(const returnToOriginal of [false,true]){
    const {listeners,context}=create();
    const original='https://chatgpt.com/c/private-before-navigation';
    const other='https://chatgpt.com/c/private-after-navigation';
    const sender={tab:{id:97,url:original},url:original};
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
      action:'register',route:'/c/private-before-navigation'},sender)).ok,true);
    let release;
    context.browser.tabs.sendMessage=(_id,message)=>
      message?.type==='chat-queue-api/v1'
        ?new Promise(resolve=>{release=resolve;})
        :Promise.resolve({ok:true});
    const pending=listeners.external({type:'chat-queue/v1',action:'status',tabId:97},
      {id:'approved@example.test'});
    for(let i=0;i<8&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof release,'function');
    listeners.updated(97,{url:other});
    if(returnToOriginal){
      listeners.updated(97,{url:original});
      assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
        action:'register',route:'/c/private-before-navigation'},sender)).ok,true);
    }
    release({ok:true,items:[{id:'sensitive',text:'synthetic old-conversation prompt'}]});
    const reply=await pending;
    assert.equal(reply.error,'route-or-registration-changed',
      returnToOriginal?'A-B-A must not revive old document status':'route B must invalidate A status');
    assert.equal(JSON.stringify(reply).includes('synthetic old-conversation prompt'),false);
  }
});

test('private status is withheld if live URL changes before late tab update notification',async()=>{
  const {listeners,context}=create();
  const oldUrl='https://chatgpt.com/c/a-live-url',other='https://chatgpt.com/c/b-live-url';
  const sender={tab:{id:98,url:oldUrl},url:oldUrl};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/a-live-url'},sender)).ok,true);
  let release;
  context.browser.tabs.sendMessage=()=>new Promise(resolve=>{release=resolve;});
  const pending=listeners.external({type:'chat-queue/v1',action:'status',tabId:98},
    {id:'approved@example.test'});
  for(let i=0;i<8&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  // Browser URL changed, but tab update has not run the Queue listener yet.
  context.browser.tabs.get=async()=>({id:98,url:other});
  release({ok:true,items:[{id:'sensitive',text:'synthetic stale private content'}]});
  const reply=await pending;
  assert.equal(reply.error,'route-or-registration-changed');
  assert.equal(JSON.stringify(reply).includes('synthetic stale private content'),false);
});

test('private status rejects same-path cross-origin navigation before tabs.onUpdated',async()=>{
  const {listeners,context}=create();
  const url='https://chatgpt.com/c/private-cross-origin';
  const sender={tab:{id:108,url},url};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/private-cross-origin'},sender)).ok,true);
  let release;
  context.browser.tabs.sendMessage=()=>new Promise(resolve=>{release=resolve;});
  const pending=listeners.external({type:'chat-queue/v1',action:'status',tabId:108},
    {id:'approved@example.test'});
  for(let i=0;i<8&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  context.browser.tabs.get=async()=>({id:108,
    url:'https://example.test/c/private-cross-origin'});
  release({ok:true,items:[{id:'secret',text:'synthetic private cross-origin payload'}]});
  const answer=await pending;
  assert.equal(answer.error,'route-or-registration-changed');
  assert.equal(JSON.stringify(answer).includes('synthetic private cross-origin payload'),false);
});

test('private status refuses navigation during final async stored-grant recheck',async()=>{
  for(const urlAfter of [
    'https://chatgpt.com/c/other-conversation',
    'https://example.test/c/private-last-check'
  ]){
    const {listeners,context}=create();
    const url='https://chatgpt.com/c/private-last-check';
    const sender={tab:{id:109,url},url};
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
      action:'register',route:'/c/private-last-check'},sender)).ok,true);
    const originalGrantRead=context.browser.storage.local.get;
    let releaseGrant,readCount=0,liveUrl=url,tabReads=0;
    context.browser.tabs.get=async()=>({id:109,url:(tabReads++,liveUrl)});
    context.browser.storage.local.get=key=>{
      if(key==='chatqueue:api-grants:v2'&&++readCount===3)
        return new Promise(resolve=>{releaseGrant=()=>{
          resolve(originalGrantRead(key));
        };});
      return originalGrantRead(key);
    };
    context.browser.tabs.sendMessage=async()=>({
      ok:true,items:[{id:'secret',text:'synthetic private final-recheck payload'}]});
    const pending=listeners.external({type:'chat-queue/v1',action:'status',tabId:109},
      {id:'approved@example.test'});
    for(let i=0;i<12&&!releaseGrant;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof releaseGrant,'function',
      'Pause the last stored ACL read after the earlier live tab URL check');
    assert.equal(tabReads,1,'First browser-owned URL check must precede final grant read');
    liveUrl=urlAfter; // No tab-update listener notification yet.
    releaseGrant();
    const answer=await pending;
    assert.equal(answer.error,'route-or-registration-changed',
      'A new route or origin must invalidate an otherwise authorized private response');
    assert.equal(tabReads,2,'Disclosure requires a second browser URL lookup');
    assert.equal(JSON.stringify(answer).includes('synthetic private final-recheck payload'),false);
  }
});

test('private status rechecks stored read grant even before revocation event arrives',async()=>{
  const {listeners,state,context}=create();
  const url='https://chatgpt.com/c/quiet-revocation';
  const page={tab:{id:84,url},url};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/quiet-revocation'},page)).ok,true);
  let release;
  context.browser.tabs.sendMessage=()=>new Promise(resolve=>{release=resolve;});
  const pending=listeners.external({type:'chat-queue/v1',action:'status',tabId:84},
    {id:'approved@example.test'});
  for(let i=0;i<8&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  // The durable storage policy changes, but Firefox's onChanged notification
  // has deliberately NOT arrived. A volatile revision-only check would leak.
  state['chatqueue:api-grants:v2']={version:2,grants:{
    'approved@example.test':['discover','append']}};
  release({ok:true,items:[{id:'synthetic',text:'synthetic private fixture'}]});
  const answer=await pending;
  assert.equal(answer.error,'authorization-changed');
  assert.equal(JSON.stringify(answer).includes('synthetic private fixture'),false);
});

test('private status fails closed when final authorization storage read fails',async()=>{
  const {listeners,context}=create();
  const url='https://chatgpt.com/c/recheck-error';
  const page={tab:{id:85,url},url};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/recheck-error'},page)).ok,true);
  const original=context.browser.storage.local.get;
  let reads=0;
  context.browser.storage.local.get=async (...args)=>{
    reads++;
    if(reads===2)throw new Error('synthetic permission storage failure');
    return original(...args);
  };
  context.browser.tabs.sendMessage=async()=>({
    ok:true,items:[{id:'synthetic',text:'synthetic hidden status'}]});
  const answer=await listeners.external({type:'chat-queue/v1',action:'status',tabId:85},
    {id:'approved@example.test'});
  assert.equal(reads,2);
  assert.equal(answer.error,'authorization-changed');
  assert.equal(JSON.stringify(answer).includes('synthetic hidden status'),false);
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

test('state subscriptions suppress delayed metadata after silent durable Discover revoke',async()=>{
  const {listeners,state,context}=create();
  const received=[];let disconnected=0;
  const port={name:'chat-queue/v1',sender:{id:'observer@example.test'},
    onDisconnect:{addListener:()=>{}},
    postMessage:message=>received.push(message),
    disconnect:()=>disconnected++};
  listeners.connect(port);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received[0]?.event,'ready');
  const url='https://chatgpt.com/c/private-notify';
  const page={tab:{id:86,url},url};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/private-notify'},page)).ok,true);
  const original=context.browser.storage.local.get;
  const prior=state['chatqueue:api-grants:v2'];
  let resume,reads=0;
  context.browser.storage.local.get=key=>{
    if(key==='chatqueue:api-grants:v2'&&++reads===1)
      return new Promise(resolve=>{resume=()=>resolve({'chatqueue:api-grants:v2':prior});});
    return original(key);
  };
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    sequence:1,phase:'generating',running:true},page);
  assert.equal(typeof resume,'function');
  // Revocation committed but storage.onChanged has not yet been delivered.
  state['chatqueue:api-grants:v2']={version:2,grants:{
    'approved@example.test':['discover']}};
  resume();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,2);
  assert.equal(received.filter(x=>x.event==='stateChanged').length,0,
    'revoked peer must not receive subscribed private-tab state metadata');
  assert.equal(disconnected,1);
});

test('state subscriptions never publish superseded out-of-order snapshots',async()=>{
  const {listeners,context}=create();
  const received=[];
  listeners.connect({name:'chat-queue/v1',sender:{id:'observer@example.test'},
    onDisconnect:{addListener:()=>{}},
    postMessage:message=>received.push(message),
    disconnect:()=>{}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received[0]?.event,'ready');
  const url='https://chatgpt.com/c/ordered-notify';
  const page={tab:{id:87,url},url};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/ordered-notify'},page)).ok,true);
  const original=context.browser.storage.local.get;
  let releaseOld,reads=0;
  context.browser.storage.local.get=key=>{
    if(key==='chatqueue:api-grants:v2'&&++reads===1)
      return new Promise(resolve=>{releaseOld=()=>resolve(original(key));});
    return original(key);
  };
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    sequence:1,phase:'generating',running:true},page);
  assert.equal(typeof releaseOld,'function');
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    sequence:2,phase:'finished',running:false},page);
  await new Promise(resolve=>setImmediate(resolve));
  releaseOld();
  await new Promise(resolve=>setImmediate(resolve));
  const changes=received.filter(x=>x.event==='stateChanged');
  assert.equal(changes.length,1);
  assert.equal(changes[0].state.phase,'finished',
    'late older publication cannot revert newer subscriber state');
});

test('silent Discover revocation blocks delayed listTabs and capabilities responses',async()=>{
  for(const action of ['listTabs','capabilities']){
    const {listeners,state,context}=create();
    const url='https://chatgpt.com/c/private-discovery';
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
      action:'register',route:'/c/private-discovery'},
      {tab:{id:89,url},url})).ok,true);
    const original=context.browser.storage.local.get;
    const oldPolicy=state['chatqueue:api-grants:v2'];
    let resume,reads=0;
    context.browser.storage.local.get=key=>{
      if(key==='chatqueue:api-grants:v2'&&++reads===1)
        return new Promise(resolve=>{resume=()=>resolve({'chatqueue:api-grants:v2':oldPolicy});});
      return original(key);
    };
    const pending=listeners.external({type:'chat-queue/v1',action},
      {id:'approved@example.test'});
    assert.equal(typeof resume,'function');
    // Persisted change is deliberately not delivered via storage.onChanged.
    state['chatqueue:api-grants:v2']={version:2,grants:{
      'approved@example.test':['append']}};
    resume();
    const result=await pending;
    assert.equal(reads,2,action+' must re-read its durable grant');
    assert.equal(JSON.stringify(result).includes('private-discovery'),false);
    if(action==='listTabs'){
      assert.equal(result.error,'authorization-changed');
      assert.equal(Object.hasOwn(result,'tabs'),false);
    }else{
      // Capabilities are still available to an Append-only peer, but may
      // never echo the earlier, now revoked Discover/Read/Control scopes.
      assert.equal(result.ok,true);
      assert.deepEqual(Array.from(result.scopes),['append']);
    }
  }
});

test('silent durable Discover revocation denies delayed event-port ready metadata',async()=>{
  const {listeners,state,context}=create();
  const url='https://chatgpt.com/c/private-port';
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/private-port'},
    {tab:{id:88,url},url})).ok,true);
  const original=context.browser.storage.local.get;
  const oldPolicy=state['chatqueue:api-grants:v2'];
  let resume;let reads=0;
  context.browser.storage.local.get=key=>{
    if(key==='chatqueue:api-grants:v2'&&++reads===1)
      return new Promise(resolve=>{resume=()=>resolve({'chatqueue:api-grants:v2':oldPolicy});});
    return original(key);
  };
  const seen=[];let disconnected=0;
  const port={name:'chat-queue/v1',sender:{id:'observer@example.test'},
    onDisconnect:{addListener:()=>{}},
    postMessage:message=>seen.push(message),
    disconnect:()=>disconnected++};
  listeners.connect(port);
  assert.equal(typeof resume,'function');
  // The first read's result was valid at its own snapshot, but the policy
  // changed durably before its promise resolved. No onChanged event fired.
  state['chatqueue:api-grants:v2']={version:2,grants:{
    'approved@example.test':['discover']}};
  resume();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,2);
  assert.equal(disconnected,1);
  assert.deepEqual(seen,[],
    'a revoked peer cannot see even registered tab metadata via ready');
});

test('a Send hold contains metadata only and survives event-page restart',async()=>{
  const first=create();
  const route='/c/durable-proof',url='https://chatgpt.com'+route;
  const tab={tab:{id:194,url},url};
  const provider={id:'chat-signals@sguzman.github'};
  const signal={version:1,route,documentToken:'a'.repeat(32),
    sequence:1,epoch:2,phase:'idle',origin:'fresh',confidence:'observed'};
  assert.equal((await first.listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route},tab)).ok,true);
  assert.equal((await first.listeners.external({type:'chat-queue-signal/v1',
    tabId:194,signal},provider)).ok,true);
  const holdId='234f1c6a-1111-4444-bbbb-333333333333';
  const check=stage=>first.listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route,documentToken:signal.documentToken,
    epoch:2,sequence:1,stage,holdId},tab);
  assert.equal((await check('probe')).ok,true);
  assert.equal((await check('reserve')).ok,true);
  assert.equal((await check('sealed')).ok,true);
  assert.equal((await first.listeners.internal({type:'chat-queue-internal/v1',
    action:'review-send-hold',route,confirmed:true,holdId},tab)).error,'active-send-hold',
    'explicit review cannot clear another active dispatch owner');
  const key='chatqueue:send-hold:v1:durable-proof';
  assert.deepEqual(Object.keys(first.state[key]).sort(),
    ['holdId','route','tabId','version']);
  assert.equal(first.state[key].holdId,holdId);
  const restarted=create({[key]:{...first.state[key]}});
  const alias='/g/project/c/durable-proof',aliasUrl='https://chatgpt.com'+alias;
  const peer={tab:{id:195,url:aliasUrl},url:aliasUrl};
  await restarted.listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:alias},peer);
  await restarted.listeners.external({type:'chat-queue-signal/v1',tabId:195,
    signal:{...signal,route:alias,documentToken:'b'.repeat(32)}},provider);
  const peerCheck=()=>restarted.listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route:alias,documentToken:'b'.repeat(32),
    sequence:1,epoch:2},peer);
  assert.equal((await peerCheck()).error,'unresolved-durable-send');
  const initial=await restarted.listeners.internal({type:'chat-queue-internal/v1',
    action:'send-hold-status',route:alias},peer);
  assert.equal(initial.ok,true);
  assert.equal(initial.holdId,holdId);
  assert.equal((await restarted.listeners.internal({type:'chat-queue-internal/v1',
    action:'review-send-hold',route:alias,holdId},peer)).error,'active-send-hold');
  // If another tab reserves a NEW hold between the two human clicks,
  // stale consent cannot silently release that different potential Send.
  const replacementId='334f1c6a-1111-4444-bbbb-333333333333';
  restarted.state[key]={...restarted.state[key],holdId:replacementId};
  assert.equal((await restarted.listeners.internal({type:'chat-queue-internal/v1',
    action:'review-send-hold',route:alias,confirmed:true,holdId},peer)).error,
    'send-hold-changed');
  assert.equal(restarted.state[key].holdId,replacementId);
  assert.equal((await peerCheck()).error,'unresolved-durable-send');
  assert.equal((await restarted.listeners.internal({type:'chat-queue-internal/v1',
    action:'review-send-hold',route:alias,confirmed:true,holdId:replacementId},peer)).ok,true);
  assert.equal(Object.hasOwn(restarted.state,key),false);
  assert.equal((await peerCheck()).ok,true);
});

test('same-tab document reload permits reviewed retired hold but not live owner',async()=>{
  const {listeners,state}=create();
  const route='/c/rebound-owner',url='https://chatgpt.com'+route;
  const first={tab:{id:202,url},url};
  const peer={tab:{id:203,url},url};
  const provider={id:'chat-signals@sguzman.github'};
  const token='12345678-aaaa-4444-bbbb-555555555555';
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route},first);
  await listeners.external({type:'chat-queue-signal/v1',tabId:202,
    signal:{version:1,route,documentToken:'a'.repeat(32),epoch:1,sequence:1,
      phase:'idle',origin:'fresh',confidence:'observed'}},provider);
  const check=stage=>listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route,documentToken:'a'.repeat(32),epoch:1,
    sequence:1,stage,holdId:token},first);
  assert.equal((await check('probe')).ok,true);
  assert.equal((await check('reserve')).ok,true);
  assert.equal((await check('sealed')).ok,true);
  const key='chatqueue:send-hold:v1:rebound-owner';
  const review=sender=>listeners.internal({type:'chat-queue-internal/v1',
    action:'review-send-hold',route,confirmed:true,holdId:token},sender);
  assert.equal((await review(first)).error,'active-send-hold',
    'the currently registered active owner may not release itself by review');
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route},peer);
  assert.equal((await review(peer)).error,'active-send-hold',
    'another tab must not use retired-owner review while that owner is live');
  // Same Firefox tab re-registers after a content-document reload. The old
  // volatile owner is retained for Send arbitration, but is not current.
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route},first)).ok,true);
  assert.equal((await review(peer)).error,'active-send-hold',
    'a different tab cannot override the old tab while it still exists');
  const old=await listeners.internal({type:'chat-queue-internal/v1',
    action:'send-hold-status',route},first);
  assert.equal(old.holdId,token);
  assert.equal((await review(first)).ok,true,
    'local double-confirmed review can release its own retired registration');
  assert.equal(Object.hasOwn(state,key),false);
  assert.equal((await check('probe')).error,'signal-authority-lost',
    'review does not restore provider authority for any new Send');
});

test('failed durable hold storage never permits the final Send preflight',async()=>{
  const {listeners,context}=create();
  const route='/c/hold-failure',url='https://chatgpt.com'+route;
  const tab={tab:{id:196,url},url},provider={id:'chat-signals@sguzman.github'};
  const signal={version:1,route,documentToken:'d'.repeat(32),
    sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'};
  await listeners.internal({type:'chat-queue-internal/v1',action:'register',route},tab);
  await listeners.external({type:'chat-queue-signal/v1',tabId:196,signal},provider);
  const check=stage=>listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route,documentToken:signal.documentToken,
    epoch:1,sequence:1,stage,
    holdId:'12345678-1111-4444-bbbb-333333333333'},tab);
  assert.equal((await check('probe')).ok,true);
  const original=context.browser.storage.local.set;
  context.browser.storage.local.set=async()=>{throw Error('synthetic failure');};
  assert.equal((await check('reserve')).error,'send-hold-storage-unavailable');
  assert.equal((await check('sealed')).error,'durable-send-hold-missing');
  context.browser.storage.local.set=original;
  assert.equal((await check('reserve')).ok,true);
  assert.equal((await check('sealed')).ok,true);
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
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',running:false,awaiting:false,
    leasePending:true,size:1,phase:'idle',sequence:1},senders[winner]);
  assert.equal((await check(loser)).error,'conversation-owned-by-another-tab',
    'a paused unresolved attempt must keep its route ownership');
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',running:false,awaiting:true,size:1,phase:'verifying',sequence:2},senders[winner]);
  assert.equal((await check(loser)).error,'conversation-owned-by-another-tab',
    'pausing while a response is in flight must not unlock the route');
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',running:false,awaiting:false,size:1,phase:'finished',sequence:3},senders[winner]);
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

test('same-route re-registration retains an unresolved cross-tab Send lease',async()=>{
  const {listeners}=create(),provider={id:'chat-signals@sguzman.github'};
  const url='https://chatgpt.com/c/renewed-lease';
  const first={tab:{id:71,url},url},second={tab:{id:72,url},url};
  const register={type:'chat-queue-internal/v1',action:'register',route:'/c/renewed-lease'};
  for(const tab of [first,second]){
    assert.equal((await listeners.internal(register,tab)).ok,true);
    assert.equal((await listeners.external({
      type:'chat-queue-signal/v1',tabId:tab.tab.id,
      signal:{version:1,route:'/c/renewed-lease',
        documentToken:(tab.tab.id===71?'a':'b').repeat(32),
        sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'}
    },provider)).ok,true);
  }
  const check=tab=>listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route:'/c/renewed-lease',
    documentToken:(tab.tab.id===71?'a':'b').repeat(32),
    sequence:1,epoch:1},tab);
  assert.equal((await check(first)).ok,true);
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'state',phase:'idle',running:false,awaiting:false,
    leasePending:true,sequence:1},first)).ok,true);
  assert.equal((await check(second)).error,'conversation-owned-by-another-tab');
  // A same-path re-registration invalidates the owner's prior provider
  // registration, but MUST NOT grant its unresolved click to the peer.
  assert.equal((await listeners.internal(register,first)).ok,true);
  assert.equal((await check(first)).error,'signal-authority-lost');
  assert.equal((await check(second)).error,'conversation-owned-by-another-tab',
    'same-route rebind must not open a cross-tab duplicate Send window');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'state',phase:'unknown',running:false,awaiting:false,
    leasePending:true,sequence:1},first)).ok,true);
  assert.equal((await check(second)).error,'conversation-owned-by-another-tab');
  // Only the owner's later explicit clear-state publication can relinquish
  // this conservative volatile lease. The peer still needs its own authority.
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'state',phase:'idle',running:false,awaiting:false,
    leasePending:false,sequence:2},first)).ok,true);
  assert.equal((await check(second)).ok,true);
});

test('project-route alias navigation preserves unresolved conversation ownership',async()=>{
  const {listeners}=create(),provider={id:'chat-signals@sguzman.github'};
  const oldUrl='https://chatgpt.com/c/alias-lease',projectUrl='https://chatgpt.com/g/p/c/alias-lease';
  const owner={tab:{id:73,url:oldUrl},url:oldUrl};
  const peer={tab:{id:74,url:oldUrl},url:oldUrl};
  const register=(tab,route)=>listeners.internal({type:'chat-queue-internal/v1',action:'register',route},tab);
  const signal=(tab,route,token)=>listeners.external({type:'chat-queue-signal/v1',
    tabId:tab.tab.id,signal:{version:1,route,documentToken:token.repeat(32),
      sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'}},provider);
  const check=(tab,route,token)=>listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route,documentToken:token.repeat(32),epoch:1,sequence:1},tab);
  assert.equal((await register(owner,'/c/alias-lease')).ok,true);
  assert.equal((await register(peer,'/c/alias-lease')).ok,true);
  assert.equal((await signal(owner,'/c/alias-lease','a')).ok,true);
  assert.equal((await signal(peer,'/c/alias-lease','b')).ok,true);
  assert.equal((await check(owner,'/c/alias-lease','a')).ok,true);
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    running:false,awaiting:false,leasePending:true,sequence:1},owner)).ok,true);
  assert.equal((await check(peer,'/c/alias-lease','b')).error,'conversation-owned-by-another-tab');
  // A browser-owned URL update clears the old provider registration but
  // must preserve the still-uncertain Send lease through its project alias.
  listeners.updated(73,{url:projectUrl});
  assert.equal((await check(peer,'/c/alias-lease','b')).error,'conversation-owned-by-another-tab',
    'route invalidation cannot free an unresolved alias Send');
  const projectSender={tab:{id:73,url:projectUrl},url:oldUrl};
  assert.equal((await register(projectSender,'/g/p/c/alias-lease')).ok,true);
  assert.equal((await check(peer,'/c/alias-lease','b')).error,'conversation-owned-by-another-tab',
    're-registration across aliases cannot free an unresolved Send');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    running:false,awaiting:false,leasePending:true,sequence:1},projectSender)).ok,true);
  assert.equal((await check(peer,'/c/alias-lease','b')).error,'conversation-owned-by-another-tab');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    running:false,awaiting:false,leasePending:false,sequence:2},projectSender)).ok,true);
  assert.equal((await check(peer,'/c/alias-lease','b')).ok,true,
    'an explicitly clear owner state can release the shared identity lease');
  // A different conversation must never inherit this prior owner.
  listeners.updated(74,{url:'https://chatgpt.com/c/completely-different'});
  assert.equal((await register(owner,'/g/p/c/alias-lease')).ok,true);
  assert.equal((await signal(projectSender,'/g/p/c/alias-lease','c')).ok,true);
  assert.equal((await check(projectSender,'/g/p/c/alias-lease','c')).ok,true);
  const third={tab:{id:75,url:oldUrl},url:oldUrl};
  assert.equal((await register(third,'/c/alias-lease')).ok,true);
  assert.equal((await signal(third,'/c/alias-lease','d')).ok,true);
  // Invalidate the owner again without completing its new registration.
  // Closing such a tab must release its lease, even with ROUTES absent.
  listeners.updated(73,{url:oldUrl});
  assert.equal((await check(third,'/c/alias-lease','d')).error,'conversation-owned-by-another-tab');
  listeners.removed(73);
  assert.equal((await check(third,'/c/alias-lease','d')).ok,true,
    'tab closure must clear retained lease even when the registry is absent');
});

test('rule-library reads reject durable revocation before its event notification',async()=>{
  const {listeners,state,context}=create();
  const client='sandbox@example.test';
  const key='chatqueue:external-rules:v1:'+client;
  state[key]={version:1,revision:1,rules:[{version:1,id:'private-fixture',
    enabled:true,priority:10,when:{phase:'failed'},then:{type:'pause'}}]};
  const original=context.browser.storage.local.get;
  let resume;
  context.browser.storage.local.get=(requested)=>{
    if(requested===key)return new Promise(resolve=>{resume=()=>resolve(original(requested));});
    return original(requested);
  };
  const pending=listeners.external({type:'chat-queue/v1',action:'rulesGet'}, {id:client});
  for(let i=0;i<8&&!resume;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof resume,'function');
  state['chatqueue:api-grants:v2']={version:2,grants:{[client]:['discover']}};
  // No storage.onChanged notification: the saved grant is already revoked.
  resume();
  const reply=await pending;
  assert.equal(reply.error,'authorization-changed');
  assert.equal(JSON.stringify(reply).includes('private-fixture'),false);
});

test('external rule writes reject silent durable grant revocation before persistence',async()=>{
  const {listeners,state,context}=create();
  const client='sandbox@example.test';
  const key='chatqueue:external-rules:v1:'+client;
  const originalGet=context.browser.storage.local.get;
  let resume;
  context.browser.storage.local.get=requested=>{
    if(requested===key)return new Promise(resolve=>{
      resume=()=>resolve(originalGet(requested));
    });
    return originalGet(requested);
  };
  const rule={id:'private-write',version:1,enabled:true,priority:1,
    when:{phase:'failed'},then:{type:'pause'}};
  const frame=vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify({
    type:'chat-queue/v1',action:'rulesPut',
    payload:{revision:0,rules:[rule]}
  }))+')',context);
  const ongoing=listeners.external(frame,{id:client});
  for(let i=0;i<12&&!resume;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof resume,'function');
  // The durable policy changed, but the event notification has not fired.
  state['chatqueue:api-grants:v2']={version:2,
    grants:{[client]:['discover']}};
  resume();
  const result=await ongoing;
  assert.equal(result.error,'authorization-changed');
  assert.equal(Object.hasOwn(state,key),false,
    'a delayed stale-grant writer must not overwrite durable rule storage');
});

test('rules-scoped per-client libraries are revisioned, durable and concurrent-writer safe',async()=>{
  const {listeners,state,forwards,context}=create();
  // Firefox structured-clones peer messages into the recipient realm. Pass
  // parsed receiver-realm objects through the VM like the preview API tests.
  const inReceiver=value=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(value))+')',context);
  const sender={id:'sandbox@example.test'};
  const request=(action,payload)=>listeners.external(
    inReceiver({type:'chat-queue/v1',action,payload}),sender);
  const initial=await request('rulesGet');
  assert.equal(initial.ok,true);assert.equal(initial.revision,0);
  assert.equal(initial.rules.length,0);
  const rule={version:1,id:'review',enabled:true,priority:80,
    when:{phase:'failed'},then:{type:'propose',text:'Synthetic private rule proposal'}};
  const first=await request('rulesPut',{revision:0,rules:[rule]});
  assert.equal(first.ok,true);assert.equal(first.revision,1);
  assert.equal((await request('rulesPut',{revision:0,rules:[]})).error,'rule-revision-conflict');
  assert.equal((await request('rulesPut',{revision:-1,rules:[]})).error,'invalid-rule-write');
  const stored=await request('rulesGet');
  assert.equal(stored.ok,true);assert.equal(stored.revision,1);
  assert.equal(stored.rules[0].id,'review');
  assert.equal(stored.rules[0].then.text,rule.then.text);
  assert.equal(forwards.length,0,'Rules CRUD cannot reach ChatGPT tabs');
  const racer=await Promise.all([
    request('rulesPut',{revision:1,rules:[{...rule,priority:99}]}),
    request('rulesPut',{revision:1,rules:[{...rule,priority:100}]})
  ]);
  assert.equal(racer.filter(x=>x.ok).length,1);
  assert.equal(racer.filter(x=>x.error==='rule-revision-conflict').length,1);
  const fresh=await request('rulesGet');
  assert.equal(fresh.revision,2);
  assert.ok([99,100].includes(fresh.rules[0].priority));
  assert.equal((await request('rulesPut',{revision:2,rules:[]})).ok,true);
  assert.equal((await request('rulesGet')).revision,3);
  const key='chatqueue:external-rules:v1:'+sender.id;
  state[key]={version:2,revision:100,rules:[]};
  assert.equal((await request('rulesGet')).error,'unsupported-rule-record');
  assert.equal((await request('rulesPut',{revision:100,rules:[]})).error,'unsupported-rule-record');
  assert.equal(state[key].version,2,'Unknown future library must never be replaced');
  const unrelated=await listeners.external({type:'chat-queue/v1',action:'rulesGet'},
    {id:'poster@example.test'});
  assert.equal(unrelated.error,'forbidden-scope');
  assert.equal(forwards.length,0);
});

test('out-of-order rulesChanged callbacks never deliver an older revision last',async()=>{
  const {listeners,state,context}=create();
  const peer='sandbox@example.test',acl='chatqueue:api-grants:v2';
  const record='chatqueue:external-rules:v1:'+peer;
  state[acl]={version:2,grants:{[peer]:['discover','rules']}};
  const received=[];
  listeners.connect({name:'chat-queue/v1',sender:{id:peer},
    onDisconnect:{addListener:()=>{}},
    postMessage:message=>received.push(message),disconnect:()=>{}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received[0]?.event,'ready');
  const realGet=context.browser.storage.local.get;
  const realSet=context.browser.storage.local.set;
  let writes=0,resumeOld;
  context.browser.storage.local.set=async changes=>{
    await realSet(changes);
    if(Object.hasOwn(changes,record))writes++;
  };
  context.browser.storage.local.get=key=>{
    if(key===acl&&writes===1&&!resumeOld)
      return new Promise(resolve=>{resumeOld=()=>resolve(realGet(key));});
    return realGet(key);
  };
  const rule={id:'ordered-notice',version:1,enabled:true,priority:1,
    when:{phase:'failed'},then:{type:'pause'}};
  const inReceiver=value=>vm.runInContext(
    'JSON.parse('+JSON.stringify(JSON.stringify(value))+')',context);
  const put=revision=>listeners.external(inReceiver({type:'chat-queue/v1',
    action:'rulesPut',payload:{revision,rules:[rule]}}),{id:peer});
  assert.equal((await put(0)).revision,1);
  assert.equal(typeof resumeOld,'function');
  assert.equal((await put(1)).revision,2);
  await new Promise(resolve=>setImmediate(resolve));
  resumeOld();
  await new Promise(resolve=>setImmediate(resolve));
  const notifications=received.filter(message=>message.event==='rulesChanged');
  assert.deepEqual(notifications.map(message=>message.revision),[2],
    'the newer revision supersedes an older deferred notification');
});

test('silent rules-scope revocation stops a delayed rulesChanged notification',async()=>{
  const {listeners,state,context}=create();
  const peer='sandbox@example.test';
  const acl='chatqueue:api-grants:v2';
  const ruleKey='chatqueue:external-rules:v1:'+peer;
  state[acl]={version:2,grants:{[peer]:['discover','rules']}};
  const received=[];
  listeners.connect({name:'chat-queue/v1',sender:{id:peer},
    onDisconnect:{addListener:()=>{}},
    postMessage:message=>received.push(message),
    disconnect:()=>{}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received[0]?.event,'ready');
  const oldPolicy=state[acl];
  const originalSet=context.browser.storage.local.set;
  const originalGet=context.browser.storage.local.get;
  let intercept=false,resume;
  context.browser.storage.local.set=async changes=>{
    await originalSet(changes);
    if(Object.hasOwn(changes,ruleKey))intercept=true;
  };
  context.browser.storage.local.get=key=>{
    if(key===acl&&intercept){
      intercept=false;
      return new Promise(resolve=>{
        resume=()=>resolve({[acl]:oldPolicy});
      });
    }
    return originalGet(key);
  };
  const rule={id:'silent-rule',version:1,enabled:true,priority:1,
    when:{phase:'failed'},then:{type:'pause'}};
  const frame=vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify({
    type:'chat-queue/v1',action:'rulesPut',
    payload:{revision:0,rules:[rule]}
  }))+')',context);
  assert.equal((await listeners.external(frame,{id:peer})).ok,true);
  assert.equal(typeof resume,'function');
  // The storage notification has not yet fired: source snapshot is stale.
  state[acl]={version:2,grants:{[peer]:['discover']}};
  resume();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received.filter(x=>x.event==='rulesChanged').length,0,
    'revoked rules scope cannot receive even an external rule revision');
});

test('rulesChanged events stop after rules grant revocation while discover remains',async()=>{
  const {listeners,state,context,forwards}=create();
  const peer='sandbox@example.test';
  const inReceiver=value=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(value))+')',context);
  state['chatqueue:api-grants:v2']={version:2,grants:{[peer]:['discover','rules']}};
  const received=[];let disconnected=0;
  listeners.connect({name:'chat-queue/v1',sender:{id:peer},
    onDisconnect:{addListener:()=>{}},
    postMessage:event=>received.push(event),
    disconnect:()=>disconnected++});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received[0]?.event,'ready');
  const sample={id:'rule-a',version:1,enabled:true,priority:7,
    when:{phase:'failed'},then:{type:'pause'}};
  const put=revision=>listeners.external(inReceiver({type:'chat-queue/v1',
    action:'rulesPut',payload:{revision,rules:[sample]}}),{id:peer});
  assert.equal((await put(0)).ok,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received.filter(x=>x.event==='rulesChanged').length,1);
  const realSet=context.browser.storage.local.set;
  let finishWrite;
  context.browser.storage.local.set=changes=>new Promise(resolve=>{
    finishWrite=()=>{void realSet(changes).then(resolve);};
  });
  const ongoing=put(1);
  for(let attempts=0;attempts<12&&!finishWrite;attempts++)
    await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof finishWrite,'function');
  const before=state['chatqueue:api-grants:v2'];
  const after={version:2,grants:{[peer]:['discover']}};
  state['chatqueue:api-grants:v2']=after;
  listeners.changed({'chatqueue:api-grants:v2':{oldValue:before,newValue:after}},'local');
  finishWrite();
  // A write that was already in progress may commit, but cannot grant new
  // authority to receive rulesChanged after rules scope is revoked.
  const committed=await ongoing;
  assert.equal(committed.ok,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received.filter(x=>x.event==='rulesChanged').length,1);
  assert.equal(disconnected,0,'Discover-only subscribers remain connected');
  assert.equal((await listeners.external(inReceiver({type:'chat-queue/v1',
    action:'rulesGet'}),{id:peer})).error,'forbidden-scope');
  assert.equal((await put(2)).error,'forbidden-scope');
  assert.equal(forwards.length,0);
});

test('out-of-order metadata cannot release newer conversation dispatch ownership',async()=>{
  const {listeners,context}=create();
  const url='https://chatgpt.com/c/owner-race';
  const first={tab:{id:801,url},url};
  const second={tab:{id:802,url},url};
  for(const tab of [first,second])
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
      action:'register',route:'/c/owner-race'},tab)).ok,true);
  const provider={id:'chat-signals@sguzman.github'};
  for(const tab of [first,second]){
    const signal={version:1,route:'/c/owner-race',documentToken:'b'.repeat(32),
      sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'};
    assert.equal((await listeners.external({type:'chat-queue-signal/v1',tabId:tab.tab.id,signal},provider)).ok,true);
  }
  const check=tab=>listeners.internal({type:'chat-queue-internal/v1',
    action:'dispatch-check',route:'/c/owner-race',documentToken:'b'.repeat(32),
    epoch:1,sequence:1},tab);
  assert.equal((await check(first)).ok,true);
  const older={type:'chat-queue-internal/v1',action:'state',
    phase:'idle',size:1,running:false,awaiting:false,sequence:2};
  const newer={...older,running:true,awaiting:true,phase:'generating',sequence:3};
  const realGet=context.browser.tabs.get;
  const pending=[];
  context.browser.tabs.get=id=>new Promise(resolve=>pending.push({id,resolve}));
  const stale= listeners.internal(older,first);
  const fresh= listeners.internal(newer,first);
  assert.equal(pending.length,2);
  pending[1].resolve({id:801,url});
  assert.equal((await fresh).ok,true);
  pending[0].resolve({id:801,url});
  assert.equal((await stale).error,'stale-state');
  context.browser.tabs.get=realGet;
  const listed=await listeners.external({type:'chat-queue/v1',action:'listTabs'},
    {id:'approved@example.test'});
  const entry=listed.tabs.find(tab=>tab.tabId===801);
  assert.equal(entry.running,true);
  assert.equal(entry.awaiting,true);
  assert.equal((await check(second)).error,'conversation-owned-by-another-tab',
    'stale pause must not release the route lease');
  assert.equal((await listeners.internal({...newer,sequence:3},first)).error,'stale-state');
  assert.equal((await listeners.internal({...newer,sequence:0},first)).error,'invalid-state-sequence');
});

test('superseded async register cannot overwrite a newer same-route registration or owner',async()=>{
  const {listeners,context}=create();
  const route='/c/register-race',url='https://chatgpt.com'+route;
  const tab={tab:{id:903,url},url};
  const peer={tab:{id:904,url},url};
  const register=sender=>listeners.internal({
    type:'chat-queue-internal/v1',action:'register',route
  },sender);
  const originalGet=context.browser.tabs.get;
  const pending=[];
  context.browser.tabs.get=()=>new Promise(resolve=>pending.push(resolve));
  const stale=register(tab);
  const recent=register(tab);
  assert.equal(pending.length,2);
  pending[1]({id:903,url});
  assert.equal((await recent).ok,true);
  context.browser.tabs.get=originalGet;
  assert.equal((await register(peer)).ok,true);
  const provider={id:'chat-signals@sguzman.github'};
  const signal={version:1,route,documentToken:'d'.repeat(32),
    sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'};
  for(const sender of [tab,peer])
    assert.equal((await listeners.external({
      type:'chat-queue-signal/v1',tabId:sender.tab.id,signal
    },provider)).ok,true);
  const check=sender=>listeners.internal({
    type:'chat-queue-internal/v1',action:'dispatch-check',route,
    documentToken:'d'.repeat(32),epoch:1,sequence:1
  },sender);
  assert.equal((await check(tab)).ok,true);
  pending[0]({id:903,url});
  assert.equal((await stale).error,'stale-registration');
  assert.equal((await check(peer)).error,'conversation-owned-by-another-tab',
    'late old register must not release newer Send owner');
  assert.equal((await check(tab)).ok,true,
    'late old register must not erase newer authenticated provider');
});

test('matching SPA tab URL update keeps the newer pending registration but revokes old provider',async()=>{
  const {listeners,context}=create();
  const oldUrl='https://chatgpt.com/c/old-route';
  const nextUrl='https://chatgpt.com/c/new-route';
  const old={tab:{id:902,url:oldUrl},url:oldUrl};
  const changed={tab:{id:902,url:oldUrl},url:oldUrl};
  assert.equal((await listeners.internal({
    type:'chat-queue-internal/v1',action:'register',route:'/c/old-route'
  },old)).ok,true);
  const originalGet=context.browser.tabs.get;
  let resolveGet;
  context.browser.tabs.get=()=>new Promise(resolve=>{resolveGet=resolve;});
  const newest=listeners.internal({
    type:'chat-queue-internal/v1',action:'register',route:'/c/new-route'
  },changed);
  assert.equal(typeof resolveGet,'function');
  listeners.updated(902,{url:nextUrl});
  const listed=await listeners.external({type:'chat-queue/v1',
    action:'listTabs'},{id:'approved@example.test'});
  assert.equal(listed.tabs.length,0,'old route must be revoked immediately');
  context.browser.tabs.get=originalGet;
  resolveGet({id:902,url:nextUrl});
  assert.equal((await newest).ok,true,
    'tab notification for the new route must not cancel the matching new registration');
  const provider={id:'chat-signals@sguzman.github'};
  assert.equal((await listeners.external({
    type:'chat-queue-signal/v1',tabId:902,
    signal:{version:1,route:'/c/new-route',documentToken:'e'.repeat(32),
      sequence:1,epoch:1,phase:'idle',origin:'fresh',confidence:'observed'}
  },provider)).ok,true);
});

test('tab navigation or closure cancels an in-flight registration before it can revive',async()=>{
  for(const close of [false,true]){
    const {listeners,context}=create();
    const url='https://chatgpt.com/c/pending-register';
    const sender={tab:{id:905,url},url};
    const originalGet=context.browser.tabs.get;
    let resolveGet;
    context.browser.tabs.get=()=>new Promise(resolve=>{resolveGet=resolve;});
    const registration=listeners.internal({
      type:'chat-queue-internal/v1',action:'register',route:'/c/pending-register'
    },sender);
    assert.equal(typeof resolveGet,'function');
    if(close)listeners.removed(905);
    else {
      listeners.updated(905,{url:'https://chatgpt.com/c/elsewhere'});
      listeners.updated(905,{url});
    }
    context.browser.tabs.get=originalGet;
    resolveGet({id:905,url});
    assert.equal((await registration).error,'stale-registration',
      'returning to the same path must not resurrect an invalidated callback');
    const view=await listeners.external({type:'chat-queue/v1',
      action:'listTabs'},{id:'approved@example.test'});
    assert.equal(view.tabs.length,0);
  }
});

test('same-route re-registration invalidates old in-flight metadata generations',async()=>{
  const {listeners,context}=create();
  const url='https://chatgpt.com/c/same-route-rebind';
  const sender={tab:{id:813,url},url};
  const reg={type:'chat-queue-internal/v1',action:'register',route:'/c/same-route-rebind'};
  assert.equal((await listeners.internal(reg,sender)).ok,true);
  const originalGet=context.browser.tabs.get;
  let resumeOld;
  context.browser.tabs.get=()=>new Promise(resolve=>{resumeOld=resolve;});
  const old= listeners.internal({type:'chat-queue-internal/v1',action:'state',
    sequence:500,phase:'idle',running:false,awaiting:false},sender);
  assert.equal(typeof resumeOld,'function');
  context.browser.tabs.get=originalGet;
  assert.equal((await listeners.internal(reg,sender)).ok,true,
    'registering a fresh generation may preserve the same browser pathname');
  const peer={tab:{id:814,url},url};
  assert.equal((await listeners.internal(reg,peer)).ok,true);
  const signal={version:1,route:'/c/same-route-rebind',
    documentToken:'c'.repeat(32),sequence:1,epoch:1,
    phase:'idle',origin:'fresh',confidence:'observed'};
  const provider={id:'chat-signals@sguzman.github'};
  for(const tab of [sender,peer])
    assert.equal((await listeners.external({
      type:'chat-queue-signal/v1',tabId:tab.tab.id,signal
    },provider)).ok,true);
  const check=tab=>listeners.internal({
    type:'chat-queue-internal/v1',action:'dispatch-check',
    route:'/c/same-route-rebind',documentToken:'c'.repeat(32),
    sequence:1,epoch:1},tab);
  assert.equal((await check(sender)).ok,true);
  resumeOld({id:813,url});
  assert.equal((await old).error,'stale-state',
    'old registration callbacks must not modify the new volatile state');
  assert.equal((await check(peer)).error,'conversation-owned-by-another-tab',
    'stale callback from previous registration must not release the new owner');
  const first=await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    sequence:1,phase:'generating',running:true,awaiting:true},sender);
  assert.equal(first.ok,true,'new registration starts its own state sequence');
  const result=await listeners.external({type:'chat-queue/v1',action:'listTabs'},
    {id:'approved@example.test'});
  assert.equal(result.tabs[0].phase,'generating');
  assert.equal(result.tabs[0].running,true);
});

test('background cannot authorize a Send on any non-conversation route',async()=>{
  const {listeners,forwards}=create();
  let tabId=919;
  for(const route of ['/', '/c/', '/share/abc', '/g/g-foo/c',
                       '/g/g-foo', '/c/a/extra', '/search']){
    const sender={tab:{id:tabId++,url:'https://chatgpt.com'+route},url:'https://chatgpt.com'+route};
    assert.equal((await listeners.internal({type:'chat-queue-internal/v1',action:'register',route},sender)).ok,true);
    const reply=await listeners.internal({type:'chat-queue-internal/v1',
      action:'dispatch-check',route,documentToken:'a'.repeat(32),
      sequence:1,epoch:0},sender);
    assert.equal(reply.error,'conversation-not-assigned',route);
  }
  assert.equal(forwards.length,0);
});

test('different assigned route shapes sharing an ID cannot simultaneously own Send',async()=>{
  const {listeners}=create();
  const provider={id:'chat-signals@sguzman.github'};
  const paths=['/c/collision','/g/g-project/c/collision','/c/independent'];
  const senders=paths.map((route,i)=>({
    tab:{id:170+i,url:'https://chatgpt.com'+route},
    url:'https://chatgpt.com'+route
  }));
  for(let i=0;i<senders.length;i++){
    const route=paths[i],tabId=senders[i].tab.id;
    assert.equal((await listeners.internal({
      type:'chat-queue-internal/v1',action:'register',route
    },senders[i])).ok,true);
    assert.equal((await listeners.external({type:'chat-queue-signal/v1',tabId,
      signal:{version:1,route,documentToken:String(i+1).repeat(32),
        epoch:0,sequence:1,phase:'idle',origin:'fresh',confidence:'observed'}
    },provider)).ok,true);
  }
  const check=i=>listeners.internal({
    type:'chat-queue-internal/v1',action:'dispatch-check',
    route:paths[i],documentToken:String(i+1).repeat(32),epoch:0,sequence:1
  },senders[i]);
  assert.equal((await check(0)).ok,true);
  assert.equal((await check(1)).error,'conversation-owned-by-another-tab',
    'project-shaped and ordinary chat paths must collide conservatively');
  assert.equal((await check(2)).ok,true,'a different conversation ID remains independent');
  // A background pause with an outstanding response does not unlock either
  // URL shape, even when both pages report their exact assigned routes.
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    phase:'verifying',size:1,running:false,awaiting:true,sequence:1},senders[0]);
  assert.equal((await check(1)).error,'conversation-owned-by-another-tab');
  await listeners.internal({type:'chat-queue-internal/v1',action:'state',
    phase:'finished',size:1,running:false,awaiting:false,sequence:2},senders[0]);
  assert.equal((await check(1)).ok,true);
  assert.equal((await check(0)).error,'conversation-owned-by-another-tab');
});

test('Queue requests exactly one browser-principal Signal resample for assigned registration',async()=>{
  const {listeners,syncRequests}=create();
  const sender={tab:{id:351,url:'https://chatgpt.com/c/synthetic-one'},
    url:'https://chatgpt.com/c/synthetic-one'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/synthetic-one'},sender)).ok,true);
  assert.equal(syncRequests.length,0,'registration alone cannot race uninitialized content');
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'sync-provider',route:'/c/synthetic-one'},sender)).ok,true);
  assert.equal(syncRequests.length,1);
  assert.equal(syncRequests[0].recipient,'chat-signals@sguzman.github');
  assert.deepEqual(JSON.parse(JSON.stringify(syncRequests[0].message)),{
    type:'chat-queue-signal-sync/v1',tabId:351,route:'/c/synthetic-one'
  });
  const home={tab:{id:352,url:'https://chatgpt.com/'},url:'https://chatgpt.com/'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/'},home)).ok,true);
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'sync-provider',route:'/'},home)).ok,false);
  assert.equal(syncRequests.length,1,
    'home/unassigned routes are not permitted a provider resample');
  const wrong={tab:{id:353,url:'https://chatgpt.com/c/other'},
    url:'https://chatgpt.com/c/other'};
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'register',route:'/c/not-live'},wrong)).ok,false);
  assert.equal((await listeners.internal({type:'chat-queue-internal/v1',
    action:'sync-provider',route:'/c/not-live'},wrong)).ok,false);
  assert.equal(syncRequests.length,1,'route-mismatched registration never syncs');
});
