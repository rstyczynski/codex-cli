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

prompt=$(cat <<'PROMPT'
Check whether this machine is ready to run codex-cli.

Do not inspect or modify the current repository, change files, install packages, or alter authentication.

Use only read-only commands to determine the Node.js version, Codex version, and Codex authentication status.

The goal is achieved when readiness has been determined and the observed versions and authentication status have been summarized.

Use normal Codex command execution and do not bypass any required approval.

Agentic exit-code rules, evaluated in this order:
- Use code 2 if Node.js is unavailable.
- Use code 3 if Codex is unavailable or not authenticated.
- Otherwise use code 0 when the machine is ready.
- Use code 1 if readiness cannot be determined.
PROMPT
)

if summary=$(codex-cli \
  --broker \
  --new \
  --approval accept-for-session \
  --verbosity medium \
  --timeout 900 \
  --agentic-error-code \
  --prompt "$prompt"); then
  status=0
else
  status=$?
fi

if (( status >= 16 )); then
  printf 'codex-cli system failure (%d)\n' "$status" >&2
  exit "$status"
fi

echo
echo ===========
echo Result
echo ===========

case "$status" in
  0) printf 'machine ready: %s\n' "$summary" ;;
  1) printf 'readiness unknown: %s\n' "$summary" >&2 ;;
  2) printf 'Node.js unavailable: %s\n' "$summary" >&2 ;;
  3) printf 'Codex unavailable or unauthenticated: %s\n' "$summary" >&2 ;;
  *) printf 'agentic outcome %d: %s\n' "$status" "$summary" >&2 ;;
esac

exit "$status"