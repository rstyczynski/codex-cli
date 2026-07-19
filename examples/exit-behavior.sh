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

# Without --agentic-error-code, any normally completed turn exits zero.
codex-cli --broker --new --timeout 120 \
  "Check whether README.md exists and report the result. Do not change files."
printf 'normal completed-turn status: %d\n' "$?"

# Agentic mode reserves 0-15 for prompt outcomes (except reserved code 13).
# Codes 16 and above describe wrapper/system failures and should usually be
# handled separately.
if result=$(codex-cli --broker --timeout 120 --agentic-error-code --json \
  "Check whether README.md exists. The goal is achieved if its existence is determined. Use code 2 if it is missing."); then
  status=0
else
  status=$?
fi

case "$status" in
  0) printf 'goal achieved: %s\n' "$result" ;;
  1) printf 'goal not achieved: %s\n' "$result" >&2 ;;
  2) printf 'README.md missing: %s\n' "$result" >&2 ;;
  *) printf 'system/operational failure (%d): %s\n' "$status" "$result" >&2 ;;
esac

exit "$status"
