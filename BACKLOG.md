# Backlog

## Table of Contents

- [Current State](#current-state)
- [Release Versioning Policy](#release-versioning-policy)
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
  - [CDX-17 Welcome Banner and Version](#cdx-17-welcome-banner-and-version)
  - [CDX-18 Version Option](#cdx-18-version-option)
  - [CDX-19 Interim Activity Display](#cdx-19-interim-activity-display)
  - [CDX-20 Interim Reporting Polish](#cdx-20-interim-reporting-polish)
  - [CDX-24 Saved Current-Thread References](#cdx-24-saved-current-thread-references)
  - [CDX-25 Thread-ID Bash Completion](#cdx-25-thread-id-bash-completion)
  - [CDX-26 One-Off Thread Targeting](#cdx-26-one-off-thread-targeting)
  - [CDX-27 Native Codex Thread Labels](#cdx-27-native-codex-thread-labels)
  - [CDX-28 Deterministic Thread Selector Contract](#cdx-28-deterministic-thread-selector-contract)
  - [CDX-29 Safe Thread Completion](#cdx-29-safe-thread-completion)
- [Open](#open)
  - [CDX-6 Upstream Turn-Level Sandbox Enforcement](#cdx-6-upstream-turn-level-sandbox-enforcement)
  - [CDX-7 Install and Release Polish](#cdx-7-install-and-release-polish)
  - [CDX-8 Documentation Tightening](#cdx-8-documentation-tightening)
  - [CDX-16 Transport-Wide Interactive Approval Coverage](#cdx-16-transport-wide-interactive-approval-coverage)
  - [CDX-21 Upstream Model-Cache Incompatibility Recovery](#cdx-21-upstream-model-cache-incompatibility-recovery)
  - [CDX-22 App-Server Compatibility Guard](#cdx-22-app-server-compatibility-guard)
  - [CDX-23 Configured Prompt Extensions](#cdx-23-configured-prompt-extensions)

## Current State

`codex-cli` is now a dependency-free (single file) Node.js terminal client for the local Codex app-server. It supports broker, direct, and managed socket modes; persistent broker threads; one-off and persistent thread selectors by ID or native label; saved-thread ID prompt references; explicit thread naming and listing; approvals and user input; layered JSON client configuration; local PNG/JPEG/WebP/GIF attachments; explicit prompt attachment actions including `<clipboard>` and `<thread_id>`; Bash completion; model completion; rich verbosity levels; debug diagnostics; JSONL output; agentic script exit codes; raw app-server parameter forwarding; and guarded sandbox handling.

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

## Release Versioning Policy

Release versions group related work; they do not advance once for every individual backlog item.

- A coherent group of completed backlog items is released in the next minor version (`1.x.0`). Move each completed item to **Done** and record `Status: implemented in v1.x.0`.
- Backward-compatible bug fixes and regressions released after that feature group use patch versions (`1.x.y`). Move fixed entries from the active section of `BUGS.md` to **Resolved** and record the release version.
- Breaking user-facing changes require the next major version.
- An upstream issue with only a local mitigation remains active in `BUGS.md` and the backlog until the upstream behavior is fixed; describe the mitigation but do not mark it resolved.
- Every versioned release updates `CHANGELOG.md`, tests, and affected documentation/examples before its tag is created.

Release decision for v1.1.0: at the project owner's direction, this minor
release intentionally changes the pre-release `--thread` behavior from a
persistent switch to one-off targeting. Existing callers migrate to
`--thread-switch` when persistence is required. This explicit exception does
not change the major-version rule for future breaking user-facing changes.

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
- Preserve strict behavior for explicit stale thread IDs while allowing
  same-broker implicit stale state to recover automatically.
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
- Same-broker implicit stale state can recover with a new thread. After a
  broker restart, the saved thread is rejoined strictly and an unavailable
  conversation stops with recovery evidence instead of being replaced.

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
- Preserve clean JSON stdout and report effective sources through `--debug` and `--show-config`; default to configured fields while retaining an `all` view.

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
- Complete every registered prompt-action token in Bash, preserving preceding prompt text and correcting unmatched angle-bracket prefixes.
- Cover text/image ordering, helper failures, MIME mismatch, cleanup, state redaction, and direct/broker/socket transport parity with fixture-driven tests.

Design: `model/CDX-14-prompt-attachment-actions.md`.

### CDX-15 hiai Broker Launcher Regression

Status: implemented.

The `hiai` wrapper, npm command, and generated shell fallback now select broker
mode so existing approval handling receives and answers app-server requests.
The launcher path is covered by completion, forwarding, and broker approval
integration tests plus the maintained approval example.

Design: `model/CDX-15-hiai-broker-launcher-regression.md`.

### CDX-17 Welcome Banner and Version

Status: implemented in v1.0.6.

Show a concise welcome banner when `codex-cli` starts, including the installed version. The banner must make the active client version visible without interfering with machine-readable output or scripts.

### CDX-18 Version Option

Status: implemented in v1.0.7.

Add a `--version` option for `codex-cli`, `cdx`, and `hiai`. It must print only the installed version to standard output and exit successfully, without a welcome banner or other operational output.

### CDX-19 Interim Activity Display

Status: implemented in v1.0.7.

Present real interim Codex work events next to the progress indicator while a turn is running, such as plans, commands, file changes, tool calls, approvals, and errors. Control this with `--interim`, enabled by default; it must not invent progress or interfere with JSON and agentic-script output.

### CDX-20 Interim Reporting Polish

Status: implemented in v1.0.10.

Refine live progress reporting so it keeps the user oriented without flooding the terminal with raw operational events. The current low-verbosity `--interim` experience can show every command start and completion alongside useful assistant updates.

Delivered behavior:

- Keep the spinner active whenever interim messages are hidden, so a quiet turn still visibly makes progress.
- Make `--interim` opt into concise, user-facing status updates rather than raw command telemetry at low and medium verbosity.
- Use `--verbosity high` to additionally show detailed operational activity, including command start/completion and other rich item details.
- Preserve the existing guarantees for `--json`, `--agentic-error-code`, redirected stderr, and no invented progress.
- Define and test the full `--interim` × verbosity visibility matrix, including spinner clearing and resuming around visible output.

### CDX-24 Saved Current-Thread References

Status: implemented in v1.1.0.

Expose the current `codex-cli`-managed thread from its saved
`.codex-cli/codex-cli.json` state when a caller needs the opaque ID itself.
Normal prompt execution already reuses that saved thread by default.

Delivered:

- `--current-thread` prints the saved `threadId` only and fails without valid
  saved state.
- `<thread_id>` expands to that ID in direct and broker prompt input,
  preserving ordering and action digests and honoring the invoking client's
  explicit `--state` file in both transports.

### CDX-25 Thread-ID Bash Completion

Status: implemented in v1.1.0.

Complete `--thread` and `--thread-switch` values from threads available through
the selected codex-cli broker, so callers do not need to copy opaque IDs
manually.

Delivered:

- Completion queries only an existing broker, shows a delayed spinner while a
  first full-catalog lookup is running, and produces no output when it is
  unavailable.
- Completion presents native names/previews, matches ID prefixes and label
  fragments, and is disabled for `--new`, direct, and socket invocations.
- Tests cover live results, missing brokers, prefixes, and incompatible modes.

### CDX-26 One-Off Thread Targeting

Status: implemented in v1.1.0.

Separate temporary thread targeting from changing the workspace's saved current
thread.

Delivered:

- `--thread SELECTOR` sends one prompt to the selected thread without changing
  `.codex-cli/codex-cli.json`.
- `--thread-switch SELECTOR` sends one prompt and persists that thread as the
  workspace current thread.
- Both selectors support ID prefixes and thread name/preview fragments, with
  ambiguity rejected.

### CDX-27 Native Codex Thread Labels

Status: implemented in v1.1.0.

Name Codex threads from the CLI and use those names as convenient selectors.

Delivered:

- `--thread-label LABEL` calls Codex's native thread-name API for `--new`,
  `--thread`, `--thread-switch`, or the saved current broker thread.
- `--thread` remains one-off; `--thread-switch` still persists the selected
  thread. Both accept UUIDs, UUID prefixes, labels, and label fragments.
- Bash completion presents native names and matches both IDs and labels.

### CDX-28 Deterministic Thread Selector Contract

Status: implemented in v1.1.0.

Make the `--thread` family deterministic across transports and configuration
sources, with semantics suitable for noninteractive Bash scripts.

Delivered:

- `--thread SELECTOR` is one-off in broker and socket mode and never changes
  the saved current thread; `--thread-switch SELECTOR` changes it only after
  the requested turn completes.
- Command-line, environment, and JSON-configuration selectors share the same
  resolution and persistence rules. `thread`, `threadSwitch`, and `new` are
  mutually exclusive within one source; a higher-precedence selection mode
  replaces a lower-precedence one. An explicit selector that is missing or
  ambiguous fails instead of creating or choosing a thread.
- A displayed selector label is the full normalized native name when present,
  otherwise the full normalized preview; a native name therefore hides its
  older preview. Selectors resolve in a documented order: full UUID, exact
  displayed label, unique UUID prefix, then unique displayed-label fragment.
  Full UUIDs remain the stable interface recommended for scripts; ambiguity
  exits 65, a missing or stale selector exits 66, and an empty selector is a
  usage error (2 normally, or system-error status 70 with
  `--agentic-error-code`).
- Thread-label operations require an advertised broker capability, so a client
  cannot silently send them to an older broker that would ignore the field.
- Label mutation happens only after selector, capability, and active-turn
  checks; saved thread switching is committed only after turn completion and
  before a subsequent label RPC, so a naming failure does not roll it back.
- A native thread label is selection metadata only. It neither validates nor
  replaces the conversation's stored history or summary.

### CDX-29 Safe Thread Completion

Status: implemented in v1.1.0.

Make label-oriented completion convenient at the terminal without changing
state or producing unsafe command lines.

Delivered:

- Completion uses the same implicit workspace selection as the command and
  queries only an already-running broker; pressing Tab never starts one.
- A non-empty ID prefix or label fragment searches the complete active and
  archived catalog. Matching rows are cached for 30 seconds in both the broker
  and current Bash process, avoiding a full global thread scan on every key
  press; an empty value never dumps the whole catalog.
- Completed labels are shell-quoted as one argument, including whitespace,
  apostrophes, glob characters, substitutions, and other shell metacharacters.
- Shared label prefixes can be narrowed with more text and another Tab press
  while remaining one quoted selector argument.
- An ID-prefix query completes to the full UUID rather than replacing it with
  a potentially duplicated label. Label fragments still complete to readable
  labels for interactive use.
- The first lookup is bounded to ten seconds and displays `Searching Codex
  threads…` after 0.2 seconds, rather than failing silently at an arbitrary
  one-second cutoff.
- `--thread-label` suggests deduplicated displayed labels, including with
  `--new`, without ever substituting a thread ID for the requested new name.
- A real Bash/Readline PTY regression executes repeated shared-prefix
  completion and a metacharacter-heavy label, verifying one selector argument
  and no filename fallback. Integration coverage also checks workspace
  selection, broker-start side effects, duplicate labels, and ID-prefix
  preservation.

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

### CDX-16 Transport-Wide Interactive Approval Coverage

Status: open.

`v1.0.3` fixed a transport split where `--interactive` prompted for command
approval in direct mode but silently declined it in existing app-server socket
mode. Broker mode has its own request/response bridge. Current tests verify
the non-terminal fail-closed behavior for broker and socket transports, but do
not drive a real terminal prompt across every transport.

Remaining work:

- Add portable PTY-backed integration coverage for `accept` and `decline` in
  direct, broker, and existing-socket modes.
- Keep a non-terminal assertion that `--interactive` fails before a turn
  starts, rather than silently supplying an approval decision.
- Verify that interactive handling answers Codex protocol requests only and
  never forwards terminal input to child commands.
- Document any platform-specific PTY limitations or test skips explicitly.

### CDX-21 Upstream Model-Cache Incompatibility Recovery

Status: mitigated locally; upstream bug remains open.

Observed behavior: an older `~/.codex/models_cache.json` lacking mandatory
model metadata such as `base_instructions` causes the upstream
`codex_models_manager` to log repeated TTL-refresh and cache-load errors. The
app-server does not automatically discard the invalid snapshot and refetch it.

Remaining work:

- Track the upstream `models-manager` fix that deserializes legacy model
  records or invalidates incompatible cache files.
- Keep the regression fixture for the known diagnostic and the local recovery
  guidance: stop Codex, rename/remove `~/.codex/models_cache.json`, and
  restart.
- Keep automatic cache deletion opt-in; the client must not mutate global
  Codex state without explicit user authorization.

### CDX-22 App-Server Compatibility Guard

Status: open.

Prevent upstream `codex app-server` interface and runtime changes from
becoming ambiguous broker failures.

Remaining work:

- Capture `codex --version` when starting a broker and retain it in broker
  metadata; restart rather than reuse a broker after the binary changes.
- Define and test a supported upstream-version policy, with a clear warning
  for untested versions rather than an unsupported claim of compatibility.
- Continue capability/config-requirement negotiation before optional behavior,
  and add coverage for unavailable or changed capabilities.
- Classify known fatal child diagnostics during startup and return a stable
  error code and remediation, while retaining the stderr tail for diagnosis.

### CDX-23 Configured Prompt Extensions

Status: open.

Support an explicit `promptExtension` field in `.codex-cli/config.json` for
stable, reusable instructions appended to each user-supplied prompt. The
existing `prompt` field must remain unsupported in configuration so a
repository configuration cannot silently replace the caller's task.

Remaining work:

- Define the JSON shape, precedence, ordering, and exact prompt-boundary
  formatting for `promptExtension`.
- Make the extension visible through `--show-config`, `--debug`, and the
  existing source/risk reporting; warn when it is auto-discovered from a Git
  or directory configuration file.
- Apply it identically in direct, broker, and existing-socket transports,
  including timed-out-turn reattachment matching and agentic-result contracts.
- Add configuration-validation, precedence, transport-parity, and output
  redaction tests; document how users can disable or override it per command.
