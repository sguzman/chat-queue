# Chat Queue 🗂️

A standalone, **Firefox Developer Edition-first** ChatGPT message queue and floating HUD. Author multiple prompts, adjust their order during generation, and let the queue submit one at a time only when the independent [Chat Signals](https://github.com/sguzman/chat-signals) observer indicates control has returned. The project also targets a permissioned API for other Firefox extensions and future conditional queues based on state transitions.

**Status: early development prototype, not authenticated-site verified.** The implementation has passed 46 Node tests, pinned Mozilla add-on lint with zero warnings/errors, actual Firefox Developer Edition installation, synthetic HUD and queue-persistence interaction, and a two-add-on synthetic Signal transport test. These **do not** establish authenticated ChatGPT sending or a working publisher in the real Chat Signals extension.

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

- Floating, isolated Shadow DOM HUD with add/edit/delete, guarded two-step Clear, drag/drop, up/down reorder, collapse, recent locally stored submissions, and Start/Pause controls.
- **Theme selector:** `System` (default), `Light`, `Dark`. `System` follows desktop preferences without synchronizing with ChatGPT's own site theme. Selection is saved locally and mirrored in other open HUDs and the options page.
- Queued prompts remain editable while ChatGPT generates. Only an active dispatch attempt temporarily locks mutations.
- Single-attempt dispatch with draft occupancy checks, explicit user authorization, and pause on unknown/interrupted/failed/limit states. No automatic retry after an uncertain submission.
- Local Firefox extension storage and **explicit, independent extension API grants** for `discover`, `read`, `append`, `edit`, and `control`; no telemetry or server endpoint. Legacy broad allowlist entries are deliberately inactive until manually reauthorized. Scoped API client, mutation-token conflict handling, and revocation passed synthetic Firefox Developer Edition QA; Options permissions UX and event-page restart remain unaccepted.

## 📡 Critical limitation: Chat Signals contract

Chat Signals v0.3.13 currently provides `document.documentElement.dataset.chatSignalsState`. This attribute is **not an authenticated channel and contains no response epoch or route identity**. Chat Queue now reads it **for HUD display only**, not for sending or queue advancement.

The fail-closed consumer accepts `chat-queue-signal/v1` only when Firefox authenticates the sender as the Chat Signals extension. It requires a matching route, monotonic sequence, response epoch and fresh event origin; each Send attempt is journaled as uncertain before the click. See [Signal contract](docs/SIGNAL-CONTRACT.md).

**Important: Chat Signals does not yet publish this protocol.** Start therefore refuses with `authenticated-chat-signals-required`. The receiver's tests are not real browser integration acceptance. No changes were made to the Chat Signals repository.

## 🦊 Disposable Firefox Developer Edition

For an isolated local QA profile, use `fish scripts/qa-firefox-developer.fish`. The script only opens a separate Firefox Developer Edition profile and `about:debugging`; it does not modify the personal browser profile, install an add-on or automatically send messages. Select the repository's `manifest.json` via **Load Temporary Add-on** inside that separate profile, and independently install Chat Signals in the same QA profile when testing integration.

The addon uses Manifest V3's Firefox `background.scripts`, the `storage` permission, and a content script on `https://chatgpt.com/*` only. There is no Native Messaging or local Jobflick backend. For real authenticated sending, wait until the QA gates in `docs/QA.md` are evidenced. An unsigned developer add-on may need Mozilla signing for permanent installation; the current manifest is a development artifact.

The local queue loader preserves unrecognized future-version records without overwriting them; recognizable legacy versionless records can be edited and saved as v1. Firefox synthetic QA verifies both paths. External `move`/`reorder` requests reject invalid targets and duplicate or foreign IDs without changing order. These tests remain distinct from authenticated ChatGPT acceptance.

## 🛠️ Development

Use Node 22+ and `npm run check` (no installed NPM dependencies). `npm run progress` prints verified vs. implemented percentages; edit `progress.json`, then regenerate `ROADMAP.md` using `npm run roadmap`. CI performs static/Node checks, real headless Firefox Developer Edition installation, a synthetic HUD/browser test, and **two-addon synthetic Signal transport** tests. These prove bounded browser mechanics, not authenticated ChatGPT sending or a working real Chat Signals publisher.

Work directly on `main`, keep public materials free of private chat content, and do not reproduce Chat Signals inference logic here. This is a complete-feature roadmap, not an assertion that every later conditional or external API behavior already works.

## 🔀 History API route guard (synthetic Firefox accepted)

ChatGPT can change conversations using `history.pushState()` or `history.replaceState()` without reloading. Chat Queue checks **only the pathname** with a bounded one-second content-script watcher plus ordinary navigation hints; Firefox `tabs.onUpdated` invalidates old authority when the URL changes. A live `tabs.get(tabId)` checks the browser-owned route on registration and state publication, because a long-lived content script's `sender.url` may remain at the original document URL. No `webNavigation` permission, history enumeration, transcript scan or forced tab reload is used.

A synthetic Firefox Developer Edition test verifies switching away and back restores queued messages **paused**, rotates optimistic edit tokens, isolates the other conversation, and does not click Send. Authenticated ChatGPT routing is a separate acceptance gate.

## 🧠 Conditional-rule preview (no Send)

The preferences page includes a **visual, dry-run rule editor** for building declarative conditions, setting priorities, and simulating fresh/restored Chat Signals outcomes. Preview output is rendered as text, never injected HTML. Rule definitions can now be saved in local extension storage, but the simulation replay history clears on reload. There is no live background dispatch integration or automatic conditional action.

The pure rule engine and its 8 focused Node regressions passed in [GitHub Actions](https://github.com/sguzman/chat-queue/actions/runs/40035678496). Real headless Firefox Developer Edition accepted the production simulator scripts on a synthetic preferences document (including replay suppression, restored-state rejection and inert HTML text) in [run 40036012429](https://github.com/sguzman/chat-queue/actions/runs/40036012429). Neither test is authenticated ChatGPT conditional-send acceptance. See [conditional rule contract](docs/CONDITIONAL-RULES.md).

## 📦 Reordering while generating

The synthetic Firefox Developer Edition two-add-on test now covers adding and reordering pending messages **during** a response: message A is dispatched, C is added and moved ahead of B while A is generating, then subsequent synthetic provider completions produce A → C → B without a duplicate ([accepted CI](https://github.com/sguzman/chat-queue/actions/runs/40036243322)). This is browser-level evidence for queue interaction, not authenticated ChatGPT acceptance.

## 🛡️ Uncertain sends and deliberate recovery

When the background loses a synthetic authenticated Signal registry at the pre-send check, the queue preserves the draft and an uncertain item. A later idle Signal never retries it; explicit user clearing of the occupied composer, **Retry**, and **Start** are required. Actual headless Firefox Developer Edition verifies this sequence in [run 40036722480](https://github.com/sguzman/chat-queue/actions/runs/40036722480). This is fault injection, not a demonstrated real event-page restart. The HUD also disarms Clear confirmation when the user clicks elsewhere.

## 🔌 Independent rules-preview permission

An approved Firefox extension may now request the separate `rules` scope and call `chat-queue/v1` → `previewRules` with its **own synthetic event and typed rule data**. No provider event, conversation content, or queued prompt is read; nothing is persisted or sent. The [independent Firefox client acceptance run](https://github.com/sguzman/chat-queue/actions/runs/40037217649) verifies isolated scope, typed decisions, and immediate denial after revocation. External rule CRUD, event notifications and activated policies are not implemented; local Options-only editing is independent of that API. See [API.md](API.md).

## 🧠 Locally saved conditional rule definitions (no execution)

The Options rule editor now stores up to 32 validated, versioned rule definitions in `browser.storage.local` on explicit Save/Remove/Clear actions. Definitions load after an Options reload; a two-step **Clear saved rules** action removes them. Malformed, oversized, or future-version storage records are never silently overwritten. Saving a rule does **not** activate it, watch a conversation, enqueue a message, or trigger Send. Rule preview still uses synthetic events only, and the external `rules` API still evaluates exclusively caller-supplied data. See [docs/CONDITIONAL-RULES.md](docs/CONDITIONAL-RULES.md).

## 🎨 HUD placement and collapse

The floating queue HUD supports pointer dragging on the header without intercepting its controls, keyboard movement when the header is focused (arrow keys, or Shift+arrow for a larger step), and Home to reset position. A **Reset queue position** button also expands the panel and returns to the default corner. Only bounded right/bottom coordinates and a collapsed flag are stored under `chatqueue:ui:v1` in Firefox local extension storage; these preferences are shared across the extension's ChatGPT tabs. Viewport resizing clamps the panel to the visible area. The HUD never changes browser preferences or navigates the page.

## 🧷 Same-conversation dispatch ownership

Two Firefox tabs may display the same ChatGPT conversation, but only one queue may hold its volatile exact-route dispatch lease at a time. The owner is reserved before any composer mutation and rechecked immediately before Send. A second tab is refused without touching its draft or sending; pausing an owner while its response is still pending **does not** release the lease. A confirmed completion after pause, tab close, or route departure permits a later explicit Start in another tab. This prevents competing queue dispatch in the synthetic Firefox test; it is not proof of authenticated ChatGPT behavior or a substitute for the real Chat Signals publisher.

## 🤝 Real Chat Signals coexistence (synthetic Firefox)

A pinned checkout of the **actual Chat Signals v0.3.13 source** is loaded alongside Chat Queue in disposable headless Firefox Developer Edition using localhost-only QA host scopes. Its real DOM phase is displayed as **unverified** by the queue HUD, and the queue refuses Send because the authenticated publisher is not implemented. A forged page `finished` state also cannot authorize dispatch. [Passing coexistence CI](https://github.com/sguzman/chat-queue/actions/runs/40042631264). This is not authenticated ChatGPT integration; the actual publisher and response-epoch acceptance gates remain open.
