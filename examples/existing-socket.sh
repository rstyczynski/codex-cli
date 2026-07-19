#!/usr/bin/env bash
set -euo pipefail

# Another process must own the app-server lifecycle. Pass its Unix socket path:
#   ./examples/existing-socket.sh /path/to/app-server.sock
# For Codex's managed daemon, the corresponding first invocation is:
#   codex-cli --start-daemon --new "Start a managed-socket thread"
if (( $# != 1 )); then
  printf 'usage: %s APP_SERVER_SOCKET\n' "$0" >&2
  exit 2
fi

socket_path=$1
if [[ ! -S "$socket_path" ]]; then
  printf 'not a Unix socket: %s\n' "$socket_path" >&2
  exit 2
fi

state_path=.codex-cli/socket-example-state.json
codex-cli --socket "$socket_path" --state "$state_path" --new --timeout 120 \
  "Reply with: connected through the supplied app-server socket"

# The saved state lets a later invocation omit both --new and --thread.
codex-cli --socket "$socket_path" --state "$state_path" --timeout 120 \
  "Reply with: continued the socket thread"
