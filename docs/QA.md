# 🦊 Firefox Developer Edition acceptance plan

Follow the same evidence discipline as [Jobflick Bridge QA](https://github.com/sguzman/jobflick-bridge/blob/main/docs/QA.md). Firefox Developer Edition, not Firefox Release/Chromium/Edge, is the target for QA. The automated suite must use a disposable browser profile; never modify Firefox profile preferences or load add-ons into the user's active browser without explicit consent.

## Test tiers

- **Q0 static:** `npm run check` validates JS syntax, ledger/roadmap consistency, queue pure functions, and background allowlist rejection. Q0 passes 77 Node tests, including v2 scope enforcement and subscription revocation; this does *not* validate DOM rendering or live site integration.
- **Q1 synthetic FDE:** install/uninstall the exact production manifest in a disposable headless FDE profile. With a strictly QA-only synthetic fixture, exercise HUD, each theme including OS change, drag/keyboard ordering, reload and stale route. No ChatGPT account required.
- **Q2 Signal contract:** run Chat Signals + Chat Queue in the same disposable FDE instance, with scripted fresh vs restored response epochs, failed/interrupted/limit states, and provider disappearance. Confirm no unauthorized send. A page attribute alone is not an authenticated signal.
- **Q2a negative gate:** with Chat Signals v0.3.13 and no authenticated event publisher, the HUD may display unverified phase changes, but Start must refuse and no Send click may occur. Node unit tests for the candidate consumer are not a substitute for a real FDE run.
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
| Restored/historical `finished` | No falsely attributed response | Candidate consumer and Node regression; producer/FDE pending |
| Reply interrupted/failed/limited | Pause; no blind retry | Prototype implementation only |
| Existing draft or attachment | Remains untouched | Prototype adapter only; not live tested |
| Navigation to another conversation | No misrouted send | Synthetic Firefox pushState/replaceState, route return and no-send passed in run 40034372239; authenticated live navigation pending |
| Two tabs same conversation | Deterministic ownership | Not implemented |
| Same tab after browser restart | No automatic resumption | Volatile run flag; real restart untested |
| Synthetic cross-extension caller denied | No queue contents disclosed | Node tests pass |
| Approved caller revocation | Immediate denial on new calls | Code present; FDE port tests pending |
| Three themes and system preference | Legible HUD and preferences persist | CSS/selector implementation only |
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

The production-only `scripts/security-audit.mjs` is part of `npm run check`: storage-only manifest permissions, exact ChatGPT scope, no broad hosts, no remote assets, no dynamic JS, and no runtime network APIs. Four tests create disposable modified copies to verify that the gate rejects violations; they never modify real Firefox profiles. Static-and-unit CI passes with 60 Node tests. This does not replace a manual source, supply-chain, browser-privacy and authenticated delivery audit. See [static audit contract](SECURITY-AUDIT.md).

## 💾 Failed and delayed local queue writes

A QA-only content-script substitution makes `browser.storage.local.set` reject or complete after a deliberate delay. The real Firefox Developer Edition HUD must reject Start with `storage-unavailable` after a failed write and `queue-save-pending` before a delayed write finishes. Once another save commits, the queue remains paused and still requires authenticated Signal authority and a separate Start action. A reload must preserve the successfully saved items without a Send. [Accepted browser regression](https://github.com/sguzman/chat-queue/actions/runs/40046386978). This does not simulate power loss, genuine Firefox quota exhaustion or a live ChatGPT editor.

## 🧭 Sixteen-tab Firefox workload

The disposable Firefox Developer Edition cross-tab regression now opens **16 independent ChatGPT-shaped conversation routes**, checks exact-route queue isolation, and revisits a previously hidden tab after additional queues are created. It verifies shared Light/Dark preference and zero Send clicks. [Firefox workload run](https://github.com/sguzman/chat-queue/actions/runs/40046956628).

This is bounded synthetic browser QA, not authenticated ChatGPT, a realistic large transcript, long-idle power profiling, whole-browser crash/relaunch or full multi-tab performance acceptance. The corresponding M7-05 milestone remains `implemented` rather than verified.

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
