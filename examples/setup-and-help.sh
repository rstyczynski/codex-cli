#!/usr/bin/env bash
set -euo pipefail

# This example does not start Codex. It verifies the three commands needed by
# the other examples and shows where to discover all supported options.
for command_name in node codex codex-cli; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'missing command: %s\n' "$command_name" >&2
    if [[ "$command_name" == codex-cli ]]; then
      printf '%s\n' 'from the repository root, run: export PATH="$PWD/bin:$PATH"' >&2
    fi
    exit 1
  fi
done

printf 'Node.js: '
node --version
printf 'Codex: '
codex --version
printf 'Codex authentication: '
codex login status
printf 'codex-cli: %s\n\n' "$(command -v codex-cli)"

codex-cli --help
