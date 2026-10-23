/* Declarative Chat Queue conditional-rule preview engine (v1).
 * Pure; never writes browser storage, reads transcript text, or sends prompts.
 * The caller must authenticate events before using the returned proposal.
 */
(function(root){
  'use strict';
  const contract=root.ChatQueueSignal;
  const VERSION=1,MAX_RULES=32,MAX_MESSAGE_CHARS=24000,MAX_SEEN=256;
  const PHASES=new Set(['finished','failed','interrupted','limit']);
  const CONFIDENCES=new Set(['any','observed','inferred']);
  const ACTIONS=new Set(['propose','pause']);
  const ID=/^[a-zA-Z0-9_-]{1,64}$/;
  const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
    (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
  const keys=(x,names)=>Object.keys(x).every(k=>names.includes(k));
  function normalize(input){
    if(!Array.isArray(input)||input.length>MAX_RULES)return {ok:false,error:'invalid-rule-count'};
    const ids=new Set(),out=[];
    for(const item of input){
      if(!plain(item)||!keys(item,['id','version','enabled','priority','when','then'])||
         item.version!==VERSION||typeof item.id!=='string'||!ID.test(item.id)||
         ids.has(item.id)||typeof item.enabled!=='boolean'||
         !Number.isSafeInteger(item.priority)||item.priority<0||item.priority>1000||
         !plain(item.when)||!keys(item.when,['phase','confidence'])||
         !PHASES.has(item.when.phase)||
         (item.when.confidence!==undefined&&!CONFIDENCES.has(item.when.confidence))||
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
          confidence:item.when.confidence||'any'}),then:Object.freeze(item.then.type==='pause'
            ? {type:'pause'} : {type:'propose',text:item.then.text})}));
    }
    out.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id,'en'));
    return {ok:true,rules:Object.freeze(out)};
  }
  function eventKey(s){return `${s.route}|${s.documentToken}|${s.epoch}|${s.phase}`;}
  function evaluate(input,event,used=[]){
    const valid=normalize(input);
    if(!valid.ok)return valid;
    if(!Array.isArray(used)||used.length>MAX_SEEN||
       !used.every(x=>typeof x==='string'&&x.length<=650))
      return {ok:false,error:'invalid-history'};
    // Parse shape only; the Firefox sender principal is verified separately.
    const s=contract?.parse({type:contract.TYPE,signal:event});
    if(!s)return {ok:false,error:'invalid-event'};
    if(s.origin!=='fresh'||s.epoch===0||s.confidence==='unknown'||!PHASES.has(s.phase))
      return {ok:true,decision:null,reason:'not-actionable'};
    const key=eventKey(s);
    if(used.includes(key))return {ok:true,decision:null,reason:'already-considered'};
    const match=valid.rules.find(r=>r.enabled&&r.when.phase===s.phase&&
      (r.when.confidence==='any'||r.when.confidence===s.confidence));
    if(!match)return {ok:true,decision:null,reason:'no-match'};
    return {ok:true,decision:Object.freeze({ruleId:match.id,eventKey:key,
      action:match.then,approvalRequired:true}),reason:'preview-only'};
  }
  const api=Object.freeze({VERSION,MAX_RULES,MAX_SEEN,PHASES,normalize,evaluate});
  root.ChatQueueRules=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);