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

- Upstream Codex model-cache schema incompatibility can emit repeated errors
  such as `failed to renew cache TTL: missing field base_instructions` when
  `~/.codex/models_cache.json` was created by an older schema. The app-server
  continues to retry the invalid cache instead of treating it as a miss and
  replacing it. This remains an upstream `models-manager` defect; clearing the
  cache restores operation. codex-cli now recognizes the retained diagnostic
  when a broker startup or request fails and gives the focused cache-rebuild
  recovery step alongside the raw tail when `--diagnostics` is requested.

- codex-cli currently has no startup compatibility guard for the upstream
  `codex app-server` binary it launches. A changed app-server protocol or
  incompatible local runtime state can appear only as broker stderr after a
  failed or degraded run. Record the upstream version, validate advertised
  capabilities, and reject known fatal startup diagnostics with actionable
  remediation before accepting a broker request.

- Interrupted test runs leak detached fake Codex brokers. The test suite starts
  `codex-cli --broker-serve` with
  `tests/fixtures/fake-codex.mjs app-server --stdio`; normal `t.after()` hooks
  stop them, but an interrupted Node test process bypasses those hooks and
  leaves both the broker and fake child alive indefinitely. Sprint 9 found a
  large population of stale pairs from temporary `codex cli ...` fixture
  directories. Add an interrupt-safe test broker registry/teardown and a
  suite-start stale-fixture cleanup; do not change production broker
  persistence semantics. Fixed locally with a test-only 60-second broker lease
  (`CODEX_CLI_TEST_BROKER_LEASE_SECONDS`) in the standard test command.

- The upstream Codex app-server can fail before broker readiness when its
  SQLite state runtime cannot initialize under `~/.codex`. Sprint 9 observed:
  `failed to initialize sqlite state runtime under /Users/rstyczynski/.codex`.
  `codex-cli` exposes the child stderr with `--diagnostics`, but the caller must
  run from a terminal/sandbox that permits Codex state initialization. This is
  not a broker socket or Terraform workflow failure.

## Resolved

- Fixed locally in v1.1.0: thread-targeting semantics depended on transport and
  option source. Socket `--thread` could overwrite saved state before
  validation, configured or environment `thread` values bypassed label
  resolution, and `threadSwitch` values could behave as one-off targets. The
  broker and socket paths now keep `--thread` one-off and apply
  `--thread-switch` only after a completed turn, regardless of whether the
  selector came from CLI, environment, or JSON configuration. `thread`,
  `threadSwitch`, and `new` are one precedence-aware, mutually exclusive mode
  family across those sources.

- Fixed locally in v1.1.0: fuzzy thread lookup did not prioritize an exact
  label and could report a multi-match UUID prefix as a missing full ID.
  Resolution is now deterministic—full UUID, exact full displayed label,
  unique UUID prefix, then unique displayed-label fragment—and a native name
  hides the thread's older preview. Missing, stale, or ambiguous explicit
  selectors fail without creating a thread, using stable statuses 66 and 65.

- Fixed locally in v1.1.0: thread completion could query a different workspace
  from the eventual command, start a broker as a side effect, scan every
  active and archived thread on each Tab, emit unsafe unquoted shell syntax,
  leave a shared label prefix unsafe to narrow across repeated Tab presses, or
  replace an unambiguous UUID prefix with an ambiguous label. Completion now
  uses the command's implicit workspace, requires an existing broker, searches
  the full active and archived catalog only for a non-empty typed fragment,
  caches it for 30 seconds, keeps repeated label completion in one quoted
  argument, and preserves ID-prefix completion. A delayed spinner makes a
  first slow search visible, with a ten-second upper bound; `--thread-label`
  also returns deduplicated, Bash-quoted displayed labels without inserting
  thread IDs.

- Fixed locally in v1.1.0: the broker protocol did not advertise native
  thread-label support, allowing a newer client to send `threadLabel` to an
  older broker that silently ignored it. The client now requires the broker's
  thread-label capability and reports that the broker must be restarted when
  it is unavailable.

- Fixed locally in v1.1.0: thread naming and switching could mutate state before
  selector, capability, or active-turn validation. A requested label or switch
  is now committed only after the Codex protocol turn reaches `completed`; a
  completed switch is persisted before a subsequent naming request, so a label
  RPC failure cannot silently discard that switch.

- Fixed locally in v1.1.0: every broker failure appended the retained Codex
  stderr tail, even when it was unrelated to the immediate request (for
  example, a failed thread-label lookup). Broker diagnostics are now hidden by
  default and shown only with `--diagnostics`.

- Fixed locally in v1.1.0: broker-side `<thread_id>` expansion used the state
  file selected when the broker started rather than the invoking client's
  explicit `--state` file. The client now passes the already-read saved ID
  through a capability-gated request field, without granting the broker access
  to another client-selected path.

- Fixed locally: a broker could report ready, then die on the first turn when
  its app-server wrote to stderr. The short-lived launcher had destroyed the
  detached broker's stderr pipe after readiness, so that later write could
  raise `EPIPE` and surface only as `broker connection closed before
  completion`. Broker stderr now goes to a private `${pid}.stderr.log` for its
  full lifetime; client-side transport and structured broker failures include
  its last 4 KiB when `--diagnostics` is requested. Regression coverage
  verifies both a post-ready diagnostic and a crashing app-server diagnostic.

- Fixed locally: broker startup now honors the caller timeout and retains up to
  4 KiB of detached-child stderr for a readiness timeout, rather than silently
  failing after 60 seconds with no diagnostic.

- Fixed in `v1.0.8`: default-on interim display exposed streamed `--agentic-error-code` contract JSON directly to people using `hiai`, instead of showing useful progress. It now displays only each message's summary; raw protocol data remains available through `--json`.
- Fixed in `v1.0.9`: an implicit `hiai --broker start` could inherit `/` as its workspace and attempt to create `/.codex-cli`. Broker state now resolves to the Git root, or to the user's home directory outside Git; `--cwd` remains authoritative.
- Fixed in `v1.0.7`: `--agentic-error-code` suppressed streamed assistant deltas, coupling OS exit-status handling to presentation. It now controls only the final process status while interim output and JSON event streaming remain independently configurable.
- Fixed in `v1.0.6`: the progress spinner advanced on an independent timer even when Codex had sent no event, falsely implying live work. It now advances only when Codex or the broker sends an event.
- Fixed in `v1.0.5`: `codex-cli` previously declined `item/fileChange/requestApproval` because it accepted only command-execution approval requests. Every app-server approval request now honors the configured policy, while unrelated request methods remain denied.
- Fixed locally: `mcpServer/elicitation/request` was fail-closed with an approval-shaped `{ decision: "decline" }` response, even though MCP elicitation requires `{ action: "decline" }`. Elicitation requests now receive the protocol-correct decline response in direct and broker transports.
- Fixed locally: a plain follow-up ignored its saved broker transport, fell back to the managed app-server control socket, and exposed a bare `ECONNREFUSED` when that socket was stale. It now starts and reuses the saved broker automatically and directs unmanaged-socket failures to broker recovery.
- Fixed in `v1.0.3`: `--interactive` silently declined approval and user-input requests when standard input was not a terminal. It now fails before starting a turn and explains that it needs a terminal.
- Fixed in `v1.0.1`: `hiai` selected broker mode but left agentic exit-code mode disabled, so a completed prompt returned status `0` even when its requested outcome was nonzero. `hiai` now adds `--agentic-error-code` by default.
- Fixed in `v1.0.2`: the agentic result validator rejected code `1` with `goal_achieved: true`, even when the prompt explicitly used status `1` for a completed check's failing observed result.
