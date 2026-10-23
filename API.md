# Chat Queue extension API v1

**Firefox extension ID:** `chat-queue@sguzman.github`

All cross-extension access is denied unless the exact caller extension ID is entered in Chat Queue's Options page. Authorization is enforced in the background and never by trusting the page or a client-supplied `senderId`. An authorized client can both inspect raw queue text and mutate/start dispatch: treat this as a privileged capability.

## Request/response

From another Firefox extension's background script:

```javascript
const target = 'chat-queue@sguzman.github';
const envelope = (action, tabId, payload) =>
  ({ type: 'chat-queue/v1', action, ...(tabId == null ? {} : {tabId}), ...(payload ? {payload} : {}) });

const { tabs } = await browser.runtime.sendMessage(target, envelope('listTabs'));
const tabId = tabs[0].tabId;
const added = await browser.runtime.sendMessage(target, envelope('enqueue', tabId, { text: 'Explain the next step.' }));
const snapshot = await browser.runtime.sendMessage(target, envelope('status', tabId));
// Start is an explicit privileged action. It can submit content to ChatGPT.
const started = await browser.runtime.sendMessage(target, envelope('start', tabId));
```

Every response returns `{ok:boolean}` plus action-specific data or `error`. `listTabs` reports registered ChatGPT tabs with `{tabId,phase,size,running,revision}` (no message text). `status` returns `{tabId,phase,running,awaiting,items,history}`; `items` and `history` include message text.

| Action | `payload` | Behavior |
| --- | --- | --- |
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

The client is disconnected if its extension ID is removed from the allowlist. Message contents are never sent on the event stream; call `status` to request them.

## Future conditional message contract (NOT implemented)

A later v2 revision may expose rules such as `when: {phase:'finished'}`, `when:{phase:'failed'}`, or `when:{phase:'interrupted',minDurationMs:5000}`. They will be evaluated per response epoch and scoped conversation, with policy-specific action caps, priority and manual approval for risky retries. **Do not** interpret v1 message fields as executable predicates. No content-based success evaluation currently exists.
