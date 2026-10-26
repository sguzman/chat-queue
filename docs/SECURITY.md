# 🛡️ Threat model and privacy boundary

**Assets:** unsent message text; user's unsent ChatGPT composer draft; conversation identity; whether an outgoing message has been accepted; other extensions' permissions; browser stability.

**Adversaries and failure causes:** arbitrary page scripts on chatgpt.com, compromised/overprivileged peer add-ons, rapid site rerenders, Firefox event-page suspension, concurrent manual typing, network interruptions, stale historical signals, mistaken conversation navigation, replayed cross-extension commands and corrupted storage.

## Required invariants

1. Exact host restriction: ChatGPT only. No remote endpoints or data telemetry. Never copy transcripts to logs, issues, fixtures or public docs.
2. User-added queued prompts remain local to `browser.storage.local`, not sync storage. Treat storage as sensitive: Firefox profile access can read it. The HUD offers explicit JSON import/export, confirmed history deletion, and manual same-route previous-tab recovery. These actions do not upload data or automatically resume Send.
3. No background scans across arbitrary tabs; no head/body-wide per-token observers. The HUD may attach once to the intended page, and queue signal observation watches only a named root attribute in the prototype.
4. A separate extension is **not approved** merely because it knows this extension ID. External messages require a verified `sender.id` in an exact allowlist. Treat every payload as untrusted; prevent oversized strings and privilege escalation. Scopes are now separated: `discover`/`read`/`append`/`edit`/`control`, with exact-ID matching, bounded IPC and revoke-on-grant-change for subscriptions. The old broad allowlist is ignored; a caller must receive an explicit v2 grant. Node tests and disposable Firefox Developer Edition tests using a separate synthetic peer add-on verify scope separation, revocation and bounded API routing; authenticated ChatGPT and real peer-app integration remain separate acceptance gates.
5. Never overwrite a ChatGPT draft, existing attachment, or a different chat; verify route, form, editor and Send at the operation boundary. No automatic navigation.
6. No automatic retries for uncertain sends. A script click, empty draft, or temporary Stop control is not proof of acceptance; new response epochs and authenticated provider messages are needed before G3.
7. A failed/missing/contradictory provider signal causes pause, not guessing. Restored `finished` must not be mistaken for fresh completion. The current DOM attribute can be spoofed by page JavaScript; it is a provisional observation channel only.
8. Expose uncertainty explicitly. Do not claim `sent` without an appropriate positive acceptance proof; labels like `attempted` may be more honest. Maintain any attempt journal before recovery automation is enabled.
9. No profile edits, auto-open/reload of existing tabs, host install, arbitrary shell commands, or other background side effects. Test in an isolated FDE profile first.
10. All public source, issue/PR discussion, screenshots, workflow logs, release notes and commit messages must be neutral and sanitized. No private conversations, credentials, cookie values, user-specific local paths or private captures.

## Risk assessment

Unlike Jobflick Bridge, Chat Queue has no native code execution capability or general filesystem read permission. Its principal irreversible side effect is **sending an unintended message** to ChatGPT, potentially in the wrong conversation or while an existing draft was being edited. Extension crashes can also disturb page layout or focus. Browser profile isolation prevents most accidental damage to daily browsing; it does **not** change the fact that the authenticated ChatGPT account may send real content from a QA profile.

**Approved testing sequence:** static unit tests → synthetically served browser UI in disposable FDE → integrated Chat Signals + Chat Queue in isolated FDE → authenticated ChatGPT with innocuous generated test prompts → multi-tab/rerender/restart/error testing → personal profile candidate. Do not ask the user to perform routine manual QA; automation should cover repeatable tests and require at most a one-time authentication/setup when technically necessary.

## Locally saved rule definitions

The Options rule editor stores user-authored proposal text under `chatqueue:conditional-rules:v1` in Firefox local extension storage after deliberate changes. It is subject to the same local-profile privacy threat as queued prompts. The external `rules` scope does not disclose or mutate these definitions; rule previews are made from caller-provided input only. Unknown storage schema versions are preserved unread and edits are blocked. The Queue HUD may evaluate an authenticated Signal only after explicit per-conversation preview opt-in; there is no automatic rule execution, Send, retry, transcript collection or telemetry. Each proposal requires separate local approval and the approved prompt enters a paused queue.

The trusted user-input guard starts before the first awaited authorization or durable-journal operation, not after Queue fills the page editor. A person typing then erasing during that interval must cancel the Send despite the composer returning to empty. Queue's own synchronous browser-generated insertion event is exempted, but no real preceding or subsequent user input is. Real Firefox keyboard race regression passed https://github.com/sguzman/chat-queue/actions/runs/40378312934; live authenticated React remains unverified.

