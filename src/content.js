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
  const validRegistrationGeneration=x=>typeof x==='string'&&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);
  const UI_KEY='chatqueue:ui:v1';
  const uiValid=x=>x?.version===1&&Number.isSafeInteger(x.right)&&x.right>=0&&x.right<=10000&&Number.isSafeInteger(x.bottom)&&x.bottom>=0&&x.bottom<=10000&&typeof x.collapsed==='boolean';
  const editorSelector = '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"]';
  // Exact label plus the composer's sole submit button cover the observed
  // Firefox ChatGPT variants; never select unrelated retry/voice actions.
  const sendSelector = 'button[data-testid="send-button"],button[data-testid="composer-submit-button"],#composer-submit-button,button[aria-label="Send prompt" i],button[aria-label="Send message" i],button[aria-label="Send" i],button[type="submit"]';
  const state = { tabId: null, key: '', items: [], history: [], running: false, awaiting: false, awaitingUncertain: false,
    busySeen: false, attempting: null, durableHoldId: null, unconfirmedClickLease: false, signal: 'unknown', observedSignal:'unknown',
    trusted: null, trustedAt: 0, waiting: null, note: 'Paused', initialized: false,
    editing: null, collapsed: false, position:{right:20,bottom:84}, clearArmed: false, theme: 'system', destroyed: false, scheduler: null, revision: 0, etag: uid(), saveChain: Promise.resolve(), routing: false, blockedRecord: false, pendingImport: null, importing: false, historyClearArmed: false, pendingRecovery: null, recoveredSources: [], requestHighWatermarks: Object.create(null), storageFault: false, pendingSaves: 0, registryRecovering: false, registrationGeneration: null, inflightProof: null, adding: false, rulesEnabled: false, rulesLoading: false, ruleLibrary: [], ruleOffer: null, ruleSeen: [], ruleAudit: [], ruleCompleted: [], ruleConsentGeneration: 0, ruleClock: null, ruleClosedEpoch: null };
  let routeGeneration=0;
  let holdReviewArmed=false;
  let holdReviewTarget=null;
  let holdReviewRequest=0;
  // Deadlines only dismiss a pending manual review; they never authorize
  // execution, enqueue or Send. A stale timer cannot act on a newer offer.
  let ruleApprovalTimer=null;
  let activeRuleDeadlineTimer=null;
  function clearActiveRuleDeadlineTimer(){
    if(activeRuleDeadlineTimer!==null)clearTimeout(activeRuleDeadlineTimer);
    activeRuleDeadlineTimer=null;
  }
  function clearRuleApprovalTimer(){
    if(ruleApprovalTimer!==null)clearTimeout(ruleApprovalTimer);
    ruleApprovalTimer=null;
  }
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
  const isolatedDraft = location.origin==='https://chatgpt.com';
  // This listener must run on WINDOW CAPTURE: it precedes document capture,
  // where ChatGPT can intercept a keystroke and focus its own composer.
  // Blocking propagation is not cancelling the native textarea's default
  // editing action. Never preventDefault or synthesize a keystroke.
  // Apply only to a genuinely focused Queue textarea, not to the page,
  // Queue control shortcuts, or normal Tab navigation out of the editor.
  // Firefox issues a separate "paste" event AFTER Ctrl+V. A site listener
  // capturing that event can redirect focus even when keydown is isolated.
  // Stop propagation of both; never preventDefault(), so Firefox itself
  // still inserts clipboard text into the original focused textarea.
  for(const type of ['keydown','keypress','keyup','paste']){
    window.addEventListener(type,event=>{
      if((type!=='paste'&&event.key==='Tab')||
         !event.composedPath().includes(host)||
         !(shadow.activeElement instanceof HTMLTextAreaElement))return;
      event.stopPropagation();
    },true);
  }
  // ChatGPT has page-wide keyboard/focus shortcuts. Shadow DOM retargets HUD
  // events but does NOT stop their propagation to document/window, where a
  // site shortcut may steal focus and direct typed text to its own composer.
  // Keep native textarea input/defaults and all internal HUD handlers intact:
  // only stop events from crossing the HUD's shadow boundary. Do not call
  // preventDefault(), which would break typing, IME or accessible controls.
  for(const type of ['keydown','keypress','keyup','paste','beforeinput','input',
    'compositionstart','compositionupdate','compositionend',
    'pointerdown','mousedown','mouseup','click','focusin']){
    // Bubble-phase isolation is essential: stopping at capture would prevent
    // the event from reaching its OWN textarea/button/keyboard handler.
    shadow.addEventListener(type,event=>event.stopPropagation());
  }
  // The page can register CAPTURE-PHASE keyboard handlers before this
  // document_idle extension starts. Bubble isolation alone cannot stop those
  // handlers from focusing ChatGPT's composer before a HUD textarea sees its
  // own key. Restore the actively edited HUD field synchronously on an
  // unsolicited page focus change, without cancelling native keystrokes.
  let activeHudEditor=null;
  let restoringHudFocus=false;
  shadow.addEventListener('focusin',event=>{
    activeHudEditor=event.target instanceof HTMLTextAreaElement
      ?event.target:null;
  },true);
  shadow.addEventListener('click',event=>{
    if(activeHudEditor&&event.target!==activeHudEditor)
      activeHudEditor=null;
  });
  document.addEventListener('pointerdown',event=>{
    // An intentional pointer action outside the HUD releases focus normally.
    if(!event.composedPath().includes(host))activeHudEditor=null;
  },true);
  document.addEventListener('keydown',event=>{
    // Do not trap Tab: users can leave the queue with the keyboard.
    if(event.key==='Tab'&&event.composedPath().includes(host))
      activeHudEditor=null;
  },true);
  document.addEventListener('focusin',event=>{
    const editor=activeHudEditor;
    if(!editor||restoringHudFocus||event.composedPath().includes(host))return;
    if(!editor.isConnected){activeHudEditor=null;return;}
    // An earlier ChatGPT key-capture handler may have stolen focus while the
    // user was typing in Queue. Do NOT preventDefault(), modify the event,
    // inject text into ChatGPT, or infer user intent from site content.
    restoringHudFocus=true;
    try{editor.focus({preventScroll:true});}
    finally{restoringHudFocus=false;}
  },true);
  const style = document.createElement('style');
  style.textContent = `
    :host{color-scheme:light;contain:style;--panel:#fff;--text:#192432;--border:#bcc7d1;--header:#f4f6f9;--status:#f8fafc;--item:#f5f7fa;--button:#e6ecf3;--button-hover:#d9e4ed;--button-border:#9eafbf;--muted:#4c6074;--input:#fff;--accent:#204f8c;--accent-text:#fff;--focus:#1773bb;--shadow:#0002;--warning:#8c4e1b}
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
  panel.innerHTML = `<header class="top" tabindex="0" aria-label="Queue panel. Arrow keys move it; Home resets position."><strong>Message Queue</strong><span id="count" class="small">0 queued</span><select id="theme" aria-label="Chat Queue theme" title="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><button id="reset" title="Reset position and expand queue" aria-label="Reset queue position">↺</button><button id="toggle" title="Collapse or expand queue" aria-label="Collapse queue" aria-controls="body status" aria-expanded="true">−</button></header>
    <div id="status" class="status" role="status"></div><div id="body"><div id="items" class="items" role="list" aria-label="Queued messages"></div><details><summary>Recently submitted / backup</summary><div id="history" class="history"></div><div class="data-buttons"><button id="backup-export" type="button">Export queue</button><button id="backup-choose" type="button">Import JSON</button><button id="backup-confirm" type="button" hidden>Confirm import</button><button id="recovery-find" type="button">Find earlier queues</button><button id="recovery-confirm" type="button" hidden>Recover for review</button><button id="hold-review" type="button">Review prior Send hold</button><button id="history-clear" class="danger" type="button">Forget history</button><input id="backup-file" type="file" accept=".json,application/json" hidden></div><div id="data-note" class="data-note" aria-live="polite"></div></details>
    <details id="rules-panel"><summary>Conditional proposals (off)</summary><div id="rules-note" class="data-note" aria-live="polite">Disabled until explicitly enabled. No automatic sending.</div><div class="data-buttons"><button id="rules-toggle" type="button">Enable previews</button><button id="rules-approve" type="button" hidden>Approve proposal</button><button id="rules-dismiss" type="button" hidden>Dismiss</button></div><details id="rules-audit-panel"><summary>Review history (<span id="rules-audit-count">0</span>, this conversation only)</summary><div id="rules-audit" class="history" aria-label="Conditional review audit"></div></details></details>
    <div class="foot"><label for="draft" class="small">Add queued message</label><textarea id="draft" placeholder="Message to send when control returns" spellcheck="true"></textarea>
    <div class="footrow"><button id="add">Add to queue</button><button id="clear" class="danger">Clear</button><button id="run" class="primary">Start</button></div>
    <div class="hint">Uses Chat Signals. Never overwrites an existing draft.</div></div></div>`;
  shadow.append(panel);
  const els = Object.fromEntries(['count','toggle','reset','theme','status','body','items','history','backup-export','backup-choose','backup-confirm','backup-file','history-clear','recovery-find','recovery-confirm','hold-review','data-note','rules-panel','rules-note','rules-toggle','rules-approve','rules-dismiss','rules-audit','rules-audit-count','draft','add','clear','run'].map(id => [id,shadow.getElementById(id)]));
  // Live ChatGPT runs the editor in an extension-owned child frame. Key and
  // clipboard events stay in that frame, outside the host page's event tree.
  // The original textarea is only a hidden mirror for existing queue logic.
  let draftFrameReady=false;
  let draftPort=null;
  let lastDraftTheme=null;
  let draftFrame=null;
  let draftReadSerial=0;
  const pendingDraftReads=new Map();
  function setQueueDraft(value){
    els.draft.value=value;
    if(draftFrameReady)draftPort.postMessage({type:'set',value});
  }
  function readQueueDraft(){
    if(!isolatedDraft)return Promise.resolve(els.draft.value);
    if(!draftFrameReady)return Promise.resolve(null);
    const id=++draftReadSerial;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{pendingDraftReads.delete(id);resolve(null);},2000);
      pendingDraftReads.set(id,value=>{clearTimeout(timer);resolve(value);});
      draftPort.postMessage({type:'read',id});
    });
  }
  if(isolatedDraft){
    const token=uid();
    draftFrame=document.createElement('iframe');
    draftFrame.id='isolated-draft-frame';
    draftFrame.title='Add queued message';
    draftFrame.style.cssText='display:block;width:100%;height:86px;border:1px solid var(--button-border);border-radius:7px;background:var(--input);margin-bottom:8px';
    els.draft.hidden=true;
    els.draft.after(draftFrame);
    const channel=new MessageChannel();
    channel.port1.onmessage=event=>{
      const data=event.data;
      if(!data||typeof data!=='object')return;
      if(data.type==='ready'){
        if(draftFrameReady)return;
        draftFrameReady=true;draftPort=channel.port1;
        draftPort.postMessage({type:'set',value:els.draft.value});
        draftPort.postMessage({type:'theme',value:state.theme});
        lastDraftTheme=state.theme;
      }else if(data.type==='input'&&draftFrameReady){
        if(typeof data.value!=='string'||data.value.length>10000)return;
        els.draft.value=data.value;
        // The private version listener runs, but the event never bubbles
        // into ChatGPT's document capture or main-world listeners.
        els.draft.dispatchEvent(new Event('input'));
      }else if(data.type==='snapshot'&&draftFrameReady){
        if(!Number.isSafeInteger(data.id)||!pendingDraftReads.has(data.id))return;
        const done=pendingDraftReads.get(data.id);
        pendingDraftReads.delete(data.id);
        done(typeof data.value==='string'&&data.value.length<=10000?data.value:null);
      }
    };
    const src=api.runtime.getURL('ui/draft.html');
    const origin=new URL(src).origin;
    draftFrame.addEventListener('load',()=>{
      // Port transfer goes directly to a cross-origin child. No prompt text
      // is ever broadcast via the top-level ChatGPT page's postMessage.
      try{draftFrame.contentWindow.postMessage(
        {type:'queue-draft-init',token},origin,[channel.port2]);}catch{}
    },{once:true});
    draftFrame.src=src+'#'+token;
  }
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
  // A deliberate Start can refresh a stale authenticated provider snapshot.
  // This never publishes page-owned DOM attributes as Send authority.
  let startRefresh=null;
  function settleStartRefresh(accepted){
    const pending=startRefresh;
    if(!pending)return;
    startRefresh=null;
    clearTimeout(pending.timeout);
    pending.resolve(Boolean(accepted));
    render();
  }
  async function refreshProviderForStart(){
    if(freshProvider())return true;
    if(startRefresh||!validRegistrationGeneration(state.registrationGeneration))
      return false;
    const key=state.key,route=routeKey(),generation=routeGeneration;
    const registration=state.registrationGeneration,revision=state.revision;
    const previous=state.trusted;
    let resolve;
    const confirmation=new Promise(done=>{resolve=done;});
    const pending={key,route,generation,registration,previous,resolve,timeout:null};
    startRefresh=pending;
    pending.timeout=setTimeout(()=>settleStartRefresh(false),4000);
    statusNote('Checking authenticated Chat Signals');
    try{
      const response=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
        action:'sync-provider',route,registrationGeneration:registration});
      if(!response?.ok&&startRefresh===pending)settleStartRefresh(false);
    }catch{
      if(startRefresh===pending)settleStartRefresh(false);
    }
    const accepted=await confirmation;
    return accepted&&!state.destroyed&&!state.routing&&state.key===key&&
      routeKey()===route&&routeGeneration===generation&&
      state.registrationGeneration===registration&&state.revision===revision&&
      state.trusted!==previous&&freshProvider();
  }
  // Volatile fixed-schema outcomes: no prompt text, route, document token,
  // response epoch, timestamps, or cross-extension publication.
  function auditOffer(outcome,offer){
    if(!offer||!['offered','approved','dismissed','expired','invalidated','save-failed'].includes(outcome)||
       !/^[a-zA-Z0-9_-]{1,64}$/.test(offer.ruleId)||
       !['propose','pause'].includes(offer.action?.type)||
       !['finished','failed','interrupted','limit','generating'].includes(offer.phase))return;
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
    if(!state.ruleOffer)clearRuleApprovalTimer();
    if(!state.rulesEnabled)clearActiveRuleDeadlineTimer();
    host.dataset.theme=state.theme;els.theme.value=state.theme;
    if(draftFrameReady&&lastDraftTheme!==state.theme){
      draftPort.postMessage({type:'theme',value:state.theme});
      lastDraftTheme=state.theme;
    }
    els.count.textContent = `${state.items.length} queued`;
    const signalLabel=state.trusted
      ? state.signal+(state.trusted.origin==='restored'?' (historical)':'')
      : state.observedSignal+' (unverified)';
    els.status.textContent = `Signal: ${signalLabel} • ${state.running ? 'Running' : 'Paused'} • ${state.note}`;
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
    els.run.disabled=state.importing||Boolean(startRefresh);
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
    els.toggle.setAttribute('aria-expanded',String(!state.collapsed));
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
      state.importing,state.running,state.awaiting,state.awaitingUncertain,state.blockedRecord];
    if(paintedRows&&paintedRows.every((v,i)=>v===rowsState[i]))return;
    // Reordering replaces DOM controls. Preserve keyboard focus on the
    // moved item; if the current direction becomes disabled at the boundary,
    // focus its other enabled arrow. Never focus an unrelated item.
    const focusedControl=shadow.activeElement;
    const focusedActionLabel=focusedControl?.getAttribute?.('aria-label');
    const focusedActionItem=focusedActionLabel
      ? focusedControl.closest?.('.item')?.dataset.itemId:null;
    // A deleted action disappears with its row. Keep its previous ordinal
    // to select a surviving keyboard target, or return to the HUD draft.
    const focusedActionIndex=focusedActionItem
      ? [...els.items.querySelectorAll('.item')].findIndex(
          row=>row.dataset.itemId===focusedActionItem)
      : -1;
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
      // Expose the same ordinal position that arrow/pointer reorder updates.
      // This is metadata only; the row preview remains the user's actual
      // queued text and no new data is published to the host page.
      row.setAttribute('role','listitem');
      row.setAttribute('aria-posinset',String(index+1));
      row.setAttribute('aria-setsize',String(state.items.length));
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
        button('Cancel','Cancel edit',()=>{
           if(state.importing)return;
           state.editing=null;render();
           // The Cancel control was in a row replaced by render().
           // Restore keyboard focus to this same item's Edit control.
           const row=[...els.items.children].find(entry=>entry.dataset.itemId===item.id);
           row?.querySelector('button[aria-label="Edit message"]')?.focus({preventScroll:true});
         },state.importing));row.append(ctrls);
      } else {
        const preview=document.createElement('div');preview.className='preview';preview.textContent=(item.status==='uncertain'?'⚠ Submission uncertain. Review, then explicitly retry or discard.\n':'')+item.text;row.append(preview);
        const ctrls=document.createElement('div');ctrls.className='controls';
        const locked=Boolean(state.attempting||state.importing);
        const editItems=(mutate,successNote=null)=>{
          const originKey=state.key;
          void persistItemMutation(mutate).then(result=>{
            if(!result.ok)statusNote(result.error);
            else if(successNote&&state.key===originKey)statusNote(successNote);
          });
        };
        ctrls.append(button('↑','Move earlier',()=>editItems(()=>{
          state.items=core.nextPosition(state.items,item.id,-1);
        }),index===0||locked),
          button('↓','Move later',()=>editItems(()=>{
            state.items=core.nextPosition(state.items,item.id,1);
          }),index===state.items.length-1||locked),
          button('Edit','Edit message',()=>{
             state.editing=item.id;render();
             // Opening edit replaces its source button. Give the newly
             // created editor the keyboard focus, rather than losing it
             // to the host page or forcing another Tab traversal.
             const row=[...els.items.children].find(entry=>entry.dataset.itemId===item.id);
             row?.querySelector('textarea[aria-label="Edit queued message"]')?.focus({preventScroll:true});
           },locked||item.status!=='pending'),
          button('Delete','Remove message',()=>editItems(()=>{
            state.items=state.items.filter(x=>x.id!==item.id);
          },'Queued message removed.'),locked||item.status!=='pending'));
        if (item.status==='uncertain'){
          ctrls.append(button('Retry','Allow manually requested retry',async()=>{
            const reply=await act('resolve',{id:item.id,decision:'retry'},true);
            if(!reply.ok)statusNote(reply.error);
          },locked||state.running||(state.awaiting&&!state.awaitingUncertain)));
          ctrls.append(button('Discard','Discard uncertain submission after review',async()=>{
            const reply=await act('resolve',{id:item.id,decision:'discard'},true);
            if(!reply.ok)statusNote(reply.error);
          },locked||state.running||(state.awaiting&&!state.awaitingUncertain)));
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
    }else if(focusedActionItem){
      // A local persistence save re-renders the item's controls more than
      // once. Keep the existing keyboard action focused while it remains
      // valid, or return Save/Cancel to Edit when the editor closes.
      // Never focus another item or the ChatGPT page as a fallback.
      const sameRow=[...els.items.children].find(row=>row.dataset.itemId===focusedActionItem);
      const buttons=[...(sameRow?.querySelectorAll('.controls button')||[])];
      const target=buttons.find(button=>!button.disabled&&
        button.getAttribute('aria-label')===focusedActionLabel)||
        (['Save edit','Cancel edit'].includes(focusedActionLabel)
          ? buttons.find(button=>!button.disabled&&button.getAttribute('aria-label')==='Edit message')
          : null)||
        (['Move earlier','Move later'].includes(focusedActionLabel)
          ? buttons.find(button=>!button.disabled&&
            ['Move earlier','Move later'].includes(button.getAttribute('aria-label'))
          ):null);
      if(target)target.focus({preventScroll:true});
      else if(focusedActionLabel==='Remove message'&&focusedActionIndex>=0&&!sameRow){
        const rows=[...els.items.querySelectorAll('.item')];
        const neighbor=rows[Math.min(focusedActionIndex,rows.length-1)];
        const button=[...(neighbor?.querySelectorAll('.controls button')||[])]
          .find(candidate=>!candidate.disabled);
        (button||(isolatedDraft?draftFrame:els.draft)).focus({preventScroll:true});
      }
    }
    paintedRows=rowsState;
  }
  function statusNote(message) { state.note = message; render();publish(); }
  async function recoverRegistry(){
    if(state.registryRecovering||!state.initialized||state.destroyed||
       state.routing||state.key!==storageKey())return;
    settleStartRefresh(false);
    state.registryRecovering=true;
    const key=state.key,route=routeKey();
    // Re-registration is metadata-only. A restarted event page lost every
    // authenticated provider epoch; never inherit authority from this tab.
    if(state.ruleOffer)auditOffer('invalidated',state.ruleOffer);
    state.ruleOffer=null;state.rulesEnabled=false;state.ruleLibrary=[];state.ruleSeen=[];
    state.rulesLoading=false;ruleReadId++;
    state.ruleCompleted=[];state.ruleConsentGeneration++;state.ruleClock=null;state.ruleClosedEpoch=null;
    // Snapshot the interrupted work before erasing volatile authority.
    // A completed, empty queue requires no manual resume. An in-flight
    // response, however, may have reached ChatGPT without durable terminal
    // attribution and must remain a deliberate transcript/hold review.
    const hadInflightResponse=state.awaiting||state.awaitingUncertain||Boolean(state.attempting);
    const queueEmpty=!pending()&&!uncertain();
    const latestFinished=state.history[0]?.status==='finished';
    state.registrationGeneration=null;
    state.running=false;state.trusted=null;state.trustedAt=0;state.signal='unknown';
    state.waiting=null;state.awaiting=false;state.awaitingUncertain=false;state.busySeen=false;
    if(state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;
    state.note=hadInflightResponse
      ? 'Signal registry restarted during a response; inspect transcript and Send hold'
      : queueEmpty
        ? latestFinished
          ? 'Latest message finished; signal registry restarted; queue empty'
          : 'Signal registry restarted; no queued messages to resume'
        : 'Signal registry restarted; manually resume after reconnect';
    render();
    let restored=false;
    try{
      const answer=await api.runtime.sendMessage({
        type:'chat-queue-internal/v1',action:'register',route,registrationVersion:2});
      if(answer?.ok&&state.key===key&&routeKey()===route&&!state.destroyed){
        state.tabId=answer.tabId;
        state.registrationGeneration=validRegistrationGeneration(answer.registrationGeneration)
          ?answer.registrationGeneration:null;
        restored=true;
      }
    }catch{
      if(state.key===key&&!state.destroyed)statusNote('Background registry unavailable; paused');
    }finally{
      state.registryRecovering=false;
      if(restored&&!state.destroyed){
        publish();
        // Event-page suspension erased its authenticated provider registry.
        // Request a fresh publisher snapshot so a deliberate later Start
        // can recover; never reinstate volatile Run or reuse old authority.
        requestVerifiedProvider();
      }
    }
  }
  function publish() {
    if (state.tabId == null || state.destroyed || state.registryRecovering) return;
    const key=state.key,route=routeKey(),generation=routeGeneration;
    // Private background-only lease bit; never include it in public TABS,
    // status API or subscription metadata. An unresolved or unconfirmed
    // click must not lose cross-tab ownership merely because Run was paused.
    void api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'state',phase:state.signal,size:state.items.length,running:state.running,awaiting:state.awaiting,leasePending:Boolean(state.attempting||state.unconfirmedClickLease),revision:state.revision,registrationGeneration:state.registrationGeneration,sequence:++statePublishSequence})
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
  // A hidden or inert control can still have layout rectangles, and a script
  // click can activate a visibility:hidden button. Never use rects alone to
  // authorize a Send or to decide which page editor is the active composer.
  function actionableControl(element) {
    if(!element.isConnected||!element.getClientRects().length||
       element.closest('[hidden],[inert],[aria-hidden="true" i],[aria-disabled="true" i],fieldset:disabled')||
       element.disabled===true||element.readOnly===true||
       element.getAttribute('aria-disabled')==='true')return false;
    // Hidden-but-laid-out or offscreen controls still accept script clicks.
    // Opacity is not inherited: inspect the entire ancestor chain, not just
    // the target element. Dispatch remains fail-closed during fade/transition.
    for(let node=element;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.visibility!=='visible'||style.display==='none'||
         !(Number(style.opacity)>0))return false;
    }
    const bounds=element.getBoundingClientRect();
    if(bounds.width<=0||bounds.height<=0||bounds.right<=0||
       bounds.bottom<=0||bounds.left>=innerWidth||bounds.top>=innerHeight)
      return false;
    if(getComputedStyle(element).pointerEvents==='none')return false;
    // A scripted HTMLElement.click() ignores overlays. Only permit controls
    // that would receive a real pointer at the center of their visible area;
    // an intercepted element is not safe for an irreversible Send.
    const left=Math.max(0,bounds.left),right=Math.min(innerWidth,bounds.right);
    const top=Math.max(0,bounds.top),bottom=Math.min(innerHeight,bounds.bottom);
    const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
    return !!hit&&(hit===element||element.contains(hit));
  }
  function usableComposer(editor) {
    // The selector includes a fixed ChatGPT ID; it does not establish that
    // the element is still an actual text editor after a page rerender.
    const textControl=editor instanceof HTMLTextAreaElement||
      (editor instanceof HTMLInputElement&&['text','search'].includes(editor.type));
    return actionableControl(editor)&&(textControl||editor.isContentEditable===true);
  }
  // Contenteditable innerText may be "\\n" for an actually empty ProseMirror
  // paragraph (<p><br></p>). Treat *only* known structural line-break
  // placeholders as empty: any text node (even whitespace or invisible text)
  // or embedded/non-paragraph element must preserve the user's draft.
  // This is preflight only; never relax exact text verification after insertion.
  function composerHasDraft(editor) {
    if(editor instanceof HTMLTextAreaElement||editor instanceof HTMLInputElement)
      return editor.value.length>0;
    if(!editor.isContentEditable)return true;
    if(editor.textContent.length>0)return true;
    for(const element of editor.querySelectorAll('*')){
      if(!['P','DIV','BR'].includes(element.tagName))return true;
      if(element.tagName==='BR'&&element.hasAttribute('contenteditable')&&
         element.getAttribute('contenteditable')==='false')return true;
    }
    return false;
  }
  function findComposer() {
    const found=[...document.querySelectorAll(editorSelector)].filter(usableComposer);
    if (found.length !== 1) throw new Error('Composer is missing or ambiguous');
    const editor=found[0];
    const form=editor.closest('form');
    if (!form || !form.contains(editor)) throw new Error('Composer form is missing');
    if (composerHasDraft(editor)) throw new Error('Composer contains a draft; preserved it');
    if ([...form.querySelectorAll('input[type="file"]')].some(input=>input.files?.length))
      throw new Error('Composer has attachments');
    return {editor,form};
  }
  function fillComposer(editor,text) {
    editor.focus();
    // execCommand inserts at the browser's active selection, NOT into an
    // element supplied as an argument. A page-side focus handler can divert
    // the caret into another editor before Queue inserts its private prompt.
    if(document.activeElement!==editor)
      throw new Error('Composer focus diverted; no insertion');
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor),'value');
      descriptor.set.call(editor,text);
      editor.dispatchEvent(new Event('input',{bubbles:true}));
    } else {
      // A contenteditable's browser selection, not the DOM element argument,
      // determines where execCommand inserts. Preserve a valid React/
      // ProseMirror caret (and its block structure); refuse a selection in
      // some other editor instead of repositioning it at the container root.
      const selection=window.getSelection();
      const inside=node=>!!node&&(node===editor||editor.contains(node));
      if(!selection||selection.rangeCount!==1||
         !inside(selection.anchorNode)||!inside(selection.focusNode)||
         document.activeElement!==editor)
        throw new Error('Composer selection diverted; no insertion');
      if (typeof document.execCommand !== 'function' ||
          !document.execCommand('insertText',false,text))
        throw new Error('Composer insertion failed');
    }
    const value=canonicalComposerText(editorValue(editor));
    if (value !== canonicalComposerText(text)) throw new Error('Composer did not accept the exact message');
  }
  function findSend(form) {
    const buttons=[...form.querySelectorAll(sendSelector)];
    if(buttons.length!==1||!actionableControl(buttons[0]))
      throw new Error('Send button missing, disabled or ambiguous');
    return buttons[0];
  }
  function moveHudIfCoveringSend(button) {
    // The floating Queue HUD may cover ChatGPT's bottom-right Send button.
    // elementFromPoint then sees our own host, not the button. Move the HUD
    // rather than disabling the hit-test or clicking through an obstruction.
    const bounds=button.getBoundingClientRect();
    if(bounds.width<=0||bounds.height<=0)return;
    const x=Math.max(0,Math.min(innerWidth,bounds.left+bounds.width/2));
    const y=Math.max(0,Math.min(innerHeight,bounds.top+bounds.height/2));
    const blocked=document.elementFromPoint(x,y);
    if(blocked!==host&&!host.contains(blocked))return;
    const original={...state.position};
    const candidates=[
      {right:20,bottom:innerHeight},
      {right:innerWidth,bottom:innerHeight},
      {right:innerWidth,bottom:16},
      {right:20,bottom:16}
    ];
    for(const candidate of candidates){
      state.position=candidate;
      state.position=place();
      const hit=document.elementFromPoint(x,y);
      if(hit!==host&&!host.contains(hit)){
        // This saves only HUD layout, never a queue write or Send consent.
        void api.storage.local.set({[UI_KEY]:{version:1,
          ...state.position,collapsed:state.collapsed}}).catch(()=>{});
        return;
      }
    }
    state.position=original;place();
  }
  async function waitForSend(form,stillSafe) {
    // React/ProseMirror often enables or mounts Send in a later render
    // after execCommand inserted exact text. This is ONE pre-click attempt,
    // not a retry. Abort on any route, draft, signal or user-input change.
    for(let attempt=0;attempt<20;attempt++){
      if(!stillSafe())throw new Error('Dispatch context changed; no send attempted');
      const candidates=[...form.querySelectorAll(sendSelector)];
      if(candidates.length>1)
        throw new Error('Send button missing, disabled or ambiguous');
      if(candidates.length===1){
        moveHudIfCoveringSend(candidates[0]);
        if(actionableControl(candidates[0]))return candidates[0];
      }
      if(attempt<19)await delay(100);
    }
    throw new Error('Send button missing, disabled or ambiguous');
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
          epoch:signal.epoch,startedAt:now,
          generatingAt:signal.phase==='generating'?now:null,
          terminalPhase:null,durationMs:null,lastEvaluatedDuration:null};
      }else if(clock.terminalPhase){
        // Re-entering busy after terminal is not continuous timing evidence.
        state.ruleClock=null;
      }else if(signal.phase==='generating'&&clock.generatingAt===null){
        clock.generatingAt=now;
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
    if(!clock||clock.documentToken!==signal.documentToken||
       clock.route!==signal.route||clock.epoch!==signal.epoch)return undefined;
    if(signal.phase==='generating'&&clock.terminalPhase===null&&
       Number.isFinite(clock.generatingAt)){
      const duration=performance.now()-clock.generatingAt;
      return duration>=0&&duration<=rulesEngine.MAX_DURATION_MS
        ? Math.floor(duration):undefined;
    }
    return clock.terminalPhase===signal.phase&&Number.isSafeInteger(clock.durationMs)
      ?clock.durationMs:undefined;
  }
  function expireConditionalOffer(offer,force=false){
    if(state.ruleOffer!==offer||offer.deadlineAt===undefined)return;
    const now=performance.now();
    const remaining=offer.deadlineAt-now;
    if(!force&&now>=offer.offeredAt&&remaining>0){
      clearRuleApprovalTimer();
      ruleApprovalTimer=setTimeout(()=>expireConditionalOffer(offer),Math.ceil(remaining));
      return;
    }
    clearRuleApprovalTimer();
    auditOffer('expired',offer);
    state.ruleOffer=null;state.running=false;
    if(state.scheduler)clearTimeout(state.scheduler);
    state.scheduler=null;
    statusNote('Conditional proposal deadline expired; press Start separately');
  }
  // This clock only proves no authenticated terminal was received within a
  // bounded local interval. It does not claim the remote model remains busy,
  // and it can OFFER manual review but never Send, retry or resume.
  function scheduleActiveRuleDeadline(signal){
    clearActiveRuleDeadlineTimer();
    if(!state.rulesEnabled||state.ruleOffer||state.routing||state.destroyed||
       state.key!==storageKey()||signal?.phase!=='generating'||
       signal.origin!=='fresh'||signal.confidence==='unknown'||
       !sameRuleEpoch(state.ruleClock,signal)||
       state.ruleClock.terminalPhase!==null)return;
    const duration=ruleDuration(signal);
    if(duration===undefined)return;
    const future=state.ruleLibrary.filter(rule=>rule.enabled&&
      rule.when.phase==='generating'&&
      Number.isSafeInteger(rule.when.minDurationMs)&&
      // Only retry thresholds not yet EVALUATED in this authenticated
      // epoch. The scheduler's second clock read can cross the minimum
      // after the preview saw threshold-1ms, but an ineligible rule must
      // not spin a 1ms timer forever after its threshold was checked.
      rule.when.minDurationMs>(state.ruleClock.lastEvaluatedDuration??-1))
      .map(rule=>rule.when.minDurationMs);
    if(!future.length)return;
    const remaining=Math.max(1,Math.min(...future)-duration);
    const mark={documentToken:signal.documentToken,route:signal.route,epoch:signal.epoch};
    activeRuleDeadlineTimer=setTimeout(()=>{
      activeRuleDeadlineTimer=null;
      const current=state.trusted;
      if(!state.rulesEnabled||state.ruleOffer||!state.initialized||
         state.routing||state.destroyed||state.key!==storageKey()||
         !current||current.phase!=='generating'||current.origin!=='fresh'||
         current.confidence==='unknown'||!sameRuleEpoch(mark,current)||
         !sameRuleEpoch(state.ruleClock,current)||
         state.ruleClock.terminalPhase!==null)return;
      considerConditionalPreview(current);
      if(!state.ruleOffer)scheduleActiveRuleDeadline(current);
    },Math.ceil(remaining));
  }
  // This is preview-only: authenticated provider events may offer an action,
  // but only the explicit local Approve control can enqueue or pause.
  function considerConditionalPreview(signal) {
    if(!state.rulesEnabled||!state.initialized||state.routing||
       state.ruleOffer||state.key!==storageKey())return;
    const duration=ruleDuration(signal);
    if(signal.phase==='generating'&&Number.isSafeInteger(duration)&&
       sameRuleEpoch(state.ruleClock,signal)){
      state.ruleClock.lastEvaluatedDuration=Math.max(
        state.ruleClock.lastEvaluatedDuration??-1,duration);
    }
    const result=rulesEngine.evaluate(state.ruleLibrary,signal,state.ruleSeen,
      {completedRuleIds:state.ruleCompleted,
        ...(duration===undefined?{}:{stateDurationMs:duration})});
    if(!result?.ok||!result.decision)return;
    state.ruleSeen.push(result.decision.eventKey);
    if(state.ruleSeen.length>rulesEngine.MAX_SEEN)state.ruleSeen.shift();
    const offeredAt=performance.now();
    const deadlineMs=result.decision.approvalDeadlineMs;
    state.ruleOffer={key:state.key,ruleId:result.decision.ruleId,
      action:result.decision.action,consentGeneration:state.ruleConsentGeneration,
      documentToken:signal.documentToken,
      epoch:signal.epoch,phase:signal.phase,confidence:signal.confidence,
      ...(deadlineMs===undefined?{}:
        {offeredAt,deadlineAt:offeredAt+deadlineMs})};
    clearRuleApprovalTimer();
    if(deadlineMs!==undefined){
      const offer=state.ruleOffer;
      ruleApprovalTimer=setTimeout(()=>expireConditionalOffer(offer),deadlineMs);
    }
    auditOffer('offered',state.ruleOffer);
    clearActiveRuleDeadlineTimer();
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
    const attemptKey=state.key,attemptGeneration=routeGeneration,attemptRegistration=state.registrationGeneration;
    const attemptToken=uid();
    const holdId=uid();
    const baseline=state.trusted;
    state.attempting=attemptToken;
    // A -> B -> A can restore the exact pathname while an older Firefox
    // authorization promise is still pending. Path equality alone cannot
    // authorize that old attempt or allow it to clear a newer attempt.
    const sameAttempt=()=>state.attempting===attemptToken&&
      routeGeneration===attemptGeneration&&state.registrationGeneration===attemptRegistration&&
      !state.routing&&!state.destroyed&&
      state.key===attemptKey&&storageKey()===attemptKey;
    statusNote('Preparing next message');
    let clicked=false;
    // Set this BEFORE invoking click(): a handler may submit and then throw.
    // Only an attempt that never entered the click path can safely release
    // its own pre-click Send hold without any submission evidence.
    let clickStarted=false;
    // The confirmation/history write can fail AFTER one real Send click.
    // In that case preserve the cross-tab response lease while permitting
    // explicit uncertain-item review; never claim history was persisted.
    let acceptedHistoryWritePending=false;
    let acceptedHistoryBefore=null;
    let editor,send,proof,composerForm;
    let humanTouched=false,queueFilling=false;
    // Any *other* activation of the exact Send control can have caused a
    // remote submission, including page-script .click() events (untrusted
    // in Firefox). Distinguish ONLY Queue's one own synchronous .click().
    let foreignSubmission=false,ownSendClickObserved=false;
    // Start observing at the FIRST asynchronous dispatch boundary, not
    // after filling the composer. A real user may type and then erase text
    // during provider authorization or journal storage; a later empty editor
    // is not evidence the user has relinquished control.
    const onHumanInput=event=>{if(event.isTrusted&&!queueFilling)humanTouched=true;};
    const onSendClick=()=>{
      if(clickStarted&&!clicked&&!ownSendClickObserved){
        ownSendClickObserved=true;return; // Our own one synchronous click.
      }
      // A person or page script may have already submitted this prompt.
      // Synthetic page clicks are not trusted input, but their *effect*
      // is just as irreversible as a browser-trusted human Send.
      foreignSubmission=true;humanTouched=true;
    };
    const onFormSubmit=()=>{
      // React/native forms can submit via requestSubmit() or a submit
      // event without activating the Send button. An observed submission
      // may have reached the remote server: do not release its durable hold.
      // Ignore only a submit synchronously CAUSED by Queue's own click.
      if(clickStarted&&!clicked&&ownSendClickObserved)return;
      foreignSubmission=true;humanTouched=true;
    };
    document.addEventListener('beforeinput',onHumanInput,true);
    document.addEventListener('input',onHumanInput,true);
    document.addEventListener('change',onHumanInput,true);
    // A click into a different editor or keyboard navigation also means the
    // person has reclaimed the page, even if no text was changed. Never
    // refocus the ChatGPT composer behind an intentional user gesture.
    document.addEventListener('pointerdown',onHumanInput,true);
    document.addEventListener('keydown',onHumanInput,true);
    try {
      if(!sameAttempt())
        throw new Error('Conversation changed before composer handoff');
      // Reserve the exact-route owner before changing the page composer.
      // Competing tabs fail while their drafts remain completely untouched.
      const ownership=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
        action:'dispatch-check',registrationGeneration:attemptRegistration,
         route:baseline.route,documentToken:baseline.documentToken,
        epoch:baseline.epoch,sequence:baseline.sequence});
      if(!ownership?.ok)throw new Error(ownership?.error==='conversation-owned-by-another-tab'
        ? 'Another tab owns this conversation; no Send attempted'
        : ownership?.error==='unresolved-durable-send'
          ? 'Previous Send may be unresolved; review its hold'
          : ownership?.error==='send-hold-storage-unavailable'
            ? 'Saved Send hold unavailable; no Send attempted'
            : 'Signal authority lost; no Send attempted');
      if(!state.running||!sameAttempt()||humanTouched)
        throw new Error(humanTouched
          ? 'Human interaction before composer handoff; no Send attempted'
          : 'Dispatch context changed before composer handoff');
      const found=findComposer();
      // Journal uncertainty BEFORE exposing queue text in the page composer.
      // A human click during async preflight must not send unjournaled text.
      item.status='uncertain';
      await save();
      if(!state.running||!sameAttempt()||state.storageFault||state.pendingSaves>0||
         humanTouched)
        throw new Error(humanTouched
          ? 'Human interaction before composer handoff; no Send attempted'
          : 'Dispatch changed during uncertainty journal');
      // Another browser/user input may have appeared while storage committed.
      const current=findComposer();
      if(current.editor!==found.editor||current.form!==found.form)
        throw new Error('Composer replaced during uncertainty journal');
      editor=current.editor;composerForm=current.form;
      // This marker contains only a random hold ID plus route/tab metadata.
      // It must persist AFTER the private uncertainty journal but BEFORE
      // exposing the prompt in ChatGPT's composer or clicking Send.
      const reserved=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
        action:'dispatch-check',stage:'reserve',holdId,
         registrationGeneration:attemptRegistration,
        route:baseline.route,documentToken:baseline.documentToken,
        epoch:baseline.epoch,sequence:baseline.sequence});
      if(!reserved?.ok)throw new Error(reserved?.error==='unresolved-durable-send'
        ? 'Previous Send may be unresolved; review its hold'
        : 'Could not persist Send hold; no Send attempted');
      state.durableHoldId=holdId;
      if(!sameAttempt()||!state.running||state.storageFault||humanTouched)
        throw new Error(humanTouched
          ? 'Human interaction before composer handoff; no Send attempted'
          : 'Dispatch context changed after Send hold');
      // Reserving durable metadata is asynchronous. Check the composer
      // *again* after the storage round-trip: a real user may have typed
      // their own draft while Firefox committed the hold.
      const afterHold=findComposer();
      if(afterHold.editor!==editor||afterHold.form!==composerForm)
        throw new Error('Composer changed during Send hold; no Send attempted');
      // Firefox's execCommand('insertText') can emit a browser-trusted
      // input event for Queue's OWN insertion. Ignore only that synchronous
      // handoff, never a user's earlier or later trusted edit.
      if(humanTouched)
        throw new Error('Human interaction before composer handoff; no Send attempted');
      queueFilling=true;
      try{fillComposer(editor,item.text);}
      finally{queueFilling=false;}
      send=await waitForSend(current.form,()=>state.running&&sameAttempt()&&
        !state.storageFault&&state.pendingSaves===0&&!humanTouched&&
        freshProvider()&&state.trusted===baseline&&editor.isConnected&&
        editor.closest('form')===composerForm&&
        canonicalComposerText(editorValue(editor))===canonicalComposerText(item.text)&&
        ![...composerForm.querySelectorAll('input[type="file"]')]
          .some(input=>input.files?.length));
      // A user may switch to another editable field while the browser-owned
      // sealed authorization is pending. Real edits elsewhere on this page
      // also mean the user has resumed control and must cancel Queue Send.
      // Synthetic page events are untrusted and cannot trip this guard.
      send.addEventListener('click',onSendClick,true);
      composerForm.addEventListener('submit',onFormSubmit,true);
      // A real file-picker change can happen after the click without any
      // input event on the editor or Send button. Treat it as user interference.
      composerForm.addEventListener('change',onHumanInput,true);
      // Require the event page to still own this authenticated provider
      // epoch immediately pre-click; a restart invalidates its volatile ledger.
      const permission=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
        action:'dispatch-check',stage:'sealed',holdId,
         registrationGeneration:attemptRegistration,
        route:baseline.route,documentToken:baseline.documentToken,
        epoch:baseline.epoch,sequence:baseline.sequence});
      if(!permission?.ok)throw new Error('Signal authority lost; no Send attempted');
      if (!state.running || !sameAttempt() ||
          state.storageFault || state.pendingSaves>0 || humanTouched ||
          !freshProvider() || state.trusted!==baseline || !send.isConnected ||
          canonicalComposerText(editorValue(editor))!==canonicalComposerText(item.text))
        throw new Error('Dispatch context changed; no send attempted');
      // A new attachment, editor, form or Send control after our initial
      // preflight is a genuine user/DOM conflict even if text still matches.
      const form=editor.closest('form');
      const visibleEditors=[...document.querySelectorAll(editorSelector)].filter(usableComposer);
      if(!form?.isConnected || visibleEditors.length!==1 || visibleEditors[0]!==editor ||
         [...form.querySelectorAll('input[type="file"]')].some(input=>input.files?.length) ||
         findSend(form)!==send)
        throw new Error('Composer changed before Send; no send attempted');
      // Keep authenticated busy evidence if the response ends before polling.
      proof={key:attemptKey,generation:attemptGeneration,baseline,editor,busy:null};
      state.inflightProof=proof;
      // This initiates exactly one send attempt. We never click again after uncertainty.
      clickStarted=true;send.click(); clicked=true;
      statusNote('Verifying submission');
      let accepted=false;
      for (let i=0;i<12;i++) {
        await delay(250);
        // The human may edit or click Send after our own single click but
        // before the provider confirms a fresh busy epoch. A matching empty
        // editor is insufficient proof once this interaction was observed.
        if(humanTouched)
          throw new Error('Human interaction during submission verification; manual review required');
        if(composerForm && [...composerForm.querySelectorAll('input[type="file"]')].some(input=>input.files?.length))
          throw new Error('Composer attachment during submission verification; manual review required');
        if (!state.running || !sameAttempt() || !editor.isConnected) break;
        const busy=proof.busy || (contract.newBusy(state.trusted,baseline)?state.trusted:null);
        if (busy && !editorValue(editor).trim()) {
          state.waiting={documentToken:baseline.documentToken,route:baseline.route,
            epoch:busy.epoch,sequence:busy.sequence};
          accepted=true;break;
        }
      }
      if(!sameAttempt())throw new Error('Conversation changed during submission');
      if (!accepted) throw new Error('Submission not confirmed; manual review required');
      // Persist removal first; do not consider another item until storage commits.
      // Snapshot BEFORE the bounded 20-entry insert: a rejected write must
      // not silently discard the oldest unrelated history entry.
      acceptedHistoryBefore=state.history.map(entry=>({...entry}));
      state.items=state.items.filter(x=>x.id!==item.id);
      state.history.unshift({id:item.id,text:item.text,at:Date.now(),status:'submitted'});
      state.history=state.history.slice(0,20);
      state.awaiting=true;
      state.busySeen=true;
      acceptedHistoryWritePending=true;
      await save();
      acceptedHistoryWritePending=false;
      statusNote('Waiting for confirmed response completion');
      processSignal();
    } catch(error) {
      if(sameAttempt()) {
        state.running=false;
        // A script click can have submitted a real prompt even when trusted
        // busy evidence never arrived. Hold this conversation's volatile
        // cross-tab lease until deliberate uncertain-item resolution; a
        // disconnected/late provider cannot certify that the click failed.
        if((clickStarted||foreignSubmission)&&!state.awaiting)state.unconfirmedClickLease=true;
        if(acceptedHistoryWritePending){
          // The remote response may still be generating. Hold the existing
          // owner lease until its attributable terminal or an explicit review
          // action, but allow Retry/Discard without reloading this tab.
          state.awaitingUncertain=true;
          state.history=acceptedHistoryBefore;
        }
        // Pre-click journal is also uncertain if preparation was interrupted;
        // conservative manual resolution is required in either case.
        if(!state.items.some(entry=>entry.id===item.id))state.items.unshift(item);
        try{await save();}catch{}
        // This document is the authenticated owner of its saved hold.
        // A failed pre-click editor/Send check without ANY observed Send
        // activation cannot have submitted by Queue or another known actor.
        // A competing Send click OR form submission is different: the site
        // may have accepted it, so retain the hold for explicit review even
        // though Queue itself never entered its .click() path.
        let preClickReleaseFailed=false;
        if(!clickStarted&&!foreignSubmission&&state.durableHoldId)
          preClickReleaseFailed=!await releaseDurableHold();
        statusNote(preClickReleaseFailed
          ? 'No Send click attempted; prior Send hold needs separate review'
          : acceptedHistoryWritePending
            ? 'Submission record could not be saved; review uncertain message'
            : foreignSubmission
              ? 'Another Send may have submitted this prompt; review uncertain message'
              : error.message || 'Dispatch failed');
      }
    } finally {
      if(state.inflightProof===proof)state.inflightProof=null;
      document.removeEventListener('beforeinput',onHumanInput,true);
      document.removeEventListener('input',onHumanInput,true);
      document.removeEventListener('change',onHumanInput,true);
      document.removeEventListener('pointerdown',onHumanInput,true);
      document.removeEventListener('keydown',onHumanInput,true);
      if(send)send.removeEventListener('click',onSendClick,true);
      if(composerForm)composerForm.removeEventListener('submit',onFormSubmit,true);
      if(composerForm)composerForm.removeEventListener('change',onHumanInput,true);
      if(state.attempting===attemptToken)state.attempting=null;
      render();publish();
    }
  }
  async function releaseDurableHold(){
    const id=state.durableHoldId,key=state.key,route=routeKey();
    if(!id){
      // After a content-script reload, the old Send's random hold ID is
      // intentionally not reconstructed from a private queue record. Do not
      // claim release succeeded merely because the volatile field is empty.
      // A surviving durable hold requires separate explicit local review.
      try{
        const current=await api.runtime.sendMessage({
          type:'chat-queue-internal/v1',action:'send-hold-status',route,
          registrationGeneration:state.registrationGeneration});
        return current?.ok===true&&current.held===false&&
          state.key===key&&routeKey()===route;
      }catch{return false;}
    }
    let reply;
    try{reply=await api.runtime.sendMessage({type:'chat-queue-internal/v1',
      action:'release-send-hold',route,holdId:id,
       registrationGeneration:state.registrationGeneration});}
    catch{return false;}
    if(!reply?.ok)return false;
    if(state.key===key&&routeKey()===route&&state.durableHoldId===id)
      state.durableHoldId=null;
    return true;
  }
  // A rejected terminal/history status write cannot turn an unsaved
  // 'finished' or 'interrupted' label into apparent durable evidence.
  // Compare exact route generation and revision before restoring, so a
  // delayed rejection cannot undo a newer route or genuine user edit.
  function persistResponseHistoryStatus(nextStatus) {
    const entry=state.history[0];
    if(!entry||!['submitted','interrupted'].includes(entry.status))return;
    const previous=entry.status,key=state.key,generation=routeGeneration,
      revision=state.revision,id=entry.id;
    entry.status=nextStatus;
    void save().then(async()=>{
      if(nextStatus!=='finished'||state.key!==key||
         routeGeneration!==generation)return;
      if(!await releaseDurableHold()){
        state.running=false;
        statusNote('Send hold could not be cleared; review before another Send');
        return;
      }
      if(state.running&&!state.awaiting&&!state.attempting)planNext();
    }).catch(()=>{
      if(state.key===key&&routeGeneration===generation&&
         state.revision===revision+1&&state.history[0]?.id===id&&
         state.history[0].status===nextStatus){
        state.history[0].status=previous;
        state.revision++;state.etag=uid();
        render();publish();
      }
    });
    return true;
  }
  // Close a confirmed submission's response wait without putting its
  // already-clicked text back into the retry queue. A new local Start must
  // separately authorize the *next* pending item after cancellation.
  function closeUnfinishedResponse(status){
    if(!state.awaiting)return;
    const uncertainHistory=state.awaitingUncertain;
    state.awaiting=false;state.awaitingUncertain=false;state.busySeen=false;state.waiting=null;
    // A failed accepted-history commit left the previously clicked prompt
    // uncertain. Unknown, failed, interrupted or unattributed idle evidence
    // cannot release another tab to Send before explicit saved resolution.
    // An attributable finished epoch follows the separate completion path.
    if(uncertainHistory)state.unconfirmedClickLease=true;
    // A failed accepted-history write left NO current history entry. Do not
    // accidentally mark an older unrelated submitted response interrupted.
    if(!uncertainHistory&&state.history[0]?.status==='submitted')
      persistResponseHistoryStatus(status);
  }
  function processSignal() {
    if (state.key && state.key!==storageKey()) {void handleRouteChange();return;}
    const next=state.trusted?.phase || 'unknown';
    const previous=state.signal;state.signal=next;
    if ((state.running||state.awaiting) &&
        (next==='failed'||next==='limit'||next==='interrupted'||next==='unknown')) {
      // Never resume from a failed or disconnected provider. The already
      // clicked item stays in historical records, not a blind retry.
      closeUnfinishedResponse(next==='failed'||next==='limit'?'failed':'interrupted');
      state.running=false;statusNote(`Paused on ${next}`);
    } else if(state.awaiting && next==='idle' && previous!=='idle'){
      // Stop is a fresh, same-response-epoch idle transition. Any anomalous
      // idle also pauses fail-closed rather than keeping the next item stuck.
      const attributable=contract.cancelled(state.trusted,state.waiting);
      closeUnfinishedResponse('interrupted');
      state.running=false;
      statusNote(attributable
        ? 'Response cancelled; review prior Send hold before restarting'
        : 'Unattributed response cancellation; review prior Send hold');
    } else if (state.awaiting && contract.completed(state.trusted,state.waiting)) {
      const uncertainHistory=state.awaitingUncertain;
      state.awaiting=false;state.awaitingUncertain=false;state.busySeen=false;state.waiting=null;
      // A trusted finished epoch does not make a FAILED accepted-history write
      // durable. The clicked item is still uncertain until manual resolution;
      // retain cross-tab Send ownership exactly as for unknown/failed epochs.
      if(uncertainHistory)state.unconfirmedClickLease=true;
      // Only a durably journaled current response can close a history row.
      // The first row may belong to an older, abandoned submission.
      const savingFinished=!uncertainHistory&&
        persistResponseHistoryStatus('finished');
      statusNote('Response finished; control returned');
      // No following Send until finished history AND metadata hold release
      // have both committed; the async completion schedules continuation.
      if(state.running&&!savingFinished)planNext();
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
  function requestVerifiedProvider(){
    if(!state.initialized||state.destroyed||state.routing||
       state.key!==storageKey()||
       !contract.assignedConversationRoute(routeKey()))return;
    // One-shot request only; this is not provider evidence or Start authority.
    void api.runtime.sendMessage({type:'chat-queue-internal/v1',
      action:'sync-provider',route:routeKey(),
       registrationGeneration:state.registrationGeneration}).catch(()=>{});
  }
  async function handleRouteChange() {
    if(!state.initialized)return;
    settleStartRefresh(false);
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
    setQueueDraft('');
    const generation=++routeGeneration;
    state.registrationGeneration=null;
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
    state.running=false;state.awaiting=false;state.awaitingUncertain=false;state.attempting=null;state.durableHoldId=null;state.unconfirmedClickLease=false;state.busySeen=false;
    holdReviewArmed=false;holdReviewTarget=null;holdReviewRequest++;
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
      setQueueDraft('');
      state.storageFault=true;state.blockedRecord=true;
      state.items=[];state.history=[];state.recoveredSources=[];state.requestHighWatermarks=Object.create(null);
      state.revision=0;state.etag=uid();state.editing=null;
      state.running=false;state.awaiting=false;state.awaitingUncertain=false;state.routing=false;
      statusNote('Could not load conversation queue; reload to retry');
      host.style.removeProperty('visibility');
      return;
    }
    if(generation!==routeGeneration||storageKey()!==newKey)return;
    state.key=newKey;
    setQueueDraft(routeDrafts.get(newKey)||'');
    state.storageFault=false;state.pendingSaves=0;
    state.revision=0;state.etag=uid(); // invalidate stale compare tokens across routes
    state.blockedRecord=!core.savedRecordSupport(stored[newKey]).ok;
    state.items=state.blockedRecord?[]:core.normalizeSaved(stored[newKey]);
    state.history=state.blockedRecord?[]:readHistory(stored[newKey]);
    state.recoveredSources=state.blockedRecord?[]:readRecoverySources(stored[newKey]);
    state.requestHighWatermarks=state.blockedRecord?Object.create(null):core.readRequestHighWatermarks(stored[newKey]);
    state.observedSignal=signalFromPage();state.note=state.blockedRecord?'Unsupported saved queue; editing disabled':'Conversation changed; manually start queue';state.editing=null;
    // A new route also invalidates the background's Signal document sequence.
    let registration;
    try{registration=await api.runtime.sendMessage({
      type:'chat-queue-internal/v1',action:'register',route:routeKey(),registrationVersion:2});
    }catch{}
    if(generation!==routeGeneration||storageKey()!==newKey)return;
    if(registration?.ok&&validRegistrationGeneration(registration.registrationGeneration))
      state.registrationGeneration=registration.registrationGeneration;
    state.routing=false;render();host.style.removeProperty('visibility');publish();
    requestVerifiedProvider();
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
        // A Send attempt owns the uncertainty journal until it exits.
        // Even a distinct peer/client prompt cannot write that record while
        // the one-click handoff is in progress.
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
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
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
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
        if(state.running||state.attempting||
           (state.awaiting&&!state.awaitingUncertain))
          return {ok:false,error:'pause-before-resolving-uncertain'};
        const item=state.items.find(i=>i.id===payload?.id && i.status==='uncertain');
        if(!item)return {ok:false,error:'not-uncertain'};
        if(!['retry','discard'].includes(payload?.decision))return {ok:false,error:'invalid-decision'};
        const result=await persistItemMutation(()=>{
          if(payload.decision==='retry')item.status='pending';
          else state.items=state.items.filter(i=>i.id!==item.id);
        });
        if(result.ok){
          // Deliberately persisted review releases the conservative
          // no-busy-evidence click lease as well as an accepted-write lease.
          // An unsuccessful save must retain both forms of ownership.
          state.unconfirmedClickLease=false;
          // This explicit choice has already been durably saved. A failed
          // metadata-release leaves the conservative blocker in place.
          const released=await releaseDurableHold();
          // The deliberate decision is the only non-provider event allowed to
          // release a lease held for a failed post-click history write. A
          // rejected resolution write must keep the lease and review item.
          if(state.awaitingUncertain){
            state.awaiting=false;state.awaitingUncertain=false;
            state.busySeen=false;state.waiting=null;
          }
          statusNote(!released
            ? 'Saved review; Send hold still active, review separately'
            : payload.decision==='retry'
              ? 'Retry marked pending; press Start separately'
              : 'Uncertain message discarded; queue remains paused');
        }
        return result;
      }
      if (action==='pause') {settleStartRefresh(false);state.running=false;if(state.scheduler)clearTimeout(state.scheduler);state.scheduler=null;statusNote('Manually paused');return {ok:true};}
      if (action==='start') {
        // Pause during a delayed dispatch-check is not a new grant. The
        // earlier attempt must fully unwind before another Start can run.
        if(state.attempting)return {ok:false,error:'dispatch-in-progress'};
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
        if (startRefresh)return {ok:false,error:'signal-refresh-in-progress'};
        if (state.running)return {ok:false,error:'already-running'};
        if (!freshProvider()){
          // No unattended Send: this refresh is initiated by exactly this
          // Start gesture, is bounded, and requires a *new* verified message.
          const confirmed=await refreshProviderForStart();
          if(!confirmed)return {ok:false,error:'authenticated-chat-signals-required'};
          // All mutable preflight conditions may have changed across await.
          if(state.destroyed||state.routing||state.key!==storageKey()||
             state.attempting||state.ruleOffer||state.storageFault||
             state.pendingSaves>0||uncertain()||
             (!pending()&&!state.awaiting)||state.running)
            return {ok:false,error:'start-context-changed'};
        }
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
    // A home, shared, search or other unassigned pathname can name several
    // different chats. Exact pathname equality alone cannot bind old prompts
    // to the current conversation, even with deliberate human confirmation.
    if(!contract.assignedConversationRoute(routeKey())){
      els['data-note'].textContent='Recovery requires an assigned conversation URL';
      render();return;
    }
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
       !contract.assignedConversationRoute(routeKey())||
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
  els['hold-review'].addEventListener('click',async()=>{
    if(state.running||state.awaiting||state.attempting||state.routing||
       state.storageFault||state.pendingSaves>0||state.importing||
       !contract.assignedConversationRoute(routeKey())){
      holdReviewArmed=false;holdReviewTarget=null;holdReviewRequest++;
      statusNote('Pause and finish active work before reviewing a Send hold');
      return;
    }
    const key=state.key,route=routeKey(),generation=routeGeneration;
    if(!holdReviewArmed){
      const reviewRequest=++holdReviewRequest;
      try{
        const answer=await api.runtime.sendMessage({
          type:'chat-queue-internal/v1',action:'send-hold-status',route,
          registrationGeneration:state.registrationGeneration});
        if(state.key!==key||routeGeneration!==generation||
           holdReviewRequest!==reviewRequest)return;
        if(!answer?.ok){statusNote('Could not check Send hold');return;}
        if(!answer.held){statusNote('No previous Send hold for this conversation');return;}
        if(typeof answer.holdId!=='string'){statusNote('Invalid Send hold; review unavailable');return;}
        holdReviewTarget=answer.holdId;
        holdReviewArmed=true;
        statusNote('Check the ChatGPT transcript for a prior Send, then click Review prior Send hold again to release the blocker. No retry occurs.');
      }catch{statusNote('Could not check Send hold');}
      return;
    }
    holdReviewArmed=false;
    const reviewedHoldId=holdReviewTarget;
    holdReviewTarget=null;holdReviewRequest++;
    try{
      const answer=await api.runtime.sendMessage({
        type:'chat-queue-internal/v1',action:'review-send-hold',route,
        confirmed:true,holdId:reviewedHoldId,
         registrationGeneration:state.registrationGeneration});
      if(state.key!==key||routeGeneration!==generation)return;
      if(!answer?.ok){
        statusNote(answer?.error==='active-send-hold'
          ? 'An active Send still owns this conversation; resolve it first'
          : answer?.error==='send-hold-changed'
            ? 'Previous Send hold changed; inspect and review again'
            : 'Send hold was not released; review again');
        return;
      }
      state.durableHoldId=null;
      statusNote('Prior Send hold released after deliberate review; queue remains paused');
    }catch{statusNote('Send hold was not released; review again');}
  });
  shadow.addEventListener('click',event=>{
    // Two consecutive clicks on this control belong to the same review
    // intent. Another HUD click invalidates that earlier consent.
    if(event.target!==els['hold-review']){
      holdReviewArmed=false;
      holdReviewTarget=null;
      holdReviewRequest++;
    }
  },true);
  document.addEventListener('click',event=>{
    if(holdReviewArmed&&!host.contains(event.target)){
      holdReviewArmed=false;
      holdReviewTarget=null;
      holdReviewRequest++;
    }
  },true);
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
    const draftKey=state.key,draftGeneration=routeGeneration;
    // Lock synchronously BEFORE requesting a cross-frame snapshot. Awaiting
    // the private MessagePort otherwise permits duplicate Add clicks.
    state.adding=true;render();
    try{
      const text=isolatedDraft?await readQueueDraft():els.draft.value;
      if(text===null||state.key!==draftKey||routeGeneration!==draftGeneration){
        if(text===null)statusNote('Private editor unavailable; no message added');
        return;
      }
      const version=draftInputVersion;
      const response=await act('enqueue',{text},true);
      if(response.ok){
        if(draftInputVersion===version){
          if(state.key===draftKey&&routeGeneration===draftGeneration&&
             els.draft.value===text)setQueueDraft('');
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
    if(!response.ok)statusNote(
      response.error==='authenticated-chat-signals-required'&&
      state.trusted?.origin==='restored'
        ? 'Historical response is not Send authorization; a new live Chat Signals epoch is required'
        : response.error);
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
    // Browser timers are throttleable. Even if the expiry callback has not
    // fired yet, an approval after its monotonic deadline MUST fail closed.
    if(offer.deadlineAt!==undefined){
      const now=performance.now();
      if(!(now>=offer.offeredAt&&now<offer.deadlineAt)){
        expireConditionalOffer(offer,true);
        return;
      }
    }
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
      if(startRefresh&&startRefresh.key===state.key&&
         startRefresh.route===routeKey()&&
         startRefresh.generation===routeGeneration&&
         startRefresh.registration===state.registrationGeneration&&
         state.trusted!==startRefresh.previous&&freshProvider())
        settleStartRefresh(true);
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
      if(proof&&proof.key===state.key&&proof.generation===routeGeneration&&
         contract.newBusy(next,proof.baseline)&&proof.editor.isConnected&&
         !proof.busy)proof.busy=next;
      recordRuleClock(next);
      processSignal();
      considerConditionalPreview(next);
      scheduleActiveRuleDeadline(next);
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
  window.addEventListener('pageshow',event=>{
    // A page script can forge pageshow, but only the browser can restore an
    // actual bfcache document. A prior trusted pagehide tore down listeners;
    // force a new paused extension registration instead of reviving a dead HUD.
    if(!event.isTrusted)return;
    if(event.persisted&&state.destroyed){location.reload();return;}
    void handleRouteChange();
  });
  document.addEventListener('click',event=>{
    if(!event.target?.closest?.('a[href]'))return;
    for(const ms of [0,150,650]) setTimeout(()=>{
      if(state.initialized && routeKey()!==state.keyRoute) {state.keyRoute=routeKey();void handleRouteChange();}
    },ms);
  },{passive:true});
  window.addEventListener('pagehide',event=>{
    // Never let page-origin JavaScript forge a lifecycle teardown. Do not use
    // {once:true}: an untrusted event would consume a one-shot listener.
    if(!event.isTrusted||state.destroyed)return;
    state.running=false;state.destroyed=true;
    signalObserver.disconnect();clearInterval(routeWatch);
    if(state.scheduler)clearTimeout(state.scheduler);
  });
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
        response=await api.runtime.sendMessage({type:'chat-queue-internal/v1',action:'register',route:initialRoute,registrationVersion:2});
        if(response?.ok)break;
        if(routeKey()===initialRoute)throw new Error('Registration unavailable');
      }
      if(!response?.ok)throw new Error('Registration unavailable after route changes');
      // A missing generation must never authorize background state updates.
      state.registrationGeneration=validRegistrationGeneration(response.registrationGeneration)
        ?response.registrationGeneration:null;
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
        render();publish();requestVerifiedProvider();
      }
    } catch(error) {
      state.destroyed=true;signalObserver.disconnect();clearInterval(routeWatch);
      // Do not inject a broken HUD or a partial queue.
    }
  })();
})();
