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

codex-cli --broker --new --timeout 120 \
  "Remember the label thread-example and reply with that label only."

printf '\nThreads (tab-separated):\n'
codex-cli --broker threads

printf '\nThreads (one JSON object per line):\n'
codex-cli --broker threads --json

# Pass an ID printed above to demonstrate strict explicit selection:
#   ./examples/threads.sh 019abc...
if (( $# > 0 )); then
  codex-cli --broker --thread "$1" --timeout 120 \
    "Reply with the label you were asked to remember."
else
  printf '\nPass a thread ID as the first argument to continue it explicitly.\n'
fi
