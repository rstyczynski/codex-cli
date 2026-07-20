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
  - [CDX-10 Codex Response Comparison](#cdx-10-codex-response-comparison)
  - [CDX-11 Layered Client Configuration](#cdx-11-layered-client-configuration)
  - [CDX-12 Image Attachments](#cdx-12-image-attachments)
  - [CDX-13 cpb-paste Clipboard Utility](#cdx-13-cpb-paste-clipboard-utility)
  - [CDX-14 Prompt Attachment Actions](#cdx-14-prompt-attachment-actions)
  - [CDX-15 hiai Broker Launcher Regression](#cdx-15-hiai-broker-launcher-regression)
- [Open](#open)
  - [CDX-6 Upstream Turn-Level Sandbox Enforcement](#cdx-6-upstream-turn-level-sandbox-enforcement)
  - [CDX-7 Install and Release Polish](#cdx-7-install-and-release-polish)
  - [CDX-8 Documentation Tightening](#cdx-8-documentation-tightening)

## Current State

`codex-cli` is now a dependency-free (single file) Node.js terminal client for the local Codex app-server. It supports broker, direct, and managed socket modes; persistent broker threads; explicit thread selection and listing; approvals and user input; layered JSON client configuration; local PNG/JPEG/WebP/GIF attachments; explicit prompt attachment actions including `<clipboard>`; Bash completion; model completion; rich verbosity levels; debug diagnostics; JSONL output; agentic script exit codes; raw app-server parameter forwarding; and guarded sandbox handling.

The active test suite covers CLI validation, configuration precedence and safety warnings, broker lifecycle, thread resume, explicit not-loaded thread resume, direct mode, socket mode, WebSocket framing, Bash completion, image attachment validation and transport parity, fail-closed clipboard prompt actions, output rendering, agentic result validation, app-server error forwarding, sandbox parameter guarding, and standalone clipboard text/image extraction.

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
- Completion is registered for the `codex-cli`, `cdx`, and `hiai` command names.
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

### CDX-10 Codex Response Comparison

Status: implemented as the opt-in `npm run test:parity` integration suite.

Delivered:

- Compare fresh direct Codex and broker-mode `codex-cli` runs under equivalent read-only conditions.
- Version representative arithmetic, workspace-reading, and detailed code-review prompts with observable criteria.
- Record stdout, stderr, exit status, duration, workspace digests, environment metadata, and semantic rubric results under ignored `tests/results/parity/` artifacts.
- Support focused runs through `CODEX_PARITY_CASE` and configurable command timeouts.

Design: `model/CDX-10-codex-response-comparison.md`.

### CDX-11 Layered Client Configuration

Status: implemented with automatic user/Git/directory discovery, `CDX_CONFIG`,
repeatable `--config`, source-aware `--show-config`, and CLI-over-environment
precedence.

Delivered:

- Validate configuration JSON against public camelCase client option names.
- Resolve configuration-relative paths from their declaring file.
- Shallow-merge `threadParams` and `turnParams` while tracking winning sources.
- Warn before thread creation when auto-discovered project settings widen authority or contain opaque raw fields.
- Preserve clean JSON stdout and report effective sources through `--debug` and `--show-config`.

Design: `model/CDX-11-layered-client-configuration.md`.

### CDX-12 Image Attachments

Status: implemented as repeatable `--image PATH` prompt input.

Delivered:

- Validate readable regular PNG, JPEG, WebP, and GIF files from content signatures, with a 20 MiB per-image limit.
- Send Codex 0.144.4-compatible `localImage` turn input items through broker, direct, and existing socket transports.
- Preserve `CDXCLI_IMAGE` then command-line image ordering without allowing image paths in JSON configuration.
- Keep image bytes out of output, metadata, and saved state; debug output is limited to path, MIME type, and size.
- Reattach timed-out broker turns only when the prompt, canonical paths, ordered image digests, and current files match.
- Cover validation, ordering, direct/broker/socket transport parity, completion, output safety, and digest-aware reattachment with synthetic fixtures.

Design: `model/CDX-12-image-attachments.md`.

### CDX-13 cpb-paste Clipboard Utility

Status: implemented as the single-file `bin/cpb-paste` utility.

Delivered:

- Read clipboard text and images through native macOS, Windows, Wayland, and X11 adapters.
- Stream the selected raw representation with no option; image wins when both forms exist.
- Provide explicit `--text`, `--binary`, `--base64`, `--mime`, and `--json` output modes.
- Keep prompt parsing and Codex app-server attachment handling outside the utility.
- Test stream fidelity, mode errors, JSON, MIME selection, backend selection, and help behavior without a machine clipboard.

Design: `model/CDX-13-universal-clipboard-paste.md`.

### CDX-14 Prompt Attachment Actions

Status: implemented with the built-in `<clipboard>` action.

Delivered:

- Parse and validate registered prompt markers before any clipboard, broker, or app-server access; unknown action-shaped markers fail closed.
- Invoke the packaged `cpb-paste` helper as `--mime` followed by the matching `--text` or `--binary` operation.
- Preserve ordered surrounding text and insert clipboard text or a Codex-compatible local image input item in direct, broker, and socket transports.
- Store clipboard images in owner-only `.codex-cli/session/` files; direct/socket clients remove them on exit, brokers remove them on shutdown, and broker startup removes stale leftovers.
- Retain only action digests for active broker-turn matching and keep clipboard bytes out of output, state, and broker metadata.
- Cover text/image ordering, helper failures, MIME mismatch, cleanup, state redaction, and direct/broker/socket transport parity with fixture-driven tests.

Design: `model/CDX-14-prompt-attachment-actions.md`.

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

### CDX-15 hiai Broker Launcher Regression

Status: implemented.

The `hiai` wrapper, npm command, and generated shell fallback now select broker
mode so existing approval handling receives and answers app-server requests.
The launcher path is covered by completion, forwarding, and broker approval
integration tests plus the maintained approval example.

Design: `model/CDX-15-hiai-broker-launcher-regression.md`.
