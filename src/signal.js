/* Authenticated provider-event contract. Transport identity is checked in the
 * background, never by reading page-provided DOM attributes. */
(function(root){
  'use strict';
  const TYPE='chat-queue-signal/v1';
  const PROVIDER_ID='chat-signals@sguzman.github';
  const PHASES=new Set(['idle','submitted','generating','verifying','finished','interrupted','failed','limit','unknown']);
  const ACTIVE=new Set(['submitted','generating','verifying']);
  const TOKEN=/^[0-9a-f]{32}$/;
  const validRoute=route=>typeof route==='string'&&route.length<=512&&
    /^\/[a-zA-Z0-9/_%.-]*$/.test(route);
  function parse(input){
    if(!input||typeof input!=='object'||input.type!==TYPE)return null;
    const x=input.signal;
    if(!x||typeof x!=='object'||x.version!==1||!PHASES.has(x.phase)||
       !Number.isSafeInteger(x.epoch)||x.epoch<0||
       !Number.isSafeInteger(x.sequence)||x.sequence<1||
       typeof x.documentToken!=='string'||!TOKEN.test(x.documentToken)||
       !validRoute(x.route)||
       !['fresh','restored'].includes(x.origin)||
       !['observed','inferred','unknown'].includes(x.confidence))return null;
    return Object.freeze({version:1,documentToken:x.documentToken,route:x.route,
      epoch:x.epoch,sequence:x.sequence,phase:x.phase,origin:x.origin,confidence:x.confidence});
  }
  function advance(previous,next){
    if(!next)return false;
    if(!previous)return true;
    if(next.route!==previous.route)return false; // a route change needs a fresh registration
    if(next.documentToken!==previous.documentToken)return false; // new document needs re-registration
    return next.sequence>previous.sequence&&next.epoch>=previous.epoch;
  }
  function ready(signal,route){
    return Boolean(signal&&signal.route===route&&signal.origin==='fresh'&&
      signal.confidence!=='unknown'&&['idle','finished'].includes(signal.phase));
  }
  function newBusy(signal,baseline){
    return Boolean(signal&&baseline&&signal.documentToken===baseline.documentToken&&
      signal.route===baseline.route&&signal.origin==='fresh'&&
      signal.epoch>baseline.epoch&&signal.sequence>baseline.sequence&&ACTIVE.has(signal.phase));
  }
  function completed(signal,waiting){
    return Boolean(signal&&waiting&&signal.documentToken===waiting.documentToken&&
      signal.route===waiting.route&&signal.origin==='fresh'&&signal.phase==='finished'&&
      signal.epoch===waiting.epoch&&signal.sequence>waiting.sequence);
  }
  const api=Object.freeze({TYPE,PROVIDER_ID,PHASES,ACTIVE,validRoute,parse,advance,ready,newBusy,completed});
  root.ChatQueueSignal=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
