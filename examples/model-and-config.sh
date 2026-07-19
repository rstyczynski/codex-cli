#!/usr/bin/env bash
set -euo pipefail

broker_started_here=false
if ! codex-cli --broker status >/dev/null 2>&1; then
  if [[ "${EXPERIMENTAL_API:-false}" == true ]]; then
    # Experimental app-server fields must be enabled when the broker starts.
    codex-cli --broker start --experimental-api
  else
    codex-cli --broker start
  fi
  broker_started_here=true
fi

cleanup() {
  if [[ "$broker_started_here" == true ]]; then
    codex-cli --broker stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
model_args=()

# Choose an installed model without hard-coding a catalog entry:
#   CODEX_MODEL=gpt-5.6-sol ./examples/model-and-config.sh
if [[ -n "${CODEX_MODEL:-}" ]]; then
  model_args=(--model "$CODEX_MODEL")
fi

# Repeated raw-parameter options are shallow-merged from left to right.
codex-cli --broker --new \
  "${model_args[@]}" \
  --config-json "$script_dir/codex-overrides.json" \
  --thread-params "@$script_dir/thread-params.json" \
  --thread-params '{"serviceTier":"fast","sandbox":"read-only"}' \
  --turn-params "@$script_dir/turn-params.json" \
  --timeout 120 \
  --prompt "Read package.json and give a concise overview of its npm scripts. Do not change files."

# --clear-model removes only codex-cli's remembered model override.
if [[ -n "${CODEX_MODEL:-}" ]]; then
  codex-cli --broker --clear-model --timeout 120 \
    "Now name the package and its version from package.json. Do not change files."
fi
