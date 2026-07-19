#!/usr/bin/env bash
set -euo pipefail

broker_started_here=false
if ! codex-cli --broker status >/dev/null 2>&1; then
  codex-cli --broker start
  broker_started_here=true
fi

cleanup() {
  if [[ "$broker_started_here" == true ]]; then
    codex-cli --broker stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Automatic approval is appropriate only in a controlled sandbox. Decisions
# are appended to the TOML audit log when Codex requests approval.
codex-cli --broker --new \
  --approval accept \
  --approval-log .codex-cli/example-approvals.toml \
  --timeout 120 \
  "Use a read-only shell command to print the Node.js version, then report it."

# --interactive handles Codex protocol questions in a real terminal. This
# branch is skipped when the example is run by CI or with redirected input.
if [[ -t 0 && -t 1 ]]; then
  codex-cli --broker --interactive --timeout 120 \
    "Ask me one structured multiple-choice question about preferred output verbosity, then acknowledge my choice."
else
  printf 'interactive question skipped because no terminal is attached\n' >&2
fi
