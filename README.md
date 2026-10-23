# Chat Queue 🗂️

A standalone, **Firefox Developer Edition-first** ChatGPT message queue and floating HUD. Author multiple prompts, adjust their order during generation, and let the queue submit one at a time only when the independent [Chat Signals](https://github.com/sguzman/chat-signals) observer indicates control has returned. The project also targets a permissioned API for other Firefox extensions and future conditional queues based on state transitions.

**Status: early development prototype, not live-verified.** The current implementation passes 13 Node tests and has the first HUD, queue model, permissioned external messaging, and theme selector. It has **not** passed authenticated ChatGPT sending, real Firefox Developer Edition UI or addon-to-addon tests. Do not mistake code presence for acceptance.

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

- Floating, isolated Shadow DOM HUD with add/edit/delete, drag/drop, up/down reorder, collapse, recent locally stored submissions, and Start/Pause controls.
- **Theme selector:** `System` (default), `Light`, `Dark`. `System` follows desktop preferences without synchronizing with ChatGPT's own site theme. Selection is saved locally and mirrored in other open HUDs and the options page.
- Queued prompts remain editable while ChatGPT generates. Only an active dispatch attempt temporarily locks mutations.
- Single-attempt dispatch with draft occupancy checks, explicit user authorization, and pause on unknown/interrupted/failed/limit states. No automatic retry after an uncertain submission.
- Local Firefox extension storage and explicit allowlist for other extensions. No telemetry or server endpoint. An approved v1 client has broad read/write access; use only with trusted clients until least-privilege scopes are implemented.

## 📡 Critical limitation: Chat Signals contract

Chat Signals v0.3.13 currently provides `document.documentElement.dataset.chatSignalsState`. This attribute is **not an authenticated channel and contains no response epoch or route identity**. Chat Queue now reads it **for HUD display only**, not for sending or queue advancement.

The fail-closed consumer accepts `chat-queue-signal/v1` only when Firefox authenticates the sender as the Chat Signals extension. It requires a matching route, monotonic sequence, response epoch and fresh event origin; each Send attempt is journaled as uncertain before the click. See [Signal contract](docs/SIGNAL-CONTRACT.md).

**Important: Chat Signals does not yet publish this protocol.** Start therefore refuses with `authenticated-chat-signals-required`. The receiver's tests are not real browser integration acceptance. No changes were made to the Chat Signals repository.

## 🦊 Disposable Firefox Developer Edition

For an isolated local QA profile, use `fish scripts/qa-firefox-developer.fish`. The script only opens a separate Firefox Developer Edition profile and `about:debugging`; it does not modify the personal browser profile, install an add-on or automatically send messages. Select the repository's `manifest.json` via **Load Temporary Add-on** inside that separate profile, and independently install Chat Signals in the same QA profile when testing integration.

The addon uses Manifest V3's Firefox `background.scripts`, the `storage` permission, and a content script on `https://chatgpt.com/*` only. There is no Native Messaging or local Jobflick backend. For real authenticated sending, wait until the QA gates in `docs/QA.md` are evidenced. An unsigned developer add-on may need Mozilla signing for permanent installation; the current manifest is a development artifact.

## 🛠️ Development

Use Node 22+ and `npm run check` (no installed NPM dependencies). `npm run progress` prints verified vs. implemented percentages; edit `progress.json`, then regenerate `ROADMAP.md` using `npm run roadmap`. CI performs static/Node checks; real Firefox Developer Edition tests are not configured or claimed passing yet.

Work directly on `main`, keep public materials free of private chat content, and do not reproduce Chat Signals inference logic here. This is a complete-feature roadmap, not an assertion that every later conditional or external API behavior already works.
