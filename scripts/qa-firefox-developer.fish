#!/usr/bin/env fish
# Open a dedicated Firefox Developer Edition QA profile; do not touch personal profiles.
if not command -sq firefox-developer-edition
    echo "Firefox Developer Edition is required (firefox-developer-edition)" >&2
    exit 2
end
set -l data_dir "$HOME/.local/share"
if set -q XDG_DATA_HOME
    set data_dir "$XDG_DATA_HOME"
end
set -l root "$data_dir/chat-queue-fde-qa"
set -l profile "$root/profile"
if test -L "$root"; or test -L "$profile"
    echo "Refusing symlink at QA profile boundary" >&2
    exit 2
end
if test -e "$root"; and not test -d "$root"
    echo "Invalid QA profile root" >&2
    exit 2
end
mkdir -p -- "$profile"; or exit 1
chmod 700 -- "$root" "$profile"; or exit 1
set -l source_root (realpath -- (dirname (status filename))/..); or exit 1
if not test -r "$source_root/manifest.json"
    echo "Missing extension manifest" >&2
    exit 2
end
echo "QA manifest: $source_root/manifest.json"
echo "Dedicated QA profile: $profile"
echo "No extension or native host will be installed automatically."
exec firefox-developer-edition --no-remote --profile "$profile" "about:debugging#/runtime/this-firefox"
