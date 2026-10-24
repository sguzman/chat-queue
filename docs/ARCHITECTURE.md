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

The prototype persists bounded prompt text inside `browser.storage.local`, keyed by Firefox tab ID and current page path. It never uses cloud sync. This permits ordinary tab reload recovery. For a changed tab ID, a user can explicitly discover and confirm copying compatible older records with the **exact same conversation pathname**, leaving sources intact and marking all copied items uncertain. This is not automatic browser-restart recovery and does not unify live queues from multiple tabs. A future storage schema must separate stable conversation scope from transient tab ownership while preserving the current single-owner route lease and attempt journals; migration requires explicit review, never a silent merge of similarly named chats.

The executor's `running` state is volatile. Installing or reloading an extension, switching conversation, or restarting Firefox cannot resume automatic sends silently. An exception must be an explicit user-granted policy with rigorous idempotency and live acceptance.

A queue item may be pending, attempting, or uncertain. Moving/removing/editing unrelated pending items while the model generates is allowed. A dispatch in flight freezes mutating actions briefly; a durable per-item transaction and cross-caller revision protocol are planned.

## Composer adapter

Within a single exact ChatGPT composer form, verify the draft is empty, that no known attachments already exist, insert exactly the intended text, verify the resulting value, identify one enabled Send control, then attempt a single Send. **An observed click is not server acceptance**; missing confirmation moves to uncertainty and requires user resolution. Never retry automatically, click a Retry control automatically, navigate conversations, discard an existing draft, or act on a stale tab/route.

The current synthetic implementation checks UI transitions, but authenticated Firefox QA has not been performed; contenteditable/React pathways can differ. An `uncertain` item is durably written before the single Send attempt, preventing an extension reload from mistakenly retrying it. Treat local tests as pure behavioral evidence only, not live-site acceptance.

## HUD and themes

The panel is a Shadow DOM surface fixed near the lower-right, independently styled from ChatGPT. Its settings selector has exactly `System`, `Light`, and `Dark`; `System` is the default and follows `prefers-color-scheme`, including mid-session changes via CSS. Overrides use a host-scoped `data-theme` and semantic CSS variables. The choice is local and shared across ChatGPT tabs through `storage.onChanged`. The theme cannot rewrite ChatGPT's site styling. Accessible focus rings, Atkinson Hyperlegible preference with system fallback, reduced motion, and bounded viewport sizing are required. Real FDE visual/keyboard QA remains open.

## API

See [API.md](../API.md). The current API is `chat-queue/v1`, with explicit external extension allowlist, bounded item text and a few typed verbs. **v2 grants separate `discover`, `read`, `append`, `edit` and `control`**; legacy broad ID lists are ignored, background checks exact `sender.id` and each action, and subscription ports require `discover`. Source and Node coverage exist, but native Firefox external-client tests, optimistic revisions and genuine idle event-page recovery now have bounded acceptance, while authenticated ChatGPT and full session restart remain pending. Never expose queue contents through DOM attributes, tab titles or diagnostic logs.

## Concurrent mutation boundary

Each content-script instance assigns a fresh random revision token and rotates it on each saved queue mutation. The external API can supply an optional `ifMatch` precondition for ordered queue edits; a stale or previous-document token is rejected rather than silently overwriting a newer arrangement. Omitted preconditions retain experimental v1 compatibility. A separate opt-in `enqueueSequenced` operation stores a per-caller monotonically increasing sequence in the same exact-route queue record as the appended item. Replay of that sequence is rejected even after a content-script reload; the legacy `enqueue` path and deleted/moved storage records are not covered. This does not make ChatGPT Send exactly-once or protect arbitrary cross-tab mutations.

## Firefox tab URL transition boundary

Firefox `tabs.onUpdated` URL changes are handled only for an already registered ChatGPT tab. If the URL pathname changes from a tab's registered route, the background immediately discards its authenticated Signal sequence and public tab registry, then asks the same tab's content script to recheck its actual `location.pathname`. A re-registration must match the browser-provided sender URL; a forged/late route string cannot rebind old events. Route loading uses generation numbers so older delayed storage reads cannot overwrite a newer selected conversation. All transitions pause scheduling, retain old queued messages durably, and require a fresh explicit Start. Firefox extension tests cover pushState/replaceState; they do not establish authenticated ChatGPT production acceptance.

