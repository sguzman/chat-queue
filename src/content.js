/* Firefox Chat Queue content script. Chat Signals is the ONLY state detector. */
(() => {
  'use strict';
  if (globalThis.__chatQueuePrototype) return;
  globalThis.__chatQueuePrototype = true;
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.ChatQueueCore;
  const contract = globalThis.ChatQueueSignal;
  if (!api?.runtime?.sendMessage || !core || !contract) return;
  const uid = () => crypto.randomUUID();
  const editorSelector = '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]';
  const sendSelector = 'button[data-testid="send-button"],button[data-testid="composer-submit-button"],#composer-submit-button,button[aria-label="Send prompt" i],button[aria-label="Send message" i]';
  const state = { tabId: null, key: '', items: [], history: [], running: false, awaiting: false,
    busySeen: false, attempting: null, signal: 'unknown', observedSignal:'unknown',
    trusted: null, trustedAt: 0, waiting: null, note: 'Paused', initialized: false,
    editing: null, collapsed: false, theme: 'system', destroyed: false, scheduler: null, revision: 0, saveChain: Promise.resolve() };
  const routeKey = () => location.pathname;
  const storageKey = () => `chatqueue:v1:tab:${state.tabId}:${routeKey()}`;
  const host = document.createElement('div');
  host.id = 'chat-queue-extension-root';
  host.style.setProperty('all','initial');
  host.style.setProperty('position','fixed');
  host.style.setProperty('z-index','2147483200');
  host.style.setProperty('right','20px');
  host.style.setProperty('bottom','84px');
  host.style.setProperty('width','min(370px, calc(100vw - 32px))');
  const shadow = host.attachShadow({mode:'closed'});
  const style = document.createElement('style');
  style.textContent = `
    :host{color-scheme:light;contain:style;--panel:#fff;--text:#192432;--border:#bcc7d1;--header:#f4f6f9;--status:#f8fafc;--item:#f5f7fa;--button:#e6ecf3;--button-hover:#d9e4ed;--button-border:#9eafbf;--muted:#4c6074;--input:#fff;--accent:#204f8c;--accent-text:#fff;--focus:#1773bb;--shadow:#0002;--warning:#bd702b}
    @media (prefers-color-scheme:dark){:host(:not([data-theme="light"]):not([data-theme="dark"])){color-scheme:dark;--panel:#202329;--text:#f6f7fb;--border:#526075;--header:#282e38;--status:#1b2027;--item:#2b3039;--button:#394553;--button-hover:#526278;--button-border:#637488;--muted:#bfcedf;--input:#151a20;--accent:#abcff5;--accent-text:#172430;--focus:#86b6e8;--shadow:#0008;--warning:#efac74}}
    :host([data-theme="dark"]){color-scheme:dark;--panel:#202329;--text:#f6f7fb;--border:#526075;--header:#282e38;--status:#1b2027;--item:#2b3039;--button:#394553;--button-hover:#526278;--button-border:#637488;--muted:#bfcedf;--input:#151a20;--accent:#abcff5;--accent-text:#172430;--focus:#86b6e8;--shadow:#0008;--warning:#efac74}
    *,*::before,*::after{box-sizing:border-box}
    .panel{background:var(--panel);color:var(--text);font:13px/1.45 'Atkinson Hyperlegible Next','Atkinson Hyperlegible',system-ui,sans-serif;border:1px solid var(--border);border-radius:13px;box-shadow:0 12px 34px var(--shadow);overflow:hidden;max-height:min(65vh,680px);display:flex;flex-direction:column}
    .top{display:flex;align-items:center;gap:8px;padding:11px 12px;background:var(--header);border-bottom:1px solid var(--border)}
    .top strong{font-size:14px;letter-spacing:.01em;flex:1}.small{font-size:11px;color:var(--muted)}
    .status{padding:8px 12px;color:var(--muted);background:var(--status);border-bottom:1px solid var(--border)}
    .items{overflow:auto;max-height:260px;padding:8px;display:flex;flex-direction:column;gap:7px}
    .item{background:var(--item);border:1px solid var(--border);border-radius:8px;padding:8px;min-width:0}
    .preview{white-space:pre-wrap;word-break:break-word;max-height:84px;overflow:hidden;margin-bottom:6px}
    .controls{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
    button,select{font:inherit;cursor:pointer;border:1px solid var(--button-border);border-radius:6px;color:var(--text);background:var(--button);padding:5px 9px}
    button:hover,select:hover{background:var(--button-hover)}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
    button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);font-weight:700}
    button.danger{color:var(--warning)}button:disabled{opacity:.42;cursor:default}
    .foot{padding:10px 12px;border-top:1px solid var(--border);background:var(--header)}
    details{border-top:1px solid var(--border);padding:8px 12px;color:var(--muted)}summary{cursor:pointer}
    .history{max-height:140px;overflow:auto}.historyitem{padding:7px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;align-items:start}
    .historytext{min-width:0;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    textarea{display:block;width:100%;min-height:58px;max-height:160px;resize:vertical;padding:9px;border:1px solid var(--button-border);border-radius:7px;background:var(--input);color:var(--text);font:inherit;margin-bottom:8px}
    .footrow{display:flex;align-items:center;justify-content:space-between;gap:8px}.empty{padding:12px;color:var(--muted);text-align:center}
    [hidden]{display:none!important}.uncertain{border-color:var(--warning)}.hint{padding:4px 0;color:var(--muted);font-size:11px}
    @media(max-width:520px){.panel{max-height:55vh}.items{max-height:170px}.top{gap:5px;padding:8px}.top strong{font-size:12px}select{max-width:90px}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
  `;
  shadow.append(style);
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.setAttribute('aria-label', 'Chat Queue');
  panel.innerHTML = `<header class="top"><strong>Message Queue</strong><span id="count" class="small">0 queued</span><select id="theme" aria-label="Chat Queue theme" title="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><button id="toggle" title="Collapse or expand queue" aria-label="Collapse queue">−</button></header>
    <div id="status" class="status" role="status"></div><div id="body"><div id="items" class="items"></div><details><summary>Recently submitted</summary><div id="history" class="history"></div></details>
    <div class="foot"><label for="draft" class="small">Add queued message</label><textarea id="draft" placeholder="Message to send when control returns" spellcheck="true"></textarea>
    <div class="footrow"><button id="add">Add to queue</button><button id="run" class="primary">Start</button></div>
    <div class="hint">Uses Chat Signals. Never overwrites an existing draft.</div></div></div>`;
  shadow.append(panel);
  const els = Object.fromEntries(['count','toggle','theme','status','body','items','history','draft','add','run'].map(id => [id,shadow.getElementById(id)]));
  const button = (label, title, fn, disabled=false) => {
    const b=document.createElement('button'); b.type='button'; b.textContent=label; b.title=title; b.disabled=disabled; b.addEventListener('click',fn); return b;
  };
  const pending = () => state.items.some(item => item.status === 'pending');
  const uncertain = () => state.items.some(item => item.status === 'uncertain');
  const signalFromPage = () => core.validPhase(document.documentElement.dataset.chatSignalsState);
  const freshProvider = () => Boolean(state.trusted&&state.trusted.route===routeKey()&&
    state.trusted.origin==='fresh'&&Date.now()-state.trustedAt<15000);
  function render() {
    if (state.destroyed) return;
    host.dataset.theme=state.theme;els.theme.value=state.theme;
    els.count.textContent = `${state.items.length} queued`;
    els.status.textContent = `Signal: ${state.trusted ? state.signal : state.observedSignal+' (unverified)'} • ${state.running ? 'Running' : 'Paused'} • ${state.note}`;
    els.run.textContent = state.running ? 'Pause' : 'Start';
    els.toggle.textContent = state.collapsed ? '+' : '−';
    els.toggle.setAttribute('aria-label',state.collapsed ? 'Expand queue' : 'Collapse queue');
    els.body.hidden = state.collapsed;
    els.status.hidden = state.collapsed;
    els.items.replaceChildren();
    if (!state.items.length) {
      const empty=document.createElement('div');empty.className='empty';empty.textContent='No queued messages.';els.items.append(empty);
    }
    els.history.replaceChildren();
    state.history.forEach(entry=>{
      const row=document.createElement('div');row.className='historyitem';
      const preview=document.createElement('div');preview.className='historytext';
      preview.textContent=`${entry.status}: ${entry.text}`;preview.title=entry.text;
      row.append(preview,button('Requeue','Add this exact message to the end of the queue',async()=>{
        const result=await act('enqueue',{text:entry.text});
        if(!result.ok)statusNote(result.error);
      }));els.history.append(row);
    });
    state.items.forEach((item,index) => {
      const row=document.createElement('div');row.className='item'+(item.status==='uncertain'?' uncertain':'');
      row.draggable=!state.attempting;
      row.dataset.itemId=item.id;
      row.addEventListener('dragstart',event=>{event.dataTransfer.setData('text/plain',item.id);event.dataTransfer.effectAllowed='move';});
      row.addEventListener('dragover',event=>{if (row.draggable)event.preventDefault();});
      row.addEventListener('drop',event=>{
        event.preventDefault();if(state.attempting)return;const id=event.dataTransfer.getData('text/plain');
        state.items=core.moveTo(state.items,id,item.id);void save();render();
      });
      if (state.editing === item.id) {
        const textarea=document.createElement('textarea');textarea.value=item.text;textarea.setAttribute('aria-label','Edit queued message');row.append(textarea);
        const ctrls=document.createElement('div');ctrls.className='controls';
        ctrls.append(button('Save','Save edit',()=>{if (!core.validText(textarea.value)) return;item.text=textarea.value;state.editing=null;void save();render();}),button('Cancel','Cancel edit',()=>{state.editing=null;render();}));row.append(ctrls);
      } else {
        const preview=document.createElement('div');preview.className='preview';preview.textContent=(item.status==='uncertain'?'⚠ Submission uncertain. Remove or resolve before restarting.\n':'')+item.text;row.append(preview);
        const ctrls=document.createElement('div');ctrls.className='controls';
        const locked=Boolean(state.attempting);
        ctrls.append(button('↑','Move earlier',()=>{state.items=core.nextPosition(state.items,item.id,-1);void save();render();},index===0||locked),
          button('↓','Move later',()=>{state.items=core.nextPosition(state.items,item.id,1);void save();render();},index===state.items.length-1||locked),
          button('Edit','Edit message',()=>{state.editing=item.id;render();},locked),
          button('Delete','Remove message',()=>{state.items=state.items.filter(x=>x.id!==item.id);void save();render();},locked));
        if (item.status==='uncertain') ctrls.append(button('Retry','Allow manually requested retry',()=>{item.status='pending';state.note='Retry explicitly allowed';void save();render();}));
        row.append(ctrls);
      }
      els.items.append(row);
    });
  }
  function statusNote(message) { state.note = message; render();publish(); }
  function publish() {
    if (state.tabId == null || state.destroyed) return;
    void api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'state',phase:state.signal,size:state.items.length,running:state.running,revision:state.revision}).catch(()=>{});
  }
  function save() {
    state.revision++;const key=state.key;const data={version:1,items:state.items.map(item=>({id:item.id,text:item.text,status:item.status})),history:state.history.slice(0,20)};
    state.saveChain=state.saveChain.catch(()=>{}).then(()=>api.storage.local.set({[key]:data}));
    state.saveChain.catch(()=>{state.running=false;statusNote('Could not save queue; paused');});
    publish();return state.saveChain;
  }
  function editorValue(editor) {
    return (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : editor.innerText || editor.textContent || '').replace(/\r\n/g,'\n');
  }
  function findComposer() {
    const found=[...document.querySelectorAll(editorSelector)].filter(e=>e.isConnected && e.getClientRects().length && e.getAttribute('contenteditable')!=='false');
    if (found.length !== 1) throw new Error('Composer is missing or ambiguous');
    const editor=found[0];
    const form=editor.closest('form');
    if (!form || !form.contains(editor)) throw new Error('Composer form is missing');
    if (editorValue(editor).trim()) throw new Error('Composer contains a draft; preserved it');
    if (form.querySelector('input[type="file"]')?.files?.length) throw new Error('Composer has attachments');
    return {editor,form};
  }
  function fillComposer(editor,text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor),'value');
      descriptor.set.call(editor,text);
      editor.dispatchEvent(new Event('input',{bubbles:true}));
    } else {
      if (typeof document.execCommand !== 'function' || !document.execCommand('insertText',false,text)) throw new Error('Composer insertion failed');
    }
    const value=editorValue(editor).trim().replace(/\u00a0/g,' ');
    if (value !== text.trim().replace(/\u00a0/g,' ')) throw new Error('Composer did not accept the exact message');
  }
  function findSend(form) {
    const buttons=[...form.querySelectorAll(sendSelector)].filter(e=>!e.disabled && e.getAttribute('aria-disabled')!=='true' && e.getClientRects().length);
    if (buttons.length !== 1) throw new Error('Send button missing, disabled or ambiguous');
    return buttons[0];
  }
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function dispatchOne() {
    if (!state.running || state.attempting || state.awaiting || !pending()) return;
    if (state.key!==storageKey()) {void handleRouteChange();return;}
    if (!freshProvider() || !contract.ready(state.trusted,routeKey())) return;
    const item=state.items.find(e=>e.status==='pending');
    if (!item) return;
    const attemptKey=state.key;
    const baseline=state.trusted;
    state.attempting=item.id;
    statusNote('Preparing next message');
    let clicked=false;
    let editor;
    try {
      if (state.key!==attemptKey||storageKey()!==attemptKey)
        throw new Error('Conversation changed before composer handoff');
      const found=findComposer();editor=found.editor;
      fillComposer(editor,item.text);
      const send=findSend(found.form);
      // A durable pre-click uncertainty marker makes a browser crash safe:
      // it must never reopen as an automatically retryable pending item.
      item.status='uncertain';
      await save();
      if (!state.running || state.destroyed || state.key!==attemptKey ||storageKey()!==attemptKey ||
          !freshProvider() || state.trusted!==baseline || !send.isConnected ||
          editorValue(editor).trim()!==item.text.trim())
        throw new Error('Dispatch context changed; no send attempted');
      // This initiates exactly one send attempt. We never click again after uncertainty.
      send.click(); clicked=true;
      statusNote('Verifying submission');
      let accepted=false;
      for (let i=0;i<12;i++) {
        await delay(250);
        if (state.destroyed || !state.running || state.key!==attemptKey ||storageKey()!==attemptKey || !editor.isConnected) break;
        if (contract.newBusy(state.trusted,baseline) && !editorValue(editor).trim()) {
          state.waiting={documentToken:baseline.documentToken,route:baseline.route,
            epoch:state.trusted.epoch,sequence:state.trusted.sequence};
          accepted=true;break;
        }
      }
      if(state.key!==attemptKey||storageKey()!==attemptKey)throw new Error('Conversation changed during submission');
      if (!accepted) throw new Error('Submission not confirmed; manual review required');
      // Persist removal first; do not consider another item until storage commits.
      state.items=state.items.filter(x=>x.id!==item.id);
      state.history.unshift({id:item.id,text:item.text,at:Date.now(),status:'submitted'});
      state.history=state.history.slice(0,20);
      state.awaiting=true;
      state.busySeen=true;
      await save();
      statusNote('Waiting for confirmed response completion');
      processSignal();
    } catch(error) {
      if(state.key===attemptKey) {
        state.running=false;
        // Pre-click journal is also uncertain if preparation was interrupted;
        // conservative manual resolution is required in either case.
        if(!state.items.some(entry=>entry.id===item.id))state.items.unshift(item);
        try{await save();}catch{}
        statusNote(error.message || 'Dispatch failed');
      }
    } finally {
      state.attempting=null;
      render();
    }
  }
  function processSignal() {
    if (state.key && state.key!==storageKey()) {void handleRouteChange();return;}
    const next=state.trusted?.phase || 'unknown';
    const previous=state.signal;state.signal=next;
    if (state.running && (next==='failed'||next==='limit'||next==='interrupted'||next==='unknown')) {
      // A temporary connection interruption is not an automatic retry.
      if(state.awaiting && state.history[0]?.status==='submitted') {
        state.history[0].status=next==='failed'||next==='limit'?'failed':'interrupted';
        void save();
      }
      state.running=false;statusNote(`Paused on ${next}`);
    } else if(state.running && state.awaiting && next==='idle' && previous!=='idle'){
      state.running=false;statusNote('Response cancelled; press Start to continue');
    } else if (state.awaiting && contract.completed(state.trusted,state.waiting)) {
      state.awaiting=false;state.busySeen=false;state.waiting=null;
      if(state.history[0]?.status==='submitted'||state.history[0]?.status==='interrupted') {
        state.history[0].status='finished';void save();
      }
      statusNote('Response finished; control returned');
      if(state.running)planNext();
    } else if (state.running && !state.awaiting && !state.attempting &&
               freshProvider() && contract.ready(state.trusted,routeKey()) && next!==previous) {
      planNext();
    }
    if (previous!==next) render();
    publish();
  }
  function planNext() {
    if (state.scheduler) clearTimeout(state.scheduler);
    state.scheduler=setTimeout(()=>{state.scheduler=null;
      if (!state.running || state.awaiting || state.attempting ||
          !freshProvider() || !contract.ready(state.trusted,routeKey())) return;
      if (!pending()) {state.running=false;statusNote('Queue completed');return;}
      void dispatchOne();
    },350);
  }
  function readHistory(saved) {
    return Array.isArray(saved?.history) ? saved.history.filter(h=>h&&typeof h.id==='string'&&core.validText(h.text)&&Number.isSafeInteger(h.at)).slice(0,20).map(h=>({id:h.id,text:h.text,at:h.at,status:['submitted','finished','interrupted','failed'].includes(h.status)?h.status:'submitted'})) : [];
  }
  async function handleRouteChange() {
    if(!state.initialized)return;
    const newKey=storageKey();if (state.key===newKey)return;
    state.running=false;state.awaiting=false;state.attempting=null;state.busySeen=false;
    state.waiting=null;state.trusted=null;state.trustedAt=0;state.signal='unknown';
    if (state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;
    await state.saveChain.catch(()=>{});
    state.key=newKey;
    const stored=await api.storage.local.get(newKey);
    state.items=core.normalizeSaved(stored[newKey]);
    state.history=readHistory(stored[newKey]);
    state.observedSignal=signalFromPage();state.note='Conversation changed; manually start queue';state.editing=null;
    // A new route also invalidates the background's Signal document sequence.
    try{await api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register'});}catch{}
    render();publish();
  }
  async function act(action,payload,local=false) {
    if (!state.initialized) return {ok:false,error:'not-ready'};
    if(state.key!==storageKey())await handleRouteChange();
    try {
      if (action==='status') return {ok:true,tabId:state.tabId,phase:state.signal,running:state.running,awaiting:state.awaiting,items:state.items.map(e=>({...e})),history:state.history.map(e=>({...e}))};
      if (action==='enqueue') {
        const text=payload?.text;
        if (state.items.length>=core.MAX_ITEMS) return {ok:false,error:'queue-full'};
        const item=core.makeItem(text,uid());state.items.push(item);await save();render();
        if(state.running&&!state.awaiting)planNext();
        return {ok:true,id:item.id};
      }
      if (action==='update') {
        if(state.attempting) return {ok:false,error:'dispatch-in-progress'};
        const item=state.items.find(i=>i.id===payload?.id);
        if(!item||!core.validText(payload?.text))return {ok:false,error:'invalid-message'};
        item.text=payload.text;await save();render();return {ok:true};
      }
      if (action==='reorder') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        const ids=payload?.ids;
        if(!Array.isArray(ids)||ids.length!==state.items.length||new Set(ids).size!==ids.length||!ids.every(id=>state.items.some(i=>i.id===id)))return {ok:false,error:'invalid-order'};
        state.items=ids.map(id=>state.items.find(i=>i.id===id));await save();render();return {ok:true};
      }
      if (action==='move') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        state.items=core.moveTo(state.items,payload?.id,payload?.beforeId??null);await save();render();return {ok:true};
      }
      if (action==='remove' || action==='clear') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        state.items=action==='clear'?[]:state.items.filter(i=>i.id!==payload?.id);await save();render();return {ok:true};
      }
      if (action==='resolve') {
        const item=state.items.find(i=>i.id===payload?.id && i.status==='uncertain');
        if(!item)return {ok:false,error:'not-uncertain'};
        if(payload?.decision==='retry')item.status='pending';
        else if(payload?.decision==='discard')state.items=state.items.filter(i=>i.id!==item.id);
        else return {ok:false,error:'invalid-decision'};
        await save();render();return {ok:true};
      }
      if (action==='pause') {state.running=false;if(state.scheduler)clearTimeout(state.scheduler);state.scheduler=null;statusNote('Manually paused');return {ok:true};}
      if (action==='start') {
        if (uncertain())return {ok:false,error:'resolve-uncertain-message'};
        if (!pending() && !state.awaiting)return {ok:false,error:'queue-empty'};
        if (!freshProvider())return {ok:false,error:'authenticated-chat-signals-required'};
        if (core.BLOCKED.has(state.signal))return {ok:false,error:`signal-${state.signal}`};
        state.running=true;statusNote('Waiting for safe control');
        if(!state.awaiting)planNext();return {ok:true};
      }
      return {ok:false,error:'unsupported-action'};
    } catch(error) {return {ok:false,error:String(error?.message||error)};}
  }
  els.add.addEventListener('click',async()=>{
    const response=await act('enqueue',{text:els.draft.value},true);
    if(response.ok)els.draft.value='';else statusNote(response.error);
  });
  els.run.addEventListener('click',async()=>{
    const response=await act(state.running?'pause':'start',null,true);
    if(!response.ok)statusNote(response.error);
  });
  els.toggle.addEventListener('click',()=>{state.collapsed=!state.collapsed;render();});
  els.theme.addEventListener('change',async()=>{
    const next=els.theme.value;
    if(!['system','light','dark'].includes(next))return;
    state.theme=next;render();
    try{await api.storage.local.set({'chatqueue:settings:v1':{theme:next}});}catch{statusNote('Could not save theme preference');}
  });
  api.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes['chatqueue:settings:v1'])return;
    const next=changes['chatqueue:settings:v1'].newValue?.theme;
    state.theme=['system','light','dark'].includes(next)?next:'system';render();
  });
  api.runtime.onMessage.addListener((message) => {
    if(message?.type==='chat-queue-signal-verified/v1'){
      const next=contract.parse({type:contract.TYPE,signal:message.signal});
      if(!state.initialized||!next||next.route!==routeKey()||
         !contract.advance(state.trusted,next))return Promise.resolve({ok:false,error:'invalid-signal'});
      state.trusted=next;state.trustedAt=Date.now();processSignal();
      return Promise.resolve({ok:true});
    }
    if (message?.type!=='chat-queue-api/v1') return;
    return act(message.action,message.payload);
  });
  const signalObserver=new MutationObserver(records=>{
    if (records.some(r=>r.attributeName==='data-chat-signals-state')){
      state.observedSignal=signalFromPage();render();
    }
  });
  signalObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-chat-signals-state']});
  window.addEventListener('popstate',()=>void handleRouteChange());
  window.addEventListener('hashchange',()=>void handleRouteChange());
  window.addEventListener('pageshow',()=>void handleRouteChange());
  document.addEventListener('click',event=>{
    if(!event.target?.closest?.('a[href]'))return;
    for(const ms of [0,150,650]) setTimeout(()=>{
      if(state.initialized && routeKey()!==state.keyRoute) {state.keyRoute=routeKey();void handleRouteChange();}
    },ms);
  },{passive:true});
  window.addEventListener('pagehide',()=>{
    state.running=false;state.destroyed=true;
    signalObserver.disconnect();
    if(state.scheduler)clearTimeout(state.scheduler);
  },{once:true});
  (async()=>{
    try {
      const response=await api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register'});
      if(!response?.ok)throw new Error('Registration unavailable');
      state.tabId=response.tabId;state.key=storageKey();state.keyRoute=routeKey();
      const stored=await api.storage.local.get([state.key,'chatqueue:settings:v1']);
      const pref=stored['chatqueue:settings:v1']?.theme;
      state.theme=['system','light','dark'].includes(pref)?pref:'system';
      state.items=core.normalizeSaved(stored[state.key]);
      state.history=readHistory(stored[state.key]);
      state.observedSignal=signalFromPage();state.signal='unknown';state.initialized=true;
      (document.body||document.documentElement).append(host);
      state.note='Paused; press Start';render();publish();
    } catch(error) {
      state.destroyed=true;signalObserver.disconnect();
      // Do not inject a broken HUD or a partial queue.
    }
  })();
})();
