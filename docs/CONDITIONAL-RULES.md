# 🧠 Conditional rules - opt-in proposals and preview v1

The **pure rule evaluator** remains independent of ChatGPT state, the HUD and the dispatch scheduler. A separate Options-only library now persists validated *rule definitions* to Firefox `storage.local` after deliberate user edits. Saving rules never executes or sends them. When enabled explicitly in a conversation's Queue HUD, a matching browser-authenticated Signal can display a proposal for manual approval; approval may queue text or pause, but never clicks Send or retries automatically. The evaluator remains preview-only, and the external API evaluates only caller-supplied synthetic input. Real Chat Signals event publication and user-authorized conditional execution remain separate roadmap gates.

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

This version has no active timers, authenticated state-duration clocks, unattended rule execution, recursive actions, network requests, persistent decision audit trail or automatic dispatch. Those are intentionally unimplemented, and the source's unit tests should not be presented as Firefox/HUD acceptance. The dry-run editor and local definition persistence exist. Activating rules against live events still requires authenticated origin/epoch binding, explicit user approval policy, safe conflict resolution and adversarial lifecycle acceptance.

## 🗂️ Local definition library (preview-only)

The Options editor can add, replace, load, edit, remove and clear stored declarative definitions. Storage key: `chatqueue:conditional-rules:v1` with `{version:1,rules:[...]}`. The pure storage adapter accepts only the documented schema, normalizes priority order, and enforces a bounded record size (800,000 UTF-16 code units) and the engine's 32-rule / 24,000-character limits. No rule definition is synchronized to cloud storage, sent to another extension automatically, or connected to a real signal listener.

After reloading Options, rule definitions return; simulated event replay history deliberately does not. Unknown future schema versions, malformed records and unreadable storage stop edits without silently migrating or deleting user data. Clearing all definitions requires two clicks. The external `rules` scope may preview synthetic input and manage a **separate per-caller** rule library; it cannot read or alter this Options library, connect saved rules to actual Chat Signals or Send. **Saved does not mean enabled for automatic execution.**

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

## 🔌 Independent external rule libraries

An approved Firefox add-on with the `rules` grant can call `chat-queue/v1` `rulesGet` and `rulesPut` to read and replace **only its own** versioned `storage.local` record. The record is keyed by browser-verified extension ID, not by a caller-supplied identifier, and stores `{version:1,revision,rules}`. A new library starts at revision 0. Edits require the last observed revision, and concurrent same-revision writers cannot both commit. Future-version or malformed records are read-only until explicitly repaired outside this API; they are never overwritten by an optimistic migration.

When a same-caller library changes, a connected client holding both `discover` and `rules` can receive `rulesChanged` with a **revision only**. After the `rules` grant is revoked, even a client still holding `discover` stops receiving rule revisions. No rule definitions or proposed texts are pushed to subscribers; full rules require an explicit `rulesGet` request under the separate permission. This feature remains synthetic and preview-only, not a live ChatGPT conditional execution system. [External API contract](../API.md) and [native Firefox integration test](../tests/fde-api.cjs) distinguish these capabilities.

## 🦊 Per-conversation authenticated proposal review (no auto-Send)

The Queue HUD's **Conditional proposals** disclosure defaults to **off**. A deliberate **Enable previews** click reads only the local Options rule definitions. It does not replay prior signals. New, browser-authenticated, fresh known-confidence `finished`, `failed`, `interrupted` or `limit` events may show one matching proposal at a time. Forged page `data-chat-signals-state` values remain unverified and cannot produce an offer. A proposal stays inside the closed HUD and is not serialized to page attributes, public metadata, transcripts or telemetry.

When an authenticated event creates a new offer, the existing Queue scheduler is **paused synchronously**, including any next-message dispatch already scheduled after response completion; no additional queued item may Send while approval is pending. A direct Start command, including through the permissioned cross-extension API, returns `review-conditional-proposal` until the user explicitly approves or dismisses the outstanding offer. **Dismiss** performs no further action; manually pressing Start remains necessary to resume normal scheduling. **Approve proposal** requires a second deliberate click and either adds the bounded proposed text as a *pending* message (requiring a separate later **Start**) or pauses the queue. It never clicks Send. Navigating to a different conversation, reloading the document, changing the rule library or disabling previews revokes opt-in and discards outstanding offers. Rule proposals and deduplication history are transient, bounded and not recovered automatically. The external `rules` API remains separate and synthetic-preview-only.

