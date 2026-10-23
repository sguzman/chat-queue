# 🧠 Conditional rules - preview-only v1

The **pure rule evaluator** remains independent of ChatGPT state, the HUD and the dispatch scheduler. A separate Options-only library now persists validated *rule definitions* to Firefox `storage.local` after deliberate user edits. Rules do not execute, read chats, observe the DOM, enqueue content or click Send. The evaluator remains preview-only, and the external API evaluates only caller-supplied synthetic input. Real Chat Signals event publication and user-authorized conditional execution remain separate roadmap gates.

## Declarative format

A rule is a versioned data object with a stable ID, an explicit enabled flag, a bounded integer priority, one response phase, optional confidence filter, and one proposal. The v1 preview schema supports:

```json
{
  "version": 1,
  "id": "synthetic-recovery-note",
  "enabled": true,
  "priority": 20,
  "when": {"phase": "interrupted", "confidence": "observed"},
  "then": {"type": "pause"}
}
```

A `then` action may be `pause`, or `propose` with a bounded, nonempty `text` string. `propose` returns a draft for future explicit approval; it does not append anything. This permits distinct previews for `finished`, `failed`, `interrupted`, and `limit` without silently retrying an error or connection loss. Unknown fields, duplicate IDs, unknown versions, malformed objects, unknown phases and overlength texts are rejected. Functions, scripts, evaluable predicates and arbitrary network actions are not supported.

## Evaluation semantics

`ChatQueueRules.normalize(input)` validates up to 32 rules and sorts by descending numeric priority, then ascending ID. `ChatQueueRules.evaluate(rules, signal, consumedKeys)` accepts only a protocol-v1-shaped Signal with positive epoch, fresh origin and known confidence. The **caller** is responsible for authenticating the actual Firefox extension sender; passing a correctly shaped object to the pure function does not authenticate it.

At most one enabled matching rule wins per phase/response event. The evaluator returns an immutable decision with `approvalRequired: true` and a stable event key containing route, document token, epoch and phase. A bounded caller-owned list of consumed event keys suppresses repeated evaluation of that same phase in that response epoch. Later recovery to another phase remains distinguishable; actual execution will need a higher-level policy for resolving conflicting terminal and transient outcomes.

This version has no timers, state-duration predicates, rule dependencies, recursive actions, network requests, persistent audit trail or automatic execution. Those are intentionally unimplemented, and the source's unit tests should not be presented as Firefox/HUD acceptance. The actual use of the rules module will require user-visible permission controls, a dry-run editor, persistence, exact origin bindings, and adverse lifecycle tests before any conditional queue action can be enabled.

## 🗂️ Local definition library (preview-only)

The Options editor can add, replace, load, edit, remove and clear stored declarative definitions. Storage key: `chatqueue:conditional-rules:v1` with `{version:1,rules:[...]}`. The pure storage adapter accepts only the documented schema, normalizes priority order, and enforces a bounded record size (800,000 UTF-16 code units) and the engine's 32-rule / 24,000-character limits. No rule definition is synchronized to cloud storage, sent to another extension automatically, or connected to a real signal listener.

After reloading Options, rule definitions return; simulated event replay history deliberately does not. Unknown future schema versions, malformed records and unreadable storage stop edits without silently migrating or deleting user data. Clearing all definitions requires two clicks. The external `rules` scope remains a pure caller-supplied evaluation API and cannot read this local library. **Saved does not mean enabled for automatic execution.**

Synthetic Firefox Developer Edition QA must verify save → reload → edit → reload → two-step clear → reload, including that reload triggers no queue action. A future, separate acceptance gate must cover concurrent Options windows and storage errors before rule execution is even considered.

## ⏱️ Optional duration-filter previews

A rule may specify `when.minDurationMs` and/or `when.maxDurationMs`, bounded integer values from 0 to 3,600,000 (one hour), with minimum no greater than maximum. The preview function accepts an optional fourth argument, `{stateDurationMs: integer}`, supplied explicitly by the caller. A time-filtered rule **does not match** without duration evidence; boundary values match. Untimed rules retain their prior behavior. Invalid types, unknown fields and inconsistent ranges fail closed.

These are **synthetic-duration predicates**, not timers, scheduled deadlines or verified ChatGPT state durations. This evaluator does not authenticate timing data, read a clock, monitor the ChatGPT page, enqueue anything or click Send. Production adoption requires an authenticated monotonic transition clock, suspension/recovery handling and explicit user policy. No automatic retry behavior was introduced.
