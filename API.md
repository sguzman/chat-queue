# Chat Queue extension API v1 / scoped grants v2

**Firefox extension ID:** `chat-queue@sguzman.github`

All cross-extension access is denied unless the exact caller extension ID is explicitly granted the necessary **independent scopes** in Chat Queue's Options page. Firefox's verified `sender.id` is authoritative, never a client-supplied ID. The request protocol remains `chat-queue/v1`; its permission storage uses `chatqueue:api-grants:v2`.

Each line in Options is `exact-extension-id | scope,scope`. Allowed scopes are `discover` (metadata and events), `read` (private prompt text and history), `append` (new pending message), `edit` (update, remove, reorder and explicit uncertain-item resolution), and `control` (Start/Pause). An ID with `append` only cannot list tabs, read prompts, or start dispatch. An ID with only `discover` cannot read prompt bodies. The user must choose the minimum needed scopes; no implicit read/write grants.

**Migration:** the legacy `allowedExtensionIds` broad allowlist is now ignored. Existing clients must be manually reauthorized in Options with v2 scopes. No silent migration grants unrestricted access. A grant is permission to call the API, not an indication that sending is safe or that Chat Signals integration is live.

## Request/response

From another Firefox extension's background script:

```javascript
const target = 'chat-queue@sguzman.github';
const envelope = (action, tabId, payload) =>
  ({ type: 'chat-queue/v1', action, ...(tabId == null ? {} : {tabId}), ...(payload ? {payload} : {}) });

const capabilities = await browser.runtime.sendMessage(target, envelope('capabilities')); // {ok:true,version:2,scopes:[...]}, if approved
const { tabs } = await browser.runtime.sendMessage(target, envelope('listTabs')); // requires discover
const tabId = tabs[0].tabId;
const added = await browser.runtime.sendMessage(target, envelope('enqueue', tabId, { text: 'Explain the next step.' }));
const snapshot = await browser.runtime.sendMessage(target, envelope('status', tabId));
// Start is an explicit privileged action. It can submit content to ChatGPT.
const started = await browser.runtime.sendMessage(target, envelope('start', tabId));
```

Every response returns `{ok:boolean}` plus action-specific data or `error`. Missing permissions return `unauthorized` (no grant) or `forbidden-scope` (grant lacks this verb). A metadata-only `capabilities` request requires at least one grant, reports its scopes, and does not disclose prompt content. All requests have a 32 KiB serialized-frame cap. `listTabs` reports registered ChatGPT tabs with `{tabId,phase,size,running,revision}` (no message text). `status` returns `{tabId,phase,running,awaiting,items,history}`; `items` and `history` include message text.

| Action | `payload` | Behavior |
| --- | --- | --- |
| `capabilities` | None, no `tabId` | Report exact granted scopes (requires at least one grant) |
| `listTabs` | None, no `tabId` | Discover registered content-script tabs |
| `status` | None | Read active queue, history and state |
| `enqueue` | `{text}` | Append a pending message; returns `id` |
| `update` | `{id,text}` | Update pending message text |
| `reorder` | `{ids: [...]}` | Replace exact ordering with a permutation of all item IDs |
| `move` | `{id,beforeId}` | Move an item immediately before another ID; `beforeId:null` appends |
| `remove` | `{id}` | Remove a pending item |
| `clear` | None | Clear pending queue |
| `start` | None | Start or resume conservatively gated sending |
| `pause` | None | Pause; an in-progress send may remain uncertain |
| `resolve` | `{id,decision:'retry'\|'discard'}` | Explicitly handle an uncertain submission |

Message text max: 24,000 UTF-16 code units; queue cap: 100 items; recent-history cap: 20. There is no arbitrary script execution or remote request interface.

## Event stream

```javascript
const port = browser.runtime.connect('chat-queue@sguzman.github', { name: 'chat-queue/v1' });
port.onMessage.addListener(message => {
  if (message.type !== 'chat-queue/v1') return;
  // event: 'ready' (tab list) or 'stateChanged' ({tabId,state}).
  // No prompt text is included in push events.
});
```

A subscription requires the `discover` grant and is disconnected if that scope is revoked (not just when the entire extension ID is deleted). Message contents are never sent on the event stream; call `status` to request them.

## Scope-to-action summary

| Scope | Available actions | Private prompt text returned? |
| --- | --- | --- |
| `discover` | `listTabs`, connect/subscribe | No |
| `read` | `status` | Yes; opt in consciously |
| `append` | `enqueue` | No response text; controls submitted new text |
| `edit` | `update`, `remove`, `reorder`, `move`, `clear`, `resolve` | No unsolicited prompt reads |
| `control` | `start`, `pause` | No; sending can have external side effects |

API schemas remain experimental pending live FDE acceptance. Only one extension scope check is implemented per request; automatic retry/replay-safe mutation IDs, content redaction for errors, and browser event-page restart resilience are still open milestones.

## Future conditional message contract (NOT implemented)

A later v2 revision may expose rules such as `when: {phase:'finished'}`, `when:{phase:'failed'}`, or `when:{phase:'interrupted',minDurationMs:5000}`. They will be evaluated per response epoch and scoped conversation, with policy-specific action caps, priority and manual approval for risky retries. **Do not** interpret v1 message fields as executable predicates. No content-based success evaluation currently exists.
