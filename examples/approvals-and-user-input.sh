#!/usr/bin/env bash
set -euo pipefail

broker_started_here=false
if ! hiai status >/dev/null 2>&1; then
  hiai start
  broker_started_here=true
fi

cleanup() {
  if [[ "$broker_started_here" == true ]]; then
    hiai stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# hiai selects broker and agentic exit-code modes. Automatic approval is
# appropriate only in a controlled sandbox. Decisions are appended to the TOML
# audit log.
hiai --new \
  --approval accept \
  --approval-log .codex-cli/example-approvals.toml \
  --timeout 120 \
  "Ask to approve one read-only command: sudo -n whoami. Run it exactly once, then report its output or failure without retrying."

# --interactive handles Codex protocol questions in a real terminal. This
# branch is skipped when the example is run by CI or with redirected input.
if [[ -t 0 && -t 1 ]]; then
  hiai --interactive --timeout 120 \
    "Ask me one structured multiple-choice question about preferred output verbosity, then acknowledge my choice."
else
  printf 'interactive question skipped because no terminal is attached\n' >&2
fi
