#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  printf 'run this example with Bash\n' >&2
  exit 1
fi

# The generated script registers option-aware completion for codex-cli, cdx,
# and hiai. It also defines each command when that name is not installed; the
# generated hiai function selects broker mode like the installed launcher.
# The generated completion is intentionally dynamic. Command substitution also
# works with the Bash 3.2 shipped by macOS, where sourcing process substitution
# can yield an unreadable /dev/fd path.
eval "$(codex-cli --bash_completion)"

printf 'completion definition:\n'
complete -p codex-cli
complete -p cdx
complete -p hiai
printf '\nTry typing: cdx --model <Tab>, hiai --thread <Tab>, or hiai --prompt \\<clip<Tab>\n'
