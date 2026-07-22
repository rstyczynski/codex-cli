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

# The same prompt can be supplied positionally, with --prompt, or on stdin.
# Low shows assistant updates, medium adds concise plans/reasoning, and high
# also shows command, file-change, and tool telemetry. The spinner remains
# visible for hidden activity between interim messages.
codex-cli --broker --new --verbosity low --progress "Reply with: positional input"
codex-cli --broker --verbosity medium --prompt "Reply with: flag input"
printf '%s\n' 'Reply with: stdin input' | \
  codex-cli --broker --verbosity high --stdin

# Outside agentic mode, --json emits lossless JSONL app-server events. Redirect
# stdout when a script wants to process the stream independently from stderr.
codex-cli --broker --json --prompt "Reply with: JSONL output" \
  > .codex-cli/example-events.jsonl
printf 'raw events written to .codex-cli/example-events.jsonl\n'
