# 🛡️ Production security audit

Chat Queue runs `node scripts/security-audit.mjs` inside `npm run check` on every commit to `main`. The policy checks **the extension distributed to Firefox**, not tests or examples:

- **Permissions:** storage-only permission; exactly one top-level `https://chatgpt.com/*` content-script match; no optional hosts, page-accessible resources or `externally_connectable` manifest declaration.
- **Identity and disclosure:** the stable Firefox add-on ID and Mozilla `data_collection_permissions.required=["none"]`.
- **Assets and execution:** local Options scripts, no remotely sourced UI assets, inline event-handler attributes, dynamic `eval` / `Function` or dynamic module imports.
- **Network:** production JavaScript cannot introduce `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon` without the audit failing. The only permitted URL literal in production scripts is the ChatGPT origin guard.
- **Dependencies:** the package is private and has no runtime dependencies or dependency-install declaration. CI installs explicitly pinned, QA-only tools separately.

`tests/security-audit.test.js` copies the public extension source into disposable directories and verifies that permission escalation, network code, and a remote Options script are all rejected. These intentionally bad fixtures are never shipped in the production extension.

**Limits:** this is a conservative source-level check, not an independent review of all JavaScript behavior, CSP enforcement, data exfiltration through ChatGPT's own composer, storage corruption, library provenance, extension impersonation, or browser bugs. The live ChatGPT site, real Chat Signals publisher, cross-extension authorization changes, and authenticated Send remain separate adversarial acceptance gates. A malicious or compromised already-authorized extension is outside the static audit's guarantee. The audit itself can be bypassed by changes to its code or to CI; such edits require review.

Do not represent a passing source audit as Mozilla signing, full privacy validation, or permission to run unattended sends in a personal Firefox profile.
