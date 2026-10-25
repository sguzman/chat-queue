/* Firefox Chat Queue content script. Chat Signals is the ONLY state detector. */
(() => {
  'use strict';
  if (globalThis.__chatQueuePrototype) return;
  globalThis.__chatQueuePrototype = true;
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.ChatQueueCore;
  const contract = globalThis.ChatQueueSignal;
  const rulesEngine = globalThis.ChatQueueRules;
  const ruleStore = globalThis.ChatQueueRuleStore;
  if (!api?.runtime?.sendMessage || !core || !contract || !rulesEngine || !ruleStore) return;
  const uid = () => crypto.randomUUID();
  const UI_KEY='chatqueue:ui:v1';
  const uiValid=x=>x?.version===1&&Number.isSafeInteger(x.right)&&x.right>=0&&x.right<=10000&&Number.isSafeInteger(x.bottom)&&x.bottom>=0&&x.bottom<=10000&&typeof x.collapsed==='boolean';
  const editorSelector = '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]';
  const sendSelector = 'button[data-testid="send-button"],button[data-testid="composer-submit-button"],#composer-submit-button,button[aria-label="Send prompt" i],button[aria-label="Send message" i]';
  const state = { tabId: null, key: '', items: [], history: [], running: false, awaiting: false,
    busySeen: false, attempting: null, signal: 'unknown', observedSignal:'unknown',
    trusted: null, trustedAt: 0, waiting: null, note: 'Paused', initialized: false,
    editing: null, collapsed: false, position:{right:20,bottom:84}, clearArmed: false, theme: 'system', destroyed: false, scheduler: null, revision: 0, etag: uid(), saveChain: Promise.resolve(), routing: false, blockedRecord: false, pendingImport: null, importing: false, historyClearArmed: false, pendingRecovery: null, recoveredSources: [], requestHighWatermarks: Object.create(null), storageFault: false, pendingSaves: 0, registryRecovering: false, inflightProof: null, adding: false, rulesEnabled: false, rulesLoading: false, ruleLibrary: [], ruleOffer: null, ruleSeen: [], ruleAudit: [], ruleCompleted: [], ruleConsentGeneration: 0, ruleClock: null, ruleClosedEpoch: null };
  let routeGeneration=0;
  // Every metadata publication is ordered within the content-script document.
  // Async Firefox tab URL lookups may otherwise apply a stale paused state
  // after a later running state, incorrectly releasing a dispatch-owner lease.
  let statePublishSequence=0;
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
    <details id="rules-panel"><summary>Conditional proposals (off)</summary><div id="rules-note" class="data-note" aria-live="polite">Disabled until explicitly enabled. No automatic sending.</div><div class="data-buttons"><button id="rules-toggle" type="button">Enable previews</button><button id="rules-approve" type="button" hidden>Approve proposal</button><button id="rules-dismiss" type="button" hidden>Dismiss</button></div><details id="rules-audit-panel"><summary>Review history (<span id="rules-audit-count">0</span>, this conversation only)</summary><div id="rules-audit" class="history" aria-label="Conditional review audit"></div></details></details>
    <div class="foot"><label for="draft" class="small">Add queued message</label><textarea id="draft" placeholder="Message to send when control returns" spellcheck="true"></textarea>
    <div class="footrow"><button id="add">Add to queue</button><button id="clear" class="danger">Clear</button><button id="run" class="primary">Start</button></div>
    <div class="hint">Uses Chat Signals. Never overwrites an existing draft.</div></div></div>`;
  shadow.append(panel);
  const els = Object.fromEntries(['count','toggle','reset','theme','status','body','items','history','backup-export','backup-choose','backup-confirm','backup-file','history-clear','recovery-find','recovery-confirm','data-note','rules-panel','rules-note','rules-toggle','rules-approve','rules-dismiss','rules-audit','rules-audit-count','draft','add','clear','run'].map(id => [id,shadow.getElementById(id)]));
  // Unsaved HUD drafts must not migrate into another ChatGPT conversation.
  // Keep at most 32 volatile, exact-route drafts within this tab; never sync
  // or expose them to the page. Persisted queued items have separate storage.
  const routeDrafts=new Map();
  // Rule-store changes revoke pending asynchronous opt-in reads as well as
  // existing offers. Never reinstate a policy from an obsolete snapshot.
  let ruleLibraryGeneration=0;
  let ruleReadId=0; // Cancel obsolete async opt-ins on route or library changes.
  function rememberDraft(key) {
    if(!key)return;
    const value=els.draft.value;
    routeDrafts.delete(key);
    if(value)routeDrafts.set(key,value);
    while(routeDrafts.size>32)routeDrafts.delete(routeDrafts.keys().next().value);
  }
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
  // Volatile fixed-schema outcomes: no prompt text, route, document token,
  // response epoch, timestamps, or cross-extension publication.
  function auditOffer(outcome,offer){
    if(!offer||!['offered','approved','dismissed','expired','invalidated','save-failed'].includes(outcome)||
       !/^[a-zA-Z0-9_-]{1,64}$/.test(offer.ruleId)||
       !['propose','pause'].includes(offer.action?.type)||
       !['finished','failed','interrupted','limit'].includes(offer.phase))return;
    state.ruleAudit=[...state.ruleAudit,{outcome,ruleId:offer.ruleId,
      phase:offer.phase,action:offer.action.type}].slice(-20);
  }
  // This is not a durable execution journal: only user-approved rule IDs in
  // the current explicitly opted-in conversation/consent session. The pure
  // evaluator already rejects unknown or duplicate completed-rule IDs.
  function recordRuleCompletion(offer){
    if(!state.rulesEnabled||!offer||offer.key!==state.key||
       offer.consentGeneration!==state.ruleConsentGeneration||
       !state.ruleLibrary.some(rule=>rule.id===offer.ruleId))return;
    if(!state.ruleCompleted.includes(offer.ruleId) &&
       state.ruleCompleted.length<rulesEngine.MAX_RULES)
      state.ruleCompleted=[...state.ruleCompleted,offer.ruleId];
  }
  let paintedRows=null,paintedAudit=null;
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
    els['recovery-find'].disabled=state.blockedRecord||state.running||state.awaiting||Boolean(state.attempting)||state.routing||state.importing;
    els['history-clear'].disabled=!state.history.length||state.running||state.awaiting||Boolean(state.attempting)||state.importing||state.routing||state.blockedRecord||state.pendingSaves>0||state.storageFault;
    els['backup-export'].disabled=state.importing||state.storageFault||state.pendingSaves>0;
    els['backup-choose'].disabled=state.importing;
    els['recovery-confirm'].disabled=state.importing;
    els.clear.disabled=!state.items.length||Boolean(state.attempting)||state.importing;
    els.add.disabled=state.importing||state.adding;
    els.run.disabled=state.importing;
    els['rules-panel'].querySelector('summary').textContent=state.rulesEnabled?'Conditional proposals (on)':'Conditional proposals (off)';
    els['rules-toggle'].textContent=state.rulesLoading?'Loading rules':state.rulesEnabled?'Disable previews':'Enable previews';
    els['rules-toggle'].disabled=state.rulesLoading;
    els['rules-approve'].hidden=!state.ruleOffer;
    els['rules-dismiss'].hidden=!state.ruleOffer;
    els['rules-audit-count'].textContent=String(state.ruleAudit.length);
    if(paintedAudit!==state.ruleAudit){
      els['rules-audit'].replaceChildren();
      for(const entry of state.ruleAudit){
        const line=document.createElement('div');line.className='historyitem';
        line.textContent=[entry.outcome,entry.ruleId,entry.phase,entry.action].join(' · ');
        els['rules-audit'].append(line);
      }
      paintedAudit=state.ruleAudit;
    }
    els['rules-note'].textContent=state.ruleOffer
      ? (state.ruleOffer.action.type==='pause'
        ? 'Rule '+state.ruleOffer.ruleId+' proposes pausing. Requires explicit approval.'
        : 'Rule '+state.ruleOffer.ruleId+' proposes queued text (never automatic Send): '+state.ruleOffer.action.text)
      : (state.rulesEnabled?'Waiting for future authenticated events. No automatic Send.':'Disabled until explicitly enabled. No automatic sending.');
    els.toggle.textContent = state.collapsed ? '+' : '−';
    els.toggle.setAttribute('aria-label',state.collapsed ? 'Expand queue' : 'Collapse queue');
    els.body.hidden = state.collapsed;
    els.status.hidden = state.collapsed;
    place();
    // Phase, theme and status changes can be frequent. They affect the
    // header, not the item DOM. Preserving unchanged rows also preserves an
    // open editor's focus and prevents O(queue-size) DOM churn per Signal.
    // A failed persistent write can restore a previous array without
    // incrementing revision again. Include the actual collection identities
    // and sizes so rollback re-paints its restored rows/history immediately.
    // An editor opened while an item was pending must not stay actionable
    // after a failed or interrupted Send changes that item to uncertain.
    if(state.editing&&!state.items.some(item=>
      item.id===state.editing&&item.status==='pending'))state.editing=null;
    const rowsState=[state.key,state.revision,state.items,state.items.length,
      state.history,state.history.length,state.editing,state.attempting,
      state.importing,state.running,state.awaiting,state.blockedRecord];
    if(paintedRows&&paintedRows.every((v,i)=>v===rowsState[i]))return;
    const oldRow=state.editing?[...els.items.children].find(row=>
      row.dataset.itemId===state.editing):null;
    const oldEditor=oldRow?.querySelector('textarea');
    const editorDraft=oldEditor?.value;
    const restoreFocus=oldEditor&&shadow.activeElement===oldEditor;
    const selection=restoreFocus
      ? [oldEditor.selectionStart,oldEditor.selectionEnd,oldEditor.selectionDirection]
      : null;
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
        if(state.attempting||state.importing||event.button!==0||!event.target?.closest?.('.preview'))return;
        pointer={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
        try{row.setPointerCapture(event.pointerId);}catch{pointer=null;}
      });
      row.addEventListener('pointermove',event=>{
        if(!pointer||pointer.id!==event.pointerId)return;
        if(state.importing){pointer=null;clearDrop();return;}
        if(!pointer.moved && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<8)return;
        pointer.moved=true;
        clearDrop();row.dataset.dragging='true';
        const target=locate(event.clientX,event.clientY);
        if(target)target.row.dataset.dropSide=target.side;
      });
      function endPointer(event,cancelled=false){
        if(!pointer||pointer.id!==event.pointerId)return;
        const drag=pointer;pointer=null;
        const target=!cancelled&&drag.moved&&!state.attempting&&!state.importing?locate(event.clientX,event.clientY):null;
        clearDrop();
        try{if(row.hasPointerCapture(event.pointerId))row.releasePointerCapture(event.pointerId);}catch{}
        if(!target)return;
        const next=core.moveTo(state.items,item.id,target.beforeId);
        if(next.every((entry,index)=>entry.id===state.items[index]?.id))return;
        void persistItemMutation(()=>{state.items=next;}).then(result=>{
          if(!result.ok)statusNote(result.error);
        });
      }
      row.addEventListener('pointerup',event=>endPointer(event));
      row.addEventListener('pointercancel',event=>endPointer(event,true));
      if (state.editing === item.id && item.status==='pending') {
        const textarea=document.createElement('textarea');
        textarea.value=editorDraft===undefined?item.text:editorDraft;
        textarea.setAttribute('aria-label','Edit queued message');row.append(textarea);
        const ctrls=document.createElement('div');ctrls.className='controls';
        ctrls.append(button('Save','Save edit',()=>{
          if(state.importing||state.attempting||item.status!=='pending'||
             !core.validText(textarea.value))return;
          const text=textarea.value,id=item.id;
          // Use exactly the same pending-only API guard as external edits.
          // A formerly pending row may have become uncertain since Edit.
          void act('update',{id,text},true).then(result=>{
            if(!result.ok){statusNote(result.error);return;}
            const current=els.items.querySelector('textarea[aria-label="Edit queued message"]');
            // Preserve fresh keystrokes entered while storage was pending.
            if(state.editing===id&&current?.value===text){state.editing=null;render();}
          });
        },state.importing||Boolean(state.attempting)),
        button('Cancel','Cancel edit',()=>{if(state.importing)return;state.editing=null;render();},state.importing));row.append(ctrls);
      } else {
        const preview=document.createElement('div');preview.className='preview';preview.textContent=(item.status==='uncertain'?'⚠ Submission uncertain. Review, then explicitly retry or discard.\n':'')+item.text;row.append(preview);
        const ctrls=document.createElement('div');ctrls.className='controls';
        const locked=Boolean(state.attempting||state.importing);
        const editItems=mutate=>{
          void persistItemMutation(mutate).then(result=>{
            if(!result.ok)statusNote(result.error);
          });
        };
        ctrls.append(button('↑','Move earlier',()=>editItems(()=>{
          state.items=core.nextPosition(state.items,item.id,-1);
        }),index===0||locked),
          button('↓','Move later',()=>editItems(()=>{
            state.items=core.nextPosition(state.items,item.id,1);
          }),index===state.items.length-1||locked),
          button('Edit','Edit message',()=>{state.editing=item.id;render();},locked||item.status!=='pending'),
          button('Delete','Remove message',()=>editItems(()=>{
            state.items=state.items.filter(x=>x.id!==item.id);
          }),locked||item.status!=='pending'));
        if (item.status==='uncertain'){
          ctrls.append(button('Retry','Allow manually requested retry',async()=>{
            const reply=await act('resolve',{id:item.id,decision:'retry'},true);
            if(!reply.ok)statusNote(reply.error);
          },locked||state.running||state.awaiting));
          ctrls.append(button('Discard','Discard uncertain submission after review',async()=>{
            const reply=await act('resolve',{id:item.id,decision:'discard'},true);
            if(!reply.ok)statusNote(reply.error);
          },locked||state.running||state.awaiting));
        }
        row.append(ctrls);
      }
      els.items.append(row);
    });
    if(restoreFocus){
      const nextEditor=els.items.querySelector('textarea[aria-label="Edit queued message"]');
      if(nextEditor){
        nextEditor.focus({preventScroll:true});
        nextEditor.setSelectionRange(...selection);
      }
    }
    paintedRows=rowsState;
  }
  function statusNote(message) { state.note = message; render();publish(); }
  async function recoverRegistry(){
    if(state.registryRecovering||!state.initialized||state.destroyed||
       state.routing||state.key!==storageKey())return;
    state.registryRecovering=true;
    const key=state.key,route=routeKey();
    // Re-registration is metadata-only. A restarted event page lost every
    // authenticated provider epoch; never inherit authority from this tab.
    if(state.ruleOffer)auditOffer('invalidated',state.ruleOffer);
    state.ruleOffer=null;state.rulesEnabled=false;state.ruleLibrary=[];state.ruleSeen=[];
    state.rulesLoading=false;ruleReadId++;
    state.ruleCompleted=[];state.ruleConsentGeneration++;state.ruleClock=null;state.ruleClosedEpoch=null;
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
    const key=state.key,route=routeKey(),generation=routeGeneration;
    void api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'state',phase:state.signal,size:state.items.length,running:state.running,awaiting:state.awaiting,revision:state.revision,sequence:++statePublishSequence})
      .then(reply=>{
        // A delayed rejection for an earlier SPA route is not evidence that
        // the newly selected conversation lost its background registration.
        if(reply?.error==='route-mismatch'&&!state.destroyed&&!state.routing&&
           state.key===key&&routeKey()===route&&routeGeneration===generation)
          void recoverRegistry();
      })
      .catch(()=>{});
  }
  function save() {
    if(state.blockedRecord)return Promise.reject(new Error('unsupported-saved-queue'));
    state.clearArmed=false;
    state.revision++;state.etag=uid();const key=state.key;const data={version:1,items:state.items.map(item=>({id:item.id,text:item.text,status:item.status})),history:core.snapshotHistory(state.history),recoveredSources:state.recoveredSources.slice(-32),requestHighWatermarks:{...state.requestHighWatermarks}};
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
  // Authenticated duration evidence: monotonic time from the FIRST fresh,
  // busy phase observed after consent through the first fresh terminal phase
  // of the same provider document, route, and response epoch. Freeze the
  // duration at terminal: later repeats cannot turn a timer filter true.
  // Restoration, unknown or intervening idle invalidate all clock evidence.
  // Once a trusted terminal phase has closed a response epoch, a later busy
  // event using that same epoch cannot start a new duration interval. Keep a
  // volatile tombstone even when restored/unknown signals erase clock data.
  const sameRuleEpoch=(mark,signal)=>Boolean(mark&&
    mark.documentToken===signal.documentToken&&mark.route===signal.route&&
    mark.epoch===signal.epoch);
  function recordRuleClock(signal) {
    if(!state.rulesEnabled||!state.initialized||state.routing)return;
    if(signal.origin!=='fresh'||signal.confidence==='unknown'){
      // A restored terminal is historical evidence that this epoch ended.
      // It cannot supply a duration, but it must also forbid later same-
      // epoch busy events from fabricating fresh duration evidence.
      if(rulesEngine.PHASES.has(signal.phase))
        state.ruleClosedEpoch={documentToken:signal.documentToken,
          route:signal.route,epoch:signal.epoch};
      state.ruleClock=null;return;
    }
    const now=performance.now();
    const clock=state.ruleClock;
    const same=sameRuleEpoch(clock,signal);
    if(contract.ACTIVE.has(signal.phase)){
      if(sameRuleEpoch(state.ruleClosedEpoch,signal)){
        state.ruleClock=null;return;
      }
      if(!same){
        state.ruleClock={documentToken:signal.documentToken,route:signal.route,
          epoch:signal.epoch,startedAt:now,terminalPhase:null,durationMs:null};
      }else if(clock.terminalPhase){
        // Re-entering busy after terminal is not continuous timing evidence.
        state.ruleClock=null;
      }
      return;
    }
    if(!rulesEngine.PHASES.has(signal.phase)){
      state.ruleClock=null;return;
    }
    // The first fresh terminal closes this response epoch whether or not we
    // observed busy. This prevents a later duplicate busy from inventing it.
    if(!sameRuleEpoch(state.ruleClosedEpoch,signal))
      state.ruleClosedEpoch={documentToken:signal.documentToken,
        route:signal.route,epoch:signal.epoch};
    if(!same){state.ruleClock=null;return;}
    if(clock.terminalPhase!==null){
      if(clock.terminalPhase!==signal.phase)state.ruleClock=null;
      return;
    }
    const elapsed=now-clock.startedAt;
    if(!Number.isFinite(elapsed)||elapsed<0||elapsed>rulesEngine.MAX_DURATION_MS){
      state.ruleClock=null;return;
    }
    clock.terminalPhase=signal.phase;
    clock.durationMs=Math.floor(elapsed);
  }
  function ruleDuration(signal){
    const clock=state.ruleClock;
    return clock&&clock.documentToken===signal.documentToken&&
      clock.route===signal.route&&clock.epoch===signal.epoch&&
      clock.terminalPhase===signal.phase&&Number.isSafeInteger(clock.durationMs)
      ? clock.durationMs : undefined;
  }
  // This is preview-only: authenticated provider events may offer an action,
  // but only the explicit local Approve control can enqueue or pause.
  function considerConditionalPreview(signal) {
    if(!state.rulesEnabled||!state.initialized||state.routing||
       state.ruleOffer||state.key!==storageKey())return;
    const duration=ruleDuration(signal);
    const result=rulesEngine.evaluate(state.ruleLibrary,signal,state.ruleSeen,
      {completedRuleIds:state.ruleCompleted,
        ...(duration===undefined?{}:{stateDurationMs:duration})});
    if(!result?.ok||!result.decision)return;
    state.ruleSeen.push(result.decision.eventKey);
    if(state.ruleSeen.length>rulesEngine.MAX_SEEN)state.ruleSeen.shift();
    state.ruleOffer={key:state.key,ruleId:result.decision.ruleId,
      action:result.decision.action,consentGeneration:state.ruleConsentGeneration,
      documentToken:signal.documentToken,
      epoch:signal.epoch,phase:signal.phase,confidence:signal.confidence};
    auditOffer('offered',state.ruleOffer);
    // A proposal requiring manual review must stop any already-scheduled
    // next Send synchronously. processSignal may have just scheduled it on
    // the terminal event; the timeout cannot fire until this listener ends.
    state.running=false;
    if(state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;
    statusNote('Conditional proposal awaiting approval; queue paused');
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
    let editor,send,proof;
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
      const visibleEditors=[...document.querySelectorAll(editorSelector)].filter(e=>
        e.isConnected&&e.getClientRects().length&&e.getAttribute('contenteditable')!=='false');
      if(!form?.isConnected || visibleEditors.length!==1 || visibleEditors[0]!==editor ||
         [...form.querySelectorAll('input[type="file"]')].some(input=>input.files?.length) ||
         findSend(form)!==send)
        throw new Error('Composer changed before Send; no send attempted');
      // Keep authenticated busy evidence if the response ends before polling.
      proof={key:attemptKey,baseline,editor,busy:null};
      state.inflightProof=proof;
      // This initiates exactly one send attempt. We never click again after uncertainty.
      send.click(); clicked=true;
      statusNote('Verifying submission');
      let accepted=false;
      for (let i=0;i<12;i++) {
        await delay(250);
        // The human may edit or click Send after our own single click but
        // before the provider confirms a fresh busy epoch. A matching empty
        // editor is insufficient proof once this interaction was observed.
        if(humanTouched)
          throw new Error('Human interaction during submission verification; manual review required');
        if (state.destroyed || !state.running || state.key!==attemptKey ||storageKey()!==attemptKey || !editor.isConnected) break;
        const busy=proof.busy || (contract.newBusy(state.trusted,baseline)?state.trusted:null);
        if (busy && !editorValue(editor).trim()) {
          state.waiting={documentToken:baseline.documentToken,route:baseline.route,
            epoch:busy.epoch,sequence:busy.sequence};
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
      if(state.inflightProof===proof)state.inflightProof=null;
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
      if (!state.running || state.awaiting || state.attempting || state.blockedRecord)return;
      // Timers may be throttled in hidden Firefox tabs. A once-fresh ready
      // event is not indefinite authority: pause, then require a new Start.
      // A later provider transition must not resurrect a stale Run request.
      if(!freshProvider()){
        state.running=false;
        statusNote('Authenticated Signal stale; manually Start to resume');
        return;
      }
      if(!contract.ready(state.trusted,routeKey()))return;
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
    // During A -> B -> A rapid navigation, B may still be loading while
    // A's draft has already been stashed. Do not overwrite it with the now
    // blank transition textarea on a second reentrant route change.
    if(!state.routing)rememberDraft(state.key);
    els.draft.value='';
    const generation=++routeGeneration;
    state.routing=true;
    // Never display the previous conversation's private prompts while
    // a new path is waiting on slow or failed extension-storage reads.
    host.style.setProperty('visibility','hidden');
    state.clearArmed=false;state.historyClearArmed=false;state.pendingImport=null;state.pendingRecovery=null;
    // Explicit preview consent belongs to this exact conversation, not every
    // future ChatGPT route in this tab. Navigation invalidates all offers.
    state.ruleOffer=null;state.ruleSeen=[];state.rulesEnabled=false;state.ruleLibrary=[];state.ruleAudit=[];
    state.rulesLoading=false;ruleReadId++;
    state.ruleCompleted=[];state.ruleConsentGeneration++;state.ruleClock=null;state.ruleClosedEpoch=null;
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
      els.draft.value='';
      state.storageFault=true;state.blockedRecord=true;
      state.items=[];state.history=[];state.recoveredSources=[];state.requestHighWatermarks=Object.create(null);
      state.revision=0;state.etag=uid();state.editing=null;
      state.running=false;state.awaiting=false;state.routing=false;
      statusNote('Could not load conversation queue; reload to retry');
      host.style.removeProperty('visibility');
      return;
    }
    if(generation!==routeGeneration||storageKey()!==newKey)return;
    state.key=newKey;
    els.draft.value=routeDrafts.get(newKey)||'';
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
    state.routing=false;render();host.style.removeProperty('visibility');publish();
  }
  // A failed speculative write must invalidate any optimistic token that an
  // external client may have observed before the persistence error.
  function rollbackRejectedWrite(key,priorRevision,restore){
    if(state.key!==key||state.revision!==priorRevision+1)return false;
    restore();state.revision++;state.etag=uid();
    render();publish();return true;
  }
  // Changes must either reach durable storage or leave no in-memory phantom.
  // Deep-copy items because updating one item mutates an existing object.
  async function persistItemMutation(mutate) {
    if(state.routing||state.key!==storageKey())return {ok:false,error:'route-transition'};
    if(state.importing)return {ok:false,error:'import-in-progress'};
    if(state.blockedRecord)return {ok:false,error:'unsupported-saved-queue'};
    if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
    if(state.pendingSaves>0)return {ok:false,error:'queue-save-pending'};
    const key=state.key,revision=state.revision;
    const before=state.items.map(item=>({...item}));
    mutate();
    const write=save();
    render();
    try{await write;}
    catch{
      if(state.key===key&&state.revision===revision+1){
        state.items=before;
        state.revision++;state.etag=uid();
        render();publish();
      }
      return {ok:false,error:'queue-save-failed'};
    }
    render();
    return {ok:true};
  }
  async function act(action,payload,local=false,requester=null) {
    if (!state.initialized) return {ok:false,error:'not-ready'};
    if(state.routing)return {ok:false,error:'route-transition'};
    if(state.importing&&action!=='status')return {ok:false,error:'import-in-progress'};
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
        // No competing durable queue write may be pending when capturing the
        // rollback snapshot of the client's replay watermark and prompt.
        if(state.pendingSaves>0)return {ok:false,error:'queue-save-pending'};
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
        const priorItems=state.items.slice(),priorMarks={...state.requestHighWatermarks};
        const attemptKey=state.key,beforeRevision=state.revision;
        state.items.push(item);
        state.requestHighWatermarks[id]=seq;
        try{await save();}
        catch{
          // If no other edit occurred, reject the entire in-memory attempt,
          // not just the storage promise. Otherwise the same sequence would
          // appear consumed despite no durable enqueue.
          if(state.key===attemptKey&&state.revision===beforeRevision+1){
            state.items=priorItems;
            state.requestHighWatermarks=priorMarks;
            state.revision++;state.etag=uid();
            render();publish();
          }
          return {ok:false,error:'queue-save-failed'};
        }
        render();
        if(state.running&&!state.awaiting)planNext();
        return {ok:true,id:item.id,etag:state.etag};
      }
      if (action==='enqueue') {
        const text=payload?.text;
        if(state.pendingSaves>0)return {ok:false,error:'queue-save-pending'};
        if (state.items.length>=core.MAX_ITEMS) return {ok:false,error:'queue-full'};
        const item=core.makeItem(text,uid());
        const before=state.items.slice(),key=state.key,revision=state.revision;
        state.items.push(item);
        try{await save();}
        catch{
          // A rejected local-storage append must not remain in memory and
          // then get persisted twice when the user deliberately retries.
          if(state.key===key&&state.revision===revision+1){
            state.items=before;
            state.revision++;state.etag=uid();
            render();publish();
          }
          return {ok:false,error:'queue-save-failed'};
        }
        render();
        if(state.running&&!state.awaiting)planNext();
        return {ok:true,id:item.id,etag:state.etag};
      }
      if (action==='update') {
        if(state.attempting) return {ok:false,error:'dispatch-in-progress'};
        const item=state.items.find(i=>i.id===payload?.id);
        if(!item||!core.validText(payload?.text))return {ok:false,error:'invalid-message'};
        if(item.status!=='pending')return {ok:false,error:'resolve-uncertain-message'};
        return persistItemMutation(()=>{item.text=payload.text;});
      }
      if (action==='reorder') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        const ids=payload?.ids;
        if(!core.exactPermutation(state.items,ids))return {ok:false,error:'invalid-order'};
        return persistItemMutation(()=>{state.items=ids.map(id=>state.items.find(i=>i.id===id));});
      }
      if (action==='move') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        const id=payload?.id,beforeId=payload?.beforeId??null;
        if(typeof id!=='string'||!state.items.some(item=>item.id===id)||
           (beforeId!==null&&(typeof beforeId!=='string'||!state.items.some(item=>item.id===beforeId)))||
           id===beforeId)return {ok:false,error:'invalid-order'};
        return persistItemMutation(()=>{state.items=core.moveTo(state.items,id,beforeId);});
      }
      if (action==='remove' || action==='clear') {
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
        // A generic remove/clear must never erase the payload of a possibly
        // submitted message. Only resolve(discard) can explicitly do that.
        if(action==='clear'&&uncertain())return {ok:false,error:'resolve-uncertain-message'};
        if(action==='remove'&&state.items.some(i=>i.id===payload?.id&&i.status==='uncertain'))
          return {ok:false,error:'resolve-uncertain-message'};
        return persistItemMutation(()=>{state.items=action==='clear'?[]:state.items.filter(i=>i.id!==payload?.id);});
      }
      if (action==='resolve') {
        // Recovery is never an implicit continuation of an active or
        // in-flight response; a separate Start must follow deliberate review.
        if(state.running||state.awaiting||state.attempting)
          return {ok:false,error:'pause-before-resolving-uncertain'};
        const item=state.items.find(i=>i.id===payload?.id && i.status==='uncertain');
        if(!item)return {ok:false,error:'not-uncertain'};
        if(!['retry','discard'].includes(payload?.decision))return {ok:false,error:'invalid-decision'};
        const result=await persistItemMutation(()=>{
          if(payload.decision==='retry')item.status='pending';
          else state.items=state.items.filter(i=>i.id!==item.id);
        });
        if(result.ok)statusNote(payload.decision==='retry'
          ? 'Retry marked pending; press Start separately'
          : 'Uncertain message discarded; queue remains paused');
        return result;
      }
      if (action==='pause') {state.running=false;if(state.scheduler)clearTimeout(state.scheduler);state.scheduler=null;statusNote('Manually paused');return {ok:true};}
      if (action==='start') {
        // A pending conditional offer explicitly paused the scheduler.
        // No UI or privileged API Start may skip its required review.
        if(state.ruleOffer)return {ok:false,error:'review-conditional-proposal'};
        if (state.storageFault)return {ok:false,error:'storage-unavailable'};
        if (state.pendingSaves>0)return {ok:false,error:'queue-save-pending'};
        if (uncertain())return {ok:false,error:'resolve-uncertain-message'};
        if (!pending() && !state.awaiting)return {ok:false,error:'queue-empty'};
        // A pathname must identify a particular existing conversation;
        // home, shared links, GPT landing pages and temporary routes do not.
        if(!contract.assignedConversationRoute(routeKey()))
          return {ok:false,error:'conversation-not-assigned'};
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
    if(state.blockedRecord||state.attempting||state.routing||state.importing||state.storageFault||state.pendingSaves>0){statusNote('Backup unavailable while queue changes');return;}
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
    if(state.running||state.awaiting||state.attempting||state.routing||state.blockedRecord||state.importing){
      statusNote('Pause and finish the current response before importing');return;
    }
    els['backup-file'].value='';els['backup-file'].click();
  });
  els['backup-file'].addEventListener('change',async()=>{
    const file=els['backup-file'].files?.[0];
    if(!file)return;
    if(state.importing)return;
    const key=state.key,generation=routeGeneration,revision=state.revision;
    state.pendingImport=null;
    if(file.size>core.MAX_BACKUP_BYTES){els['data-note'].textContent='File too large (16 MiB limit)';render();return;}
    try{
      const data=core.parseBackup(JSON.parse(await file.text()));
      if(state.destroyed||state.key!==key||generation!==routeGeneration||
         state.revision!==revision||state.running||state.awaiting||state.attempting||state.routing||state.importing) {
        els['data-note'].textContent='Conversation or queue changed; import cancelled';return;
      }
      if(state.items.length+data.length>core.MAX_ITEMS)
        throw new Error('Queue would exceed 100 messages');
      state.pendingImport={key,generation,revision,items:data};
      els['data-note'].textContent='Review: '+data.length+' messages; no automatic sending. Click Confirm import to append.';
      render();
    }catch(error){els['data-note'].textContent='Import rejected: '+String(error?.message||error);render();}
  });
  els['backup-confirm'].addEventListener('click',async()=>{
    const draft=state.pendingImport;
    if(!draft||state.importing)return;
    // Consume confirmation synchronously. Two rapid clicks cannot append the
    // same staged backup while storage persistence is pending.
    state.pendingImport=null;
    if(draft.key!==state.key||state.key!==storageKey()||
       draft.generation!==routeGeneration||draft.revision!==state.revision||
       state.blockedRecord||state.running||state.awaiting||state.attempting||
       state.routing||state.pendingSaves>0){
      statusNote('Queue changed since import preview; select file again');return;
    }
    if(state.items.length+draft.items.length>core.MAX_ITEMS){statusNote('Queue full');return;}
    const original=state.items.slice(),key=state.key,revision=state.revision;
    state.importing=true;
    try{
      state.items.push(...draft.items.map(item=>({...core.makeItem(item.text,uid()),status:item.status})));
      render();
      await save();
      if(state.key===key&&!state.destroyed)
        els['data-note'].textContent='Imported '+draft.items.length+' messages; queue remains paused';
    }catch{
      if(rollbackRejectedWrite(key,revision,()=>{state.items=original;}))
        statusNote('Import could not be stored; queue paused');
    }finally{
      state.importing=false;
      if(!state.destroyed)render();
    }
  });
  // This storage enumeration is only performed after a local HUD click.
  // Never auto-import from an old tab ID: even a former pending item might
  // have been submitted before an unobserved browser shutdown.
  els['recovery-find'].addEventListener('click',async()=>{
    if(state.blockedRecord||state.running||state.awaiting||state.attempting||state.routing||state.importing)return;
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
      state.pendingRecovery={key,sourceKey:choice.key,revision,items,sourceSnapshot:JSON.stringify(records[choice.key])};
      els['data-note'].textContent='Found '+choices.length+' earlier queue(s) for this exact conversation. '+items.length+' message(s) will be restored as uncertain, never sent automatically. Confirm to copy.';
      render();
    }catch{els['data-note'].textContent='Could not inspect earlier local queues';render();}
  });
  els['recovery-confirm'].addEventListener('click',async()=>{
    const draft=state.pendingRecovery;
    if(!draft||draft.key!==state.key||storageKey()!==state.key||
       draft.revision!==state.revision||state.blockedRecord||state.running||
       state.awaiting||state.attempting||state.routing||state.importing||
       state.pendingSaves>0)return;
    // Disarm confirmation synchronously. Two fast clicks must not import
    // the same staged record twice while an asynchronous read is pending.
    state.pendingRecovery=null;
    // Recovery is a local import with two asynchronous boundaries: source
    // revalidation and durable persistence. Lock *before* either can yield.
    // Otherwise a later edit could be lost if persistence rolls back.
    state.importing=true;
    render();
    try {
    let latest;
    try { latest=await api.storage.local.get(draft.sourceKey); }
    catch {statusNote('Could not recheck earlier queue; search again');return;}
    // The source tab can mutate/delete/upgrade its record after discovery.
    // Never recover the stale cached copy or silently interpret a new schema.
    if(!Object.hasOwn(latest,draft.sourceKey)||
       !core.matchesRecoverySnapshot(latest[draft.sourceKey],draft.sourceSnapshot)){
      statusNote('Earlier queue changed; search again before recovering');
      return;
    }
    if(state.destroyed||draft.key!==state.key||storageKey()!==state.key||
       draft.revision!==state.revision||state.blockedRecord||state.running||
       state.awaiting||state.attempting||state.routing){
      statusNote('Conversation or queue changed; recovery cancelled');
      return;
    }
    if(state.items.length+draft.items.length>core.MAX_ITEMS){statusNote('Queue full');return;}
    const before=state.items.slice(),sources=state.recoveredSources.slice();
    state.items.push(...draft.items.map(item=>({...core.makeItem(item.text,uid()),status:'uncertain'})));
    state.recoveredSources.push(draft.sourceKey);
    try{
      await save();
      if(state.key===draft.key&&!state.destroyed){
        els['data-note'].textContent='Recovered '+draft.items.length+' messages for manual review; queue remains paused';
        render();
      }
    }catch{
      if(rollbackRejectedWrite(draft.key,draft.revision,()=>{
        state.items=before;state.recoveredSources=sources;
      }))statusNote('Recovery could not be saved; no automatic send');
    }
    } finally {
      state.importing=false;
      if(!state.destroyed)render();
    }
  });
  els['history-clear'].addEventListener('click',async()=>{
    // History writes must not overlap an Add or other durable queue write.
    // Otherwise a failed first write can leave a phantom prompt in the
    // second snapshot and prevent the rejected Add from rolling back.
    if(state.running||state.awaiting||state.attempting||state.importing||state.routing||
       state.blockedRecord||state.pendingSaves>0||state.storageFault||!state.history.length)return;
    if(!state.historyClearArmed){state.historyClearArmed=true;render();return;}
    state.historyClearArmed=false;
    const oldHistory=state.history.slice(),key=state.key,revision=state.revision;
    state.history=[];
    try{await save();if(state.key===key)render();}
    catch{rollbackRejectedWrite(key,revision,()=>{state.history=oldHistory;});}
  });
  shadow.addEventListener('click',event=>{
    if(state.historyClearArmed&&event.target!==els['history-clear']){
      state.historyClearArmed=false;queueMicrotask(()=>render());
    }
  },true);
  // A first Add may be waiting on extension storage while the user types
  // the next draft. The older completion must never erase newer input.
  let draftInputVersion=0;
  els.draft.addEventListener('input',()=>{draftInputVersion++;});
  els.add.addEventListener('click',async()=>{
    // A double click during a slow durable write must never enqueue the same
    // draft twice. Keep newer typing intact while the button is disabled.
    if(state.adding)return;
    const text=els.draft.value,version=draftInputVersion;
    const draftKey=state.key,draftGeneration=routeGeneration;
    state.adding=true;render();
    try{
      const response=await act('enqueue',{text},true);
      if(response.ok){
        if(draftInputVersion===version){
          if(state.key===draftKey&&routeGeneration===draftGeneration&&
             els.draft.value===text)els.draft.value='';
          else if(routeDrafts.get(draftKey)===text)routeDrafts.delete(draftKey);
        }
      }else statusNote(response.error);
    }finally{
      state.adding=false;
      if(!state.destroyed)render();
    }
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
    if(state.attempting||state.importing||!state.items.length)return;
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
  els['rules-toggle'].addEventListener('click',async()=>{
    if(state.rulesLoading||!state.initialized||state.routing)return;
    if(state.rulesEnabled){
      if(state.ruleOffer)auditOffer('invalidated',state.ruleOffer);
      ruleReadId++;
      state.rulesEnabled=false;state.ruleOffer=null;state.ruleSeen=[];
      state.ruleCompleted=[];state.ruleConsentGeneration++;state.ruleClock=null;state.ruleClosedEpoch=null;
      state.ruleLibrary=[];statusNote('Conditional previews disabled');return;
    }
    const key=state.key,generation=routeGeneration,libraryGeneration=ruleLibraryGeneration;
    const loadId=++ruleReadId;
    state.rulesLoading=true;render();
    try{
      const data=await api.storage.local.get(ruleStore.KEY);
      const decoded=ruleStore.decode(data[ruleStore.KEY]);
      if(!decoded.ok)throw new Error(decoded.error);
      if(state.destroyed||state.key!==key||routeGeneration!==generation||
         storageKey()!==key)throw new Error('conversation-changed');
      if(ruleLibraryGeneration!==libraryGeneration||ruleReadId!==loadId)
        throw new Error('rule-library-changed');
      state.ruleLibrary=decoded.rules;state.ruleSeen=[];state.ruleOffer=null;
      state.ruleCompleted=[];state.ruleConsentGeneration++;state.ruleClock=null;state.ruleClosedEpoch=null;
      state.rulesEnabled=true;
      statusNote('Conditional previews enabled; future authenticated events only');
    }catch(error){
      // An earlier route's pending read must not overwrite this route's
      // own opt-in, nor let a superseded library snapshot become active.
      if(!state.destroyed&&state.key===key&&routeGeneration===generation&&ruleReadId===loadId){
        state.rulesEnabled=false;state.ruleConsentGeneration++;
        state.ruleCompleted=[];state.ruleSeen=[];state.ruleClock=null;state.ruleClosedEpoch=null;
        state.ruleLibrary=[];state.ruleOffer=null;
        statusNote('Conditional previews unavailable: '+String(error?.message||error));
      }
    }finally{
      if(ruleReadId===loadId){state.rulesLoading=false;if(!state.destroyed)render();}
    }
  });
  els['rules-dismiss'].addEventListener('click',()=>{
    if(state.ruleOffer)auditOffer('dismissed',state.ruleOffer);
    state.ruleOffer=null;statusNote('Conditional proposal dismissed; no action');
  });
  els['rules-approve'].addEventListener('click',async()=>{
    const offer=state.ruleOffer;
    if(!offer||state.routing||state.key!==offer.key||state.key!==storageKey()||
       !state.rulesEnabled||offer.consentGeneration!==state.ruleConsentGeneration)return;
    // A newer provider epoch/phase must invalidate the pending review; an
    // obsolete success/failure offer cannot be approved for a later response.
    if(!state.trusted||state.trusted.documentToken!==offer.documentToken||
       state.trusted.epoch!==offer.epoch||state.trusted.phase!==offer.phase||
       state.trusted.confidence!==offer.confidence||state.trusted.origin!=='fresh'){
      auditOffer('expired',offer);
      state.ruleOffer=null;statusNote('Conditional proposal expired; review current response');
      return;
    }
    // Disarm immediately against rapid double-clicks. Never authorize Send.
    state.ruleOffer=null;state.running=false;
    if(state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;render();publish();
    if(offer.action.type==='pause'){
      recordRuleCompletion(offer);
      auditOffer('approved',offer);
      statusNote('Conditional pause approved; manually Start to resume');
      return;
    }
    if(offer.action.type!=='propose')return;
    const response=await act('enqueue',{text:offer.action.text},true);
    // The asynchronous durable append may settle after SPA navigation.
    // Never display a previous conversation's rule ID or review outcome in
    // the newly selected conversation's volatile audit/status.
    if(state.destroyed||state.routing||state.key!==offer.key||
       storageKey()!==offer.key||
       offer.consentGeneration!==state.ruleConsentGeneration)return;
    if(response.ok)recordRuleCompletion(offer);
    auditOffer(response.ok?'approved':'save-failed',offer);
    if(response.ok)statusNote('Conditional text queued; press Start separately');
    else statusNote('Conditional proposal was not queued: '+response.error);
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
    // A write to any of up to 16 other tabs' private prompt queues is not
    // a reason to redraw this tab's HUD. Only shared presentation and local
    // conditional-rule configuration can affect this document.
    let relevant=false;
    if(changes[ruleStore.KEY]){
      if(state.ruleOffer)auditOffer('invalidated',state.ruleOffer);
      ruleLibraryGeneration++;state.ruleConsentGeneration++;ruleReadId++;
      state.rulesLoading=false;
      state.rulesEnabled=false;state.ruleOffer=null;state.ruleSeen=[];
      state.ruleCompleted=[];state.ruleClock=null;state.ruleClosedEpoch=null;
      state.ruleLibrary=[];state.note='Rule library changed; previews disabled';
      relevant=true;
    }
    if(changes['chatqueue:settings:v1']){
      const next=changes['chatqueue:settings:v1'].newValue?.theme;
      state.theme=['system','light','dark'].includes(next)?next:'system';
      relevant=true;
    }
    if(changes[UI_KEY]&&uiValid(changes[UI_KEY].newValue)){
      const ui=changes[UI_KEY].newValue;state.position={right:ui.right,bottom:ui.bottom};state.collapsed=ui.collapsed;
      relevant=true;
    }
    if(relevant)render();
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
      state.trusted=next;state.trustedAt=performance.now();
      const offer=state.ruleOffer;
      if(offer&&(next.documentToken!==offer.documentToken||
         next.epoch!==offer.epoch||next.phase!==offer.phase||
         next.confidence!==offer.confidence||next.origin!=='fresh')){
        auditOffer('expired',offer);
        state.ruleOffer=null;
        state.running=false;
        if(state.scheduler)clearTimeout(state.scheduler);
        state.scheduler=null;
        statusNote('Conditional proposal expired; review current response');
      }
      const proof=state.inflightProof;
      // Only an authenticated new busy epoch can prove this journaled Send.
      // Retain its first transition across a rapid terminal event.
      // The trusted busy transition may precede React clearing the draft.
      // Recording its epoch does not itself confirm Send: confirmation below
      // still requires the composer to be empty and the matching context.
      if(proof&&proof.key===state.key&&contract.newBusy(next,proof.baseline)&&
         proof.editor.isConnected&&!proof.busy)proof.busy=next;
      recordRuleClock(next);
      processSignal();
      considerConditionalPreview(next);
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
      // Capture the route *before* asynchronous registration and storage. A
      // pushState during initial load must not paint the old conversation's
      // private queue on the newly selected route, even for one frame.
      let initialRoute,response;
      // A History API transition can race Firefox's asynchronous tab URL
      // validation. Retry only when the page *actually* changed routes;
      // genuine registration failures remain failures. Bounded retries avoid
      // an unbounded registration loop during pathological navigation.
      for(let attempt=0;attempt<4;attempt++){
        initialRoute=routeKey();
        response=await api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:initialRoute});
        if(response?.ok)break;
        if(routeKey()===initialRoute)throw new Error('Registration unavailable');
      }
      if(!response?.ok)throw new Error('Registration unavailable after route changes');
      state.tabId=response.tabId;
      state.key=`chatqueue:v1:tab:${state.tabId}:${initialRoute}`;
      state.keyRoute=initialRoute;
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
      const initialRouteChanged=state.key!==storageKey();
      if(initialRouteChanged){
        // Discard the stale in-memory snapshot before mounting the HUD. The
        // route transition will load the selected conversation independently;
        // no previous conversation's prompt or history may enter its DOM.
        state.items=[];state.history=[];state.recoveredSources=[];
        state.requestHighWatermarks=Object.create(null);state.editing=null;
        state.blockedRecord=false;
        host.style.setProperty('visibility','hidden');
      }
      (document.body||document.documentElement).append(host);
      if(initialRouteChanged)void handleRouteChange();
      else{
        state.note=state.blockedRecord?'Unsupported saved queue; editing disabled':'Paused; press Start';
        render();publish();
      }
    } catch(error) {
      state.destroyed=true;signalObserver.disconnect();clearInterval(routeWatch);
      // Do not inject a broken HUD or a partial queue.
    }
  })();
})();
