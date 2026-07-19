#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  printf 'run this example with Bash\n' >&2
  exit 1
fi

# The generated script registers option-aware completion. It also defines a
# codex-cli shell function when no executable with that name is installed.
# The generated completion is intentionally dynamic.
# shellcheck disable=SC1090
source <(codex-cli --bash_completion)

printf 'completion definition:\n'
complete -p codex-cli
printf '\nTry typing: codex-cli --model <Tab>\n'
