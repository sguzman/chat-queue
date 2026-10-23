/* Firefox event page: only forwards authenticated commands, never sees prompt text in logs. */
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const PREFIX = 'chat-queue/v1';
  const TABS = new Map();
  const PORTS = new Map();
  const notify = (tabId, state) => {
    for (const port of PORTS.keys()) {
      try { port.postMessage({ type: PREFIX, event:'stateChanged', tabId, state }); } catch { PORTS.delete(port); }
    }
  };
  const ALLOWED_ACTIONS = new Set(['status','enqueue','update','move','reorder','remove','clear','start','pause','resolve']);
  const allowedId = id => typeof id === 'string' && /^[a-zA-Z0-9_.@-]{4,160}$/.test(id);

  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'chat-queue-internal/v1' || !Number.isInteger(sender?.tab?.id)) return;
    const tab = sender.tab;
    if (!/^https:\/\/chatgpt\.com\//.test(sender.url || tab.url || '')) return;
    if (message.action === 'register') {
      TABS.set(tab.id, { phase: 'unknown', size: 0, running: false, revision: 0 });
      return Promise.resolve({ ok: true, tabId: tab.id });
    }
    if (message.action === 'state') {
      {
        const phase = String(message.phase || 'unknown');
        const prev=TABS.get(tab.id);
        const next={
          phase: /^(idle|submitted|generating|verifying|finished|interrupted|failed|limit|unknown)$/.test(phase) ? phase : 'unknown',
          size: Number.isInteger(message.size) ? Math.min(100, Math.max(0, message.size)) : 0,
          running: message.running === true,
          revision: Number.isSafeInteger(message.revision) ? message.revision : 0
        };
        TABS.set(tab.id,next);
        if(JSON.stringify(prev)!==JSON.stringify(next)) notify(tab.id,next);
      }
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false, error: 'unknown-action' });
  });

  api.runtime.onConnectExternal.addListener(port => {
    if(port.name !== PREFIX || !allowedId(port.sender?.id)) { port.disconnect();return; }
    const id=port.sender.id;
    void api.storage.local.get('allowedExtensionIds').then(config=>{
      if(!Array.isArray(config.allowedExtensionIds)||!config.allowedExtensionIds.includes(id)) {port.disconnect();return;}
      PORTS.set(port,id);
      port.onDisconnect.addListener(()=>PORTS.delete(port));
      port.postMessage({type:PREFIX,event:'ready',tabs:Array.from(TABS,([tabId,state])=>({tabId,...state}))});
    }).catch(()=>port.disconnect());
  });
  api.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes.allowedExtensionIds)return;
    const allowed=changes.allowedExtensionIds.newValue || [];
    for(const [port,id] of PORTS){
      if(!Array.isArray(allowed)||!allowed.includes(id)){PORTS.delete(port);try{port.disconnect();}catch{}}
    }
  });

  api.runtime.onMessageExternal.addListener(async (message, sender) => {
    if (!message || message.type !== PREFIX) return;
    const requester = sender?.id;
    const config = await api.storage.local.get('allowedExtensionIds');
    if (!Array.isArray(config.allowedExtensionIds) || !config.allowedExtensionIds.includes(requester) || !allowedId(requester)) {
      return { ok: false, error: 'unauthorized' };
    }
    if (message.action === 'listTabs') {
      return { ok: true, tabs: Array.from(TABS, ([tabId, status]) => ({ tabId, ...status })) };
    }
    if (!ALLOWED_ACTIONS.has(message.action) || !Number.isInteger(message.tabId) || message.tabId < 0) {
      return { ok: false, error: 'invalid-request' };
    }
    const target = TABS.get(message.tabId);
    if (!target) return { ok: false, error: 'tab-not-registered' };
    try {
      return await api.tabs.sendMessage(message.tabId, {
        type: 'chat-queue-api/v1', action: message.action, payload: message.payload || null
      });
    } catch {
      TABS.delete(message.tabId);
      return { ok: false, error: 'tab-unavailable' };
    }
  });

  api.tabs.onRemoved.addListener(tabId => {TABS.delete(tabId);notify(tabId,null);});
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && !change.url.startsWith('https://chatgpt.com/')) TABS.delete(tabId);
  });
})();
