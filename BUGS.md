# Bugs

- Upstream app-server still allows workspace file edits when `sandbox: "read-only"` is supplied only to `turn/start`. `codex-cli` now fails closed for existing-thread `--turn-params sandbox` usage and promotes it to `thread/start` for `--new` runs.

## Open

- Broker startup cannot safely use a long Unix-domain socket path by default.
  On macOS, a normal temporary test-fixture path exceeded the socket limit and
  `codex-cli --broker start` failed with `broker socket path is too long`.
  The CLI detects the condition but requires every caller to select a short
  `--broker-socket`; it should choose a safe per-user temporary socket path, or
  offer an automatic fallback. Sprint 9 worked around this with
  `/tmp/tfg-codex-cli.*/b.sock`.

- `--agentic-error-code` appends its completion-contract prose to every
  effective user message. This remains true when callers provide the contract
  centrally through `--config-json` `developer_instructions`. It preserves a
  natural local prompt file but pollutes the Codex thread transcript and makes
  centralized prompt injection incomplete. Prefer enforcing the result through
  `turn/start.outputSchema` and configuration without modifying each operator
  message.

- Codex model-cache compatibility can emit repeated errors such as `failed to
  load models cache: missing field supports_reasoning_summaries`. Sprint 9
  prompts still completed, so this is non-fatal, but the CLI reports it as an
  error on ordinary runs. This likely belongs to the upstream Codex
  model-cache schema; codex-cli should either tolerate/refresh incompatible
  cache entries or clearly classify the diagnostic as upstream and recover.

## Resolved

- Fixed locally: broker startup now honors the caller timeout and retains up to
  4 KiB of detached-child stderr for a readiness timeout, rather than silently
  failing after 60 seconds with no diagnostic.

- Fixed in `v1.0.8`: default-on interim display exposed streamed `--agentic-error-code` contract JSON directly to people using `hiai`, instead of showing useful progress. It now displays only each message's summary; raw protocol data remains available through `--json`.
- Fixed in `v1.0.9`: an implicit `hiai --broker start` could inherit `/` as its workspace and attempt to create `/.codex-cli`. Broker state now resolves to the Git root, or to the user's home directory outside Git; `--cwd` remains authoritative.
- Fixed in `v1.0.7`: `--agentic-error-code` suppressed streamed assistant deltas, coupling OS exit-status handling to presentation. It now controls only the final process status while interim output and JSON event streaming remain independently configurable.
- Fixed in `v1.0.6`: the progress spinner advanced on an independent timer even when Codex had sent no event, falsely implying live work. It now advances only when Codex or the broker sends an event.
- Fixed in `v1.0.5`: `codex-cli` previously declined `item/fileChange/requestApproval` because it accepted only command-execution approval requests. Every app-server approval request now honors the configured policy, while unrelated request methods remain denied.
- Fixed in `v1.0.3`: `--interactive` silently declined approval and user-input requests when standard input was not a terminal. It now fails before starting a turn and explains that it needs a terminal.
- Fixed in `v1.0.1`: `hiai` selected broker mode but left agentic exit-code mode disabled, so a completed prompt returned status `0` even when its requested outcome was nonzero. `hiai` now adds `--agentic-error-code` by default.
- Fixed in `v1.0.2`: the agentic result validator rejected code `1` with `goal_achieved: true`, even when the prompt explicitly used status `1` for a completed check's failing observed result.
