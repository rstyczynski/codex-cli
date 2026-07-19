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

prompt=$(cat <<'__PROMPT'
Inspect package.json without changing files and determine whether it defines an npm test script.
The goal is achieved when that fact has been determined from the file.

Agentic exit-code rules, evaluated in this order:
- Use code 2 if package.json exists but has no test script.
- Otherwise use code 0 when the goal is achieved.
- Use code 1 if the fact cannot be determined.
__PROMPT
)

# Capture nonzero agent outcomes explicitly so `set -e` does not exit early.
if summary=$(codex-cli --broker --new --timeout 120 \
  --agentic-error-code --prompt "$prompt"); then
  status=0
else
  status=$?
fi

if (( status >= 16 )); then
  printf 'codex-cli system failure (%d): %s\n' "$status" "$summary" >&2
elif (( status == 0 )); then
  printf 'test script found: %s\n' "$summary"
elif (( status == 2 )); then
  printf 'package found, but no test script: %s\n' "$summary"
else
  printf 'goal not achieved (%d): %s\n' "$status" "$summary" >&2
fi

exit "$status"
