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

# --new deliberately replaces the implicitly selected conversation.
codex-cli --broker --new --timeout 120 \
  "Read package.json and summarize the project in one sentence. Do not change files."

# With no --new or --thread, the broker continues its selected thread.
codex-cli --broker --timeout 120 \
  "Now name the available npm scripts. Do not run them or change files."

codex-cli --broker status
