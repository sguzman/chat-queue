# 📡 Authenticated signal consumer contract (candidate v1)

**Status: consumer implemented; producer absent; no unattended sending.** Chat Signals 0.3.13 does not expose this event protocol. Do not claim integration acceptance from current Node tests.

## Transport and trust

Chat Signals must send an external Firefox extension message to `chat-queue@sguzman.github` from its own extension principal (not via a page-script event). Chat Queue's background verifies the browser-supplied `sender.id` is exactly `chat-signals@sguzman.github`; a caller-supplied extension ID is ignored. Chat Queue routes a validated message to its already registered matching tab, which independently verifies its exact current pathname. This contract must be reviewed with the provider before Chat Signals work is authorized.

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

The provider has not implemented the external event stream. Pending integration work must prove actual Firefox extension-to-extension event delivery, provider event provenance and sequencing, mutation/race safety, connection recovery, rapid terminal events, provider absence, event-page suspension, and the authenticated ChatGPT composer path. No existing browser profile or other repository is changed by this candidate receiver. The provider-side implementation plan and integration QA phases are documented in [SIGNAL-PUBLISHER-HANDOFF.md](SIGNAL-PUBLISHER-HANDOFF.md); this document is a handoff, not authorization to edit the separate Chat Signals repository.

## 🦊 Real publisher evidence — initial transport

Actual Chat Signals independent source code now publishes the strict v1 envelope from its evidence tracker through its Firefox-attested background. A real two-addon disposable Firefox Developer Edition run at [40155539014](https://github.com/sguzman/chat-queue/actions/runs/40155539014) verifies initial idle, two sequential generation/completion response epochs, two exactly-once synthetic sends and denial after provider removal. This is genuine extension transport in a **synthetic site**, not proof of real authenticated ChatGPT React/ProseMirror behavior or live network recovery. The longer authenticated-site gates remain outstanding.

## 🔒 Genuine restored-epoch Firefox safety acceptance

In [both passing CI jobs of run 40197044421](https://github.com/sguzman/chat-queue/actions/runs/40197044421), a disposable Firefox Developer Edition profile installs the actual pinned Chat Signals publisher and Chat Queue. The synthetic page creates a response, Chat Signals observes its generation and terminal controls and persists the final state through its **own unmodified state ledger**. The test reloads the same browser tab to exercise real restoration; Queue sees the historical terminal but **refuses to dispatch**, despite a queued item and a manual Start. Only after a new, genuinely observed response epoch does the queue permit one manually started, guarded submission. No provider ledger is seeded or fabricated for this acceptance. This proves local extension lifecycle mechanics, **not authenticated production ChatGPT reliability**.
