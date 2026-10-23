# 🏗️ Chat Queue architecture

## Ownership and independence

- **Chat Signals** owns observation and inference of ChatGPT reply phases and conversation identity. Its [current state model](https://github.com/sguzman/chat-signals/blob/main/docs/STATE-MODEL.md) explicitly separates `submitted`, `generating`, `verifying`, `finished`, `interrupted`, `failed`, `limit`, `idle` and `unknown` with evidence limits. Chat Queue must not reimplement that classifier or patch that repository to hide queue defects.
- **Chat Queue** owns only message storage, local queue ordering, scheduling policy, guarded text entry, HUD presentation, settings and API permissions.
- **Calling extensions** may request explicit operations through the versioned extension API if permitted. They must not receive implicit authority to read every prompt merely by being installed.

```text
ChatGPT page UI
  ├── Chat Signals content script (independent observer)
  │     ├── current state attribute on documentElement (display only)
  │     └── future authenticated extension-to-extension v1 events (not yet produced)
  └── Chat Queue content script (Shadow DOM HUD + active-tab executor)
        ├── queue model/order and scoped durable queue state
        ├── read-only Signal subscription (no transcript reads)
        ├── single serialized message dispatcher
        └── extension internal messages ⇄ Firefox event-page background
                                                ├── storage.local metadata, ACL
                                                └── onMessageExternal/onConnectExternal
                                                       ⇄ approved extensions
```

Firefox Developer Edition is the primary implementation/QA target. Use `background.scripts` for Firefox event pages; do not silently test Chromium and call it Firefox acceptance. ChatGPT host scope only. No Native Messaging, shell access, remote service, telemetry, or permission to access all browser tabs.

## Event attribution

Chat Signals **currently** (v0.3.13, inspected 2026-10-23) exposes `data-chat-signals-state` on `document.documentElement`. This is a useful prototype compatibility hook, **not an authenticated production API**. Site code can alter the page DOM. A phase-only reading does not identify which response epoch finished, nor establish that the executor's last attempted Send produced that response. Some terminal states may be historical restoration from a previous extension session. Consequently phase-based scheduling is provisional and must not pass the G2/G3 acceptance gate.

An authenticated, versioned **consumer** now exists in Chat Queue's background, documented in [SIGNAL-CONTRACT.md](SIGNAL-CONTRACT.md). The corresponding Chat Signals **publisher is not implemented** and requires separately authorized coordination. The candidate envelope contains:

- provider name and schema/version; authenticated Firefox extension sender identity
- stable scoped conversation identity / document instance token; event sequence
- response epoch and phase, `fresh`/`restored`, read flag, and evidence confidence
- terminal reason and transition semantic; no transcript text

The consumer rejects mismatched routes, stale sequences, old completion, unknown versions, and missing providers. Until the independent publisher is implemented and tested, **all automatic sends remain blocked**. Page-controlled `data-*` values can only update the HUD's unverified observation.

## Queue storage and lifecycle

The prototype persists bounded prompt text inside `browser.storage.local`, keyed by Firefox tab ID and current page path. It never uses cloud sync. This permits recovery on ordinary tab reload but **does not** reliably recover when tab IDs change after restart, or deduplicate independent queues in two tabs opened on the same conversation. Future storage schema separates stable conversation scope from transient tab ownership and stores explicit attempt journals. It requires a conscious migration; do not silently merge similarly named chats.

The executor's `running` state is volatile. Installing or reloading an extension, switching conversation, or restarting Firefox cannot resume automatic sends silently. An exception must be an explicit user-granted policy with rigorous idempotency and live acceptance.

A queue item may be pending, attempting, or uncertain. Moving/removing/editing unrelated pending items while the model generates is allowed. A dispatch in flight freezes mutating actions briefly; a durable per-item transaction and cross-caller revision protocol are planned.

## Composer adapter

Within a single exact ChatGPT composer form, verify the draft is empty, that no known attachments already exist, insert exactly the intended text, verify the resulting value, identify one enabled Send control, then attempt a single Send. **An observed click is not server acceptance**; missing confirmation moves to uncertainty and requires user resolution. Never retry automatically, click a Retry control automatically, navigate conversations, discard an existing draft, or act on a stale tab/route.

The current synthetic implementation checks UI transitions, but authenticated Firefox QA has not been performed; contenteditable/React pathways can differ. An `uncertain` item is durably written before the single Send attempt, preventing an extension reload from mistakenly retrying it. Treat local tests as pure behavioral evidence only, not live-site acceptance.

## HUD and themes

The panel is a Shadow DOM surface fixed near the lower-right, independently styled from ChatGPT. Its settings selector has exactly `System`, `Light`, and `Dark`; `System` is the default and follows `prefers-color-scheme`, including mid-session changes via CSS. Overrides use a host-scoped `data-theme` and semantic CSS variables. The choice is local and shared across ChatGPT tabs through `storage.onChanged`. The theme cannot rewrite ChatGPT's site styling. Accessible focus rings, Atkinson Hyperlegible preference with system fallback, reduced motion, and bounded viewport sizing are required. Real FDE visual/keyboard QA remains open.

## API

See [API.md](../API.md). The current API is `chat-queue/v1`, with explicit external extension allowlist, bounded item text and a few typed verbs. **v2 grants separate `discover`, `read`, `append`, `edit` and `control`**; legacy broad ID lists are ignored, background checks exact `sender.id` and each action, and subscription ports require `discover`. Source and Node coverage exist, but live external Firefox caller tests, revisions and event-page recovery remain pending. Never expose queue contents through DOM attributes, tab titles or diagnostic logs.

## Concurrent mutation boundary

Each content-script instance assigns a fresh random revision token and rotates it on each saved queue mutation. The external API can supply an optional `ifMatch` precondition for ordered queue edits; a stale or previous-document token is rejected rather than silently overwriting a newer arrangement. Omitted preconditions retain experimental v1 compatibility; this does not yet protect all cross-tab ownership or provide durable exactly-once API request IDs.

## Firefox tab URL transition boundary

Firefox `tabs.onUpdated` URL changes are handled only for an already registered ChatGPT tab. If the URL pathname changes from a tab's registered route, the background immediately discards its authenticated Signal sequence and public tab registry, then asks the same tab's content script to recheck its actual `location.pathname`. A re-registration must match the browser-provided sender URL; a forged/late route string cannot rebind old events. Route loading uses generation numbers so older delayed storage reads cannot overwrite a newer selected conversation. All transitions pause scheduling, retain old queued messages durably, and require a fresh explicit Start. Firefox extension tests cover pushState/replaceState; they do not establish authenticated ChatGPT production acceptance.
