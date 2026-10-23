# 🦊 Firefox Developer Edition acceptance plan

Follow the same evidence discipline as [Jobflick Bridge QA](https://github.com/sguzman/jobflick-bridge/blob/main/docs/QA.md). Firefox Developer Edition, not Firefox Release/Chromium/Edge, is the target for QA. The automated suite must use a disposable browser profile; never modify Firefox profile preferences or load add-ons into the user's active browser without explicit consent.

## Test tiers

- **Q0 static:** `npm run check` validates JS syntax, ledger/roadmap consistency, queue pure functions, and background allowlist rejection. Q0 passed on 2026-10-23 for seven baseline Node tests; this does *not* validate DOM rendering or live site integration.
- **Q1 synthetic FDE:** install/uninstall the exact production manifest in a disposable headless FDE profile. With a strictly QA-only synthetic fixture, exercise HUD, each theme including OS change, drag/keyboard ordering, reload and stale route. No ChatGPT account required.
- **Q2 Signal contract:** run Chat Signals + Chat Queue in the same disposable FDE instance, with scripted fresh vs restored response epochs, failed/interrupted/limit states, and provider disappearance. Confirm no unauthorized send. A page attribute alone is not an authenticated signal.
- **Q3 authenticated FDE:** test a deliberately harmless queued message in a separate authenticated ChatGPT QA profile; verify one actual submission followed by verified completion. Then test two-message serial order, draft occupancy, tab switching, page rerender, timeout, background, manual stop, route change, disconnected Signal, and browser restart. These must pass *before* automatic sender acceptance.
- **Q4 extension API:** a second synthetic Firefox extension exercises allowlist, denied callers, read and mutating scopes, revocation mid-connection, service-worker/event-page wakeup, 16 tabs, and malicious/replayed payloads.
- **Q5 release:** Mozilla manifest lint, reproducible package with manifest at ZIP root, public privacy scan, signed XPI plan, installation/update on FDE, and regression acceptance against the pinned Chat Signals contract.

## Dedicated QA launch

`fish scripts/qa-firefox-developer.fish` opens Firefox Developer Edition with its own project-specific profile under `$XDG_DATA_HOME/chat-queue-fde-qa/profile`. It does not change the default browser profile, Firefox preferences, or ChatGPT account data in the normal browser. The script also does **not** automatically load or sign an extension. In the separate QA window use `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `manifest.json` from the repo root. Chat Signals must also be installed in the same QA profile for integrated observation tests.

Do not install the unsigned prototype into a personal browser for automatic sends until G2/G3 pass. A harmless manual HUD-only smoke can be considered low-risk but is not the acceptance test for the dispatch engine.

## Adversarial acceptance matrix

| Scenario | Required outcome | Current evidence |
| --- | --- | --- |
| Unknown/missing provider | No automatic Send | Node logic only |
| Restored/historical `finished` | No falsely attributed response | Not implemented; new epoch contract needed |
| Reply interrupted/failed/limited | Pause; no blind retry | Prototype implementation only |
| Existing draft or attachment | Remains untouched | Prototype adapter only; not live tested |
| Navigation to another conversation | No misrouted send | Prototype route guard; races untested |
| Two tabs same conversation | Deterministic ownership | Not implemented |
| Same tab after browser restart | No automatic resumption | Volatile run flag; real restart untested |
| Synthetic cross-extension caller denied | No queue contents disclosed | Node tests pass |
| Approved caller revocation | Immediate denial on new calls | Code present; FDE port tests pending |
| Three themes and system preference | Legible HUD and preferences persist | CSS/selector implementation only |
| User keyboard-only drag alternative | Reorder without mouse | Buttons implemented; FDE QA pending |
| Consecutive queued messages | Exactly once, ordered after matching response | Not live tested |

Mark a gate complete only with test output or reproducible authenticated FDE results. Preserve negative counterexamples when fixing live regressions. The user should not be treated as the project's automated test harness.
