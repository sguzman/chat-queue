# 🛡️ Production security audit

Chat Queue runs `node scripts/security-audit.mjs` inside `npm run check` on every commit to `main`. The policy checks **the extension distributed to Firefox**, not tests or examples:

- **Permissions and script contexts:** storage-only permission; exactly one `https://chatgpt.com/*` content-script match, fixed isolated-world entrypoints at `document_idle`, fixed Firefox background script list and no unreviewed manifest execution keys such as `world:"MAIN"` or extra workers. No optional hosts, page-accessible resources or `externally_connectable` declaration.
- **Identity and disclosure:** the stable Firefox add-on ID and Mozilla `data_collection_permissions.required=["none"]`.
- **Assets and execution:** local Options scripts, no remotely sourced UI assets, remote CSS URLs, form destinations, inline event-handler attributes, dynamic `eval` / `Function` or dynamic module imports.
- **Network:** production JavaScript cannot introduce `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon` without the audit failing. The only permitted URL literal in production scripts is the ChatGPT origin guard.
- **Dependencies:** the package is private and has no runtime dependencies or dependency-install declaration. CI installs explicitly pinned, QA-only tools separately.

`tests/security-audit.test.js` copies the public extension source into disposable directories and verifies that permission escalation, unreviewed content-script worlds/entrypoints/background workers, network code, remote Options scripts/CSS/form actions and unreviewed local Options scripts are all rejected. These intentionally bad fixtures are never shipped in the production extension.

**Limits:** this is a conservative source-level check, not an independent review of all JavaScript behavior, CSP enforcement, data exfiltration through ChatGPT's own composer, storage corruption, library provenance, extension impersonation, or browser bugs. The live ChatGPT site, real Chat Signals publisher, cross-extension authorization changes, and authenticated Send remain separate adversarial acceptance gates. A malicious or compromised already-authorized extension is outside the static audit's guarantee. The audit itself can be bypassed by changes to its code or to CI; such edits require review.

Do not represent a passing source audit as Mozilla signing, full privacy validation, or permission to run unattended sends in a personal Firefox profile.

## CI action dependency integrity

All third-party GitHub Actions in `.github/workflows/check.yml` are pinned to immutable **40-character Git commit SHAs**, including checkout, Node setup, artifact upload, Firefox Developer Edition setup, and geckodriver setup. `scripts/ci-supply-chain-audit.mjs`, enforced by `npm run check`, allows only those five reviewed action repositories and rejects mutable tags, unknown action owners, `pull_request_target` and broad `permissions: write-all` declarations. `tests/ci-supply-chain-audit.test.js` mutates a disposable copy of the workflow to prove each class of regression fails.

Pinning source commits prevents tag movement from silently changing executed CI steps. It does **not** independently audit the pinned upstream code, Ubuntu runner images, npm registry tarballs, the Firefox binary, system packages, or AMO signing infrastructure. Upgrades must deliberately update and review the pinned commit and audit policy; the static audit must not treat a new repo or tag as trusted solely because it parses.
