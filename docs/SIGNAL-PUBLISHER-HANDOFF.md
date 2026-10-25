# 📡 Chat Signals publisher handoff — independent-repository implementation plan

**Status (updated 2026-10-25):** Actual Chat Signals publisher implemented and native Firefox two-addon transport acceptance passed in [run 40155539014](https://github.com/sguzman/chat-queue/actions/runs/40155539014). This is synthetic-site transport evidence, **not** authenticated ChatGPT production-site delivery. The historical plan below remains a record of the integration gates. The consumer in this repository is present and synthetic Firefox-tested. As inspected on 2026-10-24, Chat Signals v0.3.13 (`102e3ea16a9e9535d377c1d4e8b564f5b0fdb721`) still publishes its internal `chat-signals-state` and `chat-signals-event` messages and page-root `data-chat-signals-state`, **not** the authenticated `chat-queue-signal/v1` stream. No changes to that separate repository are made here.

The original source of truth must remain Chat Signals' evidence-aware state machine. Chat Queue must not copy/rebuild its inference classifier and must not use page DOM state to authorize Send.

## Independent ownership and safe transport

1. **Chat Signals content** observes its existing `tracker.snapshot()`, `stateReady` and route generation. It builds an internal, text-free state envelope with phase, epoch, confidence, fresh/restored attribution, document token, sanitized exact pathname and strictly increasing local sequence number.
2. **Chat Signals background** receives the provider's internal message from its own content script and obtains the browser-owned tab ID through `sender.tab.id`. The publisher must validate the sender's exact ChatGPT origin and live tab route, not trust a page-supplied tab ID or route string.
3. **Only from the provider extension principal**, background calls `browser.runtime.sendMessage('chat-queue@sguzman.github', {type:'chat-queue-signal/v1',tabId,signal})`. Missing Queue, unsupported protocol or transport failures are nonfatal to Chat Signals. No fallback page `postMessage`, DOM spoofing or unauthenticated channel is permitted.
4. **Chat Queue background** already authenticates `sender.id==='chat-signals@sguzman.github'`, checks the registered tab and exact pathname, rejects non-monotonic sequence/epoch and forwards accepted events to that tab's executor. No transcript, prompt, notification icon or user text is in this contract.

The external signal must exactly match the [consumer parser](../src/signal.js). The payload's `signal` fields are `version:1`, `route` (pathname, maximum 512 allowed characters), `documentToken` (32 lowercase hex chars per document), `sequence` (positive, strictly increasing within that document), `epoch` (nonnegative, never decreases), `phase` (one of nine documented phases), `origin` (`fresh|restored`) and `confidence` (`observed|inferred|unknown`). Only use the actual Firefox tab ID as top-level `tabId`. Do not add raw conversation keys, titles, query strings, response text or unbounded fields.

## Freshness/epoch invariants

- **Initial hydration is not completion.** Chat Signals currently restores prior state through its registration response. Any replayed or restored terminal snapshot must be `origin:'restored'`, never `fresh`. If freshness is unclear, send no ready/completion authority.
- **New response epoch:** A post-Send `submitted`, `generating` or `verifying` state must have `epoch > baseline.epoch` to count as an accepted new response. A missing Stop button, a historical Copy button or a client-click is never enough.
- **Attributable finish:** `finished` needs the same document token, same route and exact response epoch, with a later sequence than the confirmed busy event. A terminal event from another tab, chat or earlier response is rejected.
- **Navigation and lifecycle:** route changes, document replacement, extension reload and background event-page restarts invalidate the previous provider authority. A fresh registration/verified event is required. Never synthesize a new `finished` solely because the background process restarted.
- **Privacy:** publish only phase/epoch/confidence metadata. No transcript scan beyond the existing Signals logic, no network telemetry, remote dependency or user-prompt logging. Errors and debug output must not include user conversations.

## Minimal independent implementation phases

- **P1 — pure publisher mapper:** add provider-owned tests for snapshot-to-wire shape, route/token validation, monotonic epochs/sequences and restored/fresh handling. Keep mappings separate from inference.
- **P2 — verified Firefox transport:** forward through the real Chat Signals extension background, derive tab ID from `sender.tab.id`, handle absent Queue gracefully and never broadcast arbitrary page data.
- **P3 — disposable two-addon FDE:** run the actual Chat Signals publisher and actual Chat Queue receiver in temporary add-ons. Test registration, initial idle, one busy epoch and attributable completion; reject stale, spoofed, duplicate, wrong-tab and restored finishes.
- **P4 — authenticated benign Send:** in a separate QA profile, prove exactly one harmless prompt on ChatGPT, then two consecutive prompts in order; test manual draft, selected attachment, navigation mid-attempt and failed/limit/interrupted states. Document Firefox Developer Edition version, add-on SHAs, date and nonprivate evidence.
- **P5 — restart and long-session acceptance:** background restart, tab restoration, simultaneous same-conversation tabs, one-minute+ generation, network drop and explicit manual resolution. Do not enable unattended scheduling before these gates pass.

The provider and consumer require separate repository tests and evidence. A simulated publisher addon such as `tests/fde-signal.cjs` is useful transport QA, **not** proof that the real Chat Signals extension has implemented the protocol. Do not mark M3 or G3 fully verified until the live provider and authenticated Firefox tests pass.

**Compatibility constraint:** Keep Chat Signals' independent UI, notifications, colors and existing internal messages functional even when Chat Queue is absent. Avoid introducing a hard dependency or shared repo. No human manual QA is required for repeatable tests; use disposable automated Firefox Developer Edition profiles.
