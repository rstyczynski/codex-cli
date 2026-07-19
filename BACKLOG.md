# Backlog

## Table of Contents

- [Current State](#current-state)
- [Done](#done)
  - [CDX-1 Terminal Codex App-Server Client](#cdx-1-terminal-codex-app-server-client)
  - [CDX-2 Pragmatic Test Coverage](#cdx-2-pragmatic-test-coverage)
  - [CDX-3 Broker Thread Attach Improvements](#cdx-3-broker-thread-attach-improvements)
  - [CDX-4 Completion Fixes](#cdx-4-completion-fixes)
  - [CDX-5 App-Server Error Surfacing](#cdx-5-app-server-error-surfacing)
  - [CDX-9 Agentic Error Code Contract](#cdx-9-agentic-error-code-contract)
- [Open](#open)
  - [CDX-6 Upstream Turn-Level Sandbox Enforcement](#cdx-6-upstream-turn-level-sandbox-enforcement)
  - [CDX-7 Install and Release Polish](#cdx-7-install-and-release-polish)
  - [CDX-8 Documentation Tightening](#cdx-8-documentation-tightening)

## Current State

`codex-cli` is now a dependency-free (single file) Node.js terminal client for the local Codex app-server. It supports broker, direct, and managed socket modes; persistent broker threads; explicit thread selection and listing; approvals and user input; Bash completion; model completion; rich verbosity levels; debug diagnostics; JSONL output; agentic script exit codes; raw app-server parameter forwarding; and guarded sandbox handling.

The active test suite covers CLI validation, broker lifecycle, thread resume, explicit not-loaded thread resume, direct mode, socket mode, WebSocket framing, Bash completion, output rendering, agentic result validation, app-server error forwarding, and sandbox parameter guarding.

Verification command:

```bash
npm test
```

Coverage command:

```bash
npm run test:coverage
```

Configured coverage thresholds are 90% lines, 70% branches, and 80% functions for `bin/codex-cli`.

## Done

### CDX-1 Terminal Codex App-Server Client

Original goal: enable command-line interaction with a Codex environment from the terminal.

Status: implemented as `bin/codex-cli`.

Delivered:

- Submit prompts from CLI via broker, direct stdio app-server, or managed app-server socket.
- Stream assistant responses to stdout.
- Route diagnostics, approvals, rich item rendering, and debug events to stderr.
- Persist selected broker thread state in `.codex-cli/codex-cli.json`.
- List broker-visible threads, including not-loaded threads from local Codex thread storage.
- Resume explicit not-loaded thread IDs through `thread/resume`.
- Preserve strict behavior for explicit stale thread IDs while auto-recovering implicit stale state.
- Support timeouts that leave turns running and allow exact-prompt reattach.
- Handle approvals, approval logs, structured user-input requests, and noninteractive decline defaults.
- Provide `--verbosity low|medium|high`, `--json`, `--debug`, and progress spinner behavior.
- Provide Bash completion for flags, broker actions, file parameters, approval modes, verbosity, and models.
- Forward `--thread-params`, `--turn-params`, and `--config-json` with CLI-managed field protection.
- Guard sandbox parameters so turn-level sandbox overrides fail closed when app-server does not enforce them.
- Document usage in `bin/README.md`.

### CDX-2 Pragmatic Test Coverage

Status: implemented.

Delivered:

- Unit and integration tests under `tests/*.test.mjs`.
- Fake app-server fixture in `tests/fixtures/fake-codex.mjs`.
- Coverage script with enforced thresholds in `package.json`.
- Coverage around broker state, completions, rich output, WebSocket transport, direct mode, socket mode, app-server error handling, and sandbox guard behavior.

### CDX-3 Broker Thread Attach Improvements

Status: implemented.

Delivered:

- `codex-cli --broker threads` lists visible local threads.
- `codex-cli --broker --thread THREAD_ID ...` resumes explicit not-loaded thread IDs.
- Explicit missing/stale thread IDs report a clear error instead of silently creating a new thread.
- Implicit saved broker state recovers with a new thread after broker restart or stale state.

### CDX-4 Completion Fixes

Status: implemented.

Delivered:

- Bash completion includes `--thread` and `--thread-params` in broker contexts.
- Completion covers public flags and hides internal broker flags.
- Tests cover option names, broker action values, files, executables, models, and script paths with spaces.

### CDX-5 App-Server Error Surfacing

Status: implemented.

Delivered:

- App-server error notifications are printed with useful diagnostics.
- Definitive failures such as authentication/authorization errors exit nonzero.
- Terminal `systemError` turns exit nonzero even when app-server reports an empty completed turn.
- Broker and socket paths have tests for hidden app-server failures.

### CDX-9 Agentic Error Code Contract

Status: implemented as `--agentic-error-code`, with prompt instructions, turn output schema, strict result validation, reserved agentic statuses `0-15`, and wrapper/system statuses `16+`.

Design: `model/CDX-9-prompt-to-script-exit-code-contract.md`.

## Open

### CDX-6 Upstream Turn-Level Sandbox Enforcement

Status: mitigated locally, still an upstream app-server behavior.

Observed behavior: app-server allows workspace file edits when `sandbox: "read-only"` is supplied only to `turn/start`. Thread-level sandbox via `thread/start` does block writes.

Current local mitigation:

- Existing-thread `--turn-params '{"sandbox":"read-only"}'` is rejected.
- New-thread `--turn-params '{"sandbox":"read-only"}'` is promoted to `thread/start`.

Remaining work:

- Track whether a future app-server release enforces `turn/start.sandbox`.
- If fixed upstream, decide whether to remove or relax the wrapper guard.
- Keep `BUGS.md` aligned with the current app-server behavior.

### CDX-7 Install and Release Polish

Status: open.

Potential work:

- Add an install script or documented symlink flow for putting `codex-cli` on `PATH`.
- Add version reporting to `codex-cli --help` or a dedicated `--version`.
- Consider packaging if this is meant to leave the local workspace.

### CDX-8 Documentation Tightening

Status: open.

Potential work:

- Add a short troubleshooting section for authentication failures, broker restarts, stale threads, and sandbox expectations.
- Add examples for attaching to known thread IDs and for safe read-only runs.
- Keep `README.md`, `bin/README.md`, `BUGS.md`, and this backlog consistent after behavior changes.
