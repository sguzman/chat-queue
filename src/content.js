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
  const UI_KEY='chatqueue:ui:v1';
  const uiValid=x=>x?.version===1&&Number.isSafeInteger(x.right)&&x.right>=0&&x.right<=10000&&Number.isSafeInteger(x.bottom)&&x.bottom>=0&&x.bottom<=10000&&typeof x.collapsed==='boolean';
  const editorSelector = '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]';
  const sendSelector = 'button[data-testid="send-button"],button[data-testid="composer-submit-button"],#composer-submit-button,button[aria-label="Send prompt" i],button[aria-label="Send message" i]';
  const state = { tabId: null, key: '', items: [], history: [], running: false, awaiting: false,
    busySeen: false, attempting: null, signal: 'unknown', observedSignal:'unknown',
    trusted: null, trustedAt: 0, waiting: null, note: 'Paused', initialized: false,
    editing: null, collapsed: false, position:{right:20,bottom:84}, clearArmed: false, theme: 'system', destroyed: false, scheduler: null, revision: 0, etag: uid(), saveChain: Promise.resolve(), routing: false, blockedRecord: false, pendingImport: null, historyClearArmed: false, pendingRecovery: null, recoveredSources: [], requestHighWatermarks: Object.create(null), storageFault: false, pendingSaves: 0, registryRecovering: false };
  let routeGeneration=0;
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
    #body{min-height:0;overflow:hidden;display:flex;flex:1 1 auto;flex-direction:column}
    .panel{background:var(--panel);color:var(--text);font:13px/1.45 'Atkinson Hyperlegible Next','Atkinson Hyperlegible',system-ui,sans-serif;border:1px solid var(--border);border-radius:13px;box-shadow:0 12px 34px var(--shadow);overflow:hidden;max-height:min(75vh,680px);display:flex;flex-direction:column}
    .top{display:flex;align-items:center;gap:8px;padding:11px 12px;background:var(--header);border-bottom:1px solid var(--border);touch-action:none;user-select:none;cursor:grab}
    .top:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
    .top strong{font-size:14px;letter-spacing:.01em;flex:1}.small{font-size:11px;color:var(--muted)}
    .status{padding:8px 12px;color:var(--muted);background:var(--status);border-bottom:1px solid var(--border)}
    .items{overflow:auto;max-height:260px;min-height:0;flex:1 1 auto;padding:8px;display:flex;flex-direction:column;gap:7px}
    .item{background:var(--item);border:1px solid var(--border);border-radius:8px;padding:8px;min-width:0}
    .preview{white-space:pre-wrap;word-break:break-word;max-height:84px;overflow:hidden;margin-bottom:6px}
    .item .preview{cursor:grab;touch-action:none;user-select:none}
    .item[data-dragging] .preview{cursor:grabbing}
    .item[data-drop-side="before"]{border-top:3px solid var(--focus)}
    .item[data-drop-side="after"]{border-bottom:3px solid var(--focus)}
    .controls{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
    button,select{font:inherit;cursor:pointer;border:1px solid var(--button-border);border-radius:6px;color:var(--text);background:var(--button);padding:5px 9px}
    button:hover,select:hover{background:var(--button-hover)}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
    button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);font-weight:700}
    button.danger{color:var(--warning)}button:disabled{opacity:.42;cursor:default}
    .foot{flex:0 0 auto;padding:10px 12px;border-top:1px solid var(--border);background:var(--header)}
    details{flex:0 0 auto;border-top:1px solid var(--border);padding:8px 12px;color:var(--muted)}summary{cursor:pointer}
    .data-buttons{display:flex;flex-wrap:wrap;gap:5px;padding:8px 0 4px}.data-note{font-size:11px;margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
    .history{max-height:140px;overflow:auto}.historyitem{padding:7px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;align-items:start}
    .historytext{min-width:0;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    textarea{display:block;width:100%;min-height:58px;max-height:160px;resize:vertical;padding:9px;border:1px solid var(--button-border);border-radius:7px;background:var(--input);color:var(--text);font:inherit;margin-bottom:8px}
    .footrow{display:flex;align-items:center;justify-content:space-between;gap:8px}.empty{padding:12px;color:var(--muted);text-align:center}
    [hidden]{display:none!important}.uncertain{border-color:var(--warning)}.hint{padding:4px 0;color:var(--muted);font-size:11px}
    @media(max-width:520px){.panel{max-height:55vh}#body{overflow:auto}.items{flex:0 0 auto;max-height:170px}.top{gap:5px;padding:8px}.top strong{font-size:12px}select{max-width:90px}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
  `;
  shadow.append(style);
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.setAttribute('aria-label', 'Chat Queue');
  panel.innerHTML = `<header class="top" tabindex="0" aria-label="Queue panel. Arrow keys move it; Home resets position."><strong>Message Queue</strong><span id="count" class="small">0 queued</span><select id="theme" aria-label="Chat Queue theme" title="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><button id="reset" title="Reset position and expand queue" aria-label="Reset queue position">↺</button><button id="toggle" title="Collapse or expand queue" aria-label="Collapse queue">−</button></header>
    <div id="status" class="status" role="status"></div><div id="body"><div id="items" class="items"></div><details><summary>Recently submitted / backup</summary><div id="history" class="history"></div><div class="data-buttons"><button id="backup-export" type="button">Export queue</button><button id="backup-choose" type="button">Import JSON</button><button id="backup-confirm" type="button" hidden>Confirm import</button><button id="recovery-find" type="button">Find earlier queues</button><button id="recovery-confirm" type="button" hidden>Recover for review</button><button id="history-clear" class="danger" type="button">Forget history</button><input id="backup-file" type="file" accept=".json,application/json" hidden></div><div id="data-note" class="data-note" aria-live="polite"></div></details>
    <div class="foot"><label for="draft" class="small">Add queued message</label><textarea id="draft" placeholder="Message to send when control returns" spellcheck="true"></textarea>
    <div class="footrow"><button id="add">Add to queue</button><button id="clear" class="danger">Clear</button><button id="run" class="primary">Start</button></div>
    <div class="hint">Uses Chat Signals. Never overwrites an existing draft.</div></div></div>`;
  shadow.append(panel);
  const els = Object.fromEntries(['count','toggle','reset','theme','status','body','items','history','backup-export','backup-choose','backup-confirm','backup-file','history-clear','recovery-find','recovery-confirm','data-note','draft','add','clear','run'].map(id => [id,shadow.getElementById(id)]));
  const button = (label, title, fn, disabled=false) => {
    const b=document.createElement('button'); b.type='button'; b.textContent=label; b.title=title; b.setAttribute('aria-label',title); b.disabled=disabled; b.addEventListener('click',fn); return b;
  };
  const pending = () => state.items.some(item => item.status === 'pending');
  const uncertain = () => state.items.some(item => item.status === 'uncertain');
  const signalFromPage = () => core.validPhase(document.documentElement.dataset.chatSignalsState);
  const header=panel.querySelector('.top');
  function place(){
    // CSS zoom scales fixed HUD geometry but not its 370px width cap.
    // Budget dimensions in rendered viewport pixels, then convert to CSS units.
    const zoom=Math.max(0.25,Math.min(8,Number.parseFloat(getComputedStyle(document.documentElement).zoom)||1));
    host.style.width=`${Math.min(370,Math.max(100,(innerWidth-32)/zoom))}px`;
    const fraction=innerWidth<=520?0.55:0.75;
    panel.style.maxHeight=`${Math.max(48,Math.min(680,innerHeight*fraction,(innerHeight-16)/zoom))}px`;
    const rect=host.getBoundingClientRect();
    const maxRight=Math.max(0,(innerWidth-rect.width)/zoom);
    const maxBottom=Math.max(0,(innerHeight-rect.height)/zoom);
    const x=Math.min(Math.max(0,state.position.right),maxRight);
    const y=Math.min(Math.max(0,state.position.bottom),maxBottom);
    host.style.right=`${x}px`;host.style.bottom=`${y}px`;
    return {right:Math.round(x),bottom:Math.round(y)};
  }
  function saveLayout(){
    state.position=place();
    void api.storage.local.set({[UI_KEY]:{version:1,...state.position,collapsed:state.collapsed}})
      .catch(()=>statusNote('Could not save HUD placement'));
  }
  let dragging=null;
  header.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target?.closest?.('button,select')||!state.initialized)return;
    dragging={id:event.pointerId,x:event.clientX,y:event.clientY,...state.position,moved:false};
    try{header.setPointerCapture(event.pointerId);}catch{dragging=null;}
  });
  header.addEventListener('pointermove',event=>{
    if(!dragging||event.pointerId!==dragging.id)return;
    dragging.moved=true;
    state.position={right:dragging.right+dragging.x-event.clientX,bottom:dragging.bottom+dragging.y-event.clientY};
    state.position=place();
  });
  function endDrag(event){if(dragging&&event.pointerId===dragging.id){const didMove=dragging.moved;dragging=null;if(didMove)saveLayout();}}
  header.addEventListener('pointerup',endDrag);
  header.addEventListener('pointercancel',endDrag);
  header.addEventListener('keydown',event=>{
    if(event.target!==header||!state.initialized)return;
    const delta=event.shiftKey?32:12;
    const move={ArrowLeft:[delta,0],ArrowRight:[-delta,0],ArrowUp:[0,delta],ArrowDown:[0,-delta]}[event.key];
    if(move){event.preventDefault();state.position={right:state.position.right+move[0],bottom:state.position.bottom+move[1]};saveLayout();}
    else if(event.key==='Home'){event.preventDefault();state.position={right:20,bottom:84};saveLayout();}
  });
  window.addEventListener('resize',()=>place());

  // Clock changes must not make an old provider event freshly authorized.
  // performance.now() is monotonic within this content-script document.
  const freshProvider = () => Boolean(state.trusted&&state.trusted.route===routeKey()&&
    state.trusted.origin==='fresh'&&state.trusted.confidence!=='unknown'&&
    performance.now()-state.trustedAt>=0&&performance.now()-state.trustedAt<15000);
  function render() {
    if (state.destroyed) return;
    host.dataset.theme=state.theme;els.theme.value=state.theme;
    els.count.textContent = `${state.items.length} queued`;
    els.status.textContent = `Signal: ${state.trusted ? state.signal : state.observedSignal+' (unverified)'} • ${state.running ? 'Running' : 'Paused'} • ${state.note}`;
    els.run.textContent = state.running ? 'Pause' : 'Start';
    els.clear.textContent=state.clearArmed ? 'Confirm clear' : 'Clear';
    els['backup-confirm'].hidden=!state.pendingImport;
    els['backup-confirm'].textContent=state.pendingImport?'Append '+state.pendingImport.items.length+' messages':'Confirm import';
    els['history-clear'].textContent=state.historyClearArmed?'Confirm forget':'Forget history';
    els['recovery-confirm'].hidden=!state.pendingRecovery;
    els['recovery-confirm'].textContent=state.pendingRecovery?'Recover '+state.pendingRecovery.items.length+' for review':'Recover for review';
    els['recovery-find'].disabled=state.blockedRecord||state.running||state.awaiting||Boolean(state.attempting)||state.routing;
    els['history-clear'].disabled=!state.history.length||state.running||state.awaiting||Boolean(state.attempting);
    els.clear.disabled=!state.items.length||Boolean(state.attempting);
    els.toggle.textContent = state.collapsed ? '+' : '−';
    els.toggle.setAttribute('aria-label',state.collapsed ? 'Expand queue' : 'Collapse queue');
    els.body.hidden = state.collapsed;
    els.status.hidden = state.collapsed;
    place();
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
      // Handle real pointer drag with explicit before/after insertion zones.
      // Keyboard Up/Down remains available and never depends on pointer input.
      row.dataset.itemId=item.id;
      let pointer=null;
      const locate=(x,y)=>{
        for(const candidate of els.items.querySelectorAll('.item')){
          const rect=candidate.getBoundingClientRect();
          if(x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)continue;
          const index=state.items.findIndex(entry=>entry.id===candidate.dataset.itemId);
          if(index<0)return null;
          const after=y>rect.top+rect.height/2;
          return {row:candidate,side:after?'after':'before',
            beforeId:after?(state.items[index+1]?.id||null):candidate.dataset.itemId};
        }
        return null;
      };
      const clearDrop=()=>{
        for(const candidate of els.items.querySelectorAll('[data-drop-side]'))
          delete candidate.dataset.dropSide;
        delete row.dataset.dragging;
      };
      row.addEventListener('pointerdown',event=>{
        if(state.attempting||event.button!==0||!event.target?.closest?.('.preview'))return;
        pointer={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
        try{row.setPointerCapture(event.pointerId);}catch{pointer=null;}
      });
      row.addEventListener('pointermove',event=>{
        if(!pointer||pointer.id!==event.pointerId)return;
        if(!pointer.moved && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<8)return;
        pointer.moved=true;
        clearDrop();row.dataset.dragging='true';
        const target=locate(event.clientX,event.clientY);
        if(target)target.row.dataset.dropSide=target.side;
      });
      function endPointer(event,cancelled=false){
        if(!pointer||pointer.id!==event.pointerId)return;
        const drag=pointer;pointer=null;
        const target=!cancelled&&drag.moved&&!state.attempting?locate(event.clientX,event.clientY):null;
        clearDrop();
        try{if(row.hasPointerCapture(event.pointerId))row.releasePointerCapture(event.pointerId);}catch{}
        if(!target)return;
        const next=core.moveTo(state.items,item.id,target.beforeId);
        if(next.every((entry,index)=>entry.id===state.items[index]?.id))return;
        state.items=next;void save();render();
      }
      row.addEventListener('pointerup',event=>endPointer(event));
      row.addEventListener('pointercancel',event=>endPointer(event,true));
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
        if (item.status==='uncertain') ctrls.append(button('Retry','Allow manually requested retry',async()=>{
          const reply=await act('resolve',{id:item.id,decision:'retry'},true);
          if(!reply.ok)statusNote(reply.error);
        },locked||state.running||state.awaiting));
        row.append(ctrls);
      }
      els.items.append(row);
    });
  }
  function statusNote(message) { state.note = message; render();publish(); }
  async function recoverRegistry(){
    if(state.registryRecovering||!state.initialized||state.destroyed||
       state.routing||state.key!==storageKey())return;
    state.registryRecovering=true;
    const key=state.key,route=routeKey();
    // Re-registration is metadata-only. A restarted event page lost every
    // authenticated provider epoch; never inherit authority from this tab.
    state.running=false;state.trusted=null;state.trustedAt=0;state.signal='unknown';
    state.waiting=null;state.awaiting=false;state.busySeen=false;
    if(state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;
    state.note='Signal registry restarted; manually resume after reconnect';
    render();
    let restored=false;
    try{
      const answer=await api.runtime.sendMessage({
        type:'chat-queue-internal/v1',action:'register',route});
      if(answer?.ok&&state.key===key&&routeKey()===route&&!state.destroyed){
        state.tabId=answer.tabId;
        restored=true;
      }
    }catch{
      if(state.key===key&&!state.destroyed)statusNote('Background registry unavailable; paused');
    }finally{
      state.registryRecovering=false;
      if(restored&&!state.destroyed)publish();
    }
  }
  function publish() {
    if (state.tabId == null || state.destroyed || state.registryRecovering) return;
    void api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'state',phase:state.signal,size:state.items.length,running:state.running,awaiting:state.awaiting,revision:state.revision})
      .then(reply=>{if(reply?.error==='route-mismatch')void recoverRegistry();})
      .catch(()=>{});
  }
  function save() {
    if(state.blockedRecord)return Promise.reject(new Error('unsupported-saved-queue'));
    state.clearArmed=false;
    state.revision++;state.etag=uid();const key=state.key;const data={version:1,items:state.items.map(item=>({id:item.id,text:item.text,status:item.status})),history:state.history.slice(0,20),recoveredSources:state.recoveredSources.slice(-32),requestHighWatermarks:{...state.requestHighWatermarks}};
    // Synchronous pending-write accounting prevents a fast Start from
    // dispatching a message whose local queue write has not committed.
    state.pendingSaves++;
    const write=state.saveChain.catch(()=>{}).then(()=>api.storage.local.set({[key]:data}));
    state.saveChain=write;
    void write.then(()=>{
      if(state.key!==key)return;
      state.pendingSaves=Math.max(0,state.pendingSaves-1);
      if(state.storageFault){
        state.storageFault=false;
        statusNote('Storage restored; manually press Start');
      }
    },()=>{
      if(state.key!==key)return;
      state.pendingSaves=Math.max(0,state.pendingSaves-1);
      state.storageFault=true;state.running=false;
      statusNote('Could not save queue; paused');
    });
    publish();return write;
  }
  function editorValue(editor) {
    return (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : editor.innerText || editor.textContent || '').replace(/\r\n/g,'\n');
  }
  const canonicalComposerText=text=>text.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ');
  function findComposer() {
    const found=[...document.querySelectorAll(editorSelector)].filter(e=>e.isConnected && e.getClientRects().length && e.getAttribute('contenteditable')!=='false');
    if (found.length !== 1) throw new Error('Composer is missing or ambiguous');
    const editor=found[0];
    const form=editor.closest('form');
    if (!form || !form.contains(editor)) throw new Error('Composer form is missing');
    if (editorValue(editor).length) throw new Error('Composer contains a draft; preserved it');
    if ([...form.querySelectorAll('input[type="file"]')].some(input=>input.files?.length))
      throw new Error('Composer has attachments');
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
    const value=canonicalComposerText(editorValue(editor));
    if (value !== canonicalComposerText(text)) throw new Error('Composer did not accept the exact message');
  }
  function findSend(form) {
    const buttons=[...form.querySelectorAll(sendSelector)].filter(e=>!e.disabled && e.getAttribute('aria-disabled')!=='true' && e.getClientRects().length);
    if (buttons.length !== 1) throw new Error('Send button missing, disabled or ambiguous');
    return buttons[0];
  }
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function dispatchOne() {
    if (!state.running || state.attempting || state.awaiting || !pending()) return;
    if(state.storageFault||state.pendingSaves>0){
      state.running=false;
      statusNote('Unsaved queue; manually restart after storage settles');
      return;
    }
    if (state.key!==storageKey()) {void handleRouteChange();return;}
    if (!freshProvider() || !contract.ready(state.trusted,routeKey())) return;
    const item=state.items.find(e=>e.status==='pending');
    if (!item) return;
    const attemptKey=state.key;
    const baseline=state.trusted;
    state.attempting=item.id;
    statusNote('Preparing next message');
    let clicked=false;
    let editor,send;
    let humanTouched=false;
    const onHumanInput=event=>{if(event.isTrusted)humanTouched=true;};
    try {
      if (state.key!==attemptKey||storageKey()!==attemptKey)
        throw new Error('Conversation changed before composer handoff');
      // Reserve the exact-route owner before changing the page composer.
      // Competing tabs fail while their drafts remain completely untouched.
      const ownership=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
        action:'dispatch-check',route:baseline.route,documentToken:baseline.documentToken,
        epoch:baseline.epoch,sequence:baseline.sequence});
      if(!ownership?.ok)throw new Error(ownership?.error==='conversation-owned-by-another-tab'
        ? 'Another tab owns this conversation; no Send attempted'
        : 'Signal authority lost; no Send attempted');
      if(!state.running||state.destroyed||state.key!==attemptKey||storageKey()!==attemptKey)
        throw new Error('Dispatch context changed before composer handoff');
      const found=findComposer();
      // Journal uncertainty BEFORE exposing queue text in the page composer.
      // A human click during async preflight must not send unjournaled text.
      item.status='uncertain';
      await save();
      if(!state.running||state.destroyed||state.storageFault||state.pendingSaves>0||
         state.key!==attemptKey||storageKey()!==attemptKey)
        throw new Error('Dispatch changed during uncertainty journal');
      // Another browser/user input may have appeared while storage committed.
      const current=findComposer();
      if(current.editor!==found.editor||current.form!==found.form)
        throw new Error('Composer replaced during uncertainty journal');
      editor=current.editor;
      fillComposer(editor,item.text);
      send=findSend(current.form);
      editor.addEventListener('beforeinput',onHumanInput,true);
      editor.addEventListener('input',onHumanInput,true);
      send.addEventListener('click',onHumanInput,true);
      // Require the event page to still own this authenticated provider
      // epoch immediately pre-click; a restart invalidates its volatile ledger.
      const permission=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
        action:'dispatch-check',route:baseline.route,documentToken:baseline.documentToken,
        epoch:baseline.epoch,sequence:baseline.sequence});
      if(!permission?.ok)throw new Error('Signal authority lost; no Send attempted');
      if (!state.running || state.destroyed || state.key!==attemptKey ||storageKey()!==attemptKey ||
          state.storageFault || state.pendingSaves>0 || humanTouched ||
          !freshProvider() || state.trusted!==baseline || !send.isConnected ||
          canonicalComposerText(editorValue(editor))!==canonicalComposerText(item.text))
        throw new Error('Dispatch context changed; no send attempted');
      // A new attachment, editor, form or Send control after our initial
      // preflight is a genuine user/DOM conflict even if text still matches.
      const form=editor.closest('form');
      if(!form?.isConnected ||
         [...document.querySelectorAll(editorSelector)].filter(e=>e.isConnected&&e.getClientRects().length&&e.getAttribute('contenteditable')!=='false').length!==1 ||
         [...form.querySelectorAll('input[type="file"]')].some(input=>input.files?.length) ||
         findSend(form)!==send)
        throw new Error('Composer changed before Send; no send attempted');
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
      if(editor){
        editor.removeEventListener('beforeinput',onHumanInput,true);
        editor.removeEventListener('input',onHumanInput,true);
      }
      if(send)send.removeEventListener('click',onHumanInput,true);
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
      if (!state.running || state.awaiting || state.attempting || state.blockedRecord ||
          !freshProvider() || !contract.ready(state.trusted,routeKey())) return;
      if (!pending()) {state.running=false;statusNote('Queue completed');return;}
      void dispatchOne();
    },350);
  }
  function readHistory(saved) {
    return Array.isArray(saved?.history) ? saved.history.filter(h=>h&&typeof h.id==='string'&&core.validText(h.text)&&Number.isSafeInteger(h.at)).slice(0,20).map(h=>({id:h.id,text:h.text,at:h.at,status:['submitted','finished','interrupted','failed'].includes(h.status)?h.status:'submitted'})) : [];
  }
  function readRecoverySources(saved){
    return Array.isArray(saved?.recoveredSources)
      ? [...new Set(saved.recoveredSources.filter(key=>typeof key==='string'&&key.startsWith('chatqueue:v1:tab:')))].slice(-32)
      : [];
  }
  async function handleRouteChange() {
    if(!state.initialized)return;
    const newKey=storageKey();
    // Duplicate navigation notices must not invalidate an in-flight
    // restore after its route key was assigned but before registration ends.
    // A -> B -> A can happen while B's async storage read is pending.
    // Returning to the prior key must cancel the in-flight transition
    // instead of leaving routing=true indefinitely.
    if (state.key===newKey&&!state.routing)return;
    const generation=++routeGeneration;
    state.routing=true;
    state.clearArmed=false;state.historyClearArmed=false;state.pendingImport=null;state.pendingRecovery=null;
    state.running=false;state.awaiting=false;state.attempting=null;state.busySeen=false;
    state.waiting=null;state.trusted=null;state.trustedAt=0;state.signal='unknown';
    if (state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;
    await state.saveChain.catch(()=>{});
    if(generation!==routeGeneration||storageKey()!==newKey)return;
    let stored;
    try{stored=await api.storage.local.get(newKey);}catch{
      if(generation!==routeGeneration||storageKey()!==newKey)return;
      // Failed reads must never display the previous conversation's queued
      // prompts under a new route. Block editing without overwriting either
      // persistent record, and let a later navigation/reload retry.
      state.key=newKey;
      state.storageFault=true;state.blockedRecord=true;
      state.items=[];state.history=[];state.recoveredSources=[];state.requestHighWatermarks=Object.create(null);
      state.revision=0;state.etag=uid();state.editing=null;
      state.running=false;state.awaiting=false;state.routing=false;
      statusNote('Could not load conversation queue; reload to retry');
      return;
    }
    if(generation!==routeGeneration||storageKey()!==newKey)return;
    state.key=newKey;
    state.storageFault=false;state.pendingSaves=0;
    state.revision=0;state.etag=uid(); // invalidate stale compare tokens across routes
    state.blockedRecord=!core.savedRecordSupport(stored[newKey]).ok;
    state.items=state.blockedRecord?[]:core.normalizeSaved(stored[newKey]);
    state.history=state.blockedRecord?[]:readHistory(stored[newKey]);
    state.recoveredSources=state.blockedRecord?[]:readRecoverySources(stored[newKey]);
    state.requestHighWatermarks=state.blockedRecord?Object.create(null):core.readRequestHighWatermarks(stored[newKey]);
    state.observedSignal=signalFromPage();state.note=state.blockedRecord?'Unsupported saved queue; editing disabled':'Conversation changed; manually start queue';state.editing=null;
    // A new route also invalidates the background's Signal document sequence.
    try{await api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:routeKey()});}catch{}
    if(generation!==routeGeneration||storageKey()!==newKey)return;
    state.routing=false;render();publish();
  }
  async function act(action,payload,local=false,requester=null) {
    if (!state.initialized) return {ok:false,error:'not-ready'};
    if(state.routing)return {ok:false,error:'route-transition'};
    if(state.key!==storageKey())await handleRouteChange();
    if(state.routing||state.key!==storageKey())return {ok:false,error:'route-transition'};
    try {
      if (action==='status') return {ok:true,tabId:state.tabId,phase:state.signal,running:state.running,awaiting:state.awaiting,readOnly:state.blockedRecord,revision:state.revision,etag:state.etag,items:state.items.map(e=>({...e})),history:state.history.map(e=>({...e}))};
      if (state.blockedRecord) return {ok:false,error:'unsupported-saved-queue'};
      // Optional optimistic compare-and-swap. A random per-document token
      // prevents revision ABA after reload or a new tab instance.
      if (['enqueue','enqueueSequenced','update','reorder','move','remove','clear','resolve'].includes(action) &&
          payload && Object.hasOwn(payload,'ifMatch') && payload.ifMatch!==state.etag)
        return {ok:false,error:'revision-conflict',revision:state.revision};
      if (action==='enqueueSequenced') {
        // Caller identity comes from the browser-authenticated background,
        // never an external caller-supplied payload field. Persist the
        // strictly increasing high-water mark in the SAME queue record as the
        // new item: an ambiguous callback cannot enqueue a second copy.
        const id=requester;
        const seq=payload?.sequence;
        if(local||typeof id!=='string'||!id.length||id.length>256)
          return {ok:false,error:'invalid-client'};
        if(!Number.isSafeInteger(seq)||seq<=0)
          return {ok:false,error:'invalid-request-sequence'};
        if(Object.hasOwn(state.requestHighWatermarks,id)){
          if(seq<=state.requestHighWatermarks[id])
            return {ok:false,error:'replayed-request'};
        }else if(Object.keys(state.requestHighWatermarks).length>=core.MAX_REQUEST_CLIENTS){
          return {ok:false,error:'request-client-limit'};
        }
        if(state.items.length>=core.MAX_ITEMS)return {ok:false,error:'queue-full'};
        const item=core.makeItem(payload?.text,uid());
        state.items.push(item);
        state.requestHighWatermarks[id]=seq;
        await save();render();
        if(state.running&&!state.awaiting)planNext();
        return {ok:true,id:item.id,etag:state.etag};
      }
      if (action==='enqueue') {
        const text=payload?.text;
        if (state.items.length>=core.MAX_ITEMS) return {ok:false,error:'queue-full'};
        const item=core.makeItem(text,uid());state.items.push(item);await save();render();
        if(state.running&&!state.awaiting)planNext();
        return {ok:true,id:item.id,etag:state.etag};
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
        if(!core.exactPermutation(state.items,ids))return {ok:false,error:'invalid-order'};
        state.items=ids.map(id=>state.items.find(i=>i.id===id));await save();render();return {ok:true};
      }
      if (action==='move') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        const id=payload?.id,beforeId=payload?.beforeId??null;
        if(typeof id!=='string'||!state.items.some(item=>item.id===id)||
           (beforeId!==null&&(typeof beforeId!=='string'||!state.items.some(item=>item.id===beforeId)))||
           id===beforeId)return {ok:false,error:'invalid-order'};
        state.items=core.moveTo(state.items,id,beforeId);await save();render();return {ok:true};
      }
      if (action==='remove' || action==='clear') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        state.items=action==='clear'?[]:state.items.filter(i=>i.id!==payload?.id);await save();render();return {ok:true};
      }
      if (action==='resolve') {
        // Recovery is never an implicit continuation of an active or
        // in-flight response; a separate Start must follow deliberate review.
        if(state.running||state.awaiting||state.attempting)
          return {ok:false,error:'pause-before-resolving-uncertain'};
        const item=state.items.find(i=>i.id===payload?.id && i.status==='uncertain');
        if(!item)return {ok:false,error:'not-uncertain'};
        if(payload?.decision==='retry')item.status='pending';
        else if(payload?.decision==='discard')state.items=state.items.filter(i=>i.id!==item.id);
        else return {ok:false,error:'invalid-decision'};
        await save();
        statusNote(payload.decision==='retry'
          ? 'Retry marked pending; press Start separately'
          : 'Uncertain message discarded; queue remains paused');
        return {ok:true};
      }
      if (action==='pause') {state.running=false;if(state.scheduler)clearTimeout(state.scheduler);state.scheduler=null;statusNote('Manually paused');return {ok:true};}
      if (action==='start') {
        if (state.storageFault)return {ok:false,error:'storage-unavailable'};
        if (state.pendingSaves>0)return {ok:false,error:'queue-save-pending'};
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
  // All file operations are deliberately initiated by a local user gesture.
  // No backup is transferred to the page, a server, or another extension.
  els['backup-export'].addEventListener('click',()=>{
    if(state.blockedRecord||state.attempting||state.routing){statusNote('Backup unavailable while queue changes');return;}
    try{
      const payload=core.backupItems(state.items);
      const blob=new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'});
      if(blob.size>core.MAX_BACKUP_BYTES)throw new Error('backup-too-large');
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download='chat-queue-messages.json';
      shadow.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),10000);
      statusNote('Queue backup download requested');
    }catch(error){statusNote('Backup rejected: '+String(error.message||error));}
  });
  els['backup-choose'].addEventListener('click',()=>{
    if(state.running||state.awaiting||state.attempting||state.routing||state.blockedRecord){
      statusNote('Pause and finish the current response before importing');return;
    }
    els['backup-file'].value='';els['backup-file'].click();
  });
  els['backup-file'].addEventListener('change',async()=>{
    const file=els['backup-file'].files?.[0];
    if(!file)return;
    const key=state.key,generation=routeGeneration;
    state.pendingImport=null;
    if(file.size>core.MAX_BACKUP_BYTES){els['data-note'].textContent='File too large (16 MiB limit)';render();return;}
    try{
      const data=core.parseBackup(JSON.parse(await file.text()));
      if(state.destroyed||state.key!==key||generation!==routeGeneration||
         state.running||state.awaiting||state.attempting||state.routing) {
        els['data-note'].textContent='Conversation or queue changed; import cancelled';return;
      }
      if(state.items.length+data.length>core.MAX_ITEMS)
        throw new Error('Queue would exceed 100 messages');
      state.pendingImport={key,items:data};
      els['data-note'].textContent='Review: '+data.length+' messages; no automatic sending. Click Confirm import to append.';
      render();
    }catch(error){els['data-note'].textContent='Import rejected: '+String(error?.message||error);render();}
  });
  els['backup-confirm'].addEventListener('click',async()=>{
    const draft=state.pendingImport;
    if(!draft||draft.key!==state.key||state.key!==storageKey()||state.blockedRecord||
       state.running||state.awaiting||state.attempting||state.routing)return;
    if(state.items.length+draft.items.length>core.MAX_ITEMS){statusNote('Queue full');return;}
    const original=state.items.slice();
    state.items.push(...draft.items.map(item=>({...core.makeItem(item.text,uid()),status:item.status})));
    try{
      await save();state.pendingImport=null;
      els['data-note'].textContent='Imported '+draft.items.length+' messages; queue remains paused';
      render();
    }catch{
      state.items=original;statusNote('Import could not be stored; queue paused');
    }
  });
  // This storage enumeration is only performed after a local HUD click.
  // Never auto-import from an old tab ID: even a former pending item might
  // have been submitted before an unobserved browser shutdown.
  els['recovery-find'].addEventListener('click',async()=>{
    if(state.blockedRecord||state.running||state.awaiting||state.attempting||state.routing)return;
    state.pendingRecovery=null;
    const key=state.key,generation=routeGeneration,revision=state.revision;
    try{
      const records=await api.storage.local.get(null);
      if(state.destroyed||state.key!==key||storageKey()!==key||generation!==routeGeneration||
         state.revision!==revision||state.running||state.awaiting||state.attempting||state.routing)return;
      const choices=core.recoveryCandidates(records,routeKey(),key,state.recoveredSources);
      if(!choices.length){els['data-note'].textContent='No other compatible queue saved for this conversation';render();return;}
      // Recover one source at a time. A confirmation is always necessary,
      // and source records are not erased or automatically scheduled.
      const choice=choices[0];
      const items=core.normalizeSaved(records[choice.key]).map(item=>({text:item.text,status:'uncertain'}));
      if(!items.length||state.items.length+items.length>core.MAX_ITEMS){
        els['data-note'].textContent='Recovery would exceed the 100-message limit';render();return;
      }
      state.pendingRecovery={key,sourceKey:choice.key,revision,items};
      els['data-note'].textContent='Found '+choices.length+' earlier queue(s) for this exact conversation. '+items.length+' message(s) will be restored as uncertain, never sent automatically. Confirm to copy.';
      render();
    }catch{els['data-note'].textContent='Could not inspect earlier local queues';render();}
  });
  els['recovery-confirm'].addEventListener('click',async()=>{
    const draft=state.pendingRecovery;
    if(!draft||draft.key!==state.key||storageKey()!==state.key||
       draft.revision!==state.revision||state.blockedRecord||state.running||
       state.awaiting||state.attempting||state.routing)return;
    if(state.items.length+draft.items.length>core.MAX_ITEMS){statusNote('Queue full');return;}
    const before=state.items.slice(),sources=state.recoveredSources.slice();
    state.items.push(...draft.items.map(item=>({...core.makeItem(item.text,uid()),status:'uncertain'})));
    state.recoveredSources.push(draft.sourceKey);
    try{
      await save();
      state.pendingRecovery=null;
      els['data-note'].textContent='Recovered '+draft.items.length+' messages for manual review; queue remains paused';
      render();
    }catch{
      state.items=before;state.recoveredSources=sources;
      state.pendingRecovery=null;statusNote('Recovery could not be saved; no automatic send');
    }
  });
  els['history-clear'].addEventListener('click',async()=>{
    if(state.running||state.awaiting||state.attempting||!state.history.length)return;
    if(!state.historyClearArmed){state.historyClearArmed=true;render();return;}
    state.historyClearArmed=false;
    const oldHistory=state.history.slice();state.history=[];
    try{await save();render();}catch{state.history=oldHistory;render();}
  });
  shadow.addEventListener('click',event=>{
    if(state.historyClearArmed&&event.target!==els['history-clear']){
      state.historyClearArmed=false;queueMicrotask(()=>render());
    }
  },true);
  els.add.addEventListener('click',async()=>{
    const response=await act('enqueue',{text:els.draft.value},true);
    if(response.ok)els.draft.value='';else statusNote(response.error);
  });
  // Confirm clear must require consecutive intent. Any unrelated click
  // cancels an armed confirmation, including clicks outside the HUD.
  shadow.addEventListener('click',event=>{
    if(state.clearArmed&&event.target!==els.clear){
      state.clearArmed=false;
      queueMicrotask(()=>render());
    }
  },true);
  document.addEventListener('click',event=>{
    if(state.clearArmed&&!host.contains(event.target)){
      state.clearArmed=false;
      render();
    }
  },true);
  els.clear.addEventListener('click',async()=>{
    if(state.attempting||!state.items.length)return;
    if(!state.clearArmed){
      state.clearArmed=true;
      statusNote('Press Confirm clear to remove every queued message');
      return;
    }
    state.clearArmed=false;
    // Stop scheduled next-item dispatch before emptying the queue.
    if(state.running)await act('pause',null,true);
    const response=await act('clear',null,true);
    if(!response.ok)statusNote(response.error);
    else statusNote('Queue cleared');
  });
  els.run.addEventListener('click',async()=>{
    const response=await act(state.running?'pause':'start',null,true);
    if(!response.ok)statusNote(response.error);
  });
  els.toggle.addEventListener('click',()=>{state.collapsed=!state.collapsed;render();saveLayout();});
  els.reset.addEventListener('click',()=>{state.collapsed=false;state.position={right:20,bottom:84};render();saveLayout();});
  els.theme.addEventListener('change',async()=>{
    const next=els.theme.value;
    if(!['system','light','dark'].includes(next))return;
    state.theme=next;render();
    try{await api.storage.local.set({'chatqueue:settings:v1':{theme:next}});}catch{statusNote('Could not save theme preference');}
  });
  api.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local')return;
    if(changes['chatqueue:settings:v1']){
      const next=changes['chatqueue:settings:v1'].newValue?.theme;
      state.theme=['system','light','dark'].includes(next)?next:'system';
    }
    if(changes[UI_KEY]&&uiValid(changes[UI_KEY].newValue)){
      const ui=changes[UI_KEY].newValue;state.position={right:ui.right,bottom:ui.bottom};state.collapsed=ui.collapsed;
    }
    render();
  });
  api.runtime.onMessage.addListener((message) => {
    if(message?.type==='chat-queue-route-changed/v1'){
      void handleRouteChange();
      return Promise.resolve({ok:true});
    }
    if(message?.type==='chat-queue-signal-verified/v1'){
      const next=contract.parse({type:contract.TYPE,signal:message.signal});
      if(!state.initialized||!next||next.route!==routeKey()||
         !contract.advance(state.trusted,next))return Promise.resolve({ok:false,error:'invalid-signal'});
      state.trusted=next;state.trustedAt=performance.now();processSignal();
      return Promise.resolve({ok:true});
    }
    if (message?.type!=='chat-queue-api/v1') return;
    return act(message.action,message.payload,false,message.requester);
  });
  const signalObserver=new MutationObserver(records=>{
    if (records.some(r=>r.attributeName==='data-chat-signals-state')){
      state.observedSignal=signalFromPage();render();
    }
  });
  signalObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-chat-signals-state']});
  // ChatGPT can use history.pushState without popstate, clicks or DOM changes.
  // Sample only pathname, never transcript/DOM. Browser throttling is harmless:
  // every dispatch and API mutation independently rechecks the current route.
  // Metadata-only heartbeat on the existing route-watch timer. A Firefox
  // event-page shutdown loses TABS/ROUTES without notifying the content script.
  // The next heartbeat detects route-mismatch, pauses and re-registers; it
  // never restores provider authority or automatically clicks Send.
  const REGISTRY_HEARTBEAT_TICKS=60;
  let heartbeatTicks=0;
  const routeWatch=setInterval(()=>{
    if(!state.initialized||state.destroyed)return;
    if(routeKey()!==state.keyRoute){
      heartbeatTicks=0;
      state.keyRoute=routeKey();void handleRouteChange();
    }else if(!state.routing&&state.key===storageKey()&&
             ++heartbeatTicks>=REGISTRY_HEARTBEAT_TICKS){
      heartbeatTicks=0;publish();
    }
  },1000);
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
    signalObserver.disconnect();clearInterval(routeWatch);
    if(state.scheduler)clearTimeout(state.scheduler);
  },{once:true});
  (async()=>{
    try {
      const response=await api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:routeKey()});
      if(!response?.ok)throw new Error('Registration unavailable');
      state.tabId=response.tabId;state.key=storageKey();state.keyRoute=routeKey();
      const stored=await api.storage.local.get([state.key,'chatqueue:settings:v1',UI_KEY]);
      const pref=stored['chatqueue:settings:v1']?.theme;
      state.theme=['system','light','dark'].includes(pref)?pref:'system';
      const ui=uiValid(stored[UI_KEY])?stored[UI_KEY]:{right:20,bottom:84,collapsed:false};
      state.position={right:ui.right,bottom:ui.bottom};state.collapsed=ui.collapsed;
      state.blockedRecord=!core.savedRecordSupport(stored[state.key]).ok;
      state.items=state.blockedRecord?[]:core.normalizeSaved(stored[state.key]);
      state.history=state.blockedRecord?[]:readHistory(stored[state.key]);
      state.recoveredSources=state.blockedRecord?[]:readRecoverySources(stored[state.key]);
      state.requestHighWatermarks=state.blockedRecord?Object.create(null):core.readRequestHighWatermarks(stored[state.key]);
      state.observedSignal=signalFromPage();state.signal='unknown';state.initialized=true;
      (document.body||document.documentElement).append(host);
      state.note=state.blockedRecord?'Unsupported saved queue; editing disabled':'Paused; press Start';render();publish();
      if(state.key!==storageKey())void handleRouteChange();
    } catch(error) {
      state.destroyed=true;signalObserver.disconnect();clearInterval(routeWatch);
      // Do not inject a broken HUD or a partial queue.
    }
  })();
})();
