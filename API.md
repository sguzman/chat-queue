# Chat Queue extension API v1 / scoped grants v2

**Firefox extension ID:** `chat-queue@sguzman.github`

All cross-extension access is denied unless the exact caller extension ID is explicitly granted the necessary **independent scopes** in Chat Queue's Options page. Firefox's verified `sender.id` is authoritative, never a client-supplied ID. The request protocol remains `chat-queue/v1`; its permission storage uses `chatqueue:api-grants:v2`.

Each line in Options is `exact-extension-id | scope,scope`. Allowed scopes are `discover` (metadata and events), `read` (private prompt text and history), `append` (new pending message), `edit` (update, remove, reorder and explicit uncertain-item resolution), `control` (Start/Pause), and `rules` (caller-scoped synthetic rule preview and persistent rule-library editing; no live data or dispatch actions). An ID with `append` only cannot list tabs, read prompts, or start dispatch. An ID with only `discover` cannot read prompt bodies. The user must choose the minimum needed scopes; no implicit read/write grants.

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

Every response returns `{ok:boolean}` plus action-specific data or `error`. Missing permissions return `unauthorized` (no grant) or `forbidden-scope` (grant lacks this verb). A metadata-only `capabilities` request requires at least one grant, reports its scopes, and does not disclose prompt content. All requests have a strict **32 KiB UTF-8-encoded serialized-frame cap** (not a UTF-16 character-count cap), including metadata-only probes and multibyte prompt text. `listTabs` reports registered ChatGPT tabs with `{tabId,phase,size,running,revision}` (no message text). `status` returns `{tabId,phase,running,awaiting,revision,etag,items,history}`; `items` and `history` include message text.

| Action | `payload` | Behavior |
| --- | --- | --- |
| `capabilities` | None, no `tabId` | Report exact granted scopes (requires at least one grant) |
| `previewRules` | `{rules,signal,consumedKeys?:[],context?:{stateDurationMs?,completedRuleIds?:string[]}}`, no `tabId` | Evaluate caller-provided synthetic rules and event only; no queue interactions |
| `rulesGet` | None, no `tabId` | Read only this exact caller extension ID's saved rule definitions and revision; requires `rules` |
| `rulesPut` | `{revision,rules}`, no `tabId` | Replace only this caller's stored definitions after bounded normalization and exact revision match; requires `rules` |
| `listTabs` | None, no `tabId` | Discover registered content-script tabs |
| `status` | None | Read active queue, history and state |
| `enqueue` | `{text}` | Append a pending message; returns `id` |
| `enqueueSequenced` | `{text,sequence}` | Append at most once per strictly increasing browser-attested client sequence and exact saved queue; rejects replay |
| `update` | `{id,text}` | Update pending message text |
| `reorder` | `{ids: [...]}` | Replace exact ordering with a permutation of all item IDs |
| `move` | `{id,beforeId}` | Move an existing item before another existing ID, or append with `beforeId:null`; unknown IDs and self-moves return `invalid-order` without changing the queue |
| `remove` | `{id}` | Remove a pending item |
| `clear` | None | Clear pending queue |
| `start` | None | Start or resume conservatively gated sending |
| `pause` | None | Pause; an in-progress send may remain uncertain |
| `resolve` | `{id,decision:'retry'\|'discard'}` | Explicitly handle an uncertain submission |

## Durable sequenced enqueue (opt-in, experimental)

For an append-only client that may lose a response after a successful write, prefer `enqueueSequenced` with `payload:{text,sequence}`. Sequence must be a **positive safe integer** that strictly increases for each **Firefox-verified caller ID** targeting the same saved queue. The client owns sequence generation and must preserve its next number across process restarts; do not reset it to 1 after a network timeout or extension restart.

The queue stores only a high-watermark number per calling extension ID, not the request text, document token or response. It is stored **in the same `browser.storage.local` queue record as the appended prompt**, so when that write commits, the operation's replay marker also commits. A reused or lower sequence returns `{ok:false,error:'replayed-request'}` and cannot append again. Missing, negative or unsafe sequence values return `invalid-request-sequence`. To bound metadata, only 32 distinct caller IDs may establish high-watermarks for a particular queue; exceeding the cap returns `request-client-limit`. The existing `append` grant permits this operation without disclosing earlier prompts. Optional `ifMatch` still works when a caller also has a recent revision token.

