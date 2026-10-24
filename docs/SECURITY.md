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