A peer's previously authorized mutation is now denied if its durable scope was silently revoked while Firefox's browser-owned URL lookup was pending: the event page makes a final stored-grant read after URL resolution and before forwarding the command. The synthetic and actual disposable Firefox scope-revocation tests pass in https://github.com/sguzman/chat-queue/actions/runs/40380891860. This is not an atomic browser URL and ACL transaction, and cannot undo any command already delivered. A genuine user pointerdown/keydown during preflight also invalidates the Send attempt even when the page text has not changed; actual native Firefox zero-Send acceptance passed https://github.com/sguzman/chat-queue/actions/runs/40381704001. Live authenticated acceptance remains separate.

## Asynchronous external permission revocation

The event page keeps a volatile ACL revision counter. A pending external grant read is invalidated whenever Options changes the grant record; this also closes any discovery port not permitted by the new record. For private prompt reads (`status`), a second check after the forwarded content-script reply ensures an earlier authorization cannot leak prompt text following a revocation. A mutation which was already delivered cannot be undone: returning its true result is safer than falsely suggesting it did not happen and inviting a duplicate retry. Node adversarial tests cover a deferred status response and a deferred event-port registration. These are not a substitute for live browser revocation races.

## Fail-closed historical message statuses

Queue storage may contain a previous version's incomplete or unfamiliar item status after a crash or interrupted update. The v1 loader now treats only the explicit `pending` value as automatically dispatchable; `uncertain`, missing, `submitted`, `sent`, and unrecognized status labels load as `uncertain`. The message body and ID remain available for deliberate manual resolution, but the queue cannot silently reinterpret a historical in-flight attempt as a new unsent prompt. Pure unit tests cover this behavior. The loader also blocks mutations when a persisted queue record has an unsupported future schema version or invalid item container. It preserves that storage record unchanged, shows a read-only HUD and requires a later supported migration rather than guessing a downgrade. Recognizable legacy records without a version remain readable. Synthetic Firefox QA exercises a seeded future-version record, an attempted edit, and a reload. This does **not** establish a complete migration protocol for future incompatible queue record versions, which remains an open acceptance task.

## Durable-write uncertainty and tab-ID recovery

Queue writes are serialized in Firefox local storage. A pending or failed save must block Start: the browser can display unsaved in-memory edits, but it cannot treat them as durable authorization for an irreversible message send. A later successful save only clears the storage fault; the user must explicitly press Start again after the authenticated provider conditions are met. Fault-injection in a disposable Firefox fixture tests this boundary independently of live ChatGPT delivery.

When Firefox assigns a different tab ID to a reopened conversation, the user can explicitly look for previous queue records from the same exact pathname. Recovery is staged, requires confirmation, leaves the source untouched, and treats every copied message as **uncertain**. This conservative downgrade avoids accidentally retrying a prompt that might have been submitted before the previous tab closed. It does not establish cross-profile recovery, authenticated restart acceptance or exactly-once browser delivery. See [backup and recovery contract](BACKUP.md).

## Closed Shadow DOM page boundary

The production HUD attaches a **closed ShadowRoot**. A synthetic Firefox Developer Edition privacy regression installs production `src/content.js` without the open-shadow substitution used by visual QA. The fixture seeds one synthetic queued message directly into `browser.storage.local`, then verifies that a normal page script cannot obtain `host.shadowRoot`, find a queue textarea, read the queued message from `document.body.innerText`/`outerHTML`, or access `ChatQueueCore` and `ChatQueueSignal` from the page world. No Send is authorized. [Browser fixture](../tests/fde-privacy.cjs).

A closed ShadowRoot is an **encapsulation boundary**, not encryption or a guarantee against every page-level side channel. It cannot defend against a malicious extension granted privileged access, Firefox profile compromise, the user deliberately copying queued text, screen-reading or accessibility tooling, or a compromised ChatGPT origin. The independent external API requires exact extension ID and scopes, and queue prompts remain in local extension storage. A real authenticated-site and privileged-peer adversarial audit remains open.

## Rule configuration invalidation

Per-conversation conditional preview consent is volatile and is invalidated when the stored local rule definitions change. Pending storage reads also carry a rule-library generation token, so an outdated asynchronous result cannot reinstate the superseded policy. Changing conversations discards the current offer and disables previews. The user must opt in again before authenticated events can create another proposal, and review cannot be bypassed by either HUD or permissioned API Start.

## Conditional proposal epoch binding

An approval is never a reusable authorization token: it is tied to the original authenticated provider document, response epoch, phase and confidence. A superseding provider transition discards it and pauses further dispatch. Even an obsolete button callback must recheck the current authenticated Signal before a proposed queue addition. This does not supply the missing real Chat Signals publisher or establish authenticated ChatGPT acceptance.

## 🧷 Preserve uncertain submission payload until explicit resolution

`uncertain` means an earlier message may already have been submitted. Ordinary editing, deleting and bulk clearing cannot replace or erase that item's original text. The HUD disables Edit/Delete for uncertain rows and exposes distinct **Retry** and **Discard** review actions; the external API must use `resolve` with an explicit decision. `resolve(retry)` changes the item to `pending` but never automatically Starts or Sends it, while `resolve(discard)` deliberately removes it. Synthetic Firefox QA verifies normal Clear is refused and the original payload survives until explicit Discard. This protects review evidence; it is not an exactly-once delivery guarantee.