The replay guarantee is scoped to the **same stored queue key, Firefox profile and retained storage record**. It does not survive profile erasure, manual removal of queue data, a new tab-ID key, or changes to the caller's extension ID; it does not deduplicate the legacy `enqueue` action. No Send or rule execution occurs on a sequenced enqueue. A lost response means the client should use a **higher sequence only for a genuinely new intended append**; repeating a possibly accepted request with a higher sequence intentionally creates a second message. This is safer than treating an ambiguous callback as authorization to retry automatically.

## Optimistic queue edits (experimental)

A caller with the 'read' scope can fetch `status.etag` (a random instance token) and pass `ifMatch:etag` within an `enqueue`, `update`, `move`, `reorder`, `remove`, `clear` or `resolve` payload. If another queue edit occurred, or the content-script document was reloaded, the operation returns `{ok:false,error:'revision-conflict',revision}` without applying a change. Fetch a fresh status, reconcile the intended edit, and issue a new request; never replay a destructive mutation blindly. The token is a consistency precondition, not an authorization secret. For backwards compatibility, omitting `ifMatch` keeps legacy unconditional semantics; the user grants still apply. `enqueue` also returns the new `etag` for append-only clients. Future revisions may require preconditions for destructive actions.

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

A subscription requires the `discover` grant and is disconnected if that scope is revoked (not just when the entire extension ID is deleted). Message contents are never sent on the event stream; call `status` to request them. Clients that also retain `rules` receive additive `rulesChanged` events with only `{revision}` after a successful rule-library write. If `rules` is revoked but `discover` remains, the metadata port stays connected while `rulesChanged` is suppressed.

## Scope-to-action summary

| Scope | Available actions | Private prompt text returned? |
| --- | --- | --- |
| `discover` | `listTabs`, connect/subscribe | No |
| `read` | `status` | Yes; opt in consciously |
| `append` | `enqueue`, `enqueueSequenced` | No response text; controls newly submitted text |
| `edit` | `update`, `remove`, `reorder`, `move`, `clear`, `resolve` | No unsolicited prompt reads |
| `control` | `start`, `pause` | No; sending can have external side effects |
| `rules` | `previewRules`, `rulesGet`, `rulesPut`; `rulesChanged` events additionally require `discover` | Stored proposals in **this caller's own** library only; no ChatGPT prompt/history reads |

API schemas remain experimental pending live FDE acceptance. The new `enqueueSequenced` is an opt-in durable anti-replay operation. Legacy `enqueue` and other mutations do not automatically gain replay safety; authenticated live browser execution, multi-client adversarial coverage and full event-page restart resilience remain separate gates.

## Per-extension rule libraries (preview-only, revisioned)

A client granted `rules` may persist up to 32 validated, bounded definitions **under its own Firefox-attested extension ID**. These definitions are independent of Chat Queue's Options rule library, other extension IDs and live conversations.

```javascript
const current = await browser.runtime.sendMessage(target, envelope('rulesGet'));
// {ok:true,revision:0,rules:[]} if this extension has no saved rules yet
const saved = await browser.runtime.sendMessage(target, envelope('rulesPut', null, {
  revision:current.revision,
  rules:[{version:1,id:'pause-on-failure',enabled:true,priority:50,
          when:{phase:'failed'},then:{type:'pause'}}]
}));
// {ok:true,revision:1}, if there was no conflicting edit
```

Each `rulesPut` is a complete replacement. The sender must provide the **exact last stored revision**, starting at 0; concurrent writes from the same caller serialize, so only one same-revision update succeeds. Stale revisions return `rule-revision-conflict`. Malformed revisions return `invalid-rule-write`, malformed definitions return the corresponding rule-validator error, and a malformed/future-version saved record fails closed with `unsupported-rule-record` without overwriting it. Storage failures return `rule-storage-unavailable`. A caller cannot select another principal's storage key through any API field. The internal key prefix is `chatqueue:external-rules:v1:`, followed by Firefox's verified `sender.id`.

If a background write was already committed when access was revoked, it cannot be undone retroactively. Revoking `rules` blocks subsequent reads/writes and suppresses rule-change notifications, including late completions of in-flight writes. The `rulesChanged` event exposes only a revision integer (no IDs, rule texts, events, routes or tokens). Installed rules are **inert**: `rulesPut` does not attach them to Chat Signals or trigger a queue mutation, Start or Send.

