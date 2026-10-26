# 🦊 Firefox Developer Edition acceptance plan

Follow the same evidence discipline as [Jobflick Bridge QA](https://github.com/sguzman/jobflick-bridge/blob/main/docs/QA.md). Firefox Developer Edition, not Firefox Release/Chromium/Edge, is the target for QA. The automated suite must use a disposable browser profile; never modify Firefox profile preferences or load add-ons into the user's active browser without explicit consent.

## Test tiers

- **Q0 static:** `npm run check` validates JS syntax, ledger/roadmap consistency, queue pure functions, and background allowlist rejection. Q0 includes Node tests for v2 scope enforcement and subscription revocation; this does *not* validate DOM rendering or live site integration.
- **Q1 synthetic FDE:** install/uninstall the exact production manifest in a disposable headless FDE profile. With a strictly QA-only synthetic fixture, exercise HUD, each theme including OS change, drag/keyboard ordering, reload and stale route. No ChatGPT account required.
- **Q2 Signal contract:** run Chat Signals + Chat Queue in the same disposable FDE instance, with scripted fresh vs restored response epochs, failed/interrupted/limit states, and provider disappearance. Confirm no unauthorized send. A page attribute alone is not an authenticated signal.
- **Q2a negative gate:** with the legacy pinned Chat Signals source `102e3ea16a9e9535d377c1d4e8b564f5b0fdb721` (manifest v0.3.13, before its Queue publisher), the HUD may display unverified phase changes, but Start must refuse and no Send click may occur. The separate pinned publisher `d17117047f5e582591e514240c008b166bf96d8a` has its own positive synthetic two-addon acceptance. Node unit tests for the candidate consumer are not a substitute for a real FDE run.
- **Q3 authenticated FDE:** test a deliberately harmless queued message in a separate authenticated ChatGPT QA profile; verify one actual submission followed by verified completion. Then test two-message serial order, draft occupancy, tab switching, page rerender, timeout, background, manual stop, route change, disconnected Signal, and browser restart. These must pass *before* automatic sender acceptance.
- **Q4 extension API:** a second synthetic Firefox extension exercises allowlist, denied callers, read and mutating scopes, revocation mid-connection, service-worker/event-page wakeup, 16 tabs, and malicious/replayed payloads.
- **Q5 release:** Mozilla manifest lint, reproducible package with manifest at ZIP root, public privacy scan, signed XPI plan, installation/update on FDE, and regression acceptance against the pinned Chat Signals contract.

## 🔌 Independent scoped API client fixture

`tests/fde-api.cjs` boots headless Firefox Developer Edition with the production queue background/content logic and an independent temporary client add-on. A QA-only grant bootstrap is added to the temporary queue manifest; no production permission bypass, user profile, authenticated account, or real ChatGPT Send is used. It asserts `discover,append` capabilities, metadata-only listing, forbidden `status`/`start`/`remove`, a successful synthetic enqueue, successful event-port subscription, immediate subscription disconnection after QA-only grant revocation, and subsequent unauthorised requests. This exercises actual Firefox sender identity and `browser.storage.local` events. The independent add-on acceptance path passed in https://github.com/sguzman/chat-queue/actions/runs/40034372239. Full Options UX and authenticated ChatGPT remain unaccepted; independent Firefox tests now cover concurrent same-revision API edits, uninstallation, revoke-on-connection, and actual event-page idle wakeup.

## Dedicated QA launch

GitHub Actions also has an independent disposable `fde-smoke` job which installs and uninstalls the production add-on in headless Firefox Developer Edition. It copies only the manifest, `src`, and `options` to a temporary add-on directory. The separate static job produces a manifest-rooted unsigned ZIP artifact (`chat-queue-fde-qa-unsigned`, retained 14 days).

The synthetic tier uses a local HTTP fixture with production queue source, replacing **only** the test manifest's host match, the background with a no-send registration mock, and one closed Shadow DOM declaration with open mode so WebDriver can reach HUD controls. It checks addition, reorder, dark theme, reload persistence, and that a page-forged `finished` signal cannot authorize Send. This does **not** authenticate Chat Signals and does **not** demonstrate real ChatGPT submission.

A separate cross-extension fixture launches two temporary Firefox add-ons in an anonymous profile. The Chat Queue add-on uses production Signal parsing, scheduling and background messaging logic, with **only QA host scope, QA Gecko ID and inspectable Shadow DOM** substituted. A second synthetic extension uses the future Chat Signals Gecko ID and a test-only page-triggered event source to exercise actual Firefox `sender.id` authentication, epoch ordering and two-message sequencing on a fake composer. No real Chat Signals source code is modified or claimed to implement the contract; these messages are not evidence of live ChatGPT delivery.

CI evidence: [production installation and unsigned QA package](https://github.com/sguzman/chat-queue/actions/runs/40026885082), [synthetic HUD and fail-closed phase-only spoofing](https://github.com/sguzman/chat-queue/actions/runs/40027299592), and [two-addon Firefox synthetic provider and two-message ordering](https://github.com/sguzman/chat-queue/actions/runs/40027710529). All passed their stated scope. Provider-origin historical or out-of-order acceptance is separately covered by unit tests; the expanded actual-FDE negative historical/old-epoch transition gate also passed in [recovery regression CI](https://github.com/sguzman/chat-queue/actions/runs/40028020629).

`fish scripts/qa-firefox-developer.fish` opens Firefox Developer Edition with its own project-specific profile under `$XDG_DATA_HOME/chat-queue-fde-qa/profile`. It does not change the default browser profile, Firefox preferences, or ChatGPT account data in the normal browser. The script also does **not** automatically load or sign an extension. In the separate QA window use `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `manifest.json` from the repo root. Chat Signals must also be installed in the same QA profile for integrated observation tests.

Do not install the unsigned prototype into a personal browser for automatic sends until G2/G3 pass. A harmless manual HUD-only smoke can be considered low-risk but is not the acceptance test for the dispatch engine.

## Adversarial acceptance matrix

| Scenario | Required outcome | Current evidence |
| --- | --- | --- |
| Unknown/missing provider | No automatic Send | Node logic only |
| Restored/historical `finished` | No falsely attributed response | Synthetic two-addon Firefox acceptance; real Chat Signals publisher pending |
| Reply interrupted/failed/limited | Pause; no blind retry | Synthetic Firefox interruption/limit/recovery tests; authenticated live cases pending |
| Existing draft or attachment | Remains untouched | Native Firefox synthetic human drafts and selected file inputs passed in [run 40045489196](https://github.com/sguzman/chat-queue/actions/runs/40045489196); authenticated site pending |
| Navigation to another conversation | No misrouted send | Synthetic Firefox pushState/replaceState, route return and no-send passed in run 40034372239; authenticated live navigation pending |
| Two tabs same conversation | Deterministic ownership | Native synthetic Firefox lease passed in [run 40042415793](https://github.com/sguzman/chat-queue/actions/runs/40042415793); project URL alias and live identity acceptance separate |
| Same tab after browser restart | No automatic resumption | Native FDE event-page restart, full Firefox shutdown/relaunch, and active-response tab reload with the real Chat Signals publisher passed in [run 40213411741](https://github.com/sguzman/chat-queue/actions/runs/40213411741); authenticated ChatGPT/crash recovery still pending |
| Synthetic cross-extension caller denied | No queue contents disclosed | Node tests pass |
| Approved caller revocation | Immediate denial on new calls | Independent Firefox extension-client acceptance passed; no production-account test |
| Three themes and system preference | Legible HUD and preferences persist | Synthetic Firefox System/Light/Dark and persistence tests passed; authenticated site pending |
| User keyboard-only drag alternative | Reorder without mouse | Buttons implemented; FDE QA pending |
| Consecutive queued messages | Exactly once, ordered after matching response | Not live tested |

Mark a gate complete only with test output or reproducible authenticated FDE results. Preserve negative counterexamples when fixing live regressions. The user should not be treated as the project's automated test harness.

## 🔀 Navigation acceptance

`tests/fde-api.cjs` uses the real Firefox Developer Edition tab URL listener plus a bounded pathname-only watcher, then calls `history.pushState()` and `history.replaceState()` in a synthetic ChatGPT-shaped tab without a page reload. The background must drop old route authority; the HUD must show a fresh empty queue on a distinct route and restore the original queued message only after returning, remaining paused and never clicking Send. The unit suite also rejects old-route late registrations and wrong-route Signal epochs. This does not prove every live ChatGPT SPA transition variant.

## 🔁 Stale API mutation evidence

In synthetic FDE, a deliberate read/edit grant allows an approved extension to retrieve an opaque queue edit token, reject stale and replayed `update` operations, and accept only a current `ifMatch`. A separate History API roundtrip must rotate the token so a previous conversation snapshot cannot silently overwrite later edits. Omitted preconditions remain allowed for backwards-compatible API clients. A separate opt-in, monotonic per-caller `enqueueSequenced` operation has an atomic local-storage high-watermark with a same-tab reload test; legacy operations and authenticated ChatGPT QA remain separately unaccepted.

## 🌓 Keyboard, themes and guarded clearing

Actual headless Firefox Developer Edition verifies Up/Down keyboard Enter, collapse/expand keyboard Enter, distinct Light/Dark semantic tokens, System choice and dark preference retained across reload ([run 40034491399](https://github.com/sguzman/chat-queue/actions/runs/40034491399)). Individual Delete followed by two separate Clear confirmation clicks preserves the first-click queue, empties it on confirmation and never clicks Send ([run 40034686806](https://github.com/sguzman/chat-queue/actions/runs/40034686806)). These are synthetic browser behavior gates, **not** a screen-reader audit or authenticated sending acceptance.

## 🧠 Conditional sandbox acceptance

[Actual headless Firefox Developer Edition CI run 40036012429](https://github.com/sguzman/chat-queue/actions/runs/40036012429) serves the production options HTML, rule evaluator and sandbox script through a disposable localhost fixture with a harmless browser.storage stub. It verifies a typed pause proposal, replay suppression, historical/restored rejection, inert rendering of HTML-like text, and the absence of persisted rules after reload. There is **no account login, prompt queue API access or Send path** in the sandbox. Opening the real privileged Firefox options tab and implementing authorized rule execution are still unaccepted separate gates.

## 📦 In-flight queue editing acceptance

[Firefox Developer Edition run 40036243322](https://github.com/sguzman/chat-queue/actions/runs/40036243322) verifies the queue can add a new message during a synthetic response-generation epoch, reorder the two pending messages with the HUD, and dispatch them **A → C → B**, each only after a correctly attributed synthetic provider completion. This does not prove live ChatGPT editor behavior or an actual Chat Signals publisher.

## 🛡️ Interrupted preflight and explicit recovery

[Real headless Firefox Developer Edition CI run 40036722480](https://github.com/sguzman/chat-queue/actions/runs/40036722480) uses a **QA-only injected loss of the background Signal registry**, while the production queue code remains unchanged. The test verifies the blocked Send never fires, the prepared draft remains in the editor for user review, the queue item is uncertain and not restarted by a later ready Signal, and only deliberate clearing of that draft followed by **Retry** and **Start** permits one later Send. This is simulated event-page state loss, **not** a genuine Firefox background restart or authenticated ChatGPT acceptance.

The same CI suite verifies an armed **Confirm clear** action is cancelled by an unrelated page click; a later Clear click therefore starts a new two-step confirmation instead of deleting messages.

## 🔌 Scoped conditional-preview API

[Firefox Developer Edition CI 40037217649](https://github.com/sguzman/chat-queue/actions/runs/40037217649) installs a synthetic second extension, grants a `rules` permission independently from all queue read/send scopes, successfully previews a caller-supplied synthetic failure/pause rule, then revokes the `rules` scope and observes `forbidden-scope` on the same request. The receiver accepts only strict typed declarative input; no queue tab receives a preview or Send. Native Firefox [rule-library CRUD acceptance](https://github.com/sguzman/chat-queue/actions/runs/40118134016) now separately verifies per-extension persistent definitions, revision conflicts, rulesChanged event metadata and denial after rules scope removal. User activation and authenticated provider events remain separate gates.

## 🗂️ Persisted preview definitions

The `fde-rules.cjs` fixture uses a synthetic same-origin sessionStorage-backed stub for Firefox extension storage. It checks that rule definitions survive page reloads, remain inert without a simulation request, can be edited after reload, and require two clicks for destructive clearing. Production Options uses Firefox `browser.storage.local`, not the fixture's `sessionStorage`. Consequently this gate proves real Firefox UI behavior and storage-adapter mechanics, not privileged Firefox extension-storage persistence or conditional execution. Corrupt/future-version record rejection is covered by Node unit tests.

## 🎨 HUD placement persistence

The synthetic headless Firefox Developer Edition HUD suite now exercises keyboard header movement, a retained position and collapsed flag after reload, and a reset that restores the default corner without clearing queued messages. Pointer drag uses bounded pointer capture in the production content script; a real pointer-drag and high-zoom visual/layout acceptance remain separate unverified gates. No browser profile preferences are changed.

## 🐟 Isolated Fish launcher regression

A path-scoped GitHub Actions workflow tests `scripts/qa-firefox-developer.fish` with a fake `firefox-developer-edition` executable under disposable HOME and XDG_DATA_HOME. It checks profile permissions 0700, explicit isolated `--no-remote --profile` arguments, untouched personal-profile marker, and refusal to use symlinked QA directories. No real browser or existing user profile is opened in this test. See [launcher CI](https://github.com/sguzman/chat-queue/actions/runs/40042036909).

## 🧷 Same-conversation two-tab ownership regression

Headless Firefox Developer Edition with two separate QA add-ons opens two tabs to the same synthetic conversation. One tab dispatches and awaits an assistant response; the other tab must be denied before editor mutation, even when the first tab is manually paused. After a confirmed terminal event and separate deliberate Start, the second tab can dispatch once. This tests the volatile route lease, pause/awaiting distinction, and no-unintended-Send behavior; it does **not** validate the real Chat Signals publisher or authenticated ChatGPT. See [two-tab CI](https://github.com/sguzman/chat-queue/actions/runs/40042415793).

## 🤝 Pinned real Chat Signals coexistence QA

`tests/fde-coexist.cjs` installs the real pinned Chat Signals 0.3.13 source and production Chat Queue files into temporary Firefox Developer Edition add-ons, substituting only localhost-only QA origins and an inspectable Queue Shadow DOM. The test asserts the real provider publishes its legacy DOM phase, the queue HUD renders it explicitly as **unverified**, and neither a missing authenticated publisher nor a page-forged `finished` phase can click Send. This passes in [CI run 40042631264](https://github.com/sguzman/chat-queue/actions/runs/40042631264). The checkout is pinned to `102e3ea16a9e9535d377c1d4e8b564f5b0fdb721`. It does not verify actual `chatgpt.com` React compatibility, provider epoch publication, authenticated message submission, profile restart or 16-tab load. Those gates remain open.

## 🔌 Legacy provider removed during a queued message

The extended `tests/fde-coexist.cjs` test removes the real pinned Chat Signals add-on, reloads the synthetic ChatGPT-shaped page, verifies the queued message remains, injects a page-forged `finished` status, and asserts no Send. [Accepted run 40042829569](https://github.com/sguzman/chat-queue/actions/runs/40042829569). No real ChatGPT account or signed release profile is involved; interruption of the future authenticated provider remains a separate integration gate.

## 🖱️ Native pointer reordering in Firefox Developer Edition

The test uses actual WebDriver pointer gestures, not dispatched fake drag/drop events. Gecko did not emit HTML5 `dragover`/`drop` for the initial native sequence, so the production HUD now uses a captured-pointer handler with explicit before/after zones. Firefox QA verifies movement before the first item, insertion after the last item, keyboard reversal, and the saved order after reload. [Passing run 40043411053](https://github.com/sguzman/chat-queue/actions/runs/40043411053).

## 🎨 Visible footer and synthetic visual audit

A screenshot audit found the original Add/Clear/Start footer clipped by the panel boundary. The repaired flex layout independently scrolls messages and keeps primary actions visible on the desktop fixture, with constrained viewport handling. The Firefox test checks each action button's entire bounding box stays within the panel and captures synthetic light/dark screenshots with their corresponding theme selector choice. Both screenshots were inspected, and the full [Firefox run 40044138955](https://github.com/sguzman/chat-queue/actions/runs/40044138955) passed. The images contain hard-coded fixtures only; this does not validate the authenticated site or screen readers.

## 📦 Firefox local queue backup and retention acceptance

Headless Firefox Developer Edition tested real local file input into a synthetic ChatGPT HUD, required a second import confirmation, preserved pending/uncertain statuses, read actual downloaded JSON bytes, and verified two-click recent-history deletion after reload, with no Send. [Acceptance CI 40044676209](https://github.com/sguzman/chat-queue/actions/runs/40044676209). The common 16 MiB input/output cap, schema rejection, and regenerated roadmap are checked in [CI 40044824317](https://github.com/sguzman/chat-queue/actions/runs/40044824317). This is local file lifecycle acceptance, not live ChatGPT submission.

## 🔌 Wire-version and event privacy acceptance

A real Firefox Developer Edition addon-to-addon fixture confirms v1 capability negotiation advertises `protocolVersion:1` and the separate v2 permission policy, retaining the historic `version:2` key. It receives a `ready` event with a wire version. Background tests confirm `stateChanged` events include the same version but no prompt or history content, and unknown/unapproved clients remain denied. [Green run 40045093724](https://github.com/sguzman/chat-queue/actions/runs/40045093724). Real authenticated ChatGPT Send remains a separate acceptance gate.

## 🗂️ Exact-conversation orphan recovery acceptance

Native headless Firefox Developer Edition seeds a compatible v1 queue under a previous tab ID, opens the same route with a new tab, and requires separate **Find earlier queues** and **Recover for review** actions. The finder must not change the active queue; confirmation copies items as uncertain and never clicks Send. After reload, the restored items must persist without offering the same source again. Different routes and unsupported versions are separately excluded by unit tests. [Verified synthetic Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40045727469). Live authenticated restart/multi-tab checks remain pending.

## 🔍 Production security audit gate

The production-only `scripts/security-audit.mjs` is part of `npm run check`: storage-only manifest permissions, exact ChatGPT scope, no broad hosts, no remote assets, no dynamic JS, and no runtime network APIs. Four tests create disposable modified copies to verify that the gate rejects violations; they never modify real Firefox profiles. Static-and-unit CI checks the audit and its adversarial fixtures; consult the latest workflow for the exact test count. This does not replace a manual source, supply-chain, browser-privacy and authenticated delivery audit. See [static audit contract](SECURITY-AUDIT.md).

## 💾 Failed and delayed local queue writes

A QA-only content-script substitution makes `browser.storage.local.set` reject or complete after a deliberate delay. The real Firefox Developer Edition HUD must reject Start with `storage-unavailable` after a failed write and `queue-save-pending` before a delayed write finishes. Once another save commits, the queue remains paused and still requires authenticated Signal authority and a separate Start action. A reload must preserve the successfully saved items without a Send. [Accepted browser regression](https://github.com/sguzman/chat-queue/actions/runs/40046386978). This does not simulate power loss, genuine Firefox quota exhaustion or a live ChatGPT editor.

## 🧭 Sixteen-tab Firefox workload

The disposable Firefox Developer Edition cross-tab regression now opens **16 independent ChatGPT-shaped conversation routes**, checks exact-route queue isolation, and revisits a previously hidden tab after additional queues are created. It verifies shared Light/Dark preference and zero Send clicks. [Firefox workload run](https://github.com/sguzman/chat-queue/actions/runs/40046956628).

This is bounded synthetic browser QA, not authenticated ChatGPT, a realistic large transcript, long-idle power profiling, whole-browser crash/relaunch or full multi-tab performance acceptance. The corresponding M7-05 milestone remains `implemented` rather than verified.

## 📦 One-use backup import concurrency acceptance

Disposable Firefox Developer Edition now runs three additional native UI scenarios: (1) select a two-message JSON backup, delay the local queue storage write, and double-click **Confirm import** in the same browser task; only two messages may exist after reload, with Add/Start temporarily locked; (2) preview the same backup, change the queue, then confirm: the stale revision must reject without appending; (3) inject a rejected storage write, confirm once, verify in-memory rollback and no Send, then reload to find no imported messages. [Passed Firefox CI](https://github.com/sguzman/chat-queue/actions/runs/40126117606).

The implementation makes confirmation one-use, binds the preview to an exact key, route generation and revision, and rejects mutation during the storage commit. Firefox also verifies that an editor already open before the import has its Save control locked during the write, without losing the original draft or sending a message ([passing run](https://github.com/sguzman/chat-queue/actions/runs/40126681399)). Backup Export is blocked during pending or rejected queue writes to avoid downloading an unsaved in-memory state ([passing run](https://github.com/sguzman/chat-queue/actions/runs/40126501147)). This is synthetic Firefox storage fault injection, not a claim that `storage.local` supplies atomic cross-tab compare-and-swap or that a real browser power loss has been simulated.

## 🔐 Closed-shadow page script privacy regression

A dedicated native Firefox Developer Edition test installs an unmodified **closed** ShadowRoot HUD (changing only the synthetic localhost match scope and mock registration background). A QA-only pending message is seeded in extension-local storage; page scripts cannot read its text through `body.innerText`, `outerHTML`, the host's `shadowRoot`, or page-realm `ChatQueueCore`/`ChatQueueSignal`. Reload preserves non-disclosure and makes no Send. [Accepted CI run](https://github.com/sguzman/chat-queue/actions/runs/40051837389). This is not a confidentiality guarantee against privileged extensions, side channels or the real authenticated site.

## 📎 Multiple native file-input collision

The authenticated synthetic Signal fixture now includes an empty first composer file input and a second, genuinely selected Firefox file input. Start must reject the attachment without mutating it, even though the first input is empty. The production adapter checks **all** file inputs at both initial handoff and final pre-Send validation. It still needs authenticated-site testing for uploaded attachment chips which may no longer have a populated file input. [Browser regression](../tests/fde-signal.cjs).

## 🧭 Navigation during final Send authorization

A disposable Firefox Developer Edition two-addon regression delays the second authenticated dispatch preflight, inserts a synthetically queued message, and calls `history.pushState()` to select another conversation before authorization returns. The new route must show no carried queue and must make no Send; returning to the original route must expose the message as **uncertain**, never automatically pending. [Accepted native Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40052236598). This is a synthetic History API race, not a live authenticated ChatGPT site or automatic retry approval.

## ✍️ Whitespace and exact composer preservation

The production adapter rejects whitespace-only human drafts as occupied and compares the queued text to the composer without trimming leading or trailing whitespace. Only browser newline/NBSP normalization is tolerated; other differences stop the attempt. The synthetic Firefox test explicitly preserves a whitespace-only draft before dispatch and separately checks user edits during delayed authorization. There is no live ProseMirror acceptance yet.

## 🔢 Sequenced API replay after Firefox tab reload

The independent synthetic Firefox API client uses a browser-attested caller ID with the `append` scope, enqueues sequence 1, rejects replay of sequence 1 and invalid 0, reloads the queue tab, and verifies sequence 1 remains rejected while sequence 2 appends exactly once. No automatic Send or authenticated ChatGPT connection is involved. Source acceptance: [Firefox API fixture](../tests/fde-api.cjs). Client high-watermarks live in each exact queue record and are bounded to 32 distinct principals; deleting the record removes that history.

## ♻️ Genuine Firefox MV3 event-page suspension

The [event-page lifecycle fixture](../tests/fde-event-page.cjs) installs production Queue background/content scripts in a disposable localhost-scoped add-on, accelerates the Firefox event-page idle preference and Queue's metadata-only heartbeat **only for QA**, and increments a browser-local marker every time the real background script loads. Firefox recreated the event page (boot counter **2 → 3**), after which the HUD detected lost in-memory registration, re-registered the same route and preserved a queued message without Send. [All jobs green](https://github.com/sguzman/chat-queue/actions/runs/40058326692). This is not a fake `route-mismatch` response; it is a real nonpersistent background lifecycle. It still does not prove whole-browser power loss, full session restore, privileged page crash or authenticated ChatGPT sending.

## 🧪 Adversarial peer API acceptance

Independent Firefox API-client QA concurrently submits two edits under the same optimistic revision, observing exactly one success and one `revision-conflict`; grant removal disconnects subscriptions, and uninstalling the client cannot erase queued messages or click Send. [Accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40057945052). Node's 128-frame deterministic malformed corpus and cyclic/oversize tests fail closed without private-text echoes. [77/77 static test run](https://github.com/sguzman/chat-queue/actions/runs/40057980573). This is synthetic context, not an authorized live ChatGPT end-to-end test.

## 🧱 Persisted-record corruption and read-only recovery

A native disposable Firefox Developer Edition fixture seeds a supported v1 queue with duplicate message IDs and another with invalid history metadata. The HUD must show the record as unsupported/read-only, reject Add and other saves, and remain unsupported after reload; the fixture only seeds a record if no key already exists, so an accidental overwrite causes the test to fail. [Accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40120282049). Pure tests also cover oversized queues, invalid text, duplicate previous-tab recovery markers and unknown item statuses restored as uncertain. An explicitly stored `null` value is additionally treated as damaged data; only a missing storage key represents a new empty queue. None of these guards migrates tab-scoped queues into a stable cross-restart conversation key, and that acceptance remains open.

A separate native Firefox extension API fixture injects asynchronous state publications in reverse completion order. The old paused state must return `stale-state`, and the newer running/awaiting state remains visible. The matching unit regression confirms the old update cannot release a conversation's dispatch lease. [Accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40120121249). Internal publication sequence numbers are volatile and never authorize a Send.

## 🧩 Same-route registration and editor replacement races

A production-background Firefox QA fixture delays a tab-state update while the **same exact route** re-registers in the event page. Its old asynchronous callback must return `stale-state`, and the newly registered tab must remain discoverable; [accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40120917438). A unit regression additionally acquires a fresh owner lease and verifies that the delayed prior-generation pause cannot release it. The volatile generation is local to the event page, carries no prompt text, and is not an authenticated Chat Signals epoch.

A separate two-extension Firefox fixture hides the original prepared composer, inserts a different visible editor, and delays final provider authorization. Chat Queue verifies **editor identity**, not merely that one visible editor exists, and refuses Send while retaining the journaled item uncertain. [Accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40120663993). Live authenticated ChatGPT DOM re-render behavior remains a separate unaccepted gate.

## 🧭 Provisional assigned-conversation dispatch gate

The production Start handler and Firefox background `dispatch-check` independently call the same `ChatQueueSignal.assignedConversationRoute()` pure validator. It currently admits `/c/<id>` and `/g/<group>/c/<id>`, and denies ChatGPT home/new-chat, shared/scheduled links, search, GPT landing and trailing/noncanonical paths. [Pure cases](../tests/signal.test.js), [background authority tests](../tests/background.test.js) and [native synthetic Firefox controls](../tests/fde-synthetic.cjs) cover that fail-closed behavior. Even an assigned-looking URL still requires authenticated, fresh provider evidence, exact browser-owned tab route and a deliberate Start. These are **synthetic URL-shape gates**; actual ChatGPT route coverage (including projects) remains a separately open acceptance criterion.

## 🔁 Recheck source before manual previous-tab recovery

The native disposable Firefox fixture stages a compatible old-tab queue, then changes that **source** to an unsupported future-version record between Find and Confirm. Confirmation must reject the stale snapshot, keep the active queue empty, hide the pending confirmation and never Send. After reload, the upgraded source remains unsupported and undiscoverable. A separate rapid double-confirm test copies a source only once and keeps all imported items uncertain. [Accepted native Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40124471023). This is re-read-before-copy protection, **not** an atomic storage transaction against a source write occurring immediately after the recheck.

## 🧷 Cross-route conversation-ID ownership collision

The Firefox two-addon provider fixture opens an ordinary `/c/<id>` tab and a `/g/<group>/c/<id>` tab sharing the same assigned conversation-ID segment. The first owns an in-flight response; Start in the alternate route must be denied without changing its composer or queue. A terminal response releases the lease and a separately authorized Start in the second route sends exactly once. [Accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40124851739). The owner key is conservatively shared; exact pathname/epoch authentication is **not** relaxed, and actual ChatGPT project URLs remain unverified.

## 🔄 Full browser shutdown/relaunch (synthetic)

`tests/fde-browser-restart.cjs` runs the production queue scripts in a disposable Firefox Developer Edition profile, shuts the entire Firefox process down, relaunches that same isolated profile and reinstalls its temporary QA add-on. The test requires a previously persisted queue to remain paused and never click synthetic Send. It then deliberately opens a second Firefox tab after relaunch to exercise a distinct tab ID, requiring explicit previous-tab discovery and confirmation; every copied item must become uncertain without removing the source. If Firefox assigns a different tab ID even for the first reopened tab, that recovery path is checked first. If Firefox reuses the same tab ID, persisted items remain paused. The full two-process and forced-distinct-tab regression passed in [Firefox Developer Edition run 40129991817](https://github.com/sguzman/chat-queue/actions/runs/40129991817). It is Q1/Q5 synthetic-site evidence; authenticated ChatGPT recovery and true crash recovery remain separate acceptance gates.

## 🛑 M4-11 — No silent resumption across Firefox lifecycle

Verified within the defined Q1/Q2 synthetic-browser scope by [full green Firefox workflow 40213411741](https://github.com/sguzman/chat-queue/actions/runs/40213411741). The *actual pinned Chat Signals publisher* and Chat Queue ran together in a disposable Firefox Developer Edition profile: Queue sent the first of two synthetic messages and received the current response's authenticated generating phase. Reloading the Firefox tab before completion retained the second prompt but reset the volatile Start grant; it stayed **paused** and caused **zero additional Send clicks**. A real event-page idle/recreation test also denied reused Signal authorization, while complete Firefox process shutdown/relaunch required explicit recovery (and marked copied prompts uncertain) without automatic dispatch.

This verifies the restart fail-closed contract for M4-11, **not** authenticated chatgpt.com, power-loss crash recovery, or the distinct real-site Send/completion and adversarial race gates in M4-06, M4-12 and M7-04.

## ⚡ Rapid authenticated response completion

A native two-extension synthetic FDE fixture tests `generating` followed by matching `finished` *before* the next Send-confirmation poll. The content script retains the first browser-authenticated new busy epoch for its journaled attempt; only a cleared composer and completion of that exact epoch can advance to a second queued item. This route widens the test's polling interval and deliberately retains the synthetic draft until *after both authenticated events are acknowledged*, then clears it to simulate a delayed React update. The test deterministically rejects premature acceptance and verifies the captured busy epoch survives its terminal transition. The real Chat Signals publisher and authenticated ChatGPT remain unverified.

## 🔏 Rejected sequenced enqueue writes

The independent-client Firefox Developer Edition API fixture now rejects one actual content-script `storage.local.set` through a **QA-only** fault. The operation must return `queue-save-failed`, restore the in-memory item list and caller-specific sequence watermark, allow the exact same caller request to persist on a later deliberate retry, reject subsequent duplicates, and never trigger Send. This is bounded storage-fault acceptance, not proof of atomicity across independent Firefox tabs or profile-level power loss.

## ✍️ Draft preservation during an in-flight Add

The synthetic Firefox fixture delays the first actual extension-storage queue write, types a second draft while that Add is pending, and verifies the earlier completion never clears the newer draft. The second message is then added and both persist after reload without Send. This fixes an actual asynchronous HUD correctness race surfaced by repeated two-message rapid-terminal Firefox QA. The rapid-terminal fixture also waits for each durable Add before starting; a UI count alone is not treated as authenticated submission evidence.

## 🪶 Signal-only HUD rendering and editor focus

The native Firefox synthetic HUD fixture verifies that changing a legacy **unverified** page Signal phase updates the status label without replacing the focused queued-message editor, losing its unsaved text, or blurring it. It also checks that a collapsed HUD does not reconstruct hidden queue rows on Signal-only status changes. The production render path now rebuilds item/history rows only when the queue revision or row-control state changes, and preserves an active editor's value and selection if rebuilding is necessary. These are targeted DOM-work and focus-preservation regressions, **not** CPU, memory, or authenticated-ChatGPT performance certification.

## 🧯 Repainting rollback after rejected history deletion

The synthetic native Firefox QA fixture now injects a `storage.local.set` rejection into confirmed history deletion, verifies the in-memory history is restored **and visibly repainted without reload**, then verifies that history still exists after reload. The optimized queue-row rendering cache includes collection identity and length in addition to revision, so a failed write's rollback cannot leave a stale cleared-history display. The synthetic test never sends a message and does not imply authenticated-site acceptance.

## 🧪 One-hundred-message Firefox UI workload

An isolated real Firefox Developer Edition fixture preloads **100 bounded synthetic queued messages** (800-character body each), then applies 80 legacy unverified Signal phase changes in the same document. A MutationObserver asserts zero queue-row added/removed DOM nodes during the status-only workload, with unchanged row identity and zero Send attempts. CI prints elapsed milliseconds as a bounded observational metric, **not** a general CPU, memory, power or authenticated-chat performance certification. This exercise guards the optimized renderer against reintroducing O(queue-size) DOM reconstruction for unrelated status events.

## 🖱️ Duplicate Add click prevention

The native Firefox synthetic fixture double-clicks **Add** during a delayed durable queue write, verifies only one prompt is queued, and checks the control locks synchronously until the write finishes. It then types and queues a distinct second prompt; both persist without duplicate entries after reload, while the newer draft survives the first completion. This is a HUD click-level safety property; external API clients have separate sequenced-idempotency controls.

## 🧷 Rejected ordinary Add and retry

The disposable Firefox HUD fault-injection fixture rejects the first `storage.local.set` for a normal **Add**, checks that the failed message is absent from the in-memory queue while its draft remains available, then allows an explicitly repeated Add to commit exactly once. It reloads Firefox and checks that the single message persists with zero Send clicks. Ordinary enqueues now refuse overlapping unsaved writes and use revision-scoped rollback on a rejected write. This is not a claim of cross-tab storage transactions or automatic retry; the user must deliberately initiate the second Add.

## 🔒 Volatile HUD draft conversation isolation

The disposable Firefox Developer Edition fixture types distinct **unsubmitted** HUD drafts on two synthetic conversation routes, navigates A → B → A → B using `history.pushState`, and verifies neither route displays the other route's draft. Returning to an already visited route restores only that route's same-tab volatile draft, without syncing or writing it to extension queue storage. Committing B's draft leaves A's queue empty and A's draft intact; all Send counters remain zero. The in-memory draft map is bounded to 32 routes and must not be confused with durable queued-message recovery.

## 🔁 Atomic Firefox API edits under rejected storage writes

The external-client disposable Firefox Developer Edition fixture rejects an actual queue `storage.local.set` during an `update` with optimistic `ifMatch`, then requires both the **in-memory prompt text and order** to match the prior status exactly, with a rotated revision token. Only a **new**, explicitly issued update using the fresh revision may commit afterward. The Queue's bounded `update`, `move`, `reorder`, `remove`, `clear` and explicit uncertain-item resolution now share one revision-scoped durable mutation/rollback path and decline overlapping pending saves. Native acceptance is bounded to the tested scenarios, not a cross-tab transactional guarantee.

## 🛟 HUD mutation rollback after storage rejection

The production HUD's local **Edit**, **Delete**, arrow-keyboard reorder, and pointer reorder operations now use the same revision-scoped durable mutation helper as the external API. They refuse overlapping queued writes and restore the exact prior item values and ordering if `storage.local.set` fails. A disposable native Firefox regression injects failure separately into local Edit, Delete, and Reorder, checks the immediately restored HUD and then reloads the tab to verify stored state was not modified. The user's actual profile is not involved; this does not imply transactional writes across independent tabs or a live ChatGPT send test.

## 🔐 Authenticated, opt-in conditional proposal review

A synthetic independent Firefox provider exercises the new HUD **Conditional proposals** setting. Native FDE must show no action on page-forged phases or before opt-in, then display one manually reviewable offer on a fresh authenticated v1 terminal event. Only a separate Approve click may enqueue bounded text, and the scheduler must remain paused with **zero Send clicks**. SPA navigation and reload remove preview consent and any offer without losing already queued items. This establishes only synthetic Firefox integration, not a live Chat Signals publisher or authenticated ChatGPT behavior.

## ⏸️ Conditional proposal preempts the next Send

A second independent-provider native Firefox scenario starts an explicitly authorized synthetic two-message queue, observes Send for the first message and its authenticated generating→finished epoch, then enables a matching finished-rule review boundary. The proposed rule must synchronously pause the Queue and cancel its pending 350-ms next dispatch; after a full 1-second interval the second Send count must remain zero. Manual approval may enqueue additional proposed text but cannot resume Send, and the paused queue remains persistent after a full tab refresh. The test exercises an isolated synthetic provider; the real Chat Signals publisher remains missing.

## 🪶 Skip unrelated cross-tab storage redraws

A disposable Firefox Developer Edition two-tab test observes the second tab's Queue HUD status node while the first tab appends and removes a private queued prompt. Those storage writes must not mutate the second tab's status subtree at all; theme and shared HUD placement changes still trigger local rendering. This avoids proportional cross-tab HUD churn for queue-only local storage changes, including the existing 16-tab workload. It is a measured DOM-work correctness/performance regression, not CPU, memory, battery or authenticated-chat certification.

## 🛑 Pending conditional approval blocks explicit Start

A native two-extension Firefox QA scenario attempts HUD **Start** after an authenticated finished-phase proposal has paused a two-message queue. The command must return `review-conditional-proposal`, keep the offer visible, leave the second message unsent, and require an independent Approve or Dismiss action before the user may start again. The same `act('start')` authorization gate serves permissioned external clients; an isolated browser fixture verifies the HUD invocation, not a real Chat Signals publisher or live ChatGPT send.

## 🔄 Native Firefox rule-policy race

A disposable two-extension Firefox Developer Edition fixture delays the Queue's opt-in rule read only on one QA pathname. A separate temporary content-script helper changes the Queue's own synthetic `storage.local` rule definitions while the read is pending. After the obsolete read settles, the HUD must remain disabled, keep Approve hidden and reject a fresh authenticated terminal event as a rule offer. The helper and delay substitution are QA-only and absent from the production extension. This does not validate the real Chat Signals publisher or genuine ChatGPT execution.

## 🧪 Superseded conditional proposal

A disposable Firefox two-extension fixture publishes a fresh authenticated finished-phase event and verifies that its matching proposal is visible. The synthetic provider then advances to a new generating response epoch. The old offer must expire, stay expired when its old Approve control is invoked programmatically, and leave the queue empty with zero Send clicks. A later independently authenticated fresh finish may show a new reviewable offer that can be dismissed. This uses the synthetic v1 publisher rather than the unimplemented real publisher.

## ⚠️ Explicit uncertain-item resolution

A disposable Firefox Developer Edition QA scenario recovers an old tab's message as `uncertain`, verifies Edit and generic Delete are disabled and the separate Retry/Discard decisions remain accessible. It tries the normal two-step bulk Clear, which must return `resolve-uncertain-message` and retain the original uncertain text. Only an explicit Discard removes the item, with persistence after refresh and zero Send clicks. This is synthetic safety acceptance, not live delivery confirmation.

## 🦊 Independent Firefox API uncertain-item guard

A separate granted Firefox extension exercises a QA-only seeded, versioned queue record containing one `uncertain` item. External `update`, `remove` and `clear` all must reject with `resolve-uncertain-message` while preserving the original items exactly. Only a deliberate `resolve(discard)` may remove it; switching back to the prior conversation must recover its unrelated existing queue without Send. This tests the actual extension-to-extension API under Firefox rather than only disabled HUD controls.

## 🦊 Editing during uncertain Send transition

A native Firefox Developer Edition two-extension regression opens Edit on a pending message, starts an authenticated synthetic dispatch, and deliberately loses provider authorization during the pre-Send check. Once the message becomes uncertain, its stale edit textarea must close, the regular Edit button must be disabled, and the original text must remain available for explicit resolution. The editor Save action also routes through the guarded pending-only `update` action rather than a lower-level mutation. No synthetic Send click is accepted in the failed preflight case; real ChatGPT confirmation remains unverified.

## 🧪 Authenticated terminal-error policy review

A native Firefox Developer Edition two-extension scenario replaces the QA-only declarative rule library with a synthetic explicit pause rule for `failed`, `interrupted`, and `limit` in turn. Each phase is checked under a restored provider event (no action), a fresh authenticated event (manual approval offer but no Send), and a repeated fresh same-epoch event (no duplicate offer after approval). Each configuration change invalidates existing preview consent and requires an explicit new Enable action. Browser clicks must never Send queued prompts. The test does not claim the real Chat Signals publisher is complete.


## 🦊 Volatile conditional review audit and navigation race

The disposable headless Firefox two-extension test checks that a genuine synthetic authenticated offer adds only metadata to the collapsed HUD Review history; no proposed message content, route or document token appears. After explicit approval it shows a separate approved record. SPA navigation wipes that history. A superseding provider epoch produces an expired record, and the failure/interruption/limit policy tests yield only bounded offered/approved records. A separate QA-only delayed queue storage write allows navigation between clicking Approve and its completion; the new chat must remain free of the old offer's rule ID/status, while the original queued item remains durable in its original route. This does not test the real Chat Signals publisher.

### Bounded review history under repeated authenticated signals

The native two-extension Firefox QA emits eight additional distinct response-epoch limit outcomes after the initial six review records. Each requires a separate manual Dismiss, and the closed-shadow audit must retain exactly the latest 20 fixed-schema entries, drop the two oldest, and contain no route, token or synthetic proposed message text. No Send may occur during this workload. This verifies the in-memory bound without claiming live ChatGPT provider acceptance.


## 🦊 Live-path dependency and skip-rule regression

A disposable Firefox Developer Edition two-extension fixture saves three linked synthetic declarative rules: a `failed` phase pause prerequisite, a `finished` proposal requiring that prerequisite, and a `finished` pause skipped if the prerequisite has been approved. A fresh authenticated finished event initially offers the ungated skip candidate. Dismissing it does not fulfill a prerequisite. A fresh authenticated failed event then offers the prerequisite; only explicit approval marks it completed. A newer fresh finished event now offers the dependent proposal, while suppressing the skipped rule; manual approval appends exactly one paused item and Send remains untouched. Disabling and re-enabling previews clears approval history: the skipped candidate becomes eligible again. This is synthetic authenticated Firefox execution of **manual proposals only**, not live ChatGPT delivery or autonomous conditional recovery.

## 🦊 Concurrent conditional opt-in invalidation

A two-extension Firefox Developer Edition fixture deliberately delays the first rule-library read, mutates the stored policy, and immediately issues a second explicit Enable for the new policy while the first read is still pending. The original read's eventual rejection and finalization must not revoke the new opt-in or generate an obsolete proposal. A fresh authenticated phase matching the new policy may then show a manual proposal, which remains inert until dismissal or approval; no Send occurs. The fixture uses a disposable localhost browser and a QA-only storage mutation helper.

## 🦊 Authenticated monotonic rule-duration regression

A disposable two-extension Firefox Developer Edition test installs synthetic `finished` rules: a high-priority rule requiring at least 250 ms of observed busy activity, and an untimed fallback. A terminal event without prior fresh busy evidence must choose the fallback. A fresh same-document, same-epoch generating event followed by over 250 ms and a fresh finish may choose the timed rule. Repeating that finish cannot create a second proposal. A restored finish invalidates the busy clock; the next fresh finish in the same epoch must use the untimed fallback. All actions remain explicit review offers with zero Send clicks. This test is not proof of the real Chat Signals publisher.

## 🦊 Durable prerequisite failure and exact retry

A disposable Firefox Developer Edition two-extension fixture uses a QA-only one-shot rejection of the actual local queue write while approving a synthetic `propose` prerequisite. The failed write must leave zero queued items and must **not** mark the rule ID approved. A later authenticated finish must still offer the rule that skips only after successful approval, not the dependent rule. After removing the QA rejection and explicitly approving a fresh prerequisite offer, only a successful saved append enables the dependent rule. The independent user Start remains absent throughout, and there are zero Send clicks. This is synthetic publisher evidence, not real ChatGPT execution.

## 🦊 Terminal duration freezes on first completion

A native Firefox synthetic publisher regression installs a single conditional finished-phase rule requiring at least 3 seconds of observed busy time. It publishes a fresh busy and an immediate fresh finish; there must be no proposal. After more than 3 seconds have elapsed since that finish, a repeated fresh finish in the same provider document/epoch must **still** have no proposal, because the duration was frozen at the first terminal event. It must create no audit outcome and click no Send. This prevents a delayed/repeated provider notification from retroactively creating timed actions.

## 🦊 Initial-load conversation isolation under delayed Firefox storage

A disposable Firefox Developer Edition synthetic HUD fixture seeds a queue on conversation A, deliberately delays the content script's **first** `storage.local.get`, then changes to conversation B with `history.pushState` before that read completes. When the old snapshot arrives, the HUD must remain hidden while B loads, and neither its Shadow DOM nor its rendered rows may contain A's private message. B opens empty; returning to A restores the stored prompt with no Send. This prevents a boot-time disclosure across routes, not merely a post-initialization navigation issue. [Full Firefox CI passed](https://github.com/sguzman/chat-queue/actions/runs/40148570623).

## 🦊 Initial provider registration races with a route change

The same disposable browser fixture delays and rejects the first background registration for conversation A after the page navigates to B. The content script must retry against B's current pathname instead of permanently failing to mount, without retrying a genuine same-route registration error. Retries are bounded to four attempts, and no Send occurs. The fixture uses a QA-only registration response; the production route validation and the real Chat Signals publisher still require authenticated acceptance. [Full Firefox CI passed](https://github.com/sguzman/chat-queue/actions/runs/40148637766).

## 🧾 History deletion cannot overlap an uncommitted queue Add

The disposable Firefox Developer Edition fixture seeds one historical submission, starts an Add whose extension-local storage write rejects after a delay, and clicks **Forget history** twice while that write is pending. History deletion must remain unarmed and unexecuted, the rejected Add must roll back to zero queued items, and the original historical record must remain after a full reload. The test verifies zero Send attempts. Both static and Firefox browser jobs passed [run 40149040013](https://github.com/sguzman/chat-queue/actions/runs/40149040013). This is a synthetic storage-failure/concurrency check, not evidence of authenticated ChatGPT delivery.

## 🦊 Restored terminal cannot reopen duration evidence

The disposable Firefox Developer Edition two-extension fixture uses browser-authenticated synthetic Chat Signals events to test two duration boundaries. First, a response that reaches a fresh terminal phase before the minimum threshold cannot be made eligible by reopening busy on that **same** response epoch, even after several more seconds pass. A genuinely newer busy-to-terminal epoch remains eligible if its own monotonic duration passes the threshold. [Full CI run 40149476705](https://github.com/sguzman/chat-queue/actions/runs/40149476705) passed both jobs.

Second, a historically **restored** terminal response closes its epoch for timing purposes, even though the restored event itself cannot trigger a proposal. An attempted fresh busy-to-terminal sequence on that closed epoch must match only the untimed fallback rather than manufacturing a duration-qualified review. [Full CI run 40149693215](https://github.com/sguzman/chat-queue/actions/runs/40149693215) passed both jobs. Both fixtures require manual review, click no Send, and do not claim that the real Chat Signals publisher exists.

## 🧾 Immutable history snapshots and failed-write compare tokens

Queue persistence now copies fixed-schema history entries when a write is scheduled; later status changes cannot rewrite an earlier queued snapshot by mutating a shared object. Pure Node regression coverage and the full Firefox Developer Edition workflow passed in [run 40153216969](https://github.com/sguzman/chat-queue/actions/runs/40153216969).

The backup-import, previous-tab-recovery and Forget-history paths also rotate optimistic revision tokens after restoring in-memory state from a rejected storage write. Disposable Firefox injects real extension-local write failures in each path and verifies that a speculative write's token is no longer advertised, the saved source remains intact and no Send occurs. [Full CI run 40153465854](https://github.com/sguzman/chat-queue/actions/runs/40153465854) passed. These checks do not establish cross-tab atomic storage transactions.

## 👆 Human edits after Send and stale ready-signal timers

A disposable Firefox two-extension fixture initiates exactly one queued Send click, then uses actual WebDriver keyboard input to edit and undo changes to the same contenteditable **before** a synthetic authenticated busy/completion epoch arrives. The Queue now treats any browser-trusted input during submission confirmation as an ambiguous attempt and leaves the message uncertain; it never sends the next queued item. [Full browser CI 40153888908](https://github.com/sguzman/chat-queue/actions/runs/40153888908) passed. This is synthetic provider evidence, not authenticated ChatGPT acceptance.

The same browser run shortens provider freshness only in a QA pathname and deliberately delays the next scheduled dispatch past that expiration. The Queue must pause instead of remaining Running, and a later fresh terminal event must not silently revive the old Start authorization. This tests timer throttling and reconnect safety without asserting actual 15-second browser timing or a real publisher.

## 📎 Attachment selected after the Queue clicks Send

A disposable Firefox Developer Edition two-extension scenario performs the Queue's single synthetic Send click and then selects a real local file in the composer while submission confirmation is pending. The Queue now observes trusted file-picker changes through the composer form **and** checks for selected file inputs during confirmation polling. Either conflict must make the attempted item uncertain, preserve the human-selected file and refrain from any subsequent queued Send. The same browser suite retains the earlier pre-click late-file guard, trusted keyboard-edit guard, and stale-provider timer pause. Both jobs passed [full CI run 40154290822](https://github.com/sguzman/chat-queue/actions/runs/40154290822). This proves synthetic Firefox mechanics, not authenticated ChatGPT delivery.

## 🦊 Real Chat Signals publisher transport — first native acceptance

The separate `tests/fde-real-publisher.cjs` fixture checks out a pinned, real Chat Signals source (not the synthetic QA provider), loads **both genuine extension backgrounds** into a disposable Firefox Developer Edition profile, and substitutes only a localhost synthetic ChatGPT-like origin/inspectable HUD for QA. The provider's own evidence tracker emits an authenticated idle, busy, and completion response epoch; Queue sends exactly two harmless synthetic messages in order. Removing the provider and reloading prohibits a page-forged finished phase from authorizing Send. The full CI suite and both jobs [passed in run 40155539014](https://github.com/sguzman/chat-queue/actions/runs/40155539014). The established pinned v0.3.13 legacy coexistence fixture also passed in that run. The actual ChatGPT site, external network conditions, project routing and long-lived account sessions remain unverified.

## 🔒 Genuine restored-epoch Firefox safety acceptance

In [both passing CI jobs of run 40197044421](https://github.com/sguzman/chat-queue/actions/runs/40197044421), a disposable Firefox Developer Edition profile installs the actual pinned Chat Signals publisher and Chat Queue. The synthetic page creates a response, Chat Signals observes its generation and terminal controls and persists the final state through its **own unmodified state ledger**. The test reloads the same browser tab to exercise real restoration; Queue sees the historical terminal but **refuses to dispatch**, despite a queued item and a manual Start. Only after a new, genuinely observed response epoch does the queue permit one manually started, guarded submission. No provider ledger is seeded or fabricated for this acceptance. This proves local extension lifecycle mechanics, **not authenticated production ChatGPT reliability**.

## 🧭 Real-provider scoped SPA route and project isolation

[Both jobs passed in CI run 40197623501](https://github.com/sguzman/chat-queue/actions/runs/40197623501). A disposable Firefox Developer Edition tab has the actual separately installed Chat Signals source publisher plus Chat Queue. After storing an unsubmitted message in a normal conversation, the fixture clicks a synthetic project link and applies History API `pushState` **within the same document**. Queue and Signals independently rescope to the new project conversation; the old prompt is neither displayed nor sent. The project queue can send one synthetic prompt after an explicit Start and attributable response evidence. A later return to the original conversation restores its own pending message without sending it. Route and source attestation are from the browser-owned extension channels, not page-root phase attributes. This verifies synthetic-site route isolation; live authenticated ChatGPT navigation and React variability remain separate acceptance gates.

## 🧪 Three exact response epochs despite stale Copy controls

[Both jobs passed in Firefox run 40198224114](https://github.com/sguzman/chat-queue/actions/runs/40198224114). The genuine separately installed Chat Signals publisher and Chat Queue execute three harmless queued prompts in a disposable Firefox Developer Edition tab. Before each synthetic terminal completion, the test holds generation and verifies **no later queued Send occurs**. Previous assistant turns retain their Copy controls while newer response epochs are generating; those stale controls cannot satisfy the current epoch's terminal evidence. Exactly three Send clicks occur, each following distinct fresh completion evidence. This proves browser extension protocol mechanics on a synthetic page, not authenticated ChatGPT production behavior.

## 🛑 Stop, Pause and explicit-restart Firefox acceptance

[Run 40198735817](https://github.com/sguzman/chat-queue/actions/runs/40198735817) validates manual Pause **after confirmed submission**: completing the active response cannot Send another queued item, but a subsequent deliberate Start advances it once. [Run 40199823775](https://github.com/sguzman/chat-queue/actions/runs/40199823775) verifies real browser-trusted Stop in the actual two-addon Firefox configuration: the same-epoch, authenticated cancellation marks the clicked message as interrupted in history, closes its awaiting response, pauses the Queue, permits a distinct explicit Start for the next pending item and never replays after reload. Both runs passed their complete static and Firefox jobs. Stopping *before* submission confirmation remains uncertain and requires manual review, not blind retry.

## 🔌 Authenticated negative response and unknown-phase safety

In [real-provider run 40200031422](https://github.com/sguzman/chat-queue/actions/runs/40200031422), the independently installed Chat Signals publisher classified three visible synthetic status conditions (input stream error, connection interrupted, and conversation-length limit). For each, the Queue paused its active response, kept the next message pending, did not retry the already-clicked message, and did not replay after reload. In [run 40200163352](https://github.com/sguzman/chat-queue/actions/runs/40200163352), an authenticated synthetic source emitted `unknown` during a previously confirmed response; Queue paused immediately and ignored a subsequent fresh terminal for unattended continuation. Both workflows passed static and Firefox jobs. These establish fail-closed extension behavior in synthetic pages, not authenticated production-site network reliability.

## ▶️ Real-provider authorized control and long-response acceptance

In [full Firefox run 40201495776](https://github.com/sguzman/chat-queue/actions/runs/40201495776), a disposable third Firefox extension with a **test-only persisted control grant** requested Start through Queue’s ordinary authenticated external API. The queued message remained unsent before that explicit request; one authorized request caused one guarded synthetic Send, followed by an attributable real Chat Signals terminal event. Existing API security tests separately reject ungranted Start. The same real-provider run held a response generating for more than 16 seconds with a later message queued. Neither an old Copy control nor stale time alone authorized another Send; the next item advanced only after fresh same-epoch completion. The real provider's initial missed idle, source restoration, rapid terminal and SPA route suites remained in place. These are synthetic-site transport results; authenticated ChatGPT network/ProseMirror release acceptance is outstanding.

## 🧩 Actual provider conditional success review and privacy audit

[Full two-job Firefox CI run 40201835724](https://github.com/sguzman/chat-queue/actions/runs/40201835724) exercises a real Chat Signals publisher with a QA-only local rule library in a disposable browser profile. Preview rules stay disabled until an explicit per-conversation opt-in. A new authenticated `finished` event offers a proposed follow-up, does not enqueue or click Send, and requires a separate **Approve** before persisting the message; actual sending still requires another **Start**. The real-provider `failed` event independently offers a manual pause. The audit includes metadata (outcome, rule ID, phase, action), but a regression asserts it does not contain the proposed prompt text. This is synthetic-page two-addon acceptance, not production ChatGPT network behavior.

## ⏰ Real-publisher bounded generating and approval clocks

[Full Firefox run 40207758293](https://github.com/sguzman/chat-queue/actions/runs/40207758293) passed both static and native browser jobs. The genuine independent Chat Signals publisher drives a disposable Queue HUD using freshly attributable phase metadata. A first busy-to-terminal elapsed-time rule can offer an explicitly approved follow-up with a 3500 ms monotonic approval expiration; late approval never enqueues or Sends, even if browser timers are delayed. Separately an actively generating response can reach a 1200 ms local duration threshold and offer an opt-in **manual pause only**, never an automatic timeout, retry, completion or Send. Explicit Approve is still required and terminal arrival after approval cannot restart the queue. These are local bounded browser clocks and synthetic-page tests, not authenticated production-site performance or network evidence.

## 🎯 Pointer-hittable and semantically valid Send targets

[Full Firefox CI 40223820479](https://github.com/sguzman/chat-queue/actions/runs/40223820479) and [earlier complete CI 40222943807](https://github.com/sguzman/chat-queue/actions/runs/40222943807) exercise synthetic ChatGPT pages in disposable Firefox Developer Edition. An actual independently installed Chat Signals publisher verifies normal dispatch remains functional. The guarded composer/Send adapter now refuses controls with hidden, transparent, inert, aria-disabled or disabled-fieldset ancestry, offscreen geometry, or a covering element that would intercept an actual pointer. The separately browser-attested synthetic provider also checks that a checkbox retaining the expected composer ID is not considered a text editor. Denial means zero new Send clicks and no implicit retry if the element becomes visible. This remains synthetic-site evidence only; real ChatGPT React/ProseMirror selection is **not yet accepted**.

## 🧾 Post-click rejected history writes and unrelated older submissions

[Full static and native Firefox CI 40223661321](https://github.com/sguzman/chat-queue/actions/runs/40223661321) rejects a real temporary add-on's `storage.local.set` after the first synthetic Send was accepted. Queue retains the exact prompt in `uncertain`, preserves its same-conversation lease against a competing Firefox tab, and permits deliberate later resolution without replaying Send. A preexisting separate `submitted` history entry remains unchanged when the new uncertain response's terminal event arrives; a missing accepted-history write must never turn an older response into `finished` or `interrupted`. No authenticated ChatGPT network guarantees are inferred.

## 🔄 Untrusted lifecycle events and back-navigation

[Full native Firefox CI 40223661321](https://github.com/sguzman/chat-queue/actions/runs/40223661321) dispatches fake page-origin `pagehide`/`pageshow` events and confirms they cannot tear down the Queue HUD. Real browser back-navigation restores a usable local queue, permits a new local Add, and performs zero automatic Send clicks. Production code additionally reloads a genuinely restored, previously torn-down back-forward-cache document rather than reviving stale execution authority. The test does **not** assert that Firefox necessarily chose bfcache instead of a normal reload on that particular run. Authenticated ChatGPT navigation remains a separate release gate.

## 🧾 Full 20-entry history rollback after a rejected Send record

[Complete Firefox CI 40225537741](https://github.com/sguzman/chat-queue/actions/runs/40225537741) creates a 20-entry synthetic queue history and rejects the first post-Send accepted-history write after exactly one synthetic Send click. The previously journaled prompt remains uncertain, the owner lease stays fail-closed, and **all 20 original history entries** are preserved in the HUD and after reload. The test checks the oldest entry specifically: the rejected bounded prepend is undone from a full snapshot, not by merely removing the failed row from an already-truncated array. This is disposable-browser storage acceptance, **not** live ChatGPT or real crash/network acceptance.

## ⌨️ Keyboard focus after moving a queue item

[Complete Firefox CI 40225986129](https://github.com/sguzman/chat-queue/actions/runs/40225986129) tests actual `Enter` activation of a queue item's Down control. A move recreates the row buttons; the HUD now restores focus to a usable arrow on the **same item**, falling back to the opposite arrow when the original direction becomes disabled at the list boundary. No focus is stolen from the ChatGPT page or another queue item. Existing pointer reorder, private Shadow DOM, themes, browser restart and real two-addon Chat Signals tests also pass. This is keyboard acceptance in disposable Firefox, **not** a complete screen-reader audit or authenticated ChatGPT HUD review.

## 🔐 Concurrent Add rejected during a Send ownership journal

[Full native Firefox CI 40228013689](https://github.com/sguzman/chat-queue/actions/runs/40228013689) deliberately stalls the background's browser-attested dispatch authorization while an already queued message is preparing. A second Add during that in-flight interval now returns `dispatch-in-progress` without entering the storage save chain, consuming a sequence-numbered external append watermark, clearing the HUD draft, or sending either message. Explicit Pause before the delayed authorization returns prevents Send. The production guard applies to both `enqueue` and `enqueueSequenced`, and the two-add-on test covers the actual HUD Add path. No claim is made about authenticated ChatGPT races.

## 🛑 Rejected uncertain-resolution write retains Send ownership

[Full native Firefox CI 40228220903](https://github.com/sguzman/chat-queue/actions/runs/40228220903) first performs exactly one synthetic Send, rejects its post-click accepted-history write, and retains the queued message in uncertain state. It then rejects the user's *explicit* Discard save: rollback must restore the uncertain payload, while a newly opened third Firefox tab trying the same assigned conversation remains denied the Send lease. Only after an attributable provider terminal and a later successfully saved explicit Discard does the original queue become empty. No duplicate Send or implicit retry occurs. This confirms synthetic Firefox transaction/lease behavior, not live ChatGPT or power-loss recovery.

## 🔁 Rapid A → B → A conversation route reuse

[Full FDE CI 40230561965](https://github.com/sguzman/chat-queue/actions/runs/40230561965) delays the browser-owned dispatch authorization on a synthetic assigned conversation, navigates to a second route, then returns to the **same pathname** while the old promise is still pending. An attempt now owns a fresh local token and the route-generation snapshot; asynchronous continuations, busy attribution, error cleanup and final clearing all verify that original generation. The restored queue remains pending, no Send occurs, and a stale callback cannot overwrite the latest queue status. This closes the synthetic pathname-ABA race without claiming real ChatGPT conversation identity acceptance.

## ⏸️ Pause → Start cannot reinstate an unresolved handoff

[Full FDE CI 40230917930](https://github.com/sguzman/chat-queue/actions/runs/40230917930) holds a verified synthetic `dispatch-check` promise while the user explicitly pauses and immediately tries Start again. Start fails with `dispatch-in-progress` until the old attempt unwinds. The old browser authorization never triggers Send and the original queued prompt is retained. The test does not substitute for authenticated React/site interaction.

## 🧾 Failed terminal-status persistence cannot fabricate a saved completion

[Full FDE CI 40231996093](https://github.com/sguzman/chat-queue/actions/runs/40231996093) makes a real temporary Firefox Queue add-on perform one synthetic Send, accept its generating phase, then rejects the terminal `finished` history write. The HUD restores the previous `submitted` status rather than leaving an unsaved `finished` label. A subsequent page reload confirms the previously committed history status, without another Send. Rejection rollback is scoped to the exact conversation route generation, history ID and optimistic revision; it cannot modify a newer route or edit. The intermittent synthetic generating-duration-rule test did **not** fail on this run. Its QA fixture now records the timer's exact decision gate if that separate issue recurs; no production scheduling or Send authorization condition was relaxed.

## 🔐 Paused in-flight and unconfirmed-click cross-tab ownership

[Full disposable Firefox CI 40233210261](https://github.com/sguzman/chat-queue/actions/runs/40233210261) verifies the background's private volatile dispatch ownership when an in-flight Send is paused, and after a **real synthetic Send click** is followed by browser-trusted human editing without acceptable busy confirmation. A competing Firefox tab in the same assigned conversation obtains its own authenticated idle Signal and explicitly presses Start; it must still receive `conversation-owned-by-another-tab` and perform zero Send clicks. A separate pure background unit test ensures a paused unresolved handoff cannot release its lease, while a genuinely clear terminal state can. The transient `leasePending` attribute exists only in internal extension messages, never public API tab metadata. A user must deliberately save Retry/Discard for an unconfirmed click to clear that lease; rejected saves do not. A background event-page restart destroys volatile ownership; this regression does **not** prove cross-restart arbitration or live ChatGPT submission, which remain release gates.

## 🧷 Same-conversation lease rebinding and project URL aliases

[Complete FDE CI 40237479778](https://github.com/sguzman/chat-queue/actions/runs/40237479778) passed both jobs after the browser-background lease changes and pure regression tests. A re-registration at the same pathname must not let another tab acquire an unresolved owner's Send lease before new state arrives. The owner registry also conservatively treats `/c/<id>` and `/g/<project>/c/<id>` as potential aliases: an intervening Firefox-owned URL update invalidates old provider authority but retains that conversation's existing owner until it explicitly publishes a clear state, changes identity, or closes. A tab closing after an alias update must relinquish the retained lease even when its old tab registry has already been cleared. The dedicated tests execute the **production background** under a Node Firefox-API harness; the full browser workflow also exercised the independent synthetic Firefox and two-addon integration suites. This is not an authenticated ChatGPT alias-navigation experiment, a durable cross-event-page lease or an exactly-once delivery guarantee.

## 🔒 Durable grant checks for asynchronous private replies

A status or saved-rule read may be authorized before a permission revocation is stored while its `storage.onChanged` notification reaches the Queue background later. The final private-response boundary now re-reads the current durable grant and refuses disclosure when its exact caller and `read` or `rules` scope no longer qualify. A final grant-storage read failure also blocks private status disclosure; mutations already forwarded still report their actual result, not a fictitious rollback. The pure adversarial tests deliberately change the stored policy **without** issuing `onChanged` and release a delayed private response only afterward, confirming `authorization-changed` without the fixture payload. The static-and-unit and native Firefox jobs passed in [run 40238427564](https://github.com/sguzman/chat-queue/actions/runs/40238427564). That two-addon test holds a real private Queue status reply during a persisted grant revocation while suppressing the event-page notification, then verifies `authorization-changed`, no leaked prompt text, and zero Send. Separate adversarial Node tests cover saved rule definitions and final permission-read failure. The extra lookup narrows the race but is not a linearizable transaction against a future revocation, and authenticated-site/privacy audits remain open.

## ⏱️ Active-rule equality-boundary rescheduling

[Complete native FDE CI 40238804775](https://github.com/sguzman/chat-queue/actions/runs/40238804775) passed with the production scheduler change and a deterministic QA-only clock regression. The actual Queue scheduler could previously evaluate a still-generating rule at 1199 ms, then read 1200 ms while deciding whether to re-arm and permanently drop that 1200 ms minimum-duration proposal. The new threshold filter permits one more tick at equality. The Firefox fixture forces the first rule-evaluation read short and the scheduling read to the exact threshold; a subsequent browser timer must produce the review-only manual pause offer under the same authenticated synthetic response epoch. This does not authorize Queue Send, Enqueue, retry, or a model timeout; actual ChatGPT/network timing acceptance remains open.

## ⏱️ One-shot active duration checkpoints (no hot polling)

[Full Firefox Developer Edition CI 40239719058](https://github.com/sguzman/chat-queue/actions/runs/40239719058) passed both jobs with the per-epoch evaluated-duration checkpoint. The source records the last generating-duration value actually considered by the rule evaluator. If a timer samples 1199 ms and the subsequent scheduling read reaches a 1200 ms minimum, one further timer checks that threshold; once a threshold has been evaluated, an ineligible rule is not scheduled every 1 ms. The disposable Firefox integration additionally installs an enabled minimum-duration rule whose dependency is intentionally never approved, waits beyond that threshold, asserts at most two deadline wakeups and no offer, and observes zero Send clicks. The forced equality fixture still requires its one subsequent manual-pause proposal when the dependency is satisfied. These are local monotonic clocks under synthetic Firefox provider conditions; they do not prove real ChatGPT responsiveness, authenticated completion or production power usage.

## 🔐 Uncertain accepted-history write during provider loss

[Full native Firefox CI 40239992754](https://github.com/sguzman/chat-queue/actions/runs/40239992754) passed the production-content-script fix and a new two-addon adversarial scenario. The first tab performs one synthetic Send, receives an authenticated generating epoch, then encounters a rejected accepted-history storage write. When its provider subsequently reports `unknown` instead of an attributable completion, Queue closes the response wait but **retains the conversation owner's private unresolved-Send lease**. A second tab with its own authenticated idle provider signal and deliberate Start cannot click Send in that conversation. Only a successfully persisted explicit Discard clears the uncertain payload and releases that owner's lease; there is no automatic replay. The source applies this safeguard to failed, interrupted and unattributed-idle closure of the same uncertain-history wait, while an independently attributable finished epoch uses the separate terminal path. Synthetic Firefox acceptance does not establish persistence across event-page destruction, power loss or authenticated production ChatGPT behavior.

## 🧩 Out-of-order browser tab registration

[Full Firefox Developer Edition CI 40243680287](https://github.com/sguzman/chat-queue/actions/runs/40243680287) passed both jobs after the asynchronous registration-race fix and targeted background regression tests. A delayed `tabs.get()` response from an older registration can no longer overwrite the newest registration for that tab, erase its authenticated Signal or relinquish an active same-conversation Send lease. A tab-close or an intervening nonmatching route transition cancels an unresolved registration, including when the URL later returns to its previous pathname. A browser URL update to the **matching newer SPA route** instead revokes the old provider registration without canceling the pending destination registration. These are synthetic provider and actual temporary Firefox lifecycle checks, **not** authenticated ChatGPT React/protocol acceptance; cross-event-page durable leasing remains open.

## 🔐 External rule-write authorization after silent grant revocation

The background's serialized `rulesPut` handler now re-reads the persisted grant before writing an externally supplied rule library. A Node adversarial regression pauses a rule record read, silently revokes the rules capability without `storage.onChanged`, then resumes the writer. It must return `authorization-changed`, leave storage unchanged, and cannot rely on the event-page's stale grant revision. Both static/unit and native Firefox Developer Edition jobs passed [CI 40243911268](https://github.com/sguzman/chat-queue/actions/runs/40243911268). Revocation after a storage write is already in flight cannot retroactively prevent that committed write; separate rule-event delivery checks continue to deny revoked notifications. Full independent security and production-site validation remain open.

## 🔐 External discovery and subscription authorization races

[Complete native Firefox Developer Edition CI 40246143991](https://github.com/sguzman/chat-queue/actions/runs/40246143991) passed static/unit and disposable Firefox jobs for the expanded external API authorization guards. A first successful ACL read is not sufficient when Firefox has committed a new permission policy but not yet delivered `storage.onChanged`: new event-port `ready`, `listTabs`, and `capabilities` replies now perform a final persisted ACL read. Revoking Discover denies pending tab-metadata delivery; reducing an existing peer to Append-only yields *only* its current Append capability, not previously held scopes.

For already-established ports, `stateChanged` checks the current persisted Discover grant before publication. Its per-tab monotonic publication generation discards older callbacks that finish after a newer state (including invalidation), so a delayed `generating` notification cannot overwrite a more recent `finished` state. `rulesChanged` also rechecks the persisted Discover and Rules grants after its initial read. Unit fault injection delivers stale first-read results after silent revocation and asserts that no private tab state or rule revision is posted. The synthetic Firefox suite exercises ordinary authenticated extension messaging, but this is not an independent browser security penetration review or proof of real ChatGPT app integration.

## 🧷 Attributable completion after failed accepted-history persistence

[Complete native Firefox CI 40246438286](https://github.com/sguzman/chat-queue/actions/runs/40246438286) passed both static/unit and disposable FDE jobs. A synthetic Send produced authenticated generating evidence, but the post-click accepted-history write was rejected while its previously persisted uncertain queue item remained. Even an attributable fresh `finished` epoch **does not make that rejected write durable**. The content script now retains its private unconfirmed-click lease after completion; a newly opened same-conversation tab with its own authenticated idle provider cannot Send until the uncertain item is explicitly reviewed and durably resolved. The regression also verifies that older unrelated history entries were not speculatively marked finished. This is per-live-event-page safety evidence, not browser-restart ownership durability or real ChatGPT delivery.

## 🔐 Permission revocation before a queued external mutation

[Complete Firefox Developer Edition CI 40250013999](https://github.com/sguzman/chat-queue/actions/runs/40250013999) passed both jobs with the durable ACL pre-forward recheck and a real temporary two-extension Firefox test. The synthetic Append caller's **first** authorization read was deliberately held with an earlier grant snapshot, while the actual `browser.storage.local` grant was revoked and the production event page's `storage.onChanged` notification suppressed. A subsequent persisted permission read before forwarding refused the enqueue with `authorization-changed`; the target's saved queue count and Send count were unchanged. Node fault-injection tests likewise exercise delayed Start and explicit uncertain-item Resolve, neither forwarded after silent revocation. A grant already exercised before revocation cannot be undone retroactively; this guards the previously delayed initial-ACL boundary, not authenticated ChatGPT behavior.

[Full native Firefox CI 40249749068](https://github.com/sguzman/chat-queue/actions/runs/40249749068) separately proves external `rulesChanged` notifications preserve increasing revisions when storage and event callbacks resolve out of order. Superseded intermediate events may be omitted, and the peer must call `rulesGet` to read current durable revisions. Only revision numbers, never prompts, rule text or provider tokens, enter the event stream.

## 🧭 Private status replies across asynchronous SPA navigation

[Complete native Firefox Developer Edition CI 40250432449](https://github.com/sguzman/chat-queue/actions/runs/40250432449) passed both jobs with a new background return-path guard and adversarial unit tests. An external client can legitimately request private Queue `status` for a tab while the content response is delayed, but must not receive the old conversation's prompt-bearing snapshot after that same tab changes to another chat. The return path now checks the browser-owned final URL plus exact route and per-tab registration generation before the final persisted Read-grant recheck. Unit fixtures force A→B, A→B→A, and a browser URL update that is visible through `tabs.get` before the background's `tabs.onUpdated` callback. Each stale response is replaced with a fixed error containing no private prompt text. Native Firefox synthetic API tests remain green. This is **not** a claim that real authenticated ChatGPT route identities or React state transitions have been accepted.

## 🔒 Metadata-only persistent Send hold and deliberate orphan review

[Native FDE + static/unit CI 40253881017](https://github.com/sguzman/chat-queue/actions/runs/40253881017) passed both jobs for the `probe → reserve → sealed` Send authorization pipeline. Its disposable Firefox synthetic Signal fixture instruments the precise composer handoff: a private uncertain queue item must already be persisted, **and** the independently stored metadata-only conversation hold must contain the current random hold ID. Neither failure of the journal write nor failure of the hold write can authorize a Send. A fresh composer check after asynchronous reservation refuses to overwrite a human draft.

The browser fixture starts a real single-click synthetic Send while its provider is generating, closes that owner tab, then opens a second independently registered tab for the **same exact assigned conversation**. The second tab's fresh idle provider cannot authorize Send even though the volatile event-page owner was freed by tab closure. Only the explicit two-click `Review prior Send hold` action clears that orphaned record, after which a **new** manual Start is required. Node tests simulate event-page recreation by instantiating a new background against the saved metadata; the same conversation ID collides conservatively across ordinary and project-route aliases, failed metadata storage leaves the sealed check denied, and an active owner cannot be cleared by review.

The same full native suite confirms that normally completed multi-message responses advance after **finished history persistence plus hold release**, and that actual Stop, failed responses and post-click history write failures do not silently free an unresolved hold. Real Firefox Developer Edition is used with disposable test profiles and the pinned Chat Signals add-on, not the user's browser session. A subsequent full native Firefox run [40254677171](https://github.com/sguzman/chat-queue/actions/runs/40254677171) also passed with an **actual temporary add-on reload** triggered while a Send hold was unresolved, followed by owner-tab closure and an independently registered competing tab's refused Send. This exercises Firefox's extension reload lifecycle, not merely another background VM. It does **not** independently terminate just the event page while keeping the add-on installed, authenticate to real ChatGPT, prove actual network delivery, or establish an exactly-once remote Send guarantee. Those remain open release gates.

## 🔐 Exact-hold review consent and ABA replacement

[Full native Firefox + static/unit CI 40255501875](https://github.com/sguzman/chat-queue/actions/runs/40255501875) passed. The first local click on `Review prior Send hold` now receives an internal-only random hold identifier and arms a review for that **specific** persisted record. A second click passes that identifier back; if the original record disappeared or another Send replaced it, the background refuses with `send-hold-changed`, leaving the new hold untouched. Node tests deliberately replace the stored hold between the two requests, verify Send remains refused and require the new identifier for successful review.

The UI cancels stale review consent on unrelated HUD or outside clicks and on route change; a delayed first-check response cannot rearm a cancelled review. Native temporary Firefox tests cover nonconsecutive clicks and retain the separate Start requirement after confirmation. No message text, stored queue payload or remote ChatGPT state is disclosed to the background or outside extensions. This is a synthetic, explicitly local review safeguard, not evidence of correct human identification of real remote delivery.

## 🕒 Real event-page idle versus authenticated hold arbitration

The native Firefox Developer Edition `fde-event-page.cjs` test uses an intentionally short, CI-only event-page idle timeout. It confirms that the **real browser** actually suspends and recreates the Queue event page, preserves the private saved queue, invalidates stale Signal authority, re-requests a verified provider snapshot, and refuses any automatic Send while no fresh publisher is present. This remains an important **fail-closed lifecycle test**, not proof that a Send-hold conflict can be exercised with a fresh publisher after that forced suspension.

A separate exploratory fixture attempted to add an independently authenticated, same-conversation competing tab after true event-page idle. Runs [40257797156](https://github.com/sguzman/chat-queue/actions/runs/40257797156) and [40259127197](https://github.com/sguzman/chat-queue/actions/runs/40259127197) showed the intentionally extreme one-second idle policy restarting the provider registration itself: the Queue returned `Signal registry restarted`, or the background rejected the valid external provider with `tab-not-registered`. Those runs had **no Send** but do not constitute an accepted *authenticated hold-denial* test. QA-only keepalives, accelerated-heartbeat overrides and bounded fresh tab registrations did not establish that stricter condition reliably. The unaccepted combined experiment was removed; the previously passing real-idle test is retained. Never mark M4-12 or release acceptance verified from those failed runs.

Separate passing native Firefox tests already exercise cross-tab durable hold arbitration with real temporary extension reload and tab closure, and the background unit suite exercises reconstruction of the metadata-only hold across a new event-page instance. To close the narrower remaining acceptance gap, use a two-phase browser fixture that restores normal event-page lifetime **after** independently proving true suspension while preserving the same on-disk extension storage and exact authenticated Signal identity. Keep prompt/history payloads out of background reads, require an attributable provider epoch, and preserve the manual-review/no-blind-retry contract. Authenticated ChatGPT/ProseMirror and remote network delivery remain separate open gates.

[Full static/unit and native Firefox Developer Edition CI 40261391446](https://github.com/sguzman/chat-queue/actions/runs/40261391446) added a **separate real-idle persistence assertion** to the existing restart fixture. It writes one strictly metadata-only orphan Send hold before the event page suspends, observes a greater actual background startup count afterward, and reads back the exact unchanged record from Firefox `storage.local`. The queued message remains intact and the synthetic Send counter stays at zero; the previously passing disconnected-provider and registry-recovery assertions still pass. Production source and dispatch semantics were not altered. The fixture contains no ChatGPT account or actual delivered message.

Earlier attempts [40261145318](https://github.com/sguzman/chat-queue/actions/runs/40261145318) and [40261245283](https://github.com/sguzman/chat-queue/actions/runs/40261245283) demonstrated that a direct authenticated hold-status request can race the re-created event page's volatile route registration under this deliberately extreme idle policy. Neither attempt is counted as successful cross-tab arbitration. The accepted test checks **durable metadata persistence only** and leaves the exact same pending M4-12, M7 authenticated-site, and G3 acceptance requirements in place. The intended two-phase, stable-lifetime authenticated arbitration check remains outstanding.


### Unaccepted same-profile two-session arbitration experiment (2026-10-26)

A second attempt separated genuine Firefox event-page suspension from a fresh, normal-lifetime browser session in the **same disposable on-disk QA profile**, with a new independent synthetic provider using the authentic Chat Signals Firefox extension principal. The actual first-phase event page restarted and the metadata-only orphan hold persisted unchanged; the queue stayed paused with zero Sends. However, the subsequent externally authenticated idle envelope was refused by the Queue event page with `tab-not-registered`, while the content script displayed `Signal registry restarted`. The diagnosis is retained in failing CI runs [40262263615](https://github.com/sguzman/chat-queue/actions/runs/40262263615) and [40262496219](https://github.com/sguzman/chat-queue/actions/runs/40262496219). The experiment does **not** verify competing-tab Send denial under fresh provider authority and did not warrant a new `verified` task.

The experimental two-session fixture was removed from `main`; the independent, accepted **real-idle metadata-persistence** assertion and its passing native FDE evidence [40261391446](https://github.com/sguzman/chat-queue/actions/runs/40261391446) remain. A future bounded investigation should establish why the re-created background's route registration is missing under this lifecycle before trying authenticated arbitration again. Do not add QA-only keepalives or weaken the Signal freshness/lease gate just to make the test green. Actual authenticated ChatGPT delivery is still independently unverified.

### 🦊 Fresh provider followed by genuine event-page revocation (2026-10-26)

[Full static/unit and native Firefox Developer Edition run 40264685418](https://github.com/sguzman/chat-queue/actions/runs/40264685418) passed the extended **single-browser, post-idle fail-closed** regression. The disposable Firefox profile first suspended and recreated the real Queue event page (observed background startup count 2 → 3), with its exact metadata-only unresolved Send hold and the original queue intact. The fixture then opened a separate, independently registered same-conversation tab, installed a second Firefox extension with the real Chat Signals principal ID, and published one fresh, browser-authenticated idle envelope. The Queue acknowledged that provider event; the tab invoked its actual Start control.

Before its Send authorization completed, the deliberately accelerated event page lost its volatile Signal registry again. The production executor reported `Signal authority lost; no Send attempted` (recorded as a **QA-only exact-status boolean**, with no prompt text). The second tab made **zero Send clicks**, retained its queued item and left the preexisting hold unchanged. The normal synthetic HUD, actual pinned Chat Signals integration, scoped API and restart suites also passed. Production Send logic was not patched for this fixture.

This is evidence for **refusing a Send after an authenticated provider's authority is revoked by a real Firefox lifecycle event**. It is *not* evidence that a continuously authorized competing tab was denied specifically by the durable hold after a genuine event-page shutdown. Trials [40263541546](https://github.com/sguzman/chat-queue/actions/runs/40263541546), [40263702144](https://github.com/sguzman/chat-queue/actions/runs/40263702144) and [40263884567](https://github.com/sguzman/chat-queue/actions/runs/40263884567) showed that even a second disposable browser session whose `prefs.js` and `user.js` contained an idle setting of 120 continued recreating the event page rapidly; that test approach was not accepted. The current single-browser fixture checks only the two safe outcomes, exact saved-hold refusal **or** revoked-Signal refusal, always coupled with zero Send and an unchanged persisted hold. The observed passing branch in run 40264685418 was **revoked-Signal refusal**. M4-12, authenticated ChatGPT Send, actual network acceptance and release remain pending, and the verified task count is unchanged.

The follow-up [full green static/unit and Firefox Developer Edition CI 40265443568](https://github.com/sguzman/chat-queue/actions/runs/40265443568) deliberately separated real suspension from subsequent dispatch by setting the **disposable QA-only** event-page idle timeout to eight seconds and its route-heartbeat to sixteen seconds. The real event page still restarted (startup count 2 → 3), and the new tab again received the independently authenticated fresh idle provider envelope before an actual Start. Its logged safe outcome was still **revoked-Signal refusal**, with zero Sends and the metadata-only hold unchanged, not the stronger `unresolved-durable-send` denial. The test remains accepted for fail-closed lifecycle behavior only; no production timing, authority semantics or Send behavior was changed. The canonical `M4-12` ledger records this exact evidence without promoting the task to `verified`.


### ✅ Post-restart exact durable Send-hold arbitration in native Firefox (2026-10-26)

[Full static/unit and actual Firefox Developer Edition CI 40324015553](https://github.com/sguzman/chat-queue/actions/runs/40324015553) passed both jobs. This builds on the earlier *revoked-Signal fail-closed* tests and now verifies the missing **exact persistent hold rejection after a genuine event-page suspension**. The QA-only startup counter proved actual background recreation (2 → 3); the original synthetic tab's private queue and its exact metadata-only orphan hold remained unchanged in Firefox `storage.local`.

An independently installed synthetic Chat Signals add-on with Firefox-attested provider identity then published a fresh assigned-route idle envelope in a newly registered second browser tab, which Queue accepted. A **QA-only content-script harness** immediately sent an internal `dispatch-check` at stage `probe` using exactly the accepted provider document token, epoch, sequence and route. The test fails unless the actual production background returns `{ok:false,error:'unresolved-durable-send'}`. It does **not** accept `signal-authority-lost`, `route-mismatch`, timeouts or a generic no-click outcome as proof of hold arbitration. That strict assertion passed. The HUD's separate Start path also failed closed after subsequent volatile Signal authority loss; there were zero Send clicks, no prompt replay, and the original hold remained unchanged. The accepted CI log explicitly reports both the hold rejection and the distinct later revoked-authority HUD outcome.

This closes the specific **synthetic, authenticated-provider, post-event-page-restart hold arbitration** gap that previous tests did not prove. The fixture substitutes a localhost synthetic page and QA-only content-script IPC for real ChatGPT and does **not** demonstrate actual human-authenticated React/ProseMirror Send, response completion, network failure reconciliation, assistive-technology acceptance or signing. Keep `M4-12` at `implemented`, `M4-06` and `M7-04` at `planned`, and the real-site/release acceptance gates open. No production Send scheduler, permission contract, storage schema, or idle duration was changed.


**Repeatability correction (2026-10-26):** A subsequent eight-second QA run [40324911498](https://github.com/sguzman/chat-queue/actions/runs/40324911498) intermittently lost the new tab's volatile route registration *before* provider acceptance (`tab-not-registered`), despite the previous exact hold-denial success. The fixture now uses a **20-second disposable Firefox idle timeout** and a **36-second QA heartbeat** to permit authentic provider registration and arbitration while still forcing genuine background suspension. [Full native FDE and static CI 40325211750](https://github.com/sguzman/chat-queue/actions/runs/40325211750) passed: observed event-page startup 2 → 3, exact fresh-epoch `unresolved-durable-send` rejection, preserved queue/hold and zero Send. Production timing remains unchanged. This stronger repeated evidence supersedes reliance on the earlier single eight-second success; full authenticated ChatGPT Send and network completion remain independently unverified.


## 🧷 Exact composer characters and focus ownership in native FDE (2026-10-26)

[Full Firefox Developer Edition and static CI 40331504782](https://github.com/sguzman/chat-queue/actions/runs/40331504782) passed both jobs. The real pinned Chat Signals publisher and unmodified Chat Queue production adapter were exercised on **synthetic localhost pages** within disposable Firefox profiles, with only the previously documented QA origin and inspectable-HUD substitutions. The page now captures what its genuine Send click handler reads **before it clears the contenteditable**, and checks the three-message sequence against exact queued strings. This includes Unicode and deliberate leading/trailing spaces; the assertion tolerates only the adapter's documented browser NBSP/CRLF canonicalization. A successful local queue postcondition alone would not detect the wrong content reaching Send, so the separate click-side capture matters.

An adversarial page-focus handler also redirects a nominally visible/usable ChatGPT composer to a second unrelated editable containing a preexisting draft. A global `document.execCommand('insertText')` otherwise targets the browser's active selection rather than an element argument; the production adapter now refuses if `document.activeElement` is not the selected composer or if the native contenteditable Selection is not owned by it. In that real Firefox regression, the unrelated draft remains byte-for-byte intact, the intended composer is still empty, Queue retains the unsent item and **zero Send clicks** occur. When selection already belongs to the expected rich-text composer, it is preserved instead of forcibly relocating the caret to the container root.

The existing original 96-task roadmap now marks **M4-03 verified** on this native synthetic evidence. This **does not** verify actual logged-in ChatGPT/React/ProseMirror insertion or network Send and cannot substitute for the separately planned **M4-06** or **M7-04** acceptance; those remain open. No human profile or private chat content was accessed, and no new runtime permissions or dependencies were introduced.


## 👆 Single attempted Send and final enabled-control preflight (2026-10-26)

[Full pinned-Chat-Signals + Chat Queue synthetic Firefox Developer Edition CI 40336822023](https://github.com/sguzman/chat-queue/actions/runs/40336822023) and [complete follow-up CI 40337879544](https://github.com/sguzman/chat-queue/actions/runs/40337879544) both passed static/unit and native browser suites.

**M4-05 exact-one-click/no-blind-retry:** a synthetic page's genuine Send handler recorded one Queue click while deliberately producing neither composer clearing nor fresh busy/response evidence. The content script refused to equate a click with acceptance, retained the first item as uncertain, preserved a second pending message, and never generated a second Send after the verification timeout or a real Firefox page reload. The separately installed genuine pinned publisher supplied browser-attested identity, not a page-root forged phase. Prior native scenarios also test delayed trusted user input, manual response interruption, persistent Send holds and explicit review without silent replay.

**M4-04 final actionable Send:** a different disposable route begins with an enabled Send control, but its real editor `input` handler disables the button as Queue inserts the queued text. The guard re-evaluates the button after insertion and refuses the click: zero Send calls, zero captured site payloads, the queued item retained, and no automatic retry after re-enabling it. Existing native Firefox cases independently refuse hidden/inert/offscreen/covered controls and check the exact prepared text. This demonstrates more than a startup-only Send-button check.

Both original tasks are marked verified for these **synthetic native-Firefox acceptance scopes**, raising the 96-task ledger to **84 verified**, without expanding task inventory. Neither proves logged-in ChatGPT's actual React/ProseMirror behavior, remote network acceptance, crash reconciliation or real-site retry safety; **M4-06** and **M7-04** remain planned, other site/security gates remain open, and no release or signing is authorized. Fixture inputs were synthetic, no personal browser profile was accessed, and production permissions, production dispatch logic and runtime dependencies were unchanged.


## ⌨️ Trusted edits outside the composer during Send handoff (2026-10-26)

[Full static and native Firefox Developer Edition CI 40341307323](https://github.com/sguzman/chat-queue/actions/runs/40341307323) and [40342011437](https://github.com/sguzman/chat-queue/actions/runs/40342011437) passed both jobs. The production Queue Send handoff now listens for real browser-trusted `beforeinput`/`input` events across its current page document during sealed pre-click authorization and post-click verification, not merely on the original composer. Nontrusted script-generated input events cannot claim human interference. The capture listeners are removed in `finally` and no new extension permissions or dependencies were introduced.

A disposable Firefox test uses the browser's real WebDriver keyboard input to edit a *different* visible textbox after Queue has prepared the intended composer but while the actual browser-owned sealed authorization awaits a QA-only delayed reply. Queue detects that the user resumed editing, does **not** click Send, retains the unrelated user's draft and the exact queued composer text, preserves its journaled uncertain item, and does not resume on a later independently authenticated idle signal. An additional independent route exercises the same adversarial user edit **after** exactly one Queue Send click but **before** the publisher supplies fresh busy evidence. A subsequently authenticated generating/finished sequence cannot certify the human-interrupted click; it remains uncertain, the next item stays queued, and no second Send occurs. Both regressions require `event.isTrusted === true` from actual Firefox input events, not fabricated browser-page messages.

The existing **M4-10** ledger task remains **implemented**, not verified: these tests establish native synthetic-site collision handling, but not actual human edits in authenticated ChatGPT React/ProseMirror or live external-app races. They do not count toward M4-06, M7-04 or release. No personal Firefox profile, real prompt, or private transcript was used.


### 🔗 Manual recovery across assigned conversation project aliases (2026-10-26)

[Full native Firefox Developer Edition and static/unit CI 40347589087](https://github.com/sguzman/chat-queue/actions/runs/40347589087) passed both jobs. The previous-tab recovery finder now recognizes precisely the same assigned-conversation ID across the two already accepted URL patterns, `/c/<id>` and `/g/<group>/c/<id>`. This does not expand the set of routes authorized for unattended Send; it only offers additional sources on a local, explicit **Find earlier queues** click.

The synthetic Firefox QA fixture seeds one prior-tab queue at a direct route and opens that same conversation through its project alias, alongside a private lookalike queue with a different ID. Discovery offers **one** compatible source without displaying or copying text yet. Only a separate **Recover for review** confirmation copies the matching source as `uncertain`; the HUD includes its uncertainty warning, the source is not deleted, reload retains the copied item and the same source is not offered twice. The page's Send count stays zero. Node tests also reject nearby IDs, percent-encoded strings, home/shared routes, extra path segments, future records and previously recovered sources. As before, confirmation rereads the exact source record and fails closed on changes.

M2-08 remains `implemented`: this is safe native synthetic-browser recovery, **not** verification of actual ChatGPT account-wide conversation identity, automatic stable cross-restart queue storage or authenticated-site duplicate delivery. No new production permission, network endpoint, dependency or automatic Send path was introduced.


**Full Firefox process restart alias regression (2026-10-26).** [Both CI jobs passed in run 40349004418](https://github.com/sguzman/chat-queue/actions/runs/40349004418). The existing `tests/fde-browser-restart.cjs` opens an assigned direct-route queue in a disposable Firefox profile, shuts down the entire Firefox process, relaunches the profile and deliberately opens a *different second tab* at its recognized project-route alias, `/g/restartqa/c/full-browser-restart`. That alias tab must initially be empty and never auto-adopt another tab's prompts. A separate user-triggered Find and Confirm restores only the compatible old conversation's message as **uncertain**, without deleting or overwriting the original tab's queue. The restored tab remains paused after reload, and an ordinary Start with only an uncertain item cannot Send; all synthetic page Send counters remain zero. This is an additional accepted two-process synthetic-site regression, separate from the event-page idle/recreation tests.

Neither the two-process fixture nor prior localhost tests establish actual logged-in ChatGPT project-route semantics, whether a network request was accepted just before a real crash, or real-site duplicate-delivery avoidance. M2-08 is still `implemented` and there is no new verified task.


## 🪄 Keyboard editor focus and semantic queue ordering (2026-10-26)

[Full static and native Firefox Developer Edition CI 40352421760](https://github.com/sguzman/chat-queue/actions/runs/40352421760) and [40352912218](https://github.com/sguzman/chat-queue/actions/runs/40352912218) both passed both jobs.

The HUD's Collapse/Expand control now retains its fixed `aria-controls="body status"` association and announces `aria-expanded` as the queue changes state. The Firefox WebDriver suite uses real keyboard Enter to collapse and expand, rechecks that the status and body visibility match the announced state, reloads a saved collapsed layout, and requires Reset to announce the restored expanded state.

Queued messages form a named `role=list`. Each row is `role=listitem` with 1-based `aria-posinset` and `aria-setsize`, rebuilt from the actual queue after pointer drag or keyboard reorder; the browser test checks exact final list order and both ordinal positions. Real keyboard Edit places focus in that item's newly created textarea. Typing an unsaved suffix and activating Cancel discards it and restores focus to the **same row's Edit button**, without changing its persisted text or clicking Send. These cases preserve all prior synthetic Firefox content-script and two-addon publisher regressions.

This is bounded **semantic DOM and keyboard behavior** in a disposable Firefox profile; no actual screen reader, authenticated ChatGPT React/ProseMirror session, or user profile was exercised. It does **not** close M7-06's independent accessibility and live-site gates, does not advance M7-12 release, and does not change the original 96-task roadmap.

## ⌨️ Keyboard Save and persistent row-focus ownership (2026-10-26)

[Complete static and native Firefox Developer Edition run 40354861240](https://github.com/sguzman/chat-queue/actions/runs/40354861240) passed both jobs. The production HUD snapshots its currently focused row action before the queue items are rebuilt. If that **same item** still has the same enabled action after a queued storage write, the action regains focus; Save or Cancel closing the item editor returns focus to that item's Edit button. Move Earlier/Later continues to fall back to the opposite enabled arrow when its previous direction reaches the list boundary. There is **no fallback into a different item** or the ChatGPT page.

The native Firefox test activates Edit and Save by actual keyboard Enter, types a synthetic suffix, verifies it was durably saved and that focus returned to that item's Edit button, then repeats a keyboard edit and Save to restore the original text. It asserts exact visible message text and zero Send clicks. Earlier native Firefox checks separately cover unsaved Cancel, ordered list semantics, collapsed state announcements, and themes. No account, real prompt, or existing browser profile is involved.

This is synthetic browser keyboard acceptance for the existing **M7-06** task, not a screen-reader or authenticated-site accessibility certification. M7-06 and release remain unverified.

## ⌨️ Queue Delete keyboard focus and screen-reader status (2026-10-26)

[Complete native Firefox Developer Edition CI 40356471838](https://github.com/sguzman/chat-queue/actions/runs/40356471838) passed **both** static/unit and full browser jobs after a production keyboard-focus fix. The new test activates Delete through real Firefox WebDriver Enter, waits for the private queue's persistent mutation, and verifies the focused action moves from the deleted second row to the remaining row's enabled Edit button. Deleting the final row focuses the HUD's Add queued message textarea, never the host page. A neutral `role=status` update announces that the queued message was removed only after a successful persistent write.

The fixture then restores both synthetic messages in their original order, preserves the unrelated unsent HUD draft and confirms zero Send clicks. This closes a concrete keyboard-focus defect within M7-06's **synthetic Firefox** coverage. It does not stand in for an actual screen-reader run, authenticated ChatGPT accessibility testing or the release gates. The verified task count therefore remains **84/96**.
