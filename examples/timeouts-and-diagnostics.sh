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

prompt="Inspect package.json and README.md, then give a five-point read-only project tour. Do not change files."

# A timeout stops this client invocation, not the Codex turn. Repeating the
# exact prompt attaches to the active turn instead of creating another one.
if codex-cli --broker --new --debug --timeout 1 --prompt "$prompt"; then
  printf 'The turn happened to finish inside the short timeout.\n'
else
  status=$?
  if (( status == 124 )); then
    printf 'Timed out locally; attaching to the same turn...\n' >&2
    codex-cli --broker --debug --timeout 120 --prompt "$prompt"
  else
    exit "$status"
  fi
fi

# Set INTERRUPT_PENDING=true to cancel an active turn before sending this one.
if [[ "${INTERRUPT_PENDING:-false}" == true ]]; then
  codex-cli --broker --interrupt-pending --timeout 120 \
    "Report which turn replaced the interrupted one."
fi