Native synthetic Firefox Developer Edition tests verify persistence, exact revisions, concurrent writes, `rulesChanged` metadata and revocation. See [rules QA](tests/fde-api.cjs) and [conditional contract](docs/CONDITIONAL-RULES.md). These are not authenticated ChatGPT rule-execution tests.

## Preview-only conditional message contract (no dispatch)

The separately granted `previewRules` request accepts caller-supplied typed rules and Signal-shaped **simulated** events and returns a proposed decision. It does not read current Chat Signals provider events, conversation text, queue state, or browser storage. No automatic or manual Send is available through this action. Future versions may expose rules such as `when: {phase:'finished'}`, `when:{phase:'failed'}`, or `when:{phase:'interrupted',minDurationMs:5000}`. They will be evaluated per response epoch and scoped conversation, with policy-specific action caps, priority and manual approval for risky retries. **Do not** interpret v1 message fields as executable predicates. No content-based success evaluation currently exists.

Preview-only duration filters accept optional `when.minDurationMs` / `when.maxDurationMs` on a rule and `context.stateDurationMs` on a preview request (integer 0–3,600,000). A filtered rule does not match when context is absent or outside its range. This context is **caller-supplied synthetic evidence**, not an authenticated ChatGPT clock. The `rules` grant still conveys no authority to enqueue, start or send messages.

Dependency/skip preview: rules may include `when.dependsOn` / `when.skipIf` lists with up to eight exact IDs per list. `context.completedRuleIds` is an optional, bounded list (maximum 32, distinct) of IDs referencing rules in the **same caller-provided simulated ruleset**. It is not a trusted completion history. Missing dependencies fail closed; self-links, cycles, dangling or conflicting references reject the ruleset. The Options sandbox and pure API expose proposals only and do not mutate queue state.

## 🔐 Grant changes during in-flight requests

When an extension grant changes while a background authorization read is pending, Chat Queue rejects that operation with `authorization-changed`, even if the older policy would have allowed it. Discovery event ports pending connection are disconnected rather than being activated under stale permissions. A private `status` response already in flight is also discarded if the grant record changes before its response returns, preventing late disclosure of prompt text. Clients should refresh capabilities after a grant change and obtain fresh status instead of treating this rejection as a transport failure.

**Mutating operations already delivered to a queue tab cannot be cancelled retroactively.** Their actual result is returned, rather than reporting a fictitious rejection after a change may have happened. Callers must not automatically replay an operation whose completion is uncertain. This is a narrow revocation/response privacy hardening, not a distributed transaction guarantee.

## Version negotiation and stable error handling

The wire **request protocol** is identified by `type: "chat-queue/v1"` (protocol version **1**). This is distinct from the **grant policy schema version 2** stored under `chatqueue:api-grants:v2`.

For backwards compatibility, `capabilities` retains `version:2` (the historical grant schema number) and adds `protocolVersion:1` and `grantVersion:2`. New consumers should check `protocolVersion` explicitly before using mutations. The subscription events `ready` and `stateChanged` carry `{type:"chat-queue/v1", protocolVersion:1, event:...}`. These fields are additive; existing v1 clients ignoring them continue to work. No private prompt, route or authenticated provider token is included in either subscription event.

All handled API errors return `{ok:false,error:"string-code"}`. Known error categories include: `unauthorized`, `forbidden-scope`, `authorization-changed`, `request-too-large`, `invalid-request`, `invalid-order`, `tab-not-registered`, `tab-unavailable`, `revision-conflict`, and protected route/Signal errors. Additional specific codes may appear in minor releases. Treat unknown errors as failures, **not** as retry authorization. Requests with an unsupported wire `type` are not dispatched; clients must never silently retry them as v1 mutations. An uncertain mutation response must not be blindly replayed.

A real synthetic Firefox Developer Edition client now asserts the protocol/grant version distinction and a versioned `ready` event. Pure background tests also verify `stateChanged` version metadata and the absence of prompt/history fields. This does not establish a real authenticated ChatGPT Send.

### Uncertain-item mutation rule

Only pending messages can be updated or removed through ordinary `update`/`remove`. A `clear` request refuses to erase a queue containing any `uncertain` item. These actions return `resolve-uncertain-message` without modifying storage when uncertain material would be affected. Explicit `resolve` with `retry` or `discard` is the only permitted way to clear uncertainty; neither decision implicitly Starts the scheduler or authorizes another Send.
