# 📡 Authenticated signal consumer contract (candidate v1)

**Status (2026-10-25): consumer and independent publisher implemented; synthetic Firefox transport accepted, authenticated ChatGPT still unaccepted.** Chat Signals v0.3.13 (`102e3ea16a9e9535d377c1d4e8b564f5b0fdb721`) does not expose this event protocol, but the separate publisher commit `d17117047f5e582591e514240c008b166bf96d8a` does. CI installs both versions independently to protect legacy coexistence and verify real publisher transport. Do not mistake synthetic-site acceptance for safe unattended sending.

## Transport and trust

Chat Signals must send an external Firefox extension message to `chat-queue@sguzman.github` from its own extension principal (not via a page-script event). Chat Queue's background verifies the browser-supplied `sender.id` is exactly `chat-signals@sguzman.github`; a caller-supplied extension ID is ignored. Chat Queue routes a validated message to its already registered matching tab, which independently verifies its exact current pathname. The browser-attested source implementation is reviewed through independently pinned Firefox integration fixtures; the page cannot forge the provider extension principal.

Envelope (all examples here are synthetic):

```json
{
  "type":"chat-queue-signal/v1",
  "tabId":17,
  "signal":{
    "version":1,
    "route":"/c/synthetic-chat",
    "documentToken":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "epoch":3,
    "sequence":9,
    "phase":"finished",
    "origin":"fresh",
    "confidence":"inferred"
  }
}
```

- `tabId` is the origin Firefox tab, not a client-selected delivery tab. If `sender.tab` exists, its ID must match.
- `documentToken` is a fresh 128-bit hex token for the provider's loaded document. It remains fixed during one document lifetime. Sequence strictly increases within that document; epoch never decreases.
- `route` is a bounded ChatGPT pathname, without query, fragment or title. Changing route/document requires re-registration, clears previous in-memory authority, and never resumes dispatch automatically.
- `origin` is `fresh` or `restored`. Restored historical completion never authorizes sending or advancing. `confidence` is `observed`, `inferred`, or `unknown`.
- `phase` is one of `idle`, `submitted`, `generating`, `verifying`, `finished`, `interrupted`, `failed`, `limit`, `unknown`. Chat Signals owns inference. The queue never examines transcript bodies to decide completion.
- A protocol-valid event with `confidence:'unknown'` may be observed, but it **cannot** confirm a new busy epoch or a completed response. Both acceptance and terminal attribution require `observed` or `inferred` confidence. Missing evidence must pause or remain uncertain, never authorize a second prompt.

## Required causal relationship

An explicit queue Start may arm pending work only when a *fresh authenticated* provider event matches the active route; initial dispatch requires `idle` or `finished` with non-unknown confidence. The event must have arrived recently (current prototype: within 15 seconds). Waiting on unrelated ongoing generation is permitted, but does not authorize sending.

Before attempting Send, the queue records the item as `uncertain` in extension storage. After one click, it requires a fresh `submitted`/`generating`/`verifying` event with **epoch greater than the pre-click baseline** and cleared draft before considering the message submitted. Completion requires a later fresh `finished` event for **that exact epoch**, same document and route, strictly later sequence. A provider restart, missing event, cancelled turn, load failure, or browser crash cannot manufacture success or an automatic retry.

## Outstanding gates

