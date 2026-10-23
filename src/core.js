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
  function normalizeSaved(value) {
    if (!value || typeof value !== 'object') return [];
    if (!Array.isArray(value.items)) return [];
    const seen = new Set();
    return value.items.slice(0, MAX_ITEMS).filter(item => {
      if (!item || !validText(item.text) || typeof item.id !== 'string' || !/^[a-z0-9-]{8,80}$/.test(item.id) || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    }).map(item => ({ id: item.id, text: item.text, status: item.status === 'uncertain' ? 'uncertain' : 'pending' }));
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
  const api = Object.freeze({ PHASES, BUSY, BLOCKED, MAX_ITEMS, MAX_CHARS, validPhase, validText, makeItem, nextPosition, moveTo, normalizeSaved, mayDispatch, completionArrived });
  root.ChatQueueCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
