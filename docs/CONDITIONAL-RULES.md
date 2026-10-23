# 🧠 Conditional rules - preview-only v1

This experimental **pure rule evaluator** is deliberately not connected to the HUD, browser storage, dispatch scheduler, or public extension API. It does not read ChatGPT messages, observe the DOM, enqueue content or click Send. It can only validate typed input and return a proposed action. Real Chat Signals event publication and user-authorized conditional execution remain separate roadmap gates.

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

## Preferences-page simulator

The Firefox preferences page includes a temporary visual sandbox for entering multiple rules and simulating fresh/restored status events. The form uses the **production** pure evaluator, including priority and replay suppression. Its rule list exists only in memory; reloading the page discards it. All preview text is rendered with `textContent`, never HTML injection. No browser queue API, ChatGPT page, prompt composer, storage writes or Send action is exposed by the simulator. Automated Firefox acceptance runs the production scripts on a synthetic localhost preferences document, without private accounts or browser-profile changes. This is still not live conditional dispatch acceptance.
