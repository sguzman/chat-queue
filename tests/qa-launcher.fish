#!/usr/bin/env fish
# Exercise the real launcher under a disposable HOME with a mocked binary.
# Never start a real Firefox process or inspect an existing profile.
set -l repo (realpath -- (dirname (status filename))/..)
set -l scratch (mktemp -d)
or exit 1
function cleanup_qa_launcher --on-event fish_exit
    if set -q scratch[1]; and test -n "$scratch"
        rm -rf -- "$scratch"
    end
end
mkdir -p -- "$scratch/bin" "$scratch/home/.mozilla/firefox" "$scratch/data" "$scratch/trap"
or exit 1
printf '%s\n' 'personal profile marker' > "$scratch/home/.mozilla/firefox/marker"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$@" > "$QA_LAUNCH_CAPTURE"' > "$scratch/bin/firefox-developer-edition"
chmod +x -- "$scratch/bin/firefox-developer-edition"
or exit 1
set -gx PATH "$scratch/bin" $PATH
set -gx HOME "$scratch/home"
set -gx XDG_DATA_HOME "$scratch/data"
set -gx QA_LAUNCH_CAPTURE "$scratch/captured-args"
set -l launcher "$repo/scripts/qa-firefox-developer.fish"
fish "$launcher" > "$scratch/output" 2> "$scratch/error"
or begin
    echo 'Disposable Firefox QA launcher refused valid mock setup' >&2
    exit 1
end
set -l qa_root "$scratch/data/chat-queue-fde-qa"
set -l profile "$qa_root/profile"
if not test -d "$profile"
    echo 'QA profile was not created under the disposable data root' >&2
    exit 1
end
if test (stat -c %a "$qa_root") != 700; or test (stat -c %a "$profile") != 700
    echo 'QA profile permissions are not private' >&2
    exit 1
end
set -l args (string split '\n' < "$QA_LAUNCH_CAPTURE")
if not contains -- '--no-remote' $args; or not contains -- '--profile' $args
    echo 'Firefox isolation flags were not forwarded' >&2
    exit 1
end
if not contains -- "$profile" $args; or not contains -- 'about:debugging#/runtime/this-firefox' $args
    echo 'Wrong QA profile or startup destination' >&2
    exit 1
end
if test (cat "$scratch/home/.mozilla/firefox/marker") != 'personal profile marker'
    echo 'Mock personal-profile marker was modified' >&2
    exit 1
end
# The launcher must reject symlinks and never invoke the browser in that case.
rm -rf -- "$qa_root"
ln -s -- "$scratch/trap" "$qa_root"
or exit 1
rm -f -- "$QA_LAUNCH_CAPTURE"
if fish "$launcher" > /dev/null 2> "$scratch/error"
    echo 'Launcher accepted a symlinked QA root' >&2
    exit 1
end
if test -e "$QA_LAUNCH_CAPTURE"; or test -e "$scratch/trap/profile"
    echo 'Symlink rejection occurred only after an unsafe action' >&2
    exit 1
end
rm -- "$qa_root"
mkdir -p -- "$qa_root"
ln -s -- "$scratch/trap" "$profile"
or exit 1
if fish "$launcher" > /dev/null 2> "$scratch/error"
    echo 'Launcher accepted a symlinked QA profile' >&2
    exit 1
end
if test -e "$QA_LAUNCH_CAPTURE"; or test -e "$scratch/trap/profile"
    echo 'Profile symlink check allowed an unsafe action' >&2
    exit 1
end
echo 'Disposable Fish QA launcher: private profile, exact flags, profile-marker protection and symlink rejection pass'
