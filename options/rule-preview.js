/* Persistent local rule editor; evaluation is simulation only. Never accesses a chat or Send. */
(() => {
  'use strict';
  const engine=globalThis.ChatQueueRules;
  const store=globalThis.ChatQueueRuleStore;
  const api=globalThis.browser||globalThis.chrome;
  const rules=[];
  const consumed=[];
  const field=id=>document.getElementById(id);
  const output=field('preview-output'), feedback=field('rule-message');
  let blocked=true, saving=false, clearArmed=false;
  function print(message){ output.textContent=message; }
  function resetClear(){clearArmed=false;field('rule-clear').textContent='Clear saved rules';}
  function feedbackText(message){feedback.textContent=message;}
  function enableEditing(){
    const busy=blocked||saving;
    field('rule-add').disabled=busy;
    field('rule-clear').disabled=busy;
    field('rule-reload').disabled=saving;
    field('preview-form').querySelector('button[type="submit"]').disabled=blocked||saving;
  }
  function draw(){
    const list=field('rule-list');list.replaceChildren();
    for(const rule of rules){
      const li=document.createElement('li'),label=document.createElement('span');
      label.textContent=`${rule.id} · ${rule.enabled?'enabled':'disabled'} · ${rule.when.phase} · priority ${rule.priority} · ${rule.then.type}${rule.when.minDurationMs===undefined?'':` · from ${rule.when.minDurationMs} ms`}${rule.when.maxDurationMs===undefined?'':` · until ${rule.when.maxDurationMs} ms`}`;
      const edit=document.createElement('button');edit.type='button';edit.textContent='Edit';
      edit.setAttribute('aria-label',`Edit ${rule.id}`);
      edit.addEventListener('click',()=>{
        resetClear();
        field('rule-id').value=rule.id;field('rule-enabled').checked=rule.enabled;
        field('rule-priority').value=rule.priority;field('rule-phase').value=rule.when.phase;
        field('rule-confidence').value=rule.when.confidence;
        field('rule-min-duration').value=rule.when.minDurationMs??'';
        field('rule-max-duration').value=rule.when.maxDurationMs??'';
        field('rule-action').value=rule.then.type;
        field('rule-text').value=rule.then.type==='propose'?rule.then.text:'';
        field('rule-text').disabled=rule.then.type==='pause';
        feedbackText(`Editing ${rule.id}. Save replaces this rule only.`);
        field('rule-id').focus();
      });
      const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';
      remove.disabled=blocked||saving;
      remove.setAttribute('aria-label',`Remove ${rule.id}`);
      remove.addEventListener('click',()=>{resetClear();void persist(rules.filter(r=>r.id!==rule.id),'Rule removed');});
      li.append(label,edit,remove);list.append(li);
    }
    enableEditing();
  }
  async function persist(next,label){
    if(blocked||saving)return;
    const encoded=store.encode(next);
    if(!encoded.ok){feedbackText(`Rejected: ${encoded.error}`);return;}
    saving=true;enableEditing();
    try{
      await api.storage.local.set({[store.KEY]:encoded.value});
      rules.splice(0,rules.length,...encoded.value.rules);
      consumed.length=0;resetClear();
      print('Saved rule definitions; nothing queued or sent.');
      feedbackText(`${label}. ${rules.length} saved preview rule(s).`);
    }catch{
      feedbackText('Could not save rule library; previous saved definitions remain unchanged.');
    }finally{saving=false;draw();}
  }
  async function load(){
    if(saving)return;
    blocked=true;enableEditing();
    try{
      const record=await api.storage.local.get(store.KEY);
      const decoded=store.decode(record?.[store.KEY]);
      if(!decoded.ok){feedbackText(`Cannot edit: ${decoded.error}. Saved data was not overwritten.`);return;}
      rules.splice(0,rules.length,...decoded.rules);
      consumed.length=0;resetClear();blocked=false;
      feedbackText(`${rules.length} saved preview rule(s). No rules can send messages.`);
      print('Rule definitions loaded; no queue action taken.');
    }catch{feedbackText('Could not read saved rules. No changes were made.');}
    finally{draw();}
  }
  field('rule-action').addEventListener('change',()=>{
    field('rule-text').disabled=field('rule-action').value==='pause';
  });
  field('rule-form').addEventListener('submit',event=>{
    event.preventDefault();if(blocked||saving)return;
    resetClear();
    const minInput=field('rule-min-duration').value.trim(),maxInput=field('rule-max-duration').value.trim();
    const min=minInput===''?{}:{minDurationMs:Number(minInput)};
    const max=maxInput===''?{}:{maxDurationMs:Number(maxInput)};
    const candidate={version:1,id:field('rule-id').value.trim(),enabled:field('rule-enabled').checked,
      priority:Number(field('rule-priority').value),
      when:{phase:field('rule-phase').value,confidence:field('rule-confidence').value,...min,...max},
      then:field('rule-action').value==='pause'?{type:'pause'}:
        {type:'propose',text:field('rule-text').value}};
    void persist([...rules.filter(r=>r.id!==candidate.id),candidate],`Saved ${candidate.id}`);
  });
  field('rule-reload').addEventListener('click',()=>{resetClear();void load();});
  field('rule-clear').addEventListener('click',()=>{
    if(blocked||saving)return;
    if(!clearArmed){clearArmed=true;field('rule-clear').textContent='Confirm clear saved rules';feedbackText('Click Confirm clear saved rules to remove every stored rule.');return;}
    clearArmed=false;field('rule-clear').textContent='Clear saved rules';
    void persist([],'Cleared saved rules');
  });
  field('preview-form').addEventListener('submit',event=>{
    event.preventDefault();if(blocked||saving)return;
    const epoch=Number(field('preview-epoch').value);
    if(!Number.isSafeInteger(epoch)||epoch<0||epoch>1000000){print('Invalid simulated epoch');return;}
    const synthetic={version:1,route:'/c/synthetic-preview',documentToken:'a'.repeat(32),
      epoch,sequence:1,phase:field('preview-phase').value,
      confidence:field('preview-confidence').value,origin:field('preview-origin').value};
    const durationInput=field('preview-duration').value.trim();
    const context=durationInput===''?undefined:{stateDurationMs:Number(durationInput)};
    const result=engine.evaluate(rules,synthetic,consumed,context);
    if(!result.ok){print(`Rejected: ${result.error}`);return;}
    if(!result.decision){print(`No proposal: ${result.reason}`);return;}
    if(consumed.length>=engine.MAX_SEEN)consumed.shift();
    consumed.push(result.decision.eventKey);
    const action=result.decision.action;
    print(`Would ${action.type==='pause'?'propose pausing':'propose text for review'} via ${result.decision.ruleId}.\nExplicit approval required. Nothing sent.${action.type==='propose'?`\n\n${action.text}`:''}`);
  });
  field('preview-reset').addEventListener('click',()=>{
    consumed.length=0;print('Replay history reset; no queue action taken.');
  });
  // Options is the only surface reading or mutating these saved definitions.
  void load();
})();