This boundary has only **synthetic disposable Firefox Developer Edition acceptance** with an independent versioned provider. The actual Chat Signals v0.3.13 publisher does not emit this authenticated v1 contract; therefore real ChatGPT rule proposals and conditional completion are **not accepted**. Dependencies, deadlines, approvals, live response attribution, idempotency and conditional scheduling remain open roadmap gates.

## 🔄 Revoking asynchronous rule-library loads

Rule-library reads are asynchronous. A storage change to `chatqueue:conditional-rules:v1` increments an in-document policy generation and disables current previews and offers immediately. Enabling previews snapshots that generation and the selected conversation; if the library changes before the read resolves, the old snapshot is rejected. A delayed read from another conversation cannot overwrite the newly selected route's rule state. The user must explicitly opt in again to the current stored rules. There is no automatic action, Send or retry.

## ⌛ Proposal identity expires on a newer authenticated response

A pending offer is tied to its verified source document token, response epoch, terminal phase and confidence. If a newer authenticated Signal changes any of these, the offer is revoked immediately and the queue stays paused. Approve separately rechecks the current trusted Signal before acting, protecting against obsolete user-interface callbacks. Fresh later events may create their own distinct proposals only while this conversation remains opted in. This is review-only behavior and does not automatically Send or retry a message.

## Authenticated error terminal acceptance boundary

Synthetic Firefox QA now drives fresh and restored authenticated provider messages for `failed`, `interrupted`, and `limit` through the existing production HUD rule-review path. The v1 declarative pause rule may propose action only after per-conversation Enable and a fresh signal; restoring an old status or repeating the same terminal event cannot execute or re-propose an action. Approval remains a manual pause, never permission to Send or automatically retry. Live published Chat Signals behavior is still a separate acceptance gate.


## 🧾 Volatile authenticated review outcomes

The opt-in per-conversation HUD now has a collapsed **Review history** section for actual browser-authenticated *synthetic* rule offers and user actions. It records up to 20 fixed-schema entries with only a validated rule ID and a known terminal phase, action kind and outcome: offered, approved, dismissed, expired, invalidated or failed to save. This is **not** transcript collection: no message text, prompt, route, document token, response epoch or timestamp is recorded. It never enters browser storage, logs, external APIs or the page's global namespace; the volatile list is discarded on conversation navigation and on document reload. The audit is updated after durable manual approval so an unsuccessful enqueue is never mislabeled as committed.

A registry restart clears any pending proposal and disables consent, rather than leaving an approval tied to lost provider authority. A late asynchronous approval cannot write its status or audit record into a different conversation. Real Chat Signals publication and authenticated ChatGPT acceptance remain unverified.


## ✅ Approved-rule dependencies and skip decisions (opt-in, local only)

In the authenticated HUD proposal path, the rule evaluator now receives a **bounded list of previously approved rule IDs**, scoped to the selected conversation and its current explicit preview-consent session. `when.dependsOn` requires each referenced rule to have been manually approved; `when.skipIf` rejects a rule once a referenced ID was manually approved. Merely displaying or dismissing an offer does not count as approval. A `pause` rule counts immediately on user approval; a `propose` rule counts only after its paused queue append is durably stored. The completed-rule list contains IDs only, never prompt content or response text, and is not persisted or sent to any other extension.

Disabling/re-enabling previews, changing the library, changing conversations, or losing the authenticated provider registry resets the completed-rule list. Pending asynchronous approvals from an obsolete consent session cannot credit a new session. This works only when an independently authenticated fresh Signal generates an offer, and it **never** authorizes automatic Start, Send, recovery or retry. Duration predicates still need trusted timing evidence and are not silently treated as satisfied. Real Chat Signals publisher integration remains missing.
