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
        !Array.isArray(value.items))
      return {ok:false,error:'unsupported-saved-queue'};
    return {ok:true};
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
  const api = Object.freeze({ PHASES, BUSY, BLOCKED, MAX_ITEMS, MAX_CHARS, validPhase, validText, makeItem, nextPosition, moveTo, exactPermutation, savedRecordSupport, normalizeSaved, mayDispatch, completionArrived });
  root.ChatQueueCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
