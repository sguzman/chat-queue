# 🧬 Reference and provenance review

Checked 2026-10-23:

- [Jobflick Bridge README](https://github.com/sguzman/jobflick-bridge/blob/main/README.md): independent standalone Firefox Developer Edition extension, small browser UI, separate local lifecycle, isolated QA profile, direct `main` commits, conservative send side effects.
- [Jobflick Bridge roadmap](https://github.com/sguzman/jobflick-bridge/blob/main/ROADMAP.md) and [progress ledger](https://github.com/sguzman/jobflick-bridge/blob/main/progress.json): stable task IDs, emoji milestones/phases, evidence-backed percentages, separate implemented/verified statuses, no untested 100% claims.
- [Jobflick Bridge QA](https://github.com/sguzman/jobflick-bridge/blob/main/docs/QA.md): automated disposable headless Firefox Developer Edition plus stricter authenticated site gates. Its Native Messaging, command validation and Fish executor are *not* applicable to Chat Queue.
- [Chat Signals](https://github.com/sguzman/chat-signals): as of v0.3.13, phase written to `document.documentElement.dataset.chatSignalsState`; observer has distinct response epochs, uncertainty and historical restores, but root attribute does not publish those details. Chat Queue must consume provider signals, not duplicate their inference.
- Prior locally supplied `chat-queue-prototype-source.zip`: new-project implementation reference: small browser extension with HUD, queue model and permissioned external messaging. Reused here as prototype implementation; its local Node test results do not establish authenticated browser operation.

Only use public reference concepts and independent implementation. No Jobflick/Chat Signals source is copied into this repository, and no private browsing captures or transcripts are committed.
