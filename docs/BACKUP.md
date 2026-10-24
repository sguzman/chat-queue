# 📦 Local queue backup and retention

Chat Queue's HUD offers user-initiated local JSON import/export and explicit history deletion. These controls are under **Recently submitted / backup** in the floating HUD. They never initiate ChatGPT Send and never transmit data to a server.

## Supported workflow

1. **Export queue** requests a download of `chat-queue-messages.json` containing only the current conversation's queued messages and their statuses. Recently submitted history is deliberately not included.
2. **Import JSON** opens a local file picker. The extension validates the selected backup, then previews its item count. **Append N messages** is a separate, deliberate confirmation; selecting a file alone changes nothing.
3. Imports append to the **currently selected** conversation queue. They generate fresh local item identifiers; they do not rebind a saved conversation route or resume an old run.
4. Imported `pending` messages remain paused until an explicit Start under a fresh authenticated Signal. Imported `uncertain` messages require deliberate review/retry or deletion. Import is unavailable while a response is in flight, while the queue is running, or during route transitions.
5. **Forget history** → **Confirm forget** permanently clears this conversation's locally retained recent submission history only. It does not delete queued messages, other conversations, or ChatGPT server history.

## Backup contract

The v1 backup is JSON with `kind: "chat-queue-message-backup"`, `version: 1`, and `items` containing at most 100 objects with a valid `text` and a `status` of `pending` or `uncertain`. Each text is bounded by the queue's 24,000-character limit. Files are limited to 16 MiB to accommodate worst-case JSON escaping.

No tab IDs, routes, browser profiles, document tokens, provider state, submission epochs, credentials, or automatic-dispatch flags are serialized. The backup **does contain the exact queued message text**, so the user must store or share it carefully. The extension does not upload it anywhere.

Malformed/future-version backups, unknown statuses, oversized files, and imports that would exceed queue capacity are rejected without appending. If the conversation changes while a file is being read, the staged import is discarded.

## Acceptance and remaining limits

The implementation has unit tests for the version, size, status and content contract. Headless Firefox Developer Edition confirms native local-file selection, staged confirmation, persistence, byte-for-byte JSON download content, preserved uncertainty, and two-click history deletion after reload. [Accepted Firefox run](https://github.com/sguzman/chat-queue/actions/runs/40044676209).

This is synthetic-page Firefox acceptance. It is not authenticated ChatGPT upload/send acceptance, does not provide automatic recovery across browser profile deletion or tab-ID changes, and does not substitute for the missing authenticated Chat Signals publisher.

## Recover queues from a previous Firefox tab ID

If Firefox reopens the same ChatGPT conversation under a new tab ID, its old local queue may still exist under the previous `chatqueue:v1:tab:<id>:<pathname>` key. While viewing the **same exact conversation path**, expand **Recently submitted / backup** and choose **Find earlier queues**. Discovery reads only local extension storage, is initiated by this click, and shows a metadata-only count; it never scans ChatGPT messages. The user must then separately click **Recover N for review**.

Recovery copies **one** older queue at a time, keeps its source record intact, and marks **every copied message uncertain**, including previously pending ones. This is intentional: a prior tab may have sent a prompt before the browser was interrupted. Review and explicitly resolve individual messages; there is no automatic Start, retry, or Send. When several earlier queues exist, repeat discovery to inspect the next one. The active queue records previously recovered source keys to avoid offering the same source twice after reloading that tab.

The recovery candidate finder requires an exact pathname match, numeric tab ID, supported saved record schema, and enough room under the 100-message queue cap. Confirmation **re-reads the original source record** and refuses recovery if that record was deleted, changed, or upgraded to an unsupported version after discovery; the user must run Find again. It also consumes the pending confirmation before the asynchronous check, preventing a fast double-click from appending twice. This check reduces stale-source races but is not an atomic cross-tab compare-and-swap: independent source writes immediately afterward cannot be locked by Firefox `storage.local`. Future-version records are not interpreted. Navigation, concurrent edits, an active generation, or storage failure cancels recovery rather than rebinding another conversation. Recovery is not a cross-device backup, and the original source remains locally stored until the user explicitly manages their Firefox profile data.

The tests distinguish helper-level matching from actual headless Firefox UI acceptance. This workflow does not prove survival of a real authenticated browser restart, cross-profile migration, or ChatGPT sending.
