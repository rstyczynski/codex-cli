# Bugs

- Upstream app-server still allows workspace file edits when `sandbox: "read-only"` is supplied only to `turn/start`. `codex-cli` now fails closed for existing-thread `--turn-params sandbox` usage and promotes it to `thread/start` for `--new` runs.

## Resolved

- Fixed in `v1.0.3`: `--interactive` silently declined approval and user-input
  requests when standard input was not a terminal. It now fails before starting
  a turn and explains that it needs a terminal.
- Fixed in `v1.0.1`: `hiai` selected broker mode but left agentic exit-code mode disabled, so a completed prompt returned status `0` even when its requested outcome was nonzero. `hiai` now adds `--agentic-error-code` by default.
- Fixed in `v1.0.2`: the agentic result validator rejected code `1` with `goal_achieved: true`, even when the prompt explicitly used status `1` for a completed check's failing observed result.
