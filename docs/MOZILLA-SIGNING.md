# 🦊 Unlisted Mozilla signing — gated, opt-in path

**Status:** path prepared; no signing attempted, no AMO credentials connected, no release created, and no personal Firefox profile modified.

Most Firefox installations require Mozilla-signed add-ons. The independent Chat Queue package can eventually be signed for **unlisted self-distribution**, not public AMO listing. Mozilla's [current web-ext command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) documents `--channel unlisted`, and the [signing/distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) describes the review/submission rules.

## Acceptance interlock

`npm run release:gate` runs `scripts/release-gate.mjs` and **fails** unless all **95 pre-tag tasks** are marked `verified` with nonempty acceptance evidence and the 96-task inventory/manifest identity remains intact. Only `M7-12` (SemVer tagging) may remain `planned` or `implemented` until signing and independent artifact review finish. When marked `verified`, M7-12 also needs evidence. This narrow exception resolves the circular dependency: tagging follows signing and review, not vice versa. It does **not** claim the ledger cannot be falsified: independent review of the evidence, pinned CI results, built artifact and release commit is still required.

`npm run sign:unlisted` calls the gate **first**. While the gate fails, it does not read credentials, install tools, stage files, contact Mozilla or create any distribution artifact. With 95 pre-tag tasks verified, it requires `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` in the invoking process's environment. These are a one-time explicit Mozilla Developer Hub setup and are never added to `package.json`, the repository, command arguments, printed diagnostics, or a browser profile. Do not paste API tokens into GitHub issues, public chat logs or commits.

After the gate, the signing script runs `npm run check` with **all `WEB_EXT_*` variables removed**, copies **only allowlisted extension files** to a disposable isolated directory, invokes pinned `web-ext@10.8.0 lint --warnings-as-errors`, then invokes `web-ext sign --channel unlisted --no-input` against Mozilla's production signing API. The signed XPI, if obtained, is stored under local `dist/signed` for separate inspection. The staging directory is deleted. The script does **not** install the XPI, modify Firefox profiles, tag a Git commit, publish a GitHub release or add the extension to a public AMO listing.

The command intentionally has no `--force`, bypass switch, generic upload directory or `listed` release mode. Production `src` and `options` source lists are explicit. New asset types or entrypoints must be audited and added to the allowlist before any submission.

## Release sequence (not yet unlocked)

1. Complete every independent project acceptance gate, including real authenticated Chat Signals → Chat Queue event transport, actual ChatGPT Send/completion, error/navigation/restart races, privacy review, Firefox Developer Edition long-running QA and release permissions.
2. Review `progress.json`, `ROADMAP.md`, `git` history, Mozilla lint results, sanitized source and the real Firefox QA evidence. Confirm a stable version number and release scope.
3. Independently acquire Mozilla Developer Hub API credentials. Provide them to the local process via `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` without saving them to public files or logs.
4. Invoke `npm run sign:unlisted` deliberately. Inspect the exact signed XPI from `dist/signed` and confirm it matches the reviewed version and stable add-on ID `chat-queue@sguzman.github`.
5. Only after separate signed-artifact verification may SemVer tagging and distribution be considered. Those are **not** automated by the signing script.

Current CI intentionally runs the *denial* tests: incomplete real ledger fails even when fake test credentials are supplied; a synthetic 95-task pre-tag ledger without credentials also refuses signing. An additional regression proves no other unfinished task can use the M7-12 exception. No test invokes the signing network command, uploads production source to Mozilla or needs a real credential.

This establishes a reproducible opt-in pathway, **not** Mozilla signing acceptance. Unlisted submission can require review and may be rejected. A release cannot be called complete until a real signed artifact and its installation/QA have been independently verified.

The signer additionally strips inherited `WEB_EXT_*` configuration before constructing a dedicated signing-only environment with just the two Mozilla credentials. It pins the submission destination to `https://addons.mozilla.org/api/v5/`, disables `web-ext` config-file discovery and passes no signing secret into the ledger checker, Node test runner or lint subprocess. A fake local `npm` binary verifies this subprocess isolation; no upload occurs in tests.
