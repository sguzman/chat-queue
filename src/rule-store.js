/* Local-only declarative rule library. Never subscribes to signals or executes actions. */
(function(root){
  'use strict';
  const engine=root.ChatQueueRules;
  const KEY='chatqueue:conditional-rules:v1';
  const VERSION=1;
  // Limit accidentally oversized or corrupted records before parsing contents.
  const MAX_BYTES=800000;
  function decode(value){
    if(value===undefined)return {ok:true,rules:[],exists:false};
    if(!value||typeof value!=='object'||Array.isArray(value)||
       Object.getPrototypeOf(value)!==Object.prototype||
       Object.keys(value).some(k=>!['version','rules'].includes(k))||
       value.version!==VERSION)return {ok:false,error:'unsupported-rule-library'};
    let size;
    try{size=JSON.stringify(value).length;}catch{return {ok:false,error:'unreadable-rule-library'};}
    if(size>MAX_BYTES)return {ok:false,error:'oversized-rule-library'};
    const check=engine.normalize(value.rules);
    if(!check.ok)return {ok:false,error:'invalid-stored-rules'};
    return {ok:true,rules:check.rules,exists:true};
  }
  function encode(rules){
    const result=engine.normalize(rules);
    if(!result.ok)return result;
    const value={version:VERSION,rules:result.rules.map(rule=>({
      id:rule.id,version:rule.version,enabled:rule.enabled,priority:rule.priority,
      when:{...rule.when},then:{...rule.then}
    }))};
    if(JSON.stringify(value).length>MAX_BYTES)return {ok:false,error:'oversized-rule-library'};
    return {ok:true,value};
  }
  const api=Object.freeze({KEY,VERSION,MAX_BYTES,decode,encode});
  root.ChatQueueRuleStore=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
