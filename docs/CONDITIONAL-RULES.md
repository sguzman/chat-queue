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

This version has no active timers, authenticated state-duration clocks, rule execution, recursive actions, network requests, persistent decision audit trail or automatic dispatch. Those are intentionally unimplemented, and the source's unit tests should not be presented as Firefox/HUD acceptance. The dry-run editor and local definition persistence exist. Activating rules against live events still requires authenticated origin/epoch binding, explicit user approval policy, safe conflict resolution and adversarial lifecycle acceptance.

## 🗂️ Local definition library (preview-only)

The Options editor can add, replace, load, edit, remove and clear stored declarative definitions. Storage key: `chatqueue:conditional-rules:v1` with `{version:1,rules:[...]}`. The pure storage adapter accepts only the documented schema, normalizes priority order, and enforces a bounded record size (800,000 UTF-16 code units) and the engine's 32-rule / 24,000-character limits. No rule definition is synchronized to cloud storage, sent to another extension automatically, or connected to a real signal listener.

After reloading Options, rule definitions return; simulated event replay history deliberately does not. Unknown future schema versions, malformed records and unreadable storage stop edits without silently migrating or deleting user data. Clearing all definitions requires two clicks. The external `rules` scope remains a pure caller-supplied evaluation API and cannot read this local library. **Saved does not mean enabled for automatic execution.**

Synthetic Firefox Developer Edition QA verifies save → reload → edit → reload → two-step clear → reload without queue action ([accepted browser run](https://github.com/sguzman/chat-queue/actions/runs/40038729574)). A future, separate acceptance gate must cover concurrent Options windows and storage errors before rule execution is even considered.

## ⏱️ Optional duration-filter previews

A rule may specify `when.minDurationMs` and/or `when.maxDurationMs`, bounded integer values from 0 to 3,600,000 (one hour), with minimum no greater than maximum. The preview function accepts an optional fourth argument, `{stateDurationMs: integer}`, supplied explicitly by the caller. A time-filtered rule **does not match** without duration evidence; boundary values match. Untimed rules retain their prior behavior. Invalid types, unknown fields and inconsistent ranges fail closed.

These are **synthetic-duration predicates**, not timers, scheduled deadlines or verified ChatGPT state durations. This evaluator does not authenticate timing data, read a clock, monitor the ChatGPT page, enqueue anything or click Send. Production adoption requires an authenticated monotonic transition clock, suspension/recovery handling and explicit user policy. No automatic retry behavior was introduced.

## 🔗 Dependency and skip previews (synthetic only)

Each declarative rule may include `when.dependsOn` and/or `when.skipIf`, each a list of up to eight distinct IDs of **other rules in the same saved library**. A rule is eligible only when every required ID is present in the caller-supplied `context.completedRuleIds` and no skipped ID is present. A missing context is never interpreted as proof that a dependency completed. The list of completed IDs is **simulated**: previewing or saving a rule does not automatically mark it complete.

The normalizer rejects dangling links, self-links, an ID simultaneously listed under required and skipped rules, dependency cycles, duplicate/invalid ID lists and unsupported extra fields. Changes to a referenced rule may be rejected if they would orphan another rule; there is no silent cascade deletion. Normalized dependency lists are immutable and rule priority remains deterministic. The Options editor allows comma-separated dependencies and skipped IDs and an independent simulated completion list. To reference a rule, save that prerequisite first.

For API preview calls the context can be `{stateDurationMs:6000,completedRuleIds:['first-rule']}`. Maximum 32 unique completed IDs; unknown IDs reject the request, and all data is caller-supplied synthetic evidence. No real Chat Signals success, user approval, queue status or retry behavior can be inferred from that context. [Pure unit regressions](../tests/rules.test.js) and [Firefox sandbox QA](../tests/fde-rules.cjs) cover the contract separately.

## 🧾 In-memory dry-run audit

The pure `ChatQueueRules.auditPreview(result,event)` returns a fixed-schema, immutable summary: phase, preview outcome, validated rule ID, action **type**, and whether approval would be required. It intentionally strips the proposal's text, event key, conversation path, document token and arbitrary rejection strings. The Options page presents at most the latest 20 summaries in a collapsed **Dry-run audit** section, rendered as text. They remain in memory for that Options window only and disappear on reload. Rule definitions, separately saved in `storage.local`, are not augmented with the audit or simulated completion history.

This is a privacy-bounded preview trace, **not** a durable audit trail for authenticated live conditional actions. No user message, model response or private conversation content is collected, and no automatic rule execution or notification has been introduced.
