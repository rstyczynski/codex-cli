#!/usr/bin/env bash
set -euo pipefail

# With no argument, attach the committed sample PNG beside this script.
# Pass a path or set IMAGE_PATH to attach a real screenshot instead.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
image_path=${1:-${IMAGE_PATH:-"$script_dir/image-attachment-example.png"}}

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

# --image is repeatable. This read-only turn sends the prompt and image in one
# user message without copying the image into codex-cli state.
codex-cli --broker --new \
  --thread-params '{"sandbox":"read-only"}' \
  --image "$image_path" \
  --prompt "Describe this image concisely. Do not modify files."
