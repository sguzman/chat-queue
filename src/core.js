/* Chat Queue state helpers. No dependency on ChatGPT DOM or browser APIs. */
(function (root) {
  'use strict';
  const PHASES = new Set(['idle', 'submitted', 'generating', 'verifying', 'finished', 'interrupted', 'failed', 'limit', 'unknown']);
  const BUSY = new Set(['submitted', 'generating', 'verifying']);
  const BLOCKED = new Set(['interrupted', 'failed', 'limit', 'unknown']);
  const MAX_ITEMS = 100;
  const MAX_CHARS = 24000;
  function validPhase(phase) { return PHASES.has(phase) ? phase : 'unknown'; }
  function validText(text) { return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_CHARS; }
  function makeItem(text, id) {
    if (!validText(text) || typeof id !== 'string' || !/^[a-z0-9-]{8,80}$/.test(id)) throw new Error('Invalid message');
    return { id, text, status: 'pending' };
  }
  function nextPosition(items, id, direction) {
    const index = items.findIndex(item => item.id === id);
    if (index < 0 || (direction !== -1 && direction !== 1)) return items;
    const target = index + direction;
    if (target < 0 || target >= items.length) return items;
    const next = items.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
  function moveTo(items, id, beforeId) {
    if (id === beforeId) return items;
    const from = items.findIndex(item => item.id === id);
    if (from < 0) return items;
    const next = items.slice();
    const [item] = next.splice(from, 1);
    const at = beforeId == null ? next.length : next.findIndex(other => other.id === beforeId);
    if (at < 0) return items;
    next.splice(at, 0, item);
    return next;
  }
  function exactPermutation(items, ids) {
    if (!Array.isArray(items) || !Array.isArray(ids) ||
        items.length > MAX_ITEMS || ids.length !== items.length) return false;
    const current = new Set(items.map(item => item?.id));
    if (current.size !== items.length || ids.some(id => typeof id !== 'string')) return false;
    const supplied = new Set(ids);
    return supplied.size === ids.length && ids.every(id => current.has(id));
  }
  // Backward-compatible missing version is allowed only for recognizable
  // legacy records. Unknown future versions must be preserved, not rewritten.
  function savedRecordSupport(value) {
    if (value==null) return {ok:true};
    if (typeof value!=='object'||Array.isArray(value)||
        (value.version!==undefined&&value.version!==1)||
        !Array.isArray(value.items)||value.items.length>MAX_ITEMS||
        !validRequestHighWatermarks(value.requestHighWatermarks))
      return {ok:false,error:'unsupported-saved-queue'};
    // Restoration must never silently drop a malformed or duplicate item:
    // subsequent saves would irreversibly replace the original record.
    const ids=new Set();
    for(const item of value.items) {
      if(!item||typeof item!=='object'||Array.isArray(item)||
         typeof item.id!=='string'||!/^[a-z0-9-]{8,80}$/.test(item.id)||
         !validText(item.text)||ids.has(item.id))
        return {ok:false,error:'unsupported-saved-queue'};
      ids.add(item.id);
    }
    // History and explicit old-tab recovery markers are also retained in the
    // same record. Never silently truncate or discard them on the next save.
    if(value.history!==undefined) {
      if(!Array.isArray(value.history)||value.history.length>20)return {ok:false,error:'unsupported-saved-queue'};
      for(const entry of value.history) {
        if(!entry||typeof entry!=='object'||Array.isArray(entry)||
           typeof entry.id!=='string'||!validText(entry.text)||
           !Number.isSafeInteger(entry.at)||
           !['submitted','finished','interrupted','failed'].includes(entry.status))
          return {ok:false,error:'unsupported-saved-queue'};
      }
    }
    if(value.recoveredSources!==undefined) {
      if(!Array.isArray(value.recoveredSources)||value.recoveredSources.length>32)
        return {ok:false,error:'unsupported-saved-queue'};
      const seenSources=new Set();
      for(const source of value.recoveredSources){
        if(typeof source!=='string'||source.length>1024||
           !source.startsWith('chatqueue:v1:tab:')||seenSources.has(source))
          return {ok:false,error:'unsupported-saved-queue'};
        seenSources.add(source);
      }
    }
    // Historical unknown item statuses remain readable but restore as uncertain.
    return {ok:true};
  }
  const MAX_REQUEST_CLIENTS=32;
  function validRequestHighWatermarks(marks) {
    if(marks===undefined)return true;
    if(!marks||typeof marks!=='object'||Array.isArray(marks)||
       Object.keys(marks).length>MAX_REQUEST_CLIENTS)return false;
    return Object.entries(marks).every(([id,sequence])=>
      id.length>0&&id.length<=256&&
      Number.isSafeInteger(sequence)&&sequence>0);
  }
  function readRequestHighWatermarks(saved) {
    const value=saved?.requestHighWatermarks;
    if(!validRequestHighWatermarks(value))return null;
    return Object.assign(Object.create(null),value||{});
  }
  function normalizeSaved(value) {
    if (!value || typeof value !== 'object') return [];
    if (!Array.isArray(value.items)) return [];
    const seen = new Set();
    return value.items.slice(0, MAX_ITEMS).filter(item => {
      if (!item || !validText(item.text) || typeof item.id !== 'string' || !/^[a-z0-9-]{8,80}$/.test(item.id) || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    }).map(item => ({ id: item.id, text: item.text, status: item.status === 'pending' ? 'pending' : 'uncertain' }));
  }
  // Recovery discovery is metadata-only. Exact pathname matching prevents a
  // queue from another conversation being offered after a tab-ID change.
  // Never auto-resume old items; the HUD must explicitly stage and confirm.
  function recoveryCandidates(records,route,currentKey,alreadyRecovered=[]) {
    if(!records||typeof records!=='object'||Array.isArray(records)||
       typeof route!=='string'||!route.startsWith('/')||
       !Array.isArray(alreadyRecovered))return [];
    const excluded=new Set(alreadyRecovered.filter(x=>typeof x==='string'));
    const prefix='chatqueue:v1:tab:';
    const candidates=[];
    for(const [key,value] of Object.entries(records)){
      if(candidates.length>=32)break;
      if(key===currentKey||excluded.has(key)||!key.startsWith(prefix))continue;
      const suffix=key.slice(prefix.length);
      const colon=suffix.indexOf(':');
      if(colon<0||!/^\d{1,16}$/.test(suffix.slice(0,colon))||
         suffix.slice(colon+1)!==route||!savedRecordSupport(value).ok)continue;
      const items=normalizeSaved(value);
      if(items.length)candidates.push({key,count:items.length});
    }
    return candidates;
  }
  const BACKUP_KIND = 'chat-queue-message-backup';
  const BACKUP_VERSION = 1;
  const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
  function backupItems(items) {
    if(!Array.isArray(items)||items.length>MAX_ITEMS)
      throw new Error('invalid-backup-items');
    const ids=new Set();
    const exported=[];
    for(const item of items) {
      if(!item||typeof item.id!=='string'||ids.has(item.id)||
         !validText(item.text)||!['pending','uncertain'].includes(item.status))
        throw new Error('invalid-backup-item');
      ids.add(item.id);
      exported.push({text:item.text,status:item.status});
    }
    // No tab ID, route, document token or scheduler state leaves the backup.
    return {kind:BACKUP_KIND,version:BACKUP_VERSION,items:exported};
  }
  function parseBackup(value) {
    if(!value||typeof value!=='object'||Array.isArray(value)||
       value.kind!==BACKUP_KIND||value.version!==BACKUP_VERSION||
       !Array.isArray(value.items)||value.items.length>MAX_ITEMS)
      throw new Error('unsupported-backup');
    const items=[];
    for(const item of value.items) {
      if(!item||typeof item!=='object'||Array.isArray(item)||
         !validText(item.text)||!['pending','uncertain'].includes(item.status))
        throw new Error('invalid-backup-item');
      items.push({text:item.text,status:item.status});
    }
    return items;
  }
  function mayDispatch(phase, waitingForCompletion, busySeen) {
    phase = validPhase(phase);
    if (BLOCKED.has(phase)) return false;
    if (waitingForCompletion) return false;
    // An initial user-authorized Start can dispatch during idle or after a
    // previously confirmed finished response; never during active generation.
    return phase === 'idle' || phase === 'finished';
  }
  function completionArrived(phase, waitingForCompletion, busySeen) {
    return waitingForCompletion && busySeen && phase === 'finished';
  }
  const api = Object.freeze({ PHASES, BUSY, BLOCKED, MAX_ITEMS, MAX_CHARS, validPhase, validText, makeItem, nextPosition, moveTo, exactPermutation, savedRecordSupport, normalizeSaved, MAX_REQUEST_CLIENTS, validRequestHighWatermarks, readRequestHighWatermarks, recoveryCandidates, BACKUP_KIND, BACKUP_VERSION, MAX_BACKUP_BYTES, backupItems, parseBackup, mayDispatch, completionArrived });
  root.ChatQueueCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
