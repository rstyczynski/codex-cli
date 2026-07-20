#!/usr/bin/env bash
set -euo pipefail

# Copy text or an image before running this example. <clipboard> is expanded by
# codex-cli, not by the shell, and is inserted into this one read-only turn.
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

codex-cli --broker --new \
  --thread-params '{"sandbox":"read-only"}' \
  --prompt 'Describe <clipboard> concisely. Do not modify files.'
