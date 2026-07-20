#!/usr/bin/env bash
set -euo pipefail

# Demonstrate every CDX-11 configuration layer without contacting Codex.
temporary=$(mktemp -d "${TMPDIR:-/tmp}/codex-cli-config.XXXXXX")
cleanup() {
  rm -rf "$temporary"
}
trap cleanup EXIT

home="$temporary/home"
project="$temporary/project"
directory="$project/service"

mkdir -p "$home/.codex-cli" "$project/.codex-cli" "$directory/.codex-cli"
git init --quiet "$project"

printf '%s\n' '{"timeout":15,"threadParams":{"fromUserConfig":true}}' \
  > "$home/.codex-cli/config.json"
printf '%s\n' '{"timeout":30,"verbosity":"low","threadParams":{"fromGitConfig":true}}' \
  > "$project/.codex-cli/config.json"
printf '%s\n' '{"timeout":45,"threadParams":{"fromDirectoryConfig":true}}' \
  > "$directory/.codex-cli/config.json"
printf '%s\n' '{"timeout":60,"threadParams":{"fromEnvironmentConfig":true}}' \
  > "$directory/ci.json"
printf '%s\n' '{"timeout":75,"threadParams":{"fromExplicitConfig":true}}' \
  > "$directory/invocation.json"

printf '%s\n' 'Configured values: automatic files, CDX_CONFIG, --config, environment, then CLI.'
(
  cd "$directory"
  HOME="$home" \
    CDX_CONFIG=ci.json \
    CDXCLI_TIMEOUT=90 \
    codex-cli \
      --config invocation.json \
      --timeout 120 \
      --thread-params '{"fromCli":true}' \
      --show-config set
)