The actual publisher and consumer have passed synthetic Firefox extension-to-extension delivery, provenance, epoch sequencing, route isolation, failure and recovery scenarios, including the complete [run 40214190414](https://github.com/sguzman/chat-queue/actions/runs/40214190414). **Remaining acceptance** requires authenticated ChatGPT React/ProseMirror submission, network and error recovery, real-site navigation identity, concurrent user interaction and independently reviewed production privacy/security. These gates cannot be replaced by synthetic fixtures or static tests. See [SIGNAL-PUBLISHER-HANDOFF.md](SIGNAL-PUBLISHER-HANDOFF.md) for the historical handoff plan. No personal browser profile or other repository is changed by this documentation update.

## 🦊 Real publisher evidence — initial transport

Actual Chat Signals independent source code now publishes the strict v1 envelope from its evidence tracker through its Firefox-attested background. A real two-addon disposable Firefox Developer Edition run at [40155539014](https://github.com/sguzman/chat-queue/actions/runs/40155539014) verifies initial idle, two sequential generation/completion response epochs, two exactly-once synthetic sends and denial after provider removal. This is genuine extension transport in a **synthetic site**, not proof of real authenticated ChatGPT React/ProseMirror behavior or live network recovery. The longer authenticated-site gates remain outstanding.

## 🔒 Genuine restored-epoch Firefox safety acceptance

In [both passing CI jobs of run 40197044421](https://github.com/sguzman/chat-queue/actions/runs/40197044421), a disposable Firefox Developer Edition profile installs the actual pinned Chat Signals publisher and Chat Queue. The synthetic page creates a response, Chat Signals observes its generation and terminal controls and persists the final state through its **own unmodified state ledger**. The test reloads the same browser tab to exercise real restoration; Queue sees the historical terminal but **refuses to dispatch**, despite a queued item and a manual Start. Only after a new, genuinely observed response epoch does the queue permit one manually started, guarded submission. No provider ledger is seeded or fabricated for this acceptance. This proves local extension lifecycle mechanics, **not authenticated production ChatGPT reliability**.

## 🧭 Real-provider scoped SPA route and project isolation

[Both jobs passed in CI run 40197623501](https://github.com/sguzman/chat-queue/actions/runs/40197623501). A disposable Firefox Developer Edition tab has the actual separately installed Chat Signals source publisher plus Chat Queue. After storing an unsubmitted message in a normal conversation, the fixture clicks a synthetic project link and applies History API `pushState` **within the same document**. Queue and Signals independently rescope to the new project conversation; the old prompt is neither displayed nor sent. The project queue can send one synthetic prompt after an explicit Start and attributable response evidence. A later return to the original conversation restores its own pending message without sending it. Route and source attestation are from the browser-owned extension channels, not page-root phase attributes. This verifies synthetic-site route isolation; live authenticated ChatGPT navigation and React variability remain separate acceptance gates.

## 🛑 Stop, Pause and explicit-restart Firefox acceptance

[Run 40198735817](https://github.com/sguzman/chat-queue/actions/runs/40198735817) validates manual Pause **after confirmed submission**: completing the active response cannot Send another queued item, but a subsequent deliberate Start advances it once. [Run 40199823775](https://github.com/sguzman/chat-queue/actions/runs/40199823775) verifies real browser-trusted Stop in the actual two-addon Firefox configuration: the same-epoch, authenticated cancellation marks the clicked message as interrupted in history, closes its awaiting response, pauses the Queue, permits a distinct explicit Start for the next pending item and never replays after reload. Both runs passed their complete static and Firefox jobs. Stopping *before* submission confirmation remains uncertain and requires manual review, not blind retry.

## ▶️ Real-provider authorized control and long-response acceptance

In [full Firefox run 40201495776](https://github.com/sguzman/chat-queue/actions/runs/40201495776), a disposable third Firefox extension with a **test-only persisted control grant** requested Start through Queue’s ordinary authenticated external API. The queued message remained unsent before that explicit request; one authorized request caused one guarded synthetic Send, followed by an attributable real Chat Signals terminal event. Existing API security tests separately reject ungranted Start. The same real-provider run held a response generating for more than 16 seconds with a later message queued. Neither an old Copy control nor stale time alone authorized another Send; the next item advanced only after fresh same-epoch completion. The real provider's initial missed idle, source restoration, rapid terminal and SPA route suites remained in place. These are synthetic-site transport results; authenticated ChatGPT network/ProseMirror release acceptance is outstanding.