## Previously opened editors cannot rewrite uncertain items

The content HUD closes an already-open item editor when a preflight or Send attempt makes its formerly pending message uncertain. Its Save action goes through the same guarded `update` validation used for permissioned callers, not directly through the persistence helper; an old user-interface callback cannot bypass the pending-only mutation rule. The initial possibly submitted payload remains preserved until an explicit Retry or Discard.


## Volatile conditional audit containment

Only validated rule IDs, enumerated phase/action labels and fixed outcomes enter the in-memory review history (maximum 20). No proposal text, stored queued prompt, route, document token, response epoch, timestamp or raw exception is retained in the audit. Navigation and reload clear it. A delayed approval after route transition must not render its metadata in the subsequent conversation. Losing authenticated provider registry authority discards active offers and disables previews; restored authorization requires fresh explicit consent.


## Scope of approved-rule dependency state

The reviewed dependency record is a maximum 32-rule, in-memory list of approved IDs, scoped to one conversation and one explicit preview enablement. It resets on route, rule-library change, opt-out/re-opt-in and provider registry loss. A dismissed proposal, failed queue storage write, restored provider event or stale asynchronous approval cannot satisfy a prerequisite. The list is not written to local storage or exposed to the web page, other tabs or the cross-extension API. An approved prerequisite controls only which future proposal is displayed, not whether or when Queue may Send.

## Superseded opt-in storage reads

Every asynchronous conditional-policy load owns a volatile request generation. Rule-library mutations, conversation transitions, provider registry loss and explicit opt-out cancel the previous generation and restore the ability to Enable previews. An earlier completion (success, failure or finally callback) cannot disable or overwrite a newer consent session. No rule load or history is persisted, and no superseded read can authorize Send.

## Rule duration authority boundary

For conditional preview only, the HUD now derives a bounded monotonic elapsed time between the first independently authenticated fresh busy event observed in the current enabled policy session and the first fresh terminal event for the same provider document, conversation route and epoch. A restoration, unknown confidence, idle phase, session reset, epoch mismatch or unbounded interval clears timing evidence. Later terminal repetitions cannot increase that frozen value. The value is not serialized, transmitted or used to authorize Send; rules requiring duration proof cannot match without this trusted lower-bound interval.

## Authenticated confirmation and persistence-race boundaries

A queued message is not accepted merely because the editor became empty and a fresh provider busy epoch appeared. The confirmation interval also observes browser-trusted human interaction on the composer; if detected after the Queue's single Send click, the attempt remains uncertain, and no following queued message is dispatched automatically. The pre-click and post-click human-edit regressions run under disposable Firefox with a synthetic browser-authenticated provider. This does not prove authenticated ChatGPT acceptance.

History is captured as a fixed-schema snapshot before asynchronous storage writes. A failed optimistic import, recovery or history deletion restores the prior local state **and rotates the revision token** so external clients cannot reuse a speculative compare token. The complete Firefox runs [40153216969](https://github.com/sguzman/chat-queue/actions/runs/40153216969), [40153465854](https://github.com/sguzman/chat-queue/actions/runs/40153465854), and [40153888908](https://github.com/sguzman/chat-queue/actions/runs/40153888908) passed their applicable tests.

### Post-click attachment and form-change interference

The confirmation interval treats a browser-trusted file-picker change within the composer form, or a newly selected input-file attachment, as evidence that the human/page composer context changed after the Queue clicked Send. It declines to interpret the later busy epoch as unambiguous acceptance, preserves the file selection and pauses for manual resolution. Real Firefox WebDriver uses an actual selected local file in the synthetic two-addon regression, not a manually fabricated `FileList`; [both CI jobs passed](https://github.com/sguzman/chat-queue/actions/runs/40154290822). No attempt is made to upload private files or retry an uncertain Send automatically.

## Unconfirmed Send and paused in-flight lease

Cross-tab ownership is a volatile event-page safeguard, not a guarantee across all Firefox restarts. Internal state publication includes a private `leasePending` bit so a paused but unresolved dispatch, or a script-clicked Send lacking authenticated busy confirmation, does not release its active assigned-conversation owner. A confirmed terminal can close an attributable response; an unconfirmed click requires a successfully persisted deliberate uncertain-item Retry or Discard before this document releases its owner. Public `listTabs`, `status` and event streams do not expose this private lease bit or prompt content. Disposable Firefox cross-tab QA passed in [run 40233210261](https://github.com/sguzman/chat-queue/actions/runs/40233210261). The event page cannot reconstruct volatile ownership after process/browser restart, and authenticated ChatGPT reconciliation remains an open prerequisite; do not treat this as a production exactly-once delivery guarantee.
