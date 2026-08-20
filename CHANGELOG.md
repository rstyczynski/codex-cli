# Changelog

## 1.1.0

- Make thread targeting deterministic and script-safe across broker and socket
  transports and across CLI, environment, and JSON-configuration sources:
  `--thread` is always one-off, while `--thread-switch` persists only after a
  completed turn. Treat `thread`, `threadSwitch`, and `new` as one
  precedence-aware, mutually exclusive mode family. Explicit missing or
  ambiguous selectors never create a thread.
- Define the full displayed selector label as the normalized native name, or
  normalized preview when unnamed; resolve in stable order—full UUID, exact
  displayed label, unique UUID prefix, then unique displayed-label fragment—and
  recommend full UUIDs for automation.
- Advertise and require broker support for native thread naming before applying
  `--thread-label`, and delay label mutation until selector, capability, and
  active-turn validation has succeeded. Persist a completed `--thread-switch`
  before applying a combined label update, so a later naming failure does not
  discard the selected current thread.
- Make thread completion side-effect-free and shell-safe: reuse the command's
  implicit workspace, never start a broker, search the complete active and
  archived catalog only for a non-empty typed fragment, cache it for 30
  seconds, and show a delayed spinner during a bounded ten-second first lookup.
  Keep shared-prefix labels safe across repeated Tab presses as one quoted
  argument, preserve UUID-prefix completion, and suggest deduplicated, quoted
  displayed labels for `--thread-label` without substituting IDs.
- Normalize legacy backslash-escaped thread values before lookup, so an older
  copied candidate still resolves its exact native label after being quoted.

- Add `--thread-label LABEL` to set a native Codex thread name for a new,
  one-off, switched, or saved-current broker thread. Thread selectors and Bash
  completion accept labels, label fragments, UUIDs, and UUID prefixes.

- Make retained broker diagnostics opt-in with `--diagnostics`, so ordinary
  request failures retain only their direct error message.

- Add `--current-thread` for machine-readable access to a workspace's saved
  Codex thread ID, and `<thread_id>` prompt expansion at the precise
  input location. Broker expansion honors the invoking client's explicit
  `--state` file through a capability-gated value rather than a broker-side
  filesystem path.
- Complete `--thread` from IDs available through an already-running broker,
  without starting one or emitting completion-time diagnostics.

## 1.0.13

- Recognize retained broker diagnostics for an incompatible upstream Codex
  model cache and provide a concise cache-rebuild recovery instruction without
  mutating global Codex state.

- Decline MCP elicitation requests with the protocol-required
  `{ "action": "decline" }` response across direct and broker transports,
  rather than treating them as command-approval requests.

## 1.0.12

- Preserve an append-only workspace procedure transcript and a crash record for
  active broker procedures interrupted by an app-server or broker-process loss.
- Rejoin the saved Codex thread after every broker restart instead of silently
  opening a replacement conversation; stop with retained recovery evidence if
  the app-server cannot resume it.
- Print the former thread ID and an explicit recovery command when a procedure
  crashes.

## 1.0.11

- Let every Boolean option accept an optional, case-insensitive value: `true`/`false`, `on`/`off`, `1`/`0`, or `yes`/`no`.
- Add Bash completion for Boolean values, including `--interim false`, `--interim off`, `--interim 0`, and `--interim no`.

## 1.0.10

- Reduced default interim noise: `low` now shows assistant updates only, `medium` adds concise reasoning and plans, and raw operational activity is reserved for `high` verbosity.
- Resume the event-driven progress spinner after visible interim output when subsequent activity is hidden.

## 1.0.9

- Resolve an implicit broker workspace to the Git root, or to the user's home directory when invoked outside a Git worktree. An explicit `--cwd` is preserved.

## 1.0.8

- Render live agentic contract messages as their user-facing summaries instead of exposing raw JSON on a normal terminal.

## 1.0.7

- Added `--version` for `codex-cli`, `cdx`, and `hiai`.
- Added default-on `--interim` activity output driven by real Codex and broker events.
- Decoupled `--agentic-error-code` from interim output and JSON event streaming.

## 1.0.6

- Added a terminal-only welcome banner that shows the installed `codex-cli` version.
- Made the progress spinner advance only when Codex or the broker sends an event.

## 1.0.5

- Added support for all app-server approval request methods, including file-change approvals.

## 1.0.4

- Documented the remaining need for transport-wide interactive approval coverage.

## 1.0.3

- Made `--interactive` fail before a turn starts when no terminal is available, instead of silently declining approval and user-input requests.

## 1.0.2

- Allowed a completed agentic run to use explicit exit code `1` when the prompt assigns that code to an observed result.

## 1.0.1

- Made `hiai` enable `--agentic-error-code` by default so its process status reflects the validated agentic result.

## 1.0.0

- Introduced `codex-cli`, a local Codex app-server client for shell automation.
- Added persistent workspace brokers with start, status, stop, and thread-list commands; saved-thread selection; one-turn-at-a-time coordination; and automatic recovery when an implicitly saved broker thread becomes stale.
- Added direct standard-I/O and existing app-server socket transports alongside broker mode, including Windows named-pipe support where applicable.
- Added the `codex-cli`, `cdx`, and `hiai` launchers, Bash completion, and model completion backed by Codex's local catalog cache.
- Added positional, `--prompt`, and standard-input prompts; reusable thread state; `--new`, explicit `--thread`, model selection, and interrupt handling.
- Added structured client configuration: layered home, Git-root, and directory JSON files; `CDXCLI_*` environment overrides; explicit config overlays; and raw thread/turn parameter objects.
- Added safe local image attachments and clipboard prompt actions, with input validation, owner-restricted temporary files, and cleanup.
- Added approval automation, audit logs, and terminal handling of Codex approval and structured user-input requests.
- Added human verbosity levels, progress display, JSONL protocol output, timeout/error diagnostics, and validated agentic result contracts that map prompt outcomes to shell exit statuses.
- Added runnable examples, security-focused validation, and the initial README/quick-start documentation.