## 🧷 Volatile single-owner conversation dispatch

The event page keeps an in-memory route→tab ownership map, independent of prompt content or local queue storage. Only the first valid authenticated `dispatch-check` for an exact conversation path reserves ownership. Every Send requires this check both *before* composer insertion and again after the durable uncertain journal entry, preventing a competing tab from altering the page draft or sending. A tab's own repeated checks are idempotent. Other tabs fail with `conversation-owned-by-another-tab`, leave their queued message pending, and require deliberate Start after ownership becomes available. Ownership is released on tab closure, route invalidation, re-registration, or a state publication with both `running=false` and `awaiting=false`. A paused conversation that is still awaiting the previous response keeps its owner lease. Event-page restart discards this volatile map and the provider ledger; the first new Send must re-establish trustworthy signals and acquire ownership anew. No tab enumeration or cross-tab navigation is introduced. Actual Firefox two-tab synthetic provider acceptance passes; real Chat Signals publishing is separate.

## Firefox event-page registry recovery

A Firefox event page can lose its volatile `TABS`, `ROUTES`, `SIGNALS` and dispatch-owner maps while a ChatGPT tab's content script remains loaded. The content script's metadata `state` message then receives `route-mismatch` from the restarted background. Chat Queue treats this as an authority-loss event, not as permission to resend: it pauses, clears the trusted Signal, response waiting state and any scheduled next-item callback, and attempts one exact-route **metadata-only** registration. A successful registration can restore API tab discovery but **does not restore the old authenticated epoch**. A fresh event from the real Chat Signals publisher and deliberate Start are still required before any later Send.

The existing once-per-second **pathname-only** route watcher now publishes metadata-only queue state after 60 successful ticks without navigation. This bounded local Firefox message is a discovery heartbeat, not a provider signal, network request, transcript read or Send authorization. It detects an event-page registry reset even when the queue is idle and untouched. Hidden-tab timer throttling may delay detection; this is eventual, not immediate, recovery. There is no additional timer or persistent worker. In disposable Firefox QA only, the heartbeat interval is shortened and the synthetic event page forgets its registry while idle; the content script must pause, clear authority and re-register without Send.

Both synthetic registry-loss injection and **genuine Firefox MV3 event-page idle/restart** are now accepted: a dedicated disposable FDE add-on observes the actual background boot counter rise from 2 to 3 and the HUD recover metadata while preserving its queued item without Send. [Real lifecycle CI](https://github.com/sguzman/chat-queue/actions/runs/40058326692). Whole-browser crash/relaunch, authenticated ChatGPT, and durable live cross-tab ownership remain separate. A failed registration leaves the queue paused rather than falling back to page attributes. An active in-flight Send remains governed by the existing uncertain-send journal.

## 🧵 Out-of-order tab metadata publications

Content scripts attach an increasing **document-local sequence** to every internal tab-state publication, separate from the durable queue edit revision. Firefox's asynchronous `tabs.get()` route checks can resolve requests out of order. The background's per-tab volatile sequence registry rejects stale/duplicate publications **after** checking the live URL but **before** mutating public tab status or releasing the route's single-dispatch-owner lease. Re-registration and tab invalidation reset that volatile registry; each successful registration also receives a distinct event-page generation. Pending asynchronous state reads must still match that generation after their URL lookup, even when the pathname is unchanged. This prevents an old same-route callback from resurrecting an obsolete pause after re-registration. Neither ordering value is exposed to other extensions or conveys Signal-provider authority. Unit tests invert asynchronous callback completion and confirm stale pause does not free ownership. The native Firefox API fixture tests the same ordering without touching a personal browser profile. This does not make a restarted event page trust stale Signals or permit unattended Send.

## 🗄️ Damaged saved-record preservation

A supported-version local queue record with malformed/duplicate item IDs, oversized queues, invalid text, malformed submitted-history entries or corrupt previous-tab recovery markers is **read-only**, not normalized and later overwritten. Legacy versionless records and unknown historical **item statuses** remain readable; unknown item statuses restore as uncertain. The validator does not mutate its input. Users may still export/read their Firefox profile data separately. Synthetic Firefox QA seeds damaged records, attempts edits, then reloads to ensure rejection persists. Neither this guard nor manual old-tab discovery establishes a stable canonical conversation key after restart; that remains its own acceptance task.
