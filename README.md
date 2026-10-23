# Chat Queue 🗂️

A standalone, **Firefox Developer Edition-first** ChatGPT message queue and floating HUD. Author multiple prompts, adjust their order during generation, and let the queue submit one at a time only when the independent [Chat Signals](https://github.com/sguzman/chat-signals) observer indicates control has returned. The project also targets a permissioned API for other Firefox extensions and future conditional queues based on state transitions.

**Status: early development prototype, not authenticated-site verified.** The implementation has passed 23 Node tests, actual Firefox Developer Edition installation, synthetic HUD interaction and a two-add-on synthetic Signal transport test. These **do not** establish authenticated ChatGPT sending or a working publisher in the real Chat Signals extension.

## 🧭 Project navigation

- [🗺️ Complete roadmap](ROADMAP.md) — 8 milestones, 16 phases, named features and 96 atomic tasks with acceptance gates.
- [📊 Progress ledger](progress.json) — canonical machine-readable status and bounded evidence for each task; `npm run progress` prints current percentages.
- [🏗️ Architecture](docs/ARCHITECTURE.md) — independent ownership, signal flow, identity/epoch contract, UI and queue lifecycle.
- [📡 Signal contract](docs/SIGNAL-CONTRACT.md) — authenticated consumer envelope, attribution and pending provider work.
- [🛡️ Security](docs/SECURITY.md) — browser privacy, threat model and single-send guarantees.
- [🦊 Firefox QA](docs/QA.md) — dedicated profile, synthetic and authenticated acceptance tiers.
- [🧬 Source provenance](docs/PROVENANCE.md) — what was studied in Jobflick Bridge/Chat Signals.
- [🔌 External API](API.md) — implemented experimental v1 and future permission model.
- [📋 Development protocol](AGENTS.md) — repo rules, public-output hygiene and honest task percentages.

## ✅ Prototype capabilities (not live browser acceptance)

- Floating, isolated Shadow DOM HUD with add/edit/delete, guarded two-click Clear, drag/drop, up/down reorder, collapse, recent locally stored submissions, and Start/Pause controls.
- **Theme selector:** `System` (default), `Light`, `Dark`. `System` follows desktop preferences without synchronizing with ChatGPT's own site theme. Selection is saved locally and mirrored in other open HUDs and the options page.
- Queued prompts remain editable while ChatGPT generates. Only an active dispatch attempt temporarily locks mutations.
- Single-attempt dispatch with draft occupancy checks, explicit user authorization, and pause on unknown/interrupted/failed/limit states. No automatic retry after an uncertain submission.
- Local Firefox extension storage and **explicit, independent extension API grants** for `discover`, `read`, `append`, `edit`, and `control`; no telemetry or server endpoint. Legacy broad allowlist entries are deliberately inactive until manually reauthorized. Scope enforcement and revocation passed a disposable Firefox Developer Edition client test; authenticated-site acceptance remains open.

## 📡 Critical limitation: Chat Signals contract

Chat Signals v0.3.13 currently provides `document.documentElement.dataset.chatSignalsState`. This attribute is **not an authenticated channel and contains no response epoch or route identity**. Chat Queue now reads it **for HUD display only**, not for sending or queue advancement.

The fail-closed consumer accepts `chat-queue-signal/v1` only when Firefox authenticates the sender as the Chat Signals extension. It requires a matching route, monotonic sequence, response epoch and fresh event origin; each Send attempt is journaled as uncertain before the click. See [Signal contract](docs/SIGNAL-CONTRACT.md).

**Important: Chat Signals does not yet publish this protocol.** Start therefore refuses with `authenticated-chat-signals-required`. Synthetic Firefox tests verify receiver mechanics only, not the real provider or authenticated ChatGPT. No changes were made to the Chat Signals repository.

## 🦊 Disposable Firefox Developer Edition

For an isolated local QA profile, use `fish scripts/qa-firefox-developer.fish`. The script only opens a separate Firefox Developer Edition profile and `about:debugging`; it does not modify the personal browser profile, install an add-on or automatically send messages. Select the repository's `manifest.json` via **Load Temporary Add-on** inside that separate profile, and independently install Chat Signals in the same QA profile when testing integration.

The addon uses Manifest V3's Firefox `background.scripts`, the `storage` permission, and a content script on `https://chatgpt.com/*` only. There is no Native Messaging or local Jobflick backend. For real authenticated sending, wait until the QA gates in `docs/QA.md` are evidenced. An unsigned developer add-on may need Mozilla signing for permanent installation; the current manifest is a development artifact.

## 🛠️ Development

Use Node 22+ and `npm run check` (no installed NPM dependencies). `npm run progress` prints verified vs. implemented percentages; edit `progress.json`, then regenerate `ROADMAP.md` using `npm run roadmap`. CI performs static/Node checks, real headless Firefox Developer Edition installation, a synthetic HUD/browser test, and **two-addon synthetic Signal transport** tests. These prove bounded browser mechanics, not authenticated ChatGPT sending or a working real Chat Signals publisher.

Work directly on `main`, keep public materials free of private chat content, and do not reproduce Chat Signals inference logic here. This is a complete-feature roadmap, not an assertion that every later conditional or external API behavior already works.

## 🔀 History API route guard (synthetic Firefox verified)

ChatGPT can switch conversations through `history.pushState()` and `history.replaceState()` without a document reload. Chat Queue uses a bounded pathname-only watcher, plus ordinary click/navigation hints and Firefox `tabs.onUpdated` invalidation. During registration and state publication the background checks the **browser-owned live tab URL** via `tabs.get(tabId)`, because a content script's `sender.url` can refer to the original document after a same-document navigation.

Returning to a conversation restores its saved queue **paused** and rotates stale API edit tokens. A synthetic two-route Firefox Developer Edition test confirms separation, restoration and no unintended Send ([passing run](https://github.com/sguzman/chat-queue/actions/runs/40034372239)). This needs no `webNavigation` permission, tab enumeration, transcript scan or forced reload. Authenticated ChatGPT routing remains a separate acceptance gate.
