#!/usr/bin/env bash
set -euo pipefail

# A normal broker prompt already resumes the saved thread. This example shows
# how to retrieve its opaque ID for a script and insert it into prompt input.
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

if ! one_off_target_id=$(codex-cli --broker --current-thread 2>/dev/null); then
  codex-cli --broker --new --thread-params '{"sandbox":"read-only"}' \
    'Confirm that this new thread is ready for a read-only continuation.'
  one_off_target_id=$(codex-cli --broker --current-thread)
fi

# Create a distinct saved-current thread. This makes the later state assertion
# meaningful: accidentally implementing --thread as a switch would restore the
# older target ID and fail the check.
printf 'one-off target ID: %s\n' "$one_off_target_id"
codex-cli --broker --new --thread-params '{"sandbox":"read-only"}' \
  'Create a distinct saved-current thread for the one-off targeting example.'
saved_current_id=$(codex-cli --broker --current-thread)
if [[ "$saved_current_id" == "$one_off_target_id" ]]; then
  printf 'the example did not create a distinct saved-current thread\n' >&2
  exit 1
fi

printf 'saved current thread ID: %s\n' "$saved_current_id"
codex-cli --broker \
  --prompt 'State the saved workspace thread ID inserted here: <thread_id>'

# <thread_id> always means the saved workspace selection, not the temporary
# target selected by --thread.
codex-cli --broker --thread "$one_off_target_id" \
  'Confirm that this prompt targets the older conversation only once.'
if [[ $(codex-cli --broker --current-thread) != "$saved_current_id" ]]; then
  printf 'one-off --thread unexpectedly changed saved state\n' >&2
  exit 1
fi

# In an interactive Bash shell, load the generated completion and use:
#   codex-cli --thread <Tab>
# Completion quotes a label as one Bash argument. Labels are useful
# interactively, but scripts should capture and pass the full UUID.
# A temporary target leaves the saved current thread unchanged:
#   codex-cli --broker --thread "$one_off_target_id" 'Ask one question in that thread.'
# A persistent target changes the saved current thread only after its prompt
# completes:
#   codex-cli --broker --thread-switch "$one_off_target_id" --thread-label 'Sprint 18' 'Continue this thread from now on.'
# A native label is also a selector; completion matches names and ID prefixes:
#   codex-cli --broker --thread 'Sprint 18' 'Ask one question in that named thread.'
# A label is selection metadata; it does not validate the conversation's
# history or summary.
