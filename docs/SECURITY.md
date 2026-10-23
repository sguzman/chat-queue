# 🛡️ Threat model and privacy boundary

**Assets:** unsent message text; user's unsent ChatGPT composer draft; conversation identity; whether an outgoing message has been accepted; other extensions' permissions; browser stability.

**Adversaries and failure causes:** arbitrary page scripts on chatgpt.com, compromised/overprivileged peer add-ons, rapid site rerenders, Firefox event-page suspension, concurrent manual typing, network interruptions, stale historical signals, mistaken conversation navigation, replayed cross-extension commands and corrupted storage.

## Required invariants

1. Exact host restriction: ChatGPT only. No remote endpoints or data telemetry. Never copy transcripts to logs, issues, fixtures or public docs.
2. User-added queued prompts remain local to `browser.storage.local`, not sync storage. Treat storage as sensitive: Firefox profile access can read it. Document retention and allow explicit clearing/export in a future milestone.
3. No background scans across arbitrary tabs; no head/body-wide per-token observers. The HUD may attach once to the intended page, and queue signal observation watches only a named root attribute in the prototype.
4. A separate extension is **not approved** merely because it knows this extension ID. External messages require a verified `sender.id` in an exact allowlist. Treat every payload as untrusted; prevent oversized strings and privilege escalation. Scopes are now separated: `discover`/`read`/`append`/`edit`/`control`, with exact-ID matching, bounded IPC and revoke-on-grant-change for subscriptions. The old broad allowlist is ignored; a caller must receive an explicit v2 grant. Synthetic Node tests cover the scope separation and port revocation; live API add-on acceptance remains pending.
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

The Options rule editor stores user-authored proposal text under `chatqueue:conditional-rules:v1` in Firefox local extension storage after deliberate changes. It is subject to the same local-profile privacy threat as queued prompts. The external `rules` scope does not disclose or mutate these definitions; rule previews are made from caller-provided input only. Unknown storage schema versions are preserved unread and edits are blocked. There is no automatic execution, listener on real conversations, or telemetry.

## Asynchronous external permission revocation

The event page keeps a volatile ACL revision counter. A pending external grant read is invalidated whenever Options changes the grant record; this also closes any discovery port not permitted by the new record. For private prompt reads (`status`), a second check after the forwarded content-script reply ensures an earlier authorization cannot leak prompt text following a revocation. A mutation which was already delivered cannot be undone: returning its true result is safer than falsely suggesting it did not happen and inviting a duplicate retry. Node adversarial tests cover a deferred status response and a deferred event-port registration. These are not a substitute for live browser revocation races.
