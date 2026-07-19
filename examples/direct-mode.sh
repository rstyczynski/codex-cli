#!/usr/bin/env bash
set -euo pipefail

# Direct mode owns a short-lived app-server and therefore always needs --new.
# It is isolated from the workspace broker's selected thread.
codex-cli --direct --new --interactive --timeout 120 \
  "Read package.json and describe this project in one sentence. Do not change files."

# A REPL keeps that isolated process open for several terminal turns. Opt in so
# this script remains automation-friendly by default:
#   ./examples/direct-mode.sh --repl
if [[ "${1:-}" == --repl ]]; then
  codex-cli --direct --new --interactive --repl --timeout 120 \
    "Start a read-only review of this workspace."
fi
