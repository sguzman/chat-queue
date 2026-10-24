/* Declarative Chat Queue conditional-rule preview engine (v1).
 * Pure; never writes browser storage, reads transcript text, or sends prompts.
 * The caller must authenticate events before using the returned proposal.
 */
(function(root){
  'use strict';
  const contract=root.ChatQueueSignal;
  const VERSION=1,MAX_RULES=32,MAX_MESSAGE_CHARS=24000,MAX_SEEN=256;
  const MAX_DURATION_MS=3600000,MAX_RULE_LINKS=8;
  const PHASES=new Set(['finished','failed','interrupted','limit']);
  const CONFIDENCES=new Set(['any','observed','inferred']);
  const ACTIONS=new Set(['propose','pause']);
  const ID=/^[a-zA-Z0-9_-]{1,64}$/;
  const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
    (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
  const keys=(x,names)=>Object.keys(x).every(k=>names.includes(k));
  const validLinks=value=>value===undefined||(Array.isArray(value)&&value.length<=MAX_RULE_LINKS&&
    value.every(id=>typeof id==='string'&&ID.test(id))&&new Set(value).size===value.length);
  function normalize(input){
    if(!Array.isArray(input)||input.length>MAX_RULES)return {ok:false,error:'invalid-rule-count'};
    const ids=new Set(),out=[];
    for(const item of input){
      if(!plain(item)||!keys(item,['id','version','enabled','priority','when','then'])||
         item.version!==VERSION||typeof item.id!=='string'||!ID.test(item.id)||
         ids.has(item.id)||typeof item.enabled!=='boolean'||
         !Number.isSafeInteger(item.priority)||item.priority<0||item.priority>1000||
         !plain(item.when)||!keys(item.when,['phase','confidence','minDurationMs','maxDurationMs','dependsOn','skipIf'])||
         !PHASES.has(item.when.phase)||!validLinks(item.when.dependsOn)||!validLinks(item.when.skipIf)||
         (item.when.confidence!==undefined&&!CONFIDENCES.has(item.when.confidence))||
         (item.when.minDurationMs!==undefined&&(!Number.isSafeInteger(item.when.minDurationMs)||item.when.minDurationMs<0||item.when.minDurationMs>MAX_DURATION_MS))||
         (item.when.maxDurationMs!==undefined&&(!Number.isSafeInteger(item.when.maxDurationMs)||item.when.maxDurationMs<0||item.when.maxDurationMs>MAX_DURATION_MS))||
         (item.when.minDurationMs!==undefined&&item.when.maxDurationMs!==undefined&&item.when.minDurationMs>item.when.maxDurationMs)||
         !plain(item.then)||!keys(item.then,['type','text'])||
         !ACTIONS.has(item.then.type))return {ok:false,error:'invalid-rule'};
      if(item.then.type==='propose' && (typeof item.then.text!=='string'||
          !item.then.text.trim()||item.then.text.length>MAX_MESSAGE_CHARS))
        return {ok:false,error:'invalid-proposal-text'};
      if(item.then.type==='pause' && item.then.text!==undefined)
        return {ok:false,error:'unexpected-pause-text'};
      ids.add(item.id);
      out.push(Object.freeze({id:item.id,version:VERSION,enabled:item.enabled,
        priority:item.priority,when:Object.freeze({phase:item.when.phase,
          confidence:item.when.confidence||'any',
          ...(item.when.minDurationMs===undefined?{}:{minDurationMs:item.when.minDurationMs}),
          ...(item.when.maxDurationMs===undefined?{}:{maxDurationMs:item.when.maxDurationMs}),
          ...(item.when.dependsOn===undefined?{}:{dependsOn:Object.freeze([...item.when.dependsOn])}),
          ...(item.when.skipIf===undefined?{}:{skipIf:Object.freeze([...item.when.skipIf])})}),then:Object.freeze(item.then.type==='pause'
            ? {type:'pause'} : {type:'propose',text:item.then.text})}));
    }
    // References cannot point outside this bounded rule library, and cyclic
    // prerequisites would be impossible to satisfy without repeated actions.
    const byId=new Map(out.map(rule=>[rule.id,rule]));
    const visited=new Set(),active=new Set();
    const visit=id=>{
      if(active.has(id))return false;
      if(visited.has(id))return true;
      active.add(id);
      for(const dep of byId.get(id).when.dependsOn||[]){
        if(!byId.has(dep)||!visit(dep))return false;
      }
      active.delete(id);visited.add(id);return true;
    };
    for(const rule of out){
      const deps=rule.when.dependsOn||[],skip=rule.when.skipIf||[];
      if([...deps,...skip].some(ref=>ref===rule.id||!byId.has(ref))||
         deps.some(ref=>skip.includes(ref))||!visit(rule.id))
        return {ok:false,error:'invalid-dependency'};
    }
    out.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id,'en'));
    return {ok:true,rules:Object.freeze(out)};
  }
  function eventKey(s){return `${s.route}|${s.documentToken}|${s.epoch}|${s.phase}`;}
  function evaluate(input,event,used=[],context){
    const valid=normalize(input);
    if(!valid.ok)return valid;
    if(!Array.isArray(used)||used.length>MAX_SEEN||
       !used.every(x=>typeof x==='string'&&x.length<=650))
      return {ok:false,error:'invalid-history'};
    // Timing context is synthetic in preview mode; never use it to send.
    if(context!==undefined&&(!plain(context)||!keys(context,['stateDurationMs','completedRuleIds'])||
       (context.stateDurationMs!==undefined&&(!Number.isSafeInteger(context.stateDurationMs)||
        context.stateDurationMs<0||context.stateDurationMs>MAX_DURATION_MS))||
       (context.completedRuleIds!==undefined&&
        (!Array.isArray(context.completedRuleIds)||context.completedRuleIds.length>MAX_RULES||
         new Set(context.completedRuleIds).size!==context.completedRuleIds.length||
         context.completedRuleIds.some(id=>typeof id!=='string'||!ID.test(id)||
           !valid.rules.some(rule=>rule.id===id))))))
      return {ok:false,error:'invalid-context'};
    // Parse shape only; the Firefox sender principal is verified separately.
    const s=contract?.parse({type:contract.TYPE,signal:event});
    if(!s)return {ok:false,error:'invalid-event'};
    if(s.origin!=='fresh'||s.epoch===0||s.confidence==='unknown'||!PHASES.has(s.phase))
      return {ok:true,decision:null,reason:'not-actionable'};
    const key=eventKey(s);
    if(used.includes(key))return {ok:true,decision:null,reason:'already-considered'};
    const completed=new Set(context?.completedRuleIds||[]);
    const match=valid.rules.find(r=>r.enabled&&r.when.phase===s.phase&&
      (r.when.dependsOn||[]).every(id=>completed.has(id))&&
      !(r.when.skipIf||[]).some(id=>completed.has(id))&&
      (r.when.confidence==='any'||r.when.confidence===s.confidence)&&
      (r.when.minDurationMs===undefined||(context?.stateDurationMs!==undefined&&context.stateDurationMs>=r.when.minDurationMs))&&
      (r.when.maxDurationMs===undefined||(context?.stateDurationMs!==undefined&&context.stateDurationMs<=r.when.maxDurationMs)));
    if(!match)return {ok:true,decision:null,reason:'no-match'};
    return {ok:true,decision:Object.freeze({ruleId:match.id,eventKey:key,
      action:match.then,approvalRequired:true}),reason:'preview-only'};
  }
  // Local dry-run audit summary: deliberately exclude route, document
  // token, event key and proposed prompt text. Never persisted or sent.
  function auditPreview(result,event){
    const validEvent=contract?.parse({type:contract.TYPE,signal:event});
    const phase=validEvent&&PHASES.has(validEvent.phase)?validEvent.phase:'unknown';
    const decision=result?.ok===true&&result.decision&&typeof result.decision==='object'
      ? result.decision:null;
    const ruleId=decision&&typeof decision.ruleId==='string'&&ID.test(decision.ruleId)
      ? decision.ruleId:null;
    const action=ruleId&&ACTIONS.has(decision.action?.type)
      ? decision.action.type:null;
    const allowedReasons=new Set(['preview-only','no-match','already-considered','not-actionable']);
    const reason=result?.ok===true&&allowedReasons.has(result.reason)
      ? result.reason:'rejected';
    return Object.freeze({
      version:1,phase,reason,ruleId,action,
      approvalRequired:decision?.approvalRequired===true
    });
  }
  const api=Object.freeze({VERSION,MAX_RULES,MAX_SEEN,MAX_DURATION_MS,MAX_RULE_LINKS,PHASES,normalize,evaluate,auditPreview});
  root.ChatQueueRules=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);