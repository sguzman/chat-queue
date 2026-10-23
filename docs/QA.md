# 🦊 Firefox Developer Edition acceptance plan

Follow the same evidence discipline as [Jobflick Bridge QA](https://github.com/sguzman/jobflick-bridge/blob/main/docs/QA.md). Firefox Developer Edition, not Firefox Release/Chromium/Edge, is the target for QA. The automated suite must use a disposable browser profile; never modify Firefox profile preferences or load add-ons into the user's active browser without explicit consent.

## Test tiers

- **Q0 static:** `npm run check` validates JS syntax, ledger/roadmap consistency, queue pure functions, and background allowlist rejection. Q0 passes 32 Node tests, including v2 scope enforcement and subscription revocation; this does *not* validate DOM rendering or live site integration.
- **Q1 synthetic FDE:** install/uninstall the exact production manifest in a disposable headless FDE profile. With a strictly QA-only synthetic fixture, exercise HUD, each theme including OS change, drag/keyboard ordering, reload and stale route. No ChatGPT account required.
- **Q2 Signal contract:** run Chat Signals + Chat Queue in the same disposable FDE instance, with scripted fresh vs restored response epochs, failed/interrupted/limit states, and provider disappearance. Confirm no unauthorized send. A page attribute alone is not an authenticated signal.
- **Q2a negative gate:** with Chat Signals v0.3.13 and no authenticated event publisher, the HUD may display unverified phase changes, but Start must refuse and no Send click may occur. Node unit tests for the candidate consumer are not a substitute for a real FDE run.
- **Q3 authenticated FDE:** test a deliberately harmless queued message in a separate authenticated ChatGPT QA profile; verify one actual submission followed by verified completion. Then test two-message serial order, draft occupancy, tab switching, page rerender, timeout, background, manual stop, route change, disconnected Signal, and browser restart. These must pass *before* automatic sender acceptance.
- **Q4 extension API:** a second synthetic Firefox extension exercises allowlist, denied callers, read and mutating scopes, revocation mid-connection, service-worker/event-page wakeup, 16 tabs, and malicious/replayed payloads.
- **Q5 release:** Mozilla manifest lint, reproducible package with manifest at ZIP root, public privacy scan, signed XPI plan, installation/update on FDE, and regression acceptance against the pinned Chat Signals contract.

## 🔌 Independent scoped API client fixture

`tests/fde-api.cjs` boots headless Firefox Developer Edition with the production queue background/content logic and an independent temporary client add-on. A QA-only grant bootstrap is added to the temporary queue manifest; no production permission bypass, user profile, authenticated account, or real ChatGPT Send is used. It asserts `discover,append` capabilities, metadata-only listing, forbidden `status`/`start`/`remove`, a successful synthetic enqueue, successful event-port subscription, immediate subscription disconnection after QA-only grant revocation, and subsequent unauthorised requests. This exercises actual Firefox sender identity and `browser.storage.local` events. The independent add-on acceptance path passed in https://github.com/sguzman/chat-queue/actions/runs/40034372239. Full Options UX, event-page restart and malicious multi-client browser tests remain unaccepted.

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

In synthetic FDE, a deliberate read/edit grant allows an approved extension to retrieve an opaque queue edit token, reject stale and replayed `update` operations, and accept only a current `ifMatch`. A separate History API roundtrip must rotate the token so a previous conversation snapshot cannot silently overwrite later edits. Omitted preconditions remain allowed for backwards-compatible API clients; exactly-once external requests and authenticated ChatGPT QA are still open.

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

[Firefox Developer Edition CI 40037217649](https://github.com/sguzman/chat-queue/actions/runs/40037217649) installs a synthetic second extension, grants a `rules` permission independently from all queue read/send scopes, successfully previews a caller-supplied synthetic failure/pause rule, then revokes the `rules` scope and observes `forbidden-scope` on the same request. The receiver accepts only strict typed declarative input; no queue tab receives a preview or Send. Full rule CRUD, user activation and provider events remain separate gates.

## 🗂️ Persisted preview definitions

The `fde-rules.cjs` fixture uses a synthetic same-origin sessionStorage-backed stub for Firefox extension storage. It checks that rule definitions survive page reloads, remain inert without a simulation request, can be edited after reload, and require two clicks for destructive clearing. Production Options uses Firefox `browser.storage.local`, not the fixture's `sessionStorage`. Consequently this gate proves real Firefox UI behavior and storage-adapter mechanics, not privileged Firefox extension-storage persistence or conditional execution. Corrupt/future-version record rejection is covered by Node unit tests.
