/* An explicitly non-executing rule sandbox. No browser APIs, queues or Send. */
(() => {
  'use strict';
  const engine=globalThis.ChatQueueRules;
  const rules=[];
  const consumed=[];
  const field=id=>document.getElementById(id);
  const output=field('preview-output'), feedback=field('rule-message');
  function print(message){ output.textContent=message; }
  function draw(){
    const list=field('rule-list');
    list.replaceChildren();
    for(const rule of rules){
      const li=document.createElement('li');
      const label=document.createElement('span');
      label.textContent=`${rule.id} · ${rule.enabled?'enabled':'disabled'} · ${rule.when.phase} · priority ${rule.priority} · ${rule.then.type}`;
      const remove=document.createElement('button');
      remove.type='button'; remove.textContent='Remove';
      remove.setAttribute('aria-label',`Remove ${rule.id}`);
      remove.addEventListener('click',()=>{
        const idx=rules.findIndex(r=>r.id===rule.id);
        if(idx>=0){rules.splice(idx,1);consumed.length=0;draw();print('Rule removed; no queue action taken.');}
      });
      li.append(label,remove);list.append(li);
    }
  }
  field('rule-action').addEventListener('change',()=>{
    const isPause=field('rule-action').value==='pause';
    field('rule-text').disabled=isPause;
  });
  field('rule-form').addEventListener('submit',event=>{
    event.preventDefault();
    const candidate={version:1,id:field('rule-id').value.trim(),enabled:field('rule-enabled').checked,
      priority:Number(field('rule-priority').value),
      when:{phase:field('rule-phase').value,confidence:field('rule-confidence').value},
      then:field('rule-action').value==='pause'?{type:'pause'}:
        {type:'propose',text:field('rule-text').value}};
    const next=[...rules.filter(r=>r.id!==candidate.id),candidate];
    const normalized=engine.normalize(next);
    if(!normalized.ok){feedback.textContent=`Rejected: ${normalized.error}`;return;}
    rules.splice(0,rules.length,...normalized.rules);
    consumed.length=0;draw();
    feedback.textContent=`${rules.length} temporary rule(s); nothing saved or sent.`;
  });
  field('preview-form').addEventListener('submit',event=>{
    event.preventDefault();
    const epoch=Number(field('preview-epoch').value);
    if(!Number.isSafeInteger(epoch)||epoch<0||epoch>1000000){print('Invalid simulated epoch');return;}
    const synthetic={version:1,route:'/c/synthetic-preview',documentToken:'a'.repeat(32),
      epoch,sequence:1,phase:field('preview-phase').value,
      confidence:field('preview-confidence').value,origin:field('preview-origin').value};
    const result=engine.evaluate(rules,synthetic,consumed);
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
  draw();
})();
