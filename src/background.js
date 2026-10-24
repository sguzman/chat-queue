/* Firefox event page: only forwards authenticated commands, never sees prompt text in logs. */
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const signalContract = globalThis.ChatQueueSignal;
  const grants = globalThis.ChatQueueGrants;
  const rulesEngine = globalThis.ChatQueueRules;
  const PREFIX = 'chat-queue/v1';
  const PROTOCOL_VERSION = 1;
  const TABS = new Map();
  // Authenticated provider envelopes never enter public tab metadata, API
  // snapshots, subscription events or persistent browser storage.
  const SIGNALS = new Map();
  // Separate route registry: never exposed through the public extension API.
  const ROUTES = new Map();
  // Volatile one-dispatch-owner-per-conversation gate. Lost with the event
  // page: a restarted page must re-validate the provider before reacquiring.
  const OWNERS = new Map();
  function releaseOwner(tabId){
    for(const [route,id] of OWNERS)if(id===tabId)OWNERS.delete(route);
  }
  const PORTS = new Map();
  // Invalidates pending authorization reads when Options changes the ACL.
  let grantRevision=0;
  const PROVIDER_TYPE = signalContract.TYPE;
  // On History API transitions sender.url may still identify the originally
  // loaded document. Verify the browser-owned live tab instead.
  async function currentRoute(sender) {
    try {
      const current=await api.tabs.get(sender.tab.id);
      const live=new URL(current?.url);
      const origin=new URL(sender.url || sender.tab.url);
      return live.origin===origin.origin ? live.pathname : null;
    } catch { return null; }
  }
  const notify = (tabId, state) => {
    for (const port of PORTS.keys()) {
      try { port.postMessage({ type: PREFIX, protocolVersion: PROTOCOL_VERSION, event:'stateChanged', tabId, state }); } catch { PORTS.delete(port); }
    }
  };

  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'chat-queue-internal/v1' || !Number.isInteger(sender?.tab?.id)) return;
    const tab = sender.tab;
    if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;
    if (message.action === 'register') {
      if (!signalContract.validRoute(message.route)) return Promise.resolve({ok:false,error:'invalid-route'});
      return currentRoute(sender).then(live=>{
        if(live!==message.route)return {ok:false,error:'route-mismatch'};
        releaseOwner(tab.id);
        ROUTES.set(tab.id,message.route);
        TABS.set(tab.id, { phase: 'unknown', size: 0, running: false, awaiting: false, revision: 0 });
        SIGNALS.delete(tab.id);
        return {ok:true,tabId:tab.id};
      });
    }
    if (message.action === 'dispatch-check') {
      // A restarted event page has no provider registration. A previously
      // observed content-script Signal cannot authorize a new Send by itself.
      const last=SIGNALS.get(tab.id);
      if(!last || ROUTES.get(tab.id)!==message.route || !TABS.has(tab.id) ||
         last.documentToken!==message.documentToken ||
         last.epoch!==message.epoch || last.sequence!==message.sequence ||
         !signalContract.ready(last,message.route))
        return Promise.resolve({ok:false,error:'signal-authority-lost'});
      return currentRoute(sender).then(live=>{
        if(live!==message.route || SIGNALS.get(tab.id)!==last ||
           ROUTES.get(tab.id)!==message.route || !TABS.has(tab.id))
          return {ok:false,error:'route-or-signal-changed'};
        const owner=OWNERS.get(message.route);
        if(owner!==undefined&&owner!==tab.id)
          return {ok:false,error:'conversation-owned-by-another-tab'};
        // This check/claim is synchronous after the asynchronous route check,
        // so competing tabs cannot both reserve the same route.
        OWNERS.set(message.route,tab.id);
        return {ok:true};
      });
    }
    if (message.action === 'state') {
      // Delayed state publication from the previous SPA route cannot recreate
      // its tab entry or advertise stale queue controls to API clients.
      const registered=ROUTES.get(tab.id);
      if(!TABS.has(tab.id)||!registered)return Promise.resolve({ok:false,error:'route-mismatch'});
      return currentRoute(sender).then(live=>{
        if(ROUTES.get(tab.id)!==registered||live!==registered||!TABS.has(tab.id))
          return {ok:false,error:'route-mismatch'};
        const phase = String(message.phase || 'unknown');
        const prev=TABS.get(tab.id);
        const next={
          phase: /^(idle|submitted|generating|verifying|finished|interrupted|failed|limit|unknown)$/.test(phase) ? phase : 'unknown',
          size: Number.isInteger(message.size) ? Math.min(100, Math.max(0, message.size)) : 0,
          running: message.running === true,
          awaiting: message.awaiting === true,
          revision: Number.isSafeInteger(message.revision) ? message.revision : 0
        };
        TABS.set(tab.id,next);
        if(!next.running&&!next.awaiting)releaseOwner(tab.id);
        if(JSON.stringify(prev)!==JSON.stringify(next)) notify(tab.id,next);
        return {ok:true};
      });
    }
    return Promise.resolve({ ok: false, error: 'unknown-action' });
  });

  api.runtime.onConnectExternal.addListener(port => {
    if(port.name !== PREFIX || !grants.validId(port.sender?.id)) { port.disconnect();return; }
    const id=port.sender.id;
    const authorizedAt=grantRevision;
    void api.storage.local.get(grants.KEY).then(config=>{
      if(authorizedAt!==grantRevision||!grants.has(config[grants.KEY],id,'discover')) {port.disconnect();return;}
      PORTS.set(port,id);
      port.onDisconnect.addListener(()=>PORTS.delete(port));
      port.postMessage({type:PREFIX,protocolVersion:PROTOCOL_VERSION,event:'ready',tabs:Array.from(TABS,([tabId,state])=>({tabId,...state}))});
    }).catch(()=>port.disconnect());
  });
  api.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes[grants.KEY])return;
    grantRevision++;
    const newPolicy=changes[grants.KEY].newValue;
    for(const [port,id] of PORTS){
      if(!grants.has(newPolicy,id,'discover')){PORTS.delete(port);try{port.disconnect();}catch{}}
    }
  });

  api.runtime.onMessageExternal.addListener(async (message, sender) => {
    if (message?.type===PROVIDER_TYPE) {
      // Firefox sets sender.id; the page cannot impersonate another extension.
      if(sender?.id!==signalContract.PROVIDER_ID)return {ok:false,error:'not-signal-provider'};
      const tabId=message.tabId;
      if(!Number.isInteger(tabId)||tabId<0||
         (sender?.tab && sender.tab.id!==tabId))return {ok:false,error:'invalid-tab'};
      const parsed=signalContract.parse(message);
      if(!parsed)return {ok:false,error:'invalid-signal'};
      const slot=TABS.get(tabId);
      if(!slot)return {ok:false,error:'tab-not-registered'};
      if(ROUTES.get(tabId)!==parsed.route)return {ok:false,error:'route-mismatch'};
      if(!signalContract.advance(SIGNALS.get(tabId),parsed))return {ok:false,error:'stale-signal'};
      // Reserve this sequence before awaiting the recipient; otherwise two
      // concurrent provider callbacks can both pass the stale-event check.
      SIGNALS.set(tabId,parsed);
      // The receiving tab independently checks the exact current route.
      try {
        const result=await api.tabs.sendMessage(tabId,{type:'chat-queue-signal-verified/v1',signal:parsed});
        if(!result?.ok)return {ok:false,error:'consumer-unavailable'};
      }catch{return {ok:false,error:'consumer-unavailable'};}
      return {ok:true};
    }
    if (!message || message.type !== PREFIX) return;
    const requester = sender?.id;
    const authorizedAt=grantRevision;
    const config = await api.storage.local.get(grants.KEY);
    if(authorizedAt!==grantRevision)return {ok:false,error:'authorization-changed'};
    const authorized=grants.scopes(config[grants.KEY],requester);
    if (!authorized.length) {
      return { ok: false, error: 'unauthorized' };
    }
    // Size limits cover all verbs, including metadata-only capability probes.
    if(JSON.stringify(message).length>32768)return {ok:false,error:'request-too-large'};
    if(message.action==='capabilities')return {ok:true,version:2,protocolVersion:PROTOCOL_VERSION,grantVersion:2,scopes:authorized};
    if(!Object.hasOwn(grants.ACTION_SCOPE,message.action))return {ok:false,error:'invalid-request'};
    if(!authorized.includes(grants.ACTION_SCOPE[message.action]))
      return {ok:false,error:'forbidden-scope'};
    if (message.action === 'previewRules') {
      // Caller-supplied synthetic data only. Never reads a live chat, persists
      // rules, publishes provider identity or changes the dispatch scheduler.
      const p=message.payload;
      if(!p||typeof p!=='object')return {ok:false,error:'invalid-preview'};
      const response=rulesEngine?.evaluate(p.rules,p.signal,p.consumedKeys??[],p.context);
      return response||{ok:false,error:'rules-engine-unavailable'};
    }
    if (message.action === 'listTabs') {
      return { ok: true, tabs: Array.from(TABS, ([tabId, status]) => ({ tabId, ...status })) };
    }
    if (!Number.isInteger(message.tabId) || message.tabId < 0) {
      return { ok: false, error: 'invalid-request' };
    }
    const target = TABS.get(message.tabId);
    if (!target) return { ok: false, error: 'tab-not-registered' };
    try {
      const reply=await api.tabs.sendMessage(message.tabId, {
        type: 'chat-queue-api/v1', action: message.action, payload: message.payload || null
      });
      // Status contains private prompts. An ACL revocation during the content
      // script's asynchronous response must prevent that content from leaving.
      // Mutations already forwarded cannot be undone; return their true result.
      if(message.action==='status' && grantRevision!==authorizedAt)
        return {ok:false,error:'authorization-changed'};
      return reply;
    } catch {
      TABS.delete(message.tabId);
      SIGNALS.delete(message.tabId);
      ROUTES.delete(message.tabId);
      return { ok: false, error: 'tab-unavailable' };
    }
  });

  function invalidate(tabId){
    if(!ROUTES.has(tabId))return;
    releaseOwner(tabId);
    ROUTES.delete(tabId);TABS.delete(tabId);SIGNALS.delete(tabId);
    notify(tabId,null);
  }
  api.tabs.onRemoved.addListener(tabId => invalidate(tabId));
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && !change.url.startsWith('https://chatgpt.com/')) invalidate(tabId);
    else if(change.url && ROUTES.has(tabId)){
      try {if(new URL(change.url).pathname!==ROUTES.get(tabId)){
        invalidate(tabId);
        void api.tabs.sendMessage(tabId,{type:'chat-queue-route-changed/v1'}).catch(()=>{});
      }}catch{}
    }
  });
})();
