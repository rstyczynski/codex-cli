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
  "Reply with: lifecycle example initialized"

printf '\nBroker status:\n'
codex-cli --broker status
printf '\nWorkspace-scoped broker files:\n'
ls -la .codex-cli/codex-cli-broker.sock \
  .codex-cli/codex-cli-broker.pid \
  .codex-cli/codex-cli.json

# Restart only a broker this example owns. Restarting a pre-existing broker
# would disrupt another user's active workspace session.
if [[ "$broker_started_here" == true ]]; then
  codex-cli --broker stop
  codex-cli --broker start
  printf '\nBroker restarted after code/config changes; the next implicit prompt rejoins the saved thread.\n'
fi
