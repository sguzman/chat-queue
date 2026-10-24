/* Chat Queue permission policy; pure, local and deny-by-default. */
(function(root){
  'use strict';
  const KEY='chatqueue:api-grants:v2';
  const SCOPES=Object.freeze(['discover','read','append','edit','control','rules']);
  const SCOPE_SET=new Set(SCOPES);
  const ACTION_SCOPE=Object.freeze({
    listTabs:'discover',status:'read',enqueue:'append',enqueueSequenced:'append',update:'edit',move:'edit',
    reorder:'edit',remove:'edit',clear:'edit',resolve:'edit',start:'control',pause:'control',
    previewRules:'rules'
  });
  const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_.@-]{4,160}$/.test(id);
  function parse(record){
    if(!record||typeof record!=='object'||record.version!==2||
       !record.grants||typeof record.grants!=='object'||Array.isArray(record.grants))return Object.freeze({});
    const result=Object.create(null);
    for(const [id,scopes] of Object.entries(record.grants).slice(0,20)){
      if(!validId(id)||!Array.isArray(scopes)||scopes.length>SCOPES.length)continue;
      const filtered=[...new Set(scopes.filter(s=>typeof s==='string'&&SCOPE_SET.has(s)))];
      if(filtered.length)result[id]=Object.freeze(filtered);
    }
    return Object.freeze(result);
  }
  function has(record,id,scope){
    if(!validId(id)||!SCOPE_SET.has(scope))return false;
    const permissions=parse(record);
    return Object.hasOwn(permissions,id)&&permissions[id].includes(scope);
  }
  function scopes(record,id){const accepted=parse(record);return Object.hasOwn(accepted,id)?[...accepted[id]]:[];}
  const api=Object.freeze({KEY,SCOPES,ACTION_SCOPE,validId,parse,has,scopes});
  root.ChatQueueGrants=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
