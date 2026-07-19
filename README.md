# codex-cli

`codex-cli` is a dependency-free Node.js client for the local Codex app-server. It sends prompts to Codex threads, streams responses, handles approvals and structured user input in the terminal, and maps validated agentic outcomes to process exit codes for reliable shell automation.

## Table of contents

- [Requirements](#requirements)
- [Quick introduction](#quick-introduction)
- [Broker mode](#broker-mode)
- [Threads](#threads)
- [Approvals and user input](#approvals-and-user-input)
- [Environment overrides](#environment-overrides)
- [Timeouts, active turns, and diagnostics](#timeouts-active-turns-and-diagnostics)
- [Model and Codex configuration](#model-and-codex-configuration)
  - [Raw app-server parameters](#raw-app-server-parameters)
- [Agentic exit codes for scripts](#agentic-exit-codes-for-scripts)
  - [Control the exit code from the prompt](#control-the-exit-code-from-the-prompt)
- [Input and output](#input-and-output)
- [Special-purpose modes](#special-purpose-modes)
  - [Direct mode](#direct-mode)
  - [Existing app-server socket](#existing-app-server-socket)
- [Bash completion](#bash-completion)
- [Local files and lifecycle](#local-files-and-lifecycle)
- [Exit behavior](#exit-behavior)

## Requirements

- Node.js
- The `codex` CLI installed and authenticated

Make the executable available on `PATH`. From this repository, run this once in your shell:

```bash
export PATH="$PWD/bin:$PATH"
```

Then run commands from the workspace you want Codex to use:

```bash
export CODEX_HOME=$PWD/.cdx
mkdir -p $CODEX_HOME
codex-cli --help
source <(codex-cli --bash_completion)
```

The script is self-contained ad includes bash completion. Copy `codex-cli` to any directory on `PATH`; the `codex` executable must also be available on `PATH` (or supplied with `--codex PATH`).

## Quick introduction

This example owns the complete workflow: it starts the broker when needed, opens a fresh Codex thread, automatically handles normal Codex approval requests for the session, shows actions as they happen, converts the agentic outcome to `$?`, and cleans up only the broker instance it started.

```bash
#!/usr/bin/env bash
set -euo pipefail

broker_started_here=false
if ! codex-cli --broker status >/dev/null 2>&1; then
  codex-cli --broker start
  broker_started_here=true
fi

cleanup() {
  if [[ "$broker_started_here" == true ]]; then
    codex-cli --broker stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

prompt=$(cat <<'PROMPT'
Check whether this machine is ready to run codex-cli.

Do not inspect or modify the current repository, change files, install packages, or alter authentication.

Use only read-only commands to determine the Node.js version, Codex version, and Codex authentication status.

The goal is achieved when readiness has been determined and the observed versions and authentication status have been summarized.

Use normal Codex command execution and do not bypass any required approval.

Agentic exit-code rules, evaluated in this order:
- Use code 2 if Node.js is unavailable.
- Use code 3 if Codex is unavailable or not authenticated.
- Otherwise use code 0 when the machine is ready.
- Use code 1 if readiness cannot be determined.
PROMPT
)

echo
echo ===========
echo Result
echo ===========

if summary=$(codex-cli \
  --broker \
  --new \
  --approval accept-for-session \
  --verbosity medium \
  --timeout 900 \
  --agentic-error-code \
  --prompt "$prompt"); then
  status=0
else
  status=$?
fi

if (( status >= 16 )); then
  printf 'codex-cli system failure (%d)\n' "$status" >&2
  exit "$status"
fi

case "$status" in
  0) printf 'machine ready: %s\n' "$summary" ;;
  1) printf 'readiness unknown: %s\n' "$summary" >&2 ;;
  2) printf 'Node.js unavailable: %s\n' "$summary" >&2 ;;
  3) printf 'Codex unavailable or unauthenticated: %s\n' "$summary" >&2 ;;
  *) printf 'agentic outcome %d: %s\n' "$status" "$summary" >&2 ;;
esac

exit "$status"
```

`--approval accept-for-session` makes the broker answer Codex approval requests with session-wide acceptance, so the master script does not depend on another Codex UI or a terminal confirmation. Whether a command requests approval is still determined by the active Codex sandbox and policy. Use automatic acceptance only in a controlled runner with an appropriate sandbox; omit the option to decline by default, or use `--interactive` when a human must approve each request.

Run the maintained [example script](../examples/intro.sh) from the `examples` directory:

```bash
./examples/intro.sh
```

## Broker mode

Broker mode is the primary way to use `codex-cli`. It keeps one local `codex app-server --stdio` process alive for the workspace, preserves the selected thread across CLI invocations, and supports normal prompts, scripts, approvals, user input, and agentic exit codes.

```bash
codex-cli --broker start
codex-cli --broker --prompt "Review this workspace."
codex-cli --broker --prompt "Suggest focused tests."
codex-cli --broker status
```

The first prompt automatically creates a thread. The selected thread is saved in `.codex-cli/codex-cli.json`, so later broker invocations continue it without requiring `--thread` or `--new`.

One broker serves one workspace and permits one active turn at a time. A second prompt while a turn is active exits with a busy error. Use `--interrupt-pending` only when you deliberately want to cancel the active turn before sending the next one.

An implicit saved thread is intentionally replaced with a new one if the broker has restarted or if the saved thread is no longer available. An explicit `--thread THREAD_ID` is strict: it reports a missing thread rather than silently switching to another conversation.

Stop the workspace broker when it is no longer needed:

```bash
codex-cli --broker stop
```

## Threads

Broker mode can list every non-deleted thread visible in the local Codex thread database, including archived and non-broker threads. The default output is tab-separated and sorted by creation time from oldest to newest:

```bash
codex-cli --broker threads
```

For scripts, emit one JSON object per line:

```bash
codex-cli --broker threads --json
```

Select a particular thread explicitly:

```bash
codex-cli --broker --thread THREAD_ID "Continue this discussion"
```

Broker-created threads belong to the broker's running app-server. After a broker restart, the next implicit prompt starts a fresh thread. The old thread may still appear in `--broker threads`, but its ID is not assumed resumable by the new broker instance.

## Approvals and user input

Approval requests default to `decline` so automation does not accidentally authorize a command. Choose a policy explicitly:

```bash
codex-cli --broker --approval accept \
  --prompt "Run a read-only command."

codex-cli --broker --approval accept-for-session \
  --prompt "Run the approved setup steps."
```

## Environment overrides

Every declared long option automatically has an environment equivalent: remove the leading `--`, uppercase it, and replace hyphens with underscores. Environment values override command-line values, so this works for shell and CI defaults without adding one-off support for each flag.

```bash
export CDXCLI_BROKER=true
export CDXCLI_NEW=true
export CDXCLI_PROMPT='Run a read-only command.'
export CDXCLI_APPROVAL=accept
codex-cli --approval decline
```

For example, `--broker-socket` maps to `CDXCLI_BROKER_SOCKET`, `--thread-params` maps to `CDXCLI_THREAD_PARAMS`, and `--bash_completion` maps to `CDXCLI_BASH_COMPLETION`. Boolean values accept `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off`; `CDXCLI_BROKER` also accepts `start`, `status`, `stop`, or `threads`.

Record each approval request and decision in an audit log:

```bash
codex-cli --broker --approval accept \
  --approval-log .codex-cli/approval-history.toml \
  --prompt "Run a read-only command."
```

Use `--interactive` to answer Codex approval prompts and structured questions from the terminal:

```bash
codex-cli --broker --interactive \
  "Ask me to choose a deployment region."
```

`--interactive` answers Codex protocol requests; it does not attach terminal input to child processes. In particular, use `sudo -n` for automated commands so a missing credential fails instead of waiting for a password prompt:

```bash
codex-cli --broker --approval accept \
  "Run sudo -n ls /. If authorization is unavailable, report the error; do not prompt for a password."
```

## Timeouts, active turns, and diagnostics

The default timeout is 15 seconds. Set a longer time for work that is expected to take longer:

```bash
codex-cli --broker --timeout 600 \
  "Perform a detailed read-only diagnostic."
```

A timeout ends the CLI invocation but leaves the Codex turn running. Re-run the exact same prompt to attach and continue listening to that active turn. The broker stores the most recent prompt with the selected-thread state, so this exact-match continuation also survives a broker restart or an app-server response that omits the user-message item. For an older state file without a stored prompt, it attaches when there is exactly one active turn. A different prompt reports the active turn instead of changing it; wait for it or explicitly interrupt it:

```bash
codex-cli --broker --timeout 3600 --prompt "Review this workspace."
codex-cli --broker --interrupt-pending \
  "Continue with the next task."
```

Use `--debug` to show connection details, events, approval callbacks, and turn status on standard error:

```bash
codex-cli --broker --debug --timeout 60 \
  "Explain the current status."
```

Every Codex error notification is written to standard error as it arrives, including errors that Codex plans to retry. The diagnostic includes the app-server message, additional details, Codex error kind, and upstream HTTP status when supplied. Errors are classified for the current turn using these rules:

- **Correctable:** the app-server explicitly promises a retry and the failure is not definitive. This covers transient connection failures, timeouts, rate limits, and most server errors.
- **Definitive:** authentication or authorization failures; non-transient HTTP 4xx failures (except 408, 409, 421, 425, and 429); HTTP 501 or 505; or any error for which the app-server does not explicitly promise a retry.

A definitive classification overrides an inconsistent `willRetry: true` notification. The CLI reports `retry suppressed`, interrupts the turn to stop further attempts, and exits nonzero. A terminal thread `systemError` also always exits nonzero, even if the app-server labels its empty turn `completed`. With `--json`, the raw error notification remains in the JSONL event stream and the process still exits nonzero for a terminal error.

If Codex marks a turn interrupted, the CLI also prints any error message and additional diagnostic details supplied by the app-server. Use broker `--debug` to display turn lifecycle events; some app-server interruptions have no supplied reason.

## Model and Codex configuration

Set and remember a model for the selected workspace thread:

```bash
codex-cli --broker --model gpt-5.6-sol \
  "Review this workspace."
```

Remove the remembered override and use Codex's configured default:

```bash
codex-cli --broker --clear-model "Continue"
```

Codex still reads its usual global and project `config.toml` files. For per-thread config overrides, provide a JSON object when creating a thread:

```json
{
  "model_reasoning_effort": "high",
  "model_verbosity": "low"
}
```

```bash
codex-cli --broker --new \
  --config-json codex-overrides.json \
  --prompt "Perform a detailed review."
```

The first implicit broker prompt also creates a thread, so it may use `--config-json` or `--thread-params` without a redundant `--new`.

### Raw app-server parameters

`--thread-params` supplies a JSON object to `thread/start`; `--turn-params` supplies one to `turn/start`. Values can be inline or loaded from `@FILE`; the options may be repeated and are shallow-merged from left to right.

Sandbox overrides are guarded because current app-server versions do not enforce `sandbox` reliably when it is supplied only to `turn/start`. For a new thread, `--turn-params '{"sandbox":"read-only"}'` is promoted to `thread/start`. For an existing thread, set sandbox on a new thread with `--new --thread-params '{"sandbox":"read-only"}'`; turn-level sandbox changes are rejected rather than silently running with the previous thread permissions.

```bash
codex-cli --broker --new \
  --thread-params '{"personality":"pragmatic","serviceTier":"fast"}' \
  --turn-params @turn-params.json \
  --prompt "Perform a detailed review."
```

Thread parameters and `--config-json` apply only while creating a thread. `--model` takes precedence over a raw `model` field. The utility owns `cwd`, `threadId`, and `input`; do not provide these inside raw parameter objects.

With `--agentic-error-code`, the utility also owns `turn/start.outputSchema`; do not set `outputSchema` through `--turn-params` in that mode.

For experimental app-server fields, start the broker accordingly:

```bash
codex-cli --broker stop
codex-cli --broker start --experimental-api
```

## Agentic exit codes for scripts

Use `--agentic-error-code` when a script needs the prompt outcome in `$?`, rather than treating every completed Codex turn as success:

### Control the exit code from the prompt

There is no separate CLI option for defining what codes `2-15` mean. Define each custom code and its condition directly in the prompt. The instruction is natural language evaluated by Codex; `codex-cli` validates the returned result and copies `agentic_exit_code` to the process status, but it does not evaluate the condition itself.

Use this prompt pattern:

```text
<task and completion criteria>

Agentic exit-code rules, evaluated in this order:
- Use code 2 if <first caller-defined condition>.
- Use code 3 if <second caller-defined condition>.
- Otherwise use code 0 when the goal is achieved.
- Use code 1 when the goal is not achieved and no custom condition applies.
```

Codes `0` and `1` already have default meanings. Custom codes are `2-12` and `14-15`; code `13` is reserved. State what should happen when several conditions match, usually by saying to evaluate the rules in order. A custom code may describe a successful result: for example, checking the weather can achieve its goal while returning code `2` to mean that rain is forecast.

```bash
codex-cli --broker --agentic-error-code --stdin <<'PROMPT'
Check today's weather in Warsaw, Poland using a current forecast.
The goal is achieved when a reliable current forecast has been obtained.

Agentic exit-code rules, evaluated in this order:
- Use code 2 if rain is forecast today.
- Use code 3 if snow is forecast today.
- Otherwise use code 0 when the forecast was obtained.
- Use code 1 if a reliable forecast could not be obtained.
PROMPT

status=$?
```

If rain is forecast and the lookup succeeds, the validated result can contain `"goal_achieved": true` together with `"agentic_exit_code": 2`, and the shell receives status `2`.

```bash
if summary=$(codex-cli --broker --timeout 900 --agentic-error-code \
  "Apply the requested fix and run npm test. The goal is achieved only if the edit is applied and the tests pass. Use agentic exit code 2 if the edit is complete but tests fail."); then
  status=0
else
  status=$?
fi

if (( status >= 16 )); then
  printf 'codex-cli system failure (%d)\n' "$status" >&2
elif (( status == 0 )); then
  printf 'completed: %s\n' "$summary"
else
  printf 'not completed (%d): %s\n' "$status" "$summary" >&2
fi
```

The mode appends conservative completion rules to the prompt and supplies a JSON Schema through `turn/start.outputSchema`. It then validates the final assistant message before choosing the process status. Codex makes the semantic judgment, so prompts should state observable success criteria such as required file changes, commands, and test results.

Exit allocation in this mode is:

- `0`: default outcome when Codex reports the prompt goal achieved.
- `1`: default outcome when Codex reports the prompt goal not achieved.
- `2-15`: caller-defined prompt outcomes that may accompany either goal state; `13` is reserved and rejected.
- `16+`: wrapper or system failures. Generic low-number failures are promoted to `70`; invalid or missing result contracts use `72`. Existing operational statuses such as broker busy (`75`), timeout (`124`), and interrupted turn (`130`) retain their meanings.

Normal output is the result's `summary` followed by a newline. With `--json`, stdout is exactly one validated object:

```json
{"goal_achieved":true,"agentic_exit_code":0,"summary":"tests pass","reason":"the fix was applied and npm test completed"}
```

System failures take precedence and do not attempt to parse or honor an agentic result. The shell exposes process statuses in the range `0-255`; this CLI does not assign new meanings to `126-127` or signal-style statuses `128-255`.

## Input and output

Use a positional prompt, `--prompt`, or `--stdin`:

```bash
codex-cli --broker "Review the current change"
codex-cli --broker --prompt "Review the current change"
printf '%s\n' 'Review the current change' | codex-cli --broker --stdin
```

Assistant messages are written to standard output. Select how much of the richer app-server item stream is rendered with `--verbosity`:

- `low` (default) preserves the original behavior and prints assistant messages only.
- `medium` also prints reasoning summaries, plans, and concise command, file-change, tool, search, and subagent lifecycle entries.
- `high` adds the details supplied by the app-server, including reasoning content, command output, diffs, and tool arguments/results when available.

```bash
codex-cli --broker --verbosity medium \
  "Review the current change and run focused tests."

codex-cli --broker --verbosity high \
  "Explain every visible action while diagnosing the failure."
```

Rich item details, operational messages, approval decisions, and errors are written to standard error, so standard output remains suitable for consuming assistant messages. These levels control terminal rendering; they do not change the model's reasoning effort or `model_verbosity` setting.

The progress spinner is enabled by default on standard error while a terminal is waiting for its first visible message or action. `--progress` may still be supplied explicitly. The spinner is independent of verbosity, clears before streamed output, and is automatically disabled when standard error is redirected or `--json` is active:

```bash
codex-cli --broker --verbosity low --progress \
  "Run the requested checks and summarize the result."
```

Outside `--agentic-error-code`, `--json` emits newline-delimited raw app-server events instead of human-formatted output and is the lossless choice for scripts that need every protocol event. In agentic error-code mode it emits only the single validated result object described above.

## Special-purpose modes

Broker mode should be used for normal conversations and scripts. The following transports are add-ons for cases that need a different app-server lifecycle.

### Direct mode

`--direct` launches an isolated, short-lived app-server process over standard I/O. Use it for broker-independent diagnostics, a one-process integration, or the direct REPL. Each invocation requires `--new` and cannot resume the broker's saved thread.

```bash
codex-cli --direct --interactive --new \
  "Diagnose this request without using the workspace broker."
```

Add `--repl` only when that isolated process must handle several terminal turns:

```bash
codex-cli --direct --interactive --repl --new \
  "Review this workspace."
```

Enter `/exit` or an empty line to leave the REPL.

### Existing app-server socket

Use the managed daemon or an explicit socket only when another process owns the app-server lifecycle:

```bash
codex app-server daemon start
codex-cli --new "Review the current change"
codex-cli "Continue the review"
```

Use `--socket PATH` to select a specific Unix socket exposed by an app-server.

## Bash completion

Source the generated completion script in Bash:

```bash
source <(codex-cli --bash_completion)
```

It completes options, broker actions, file arguments, approval modes, and models. Model completion first uses Codex's local catalog cache and falls back to the local app-server when necessary. The model result is cached in Bash for 30 seconds.

After sourcing, a `codex-cli` shell function is supplied when a command of that name is not already installed:

```bash
codex-cli --broker threads
codex-cli --model <Tab>
```

## Local files and lifecycle

Broker mode creates workspace-scoped files:

```text
.codex-cli/codex-cli-broker.sock  private Unix socket
.codex-cli/codex-cli-broker.pid   broker metadata
.codex-cli/codex-cli.json         selected thread and model state
```

The broker socket and metadata are owner-restricted. Do not expose the socket over TCP or share its path with untrusted users: a connected client can submit prompts and respond to approval requests under your local Codex account.

If code changes add a broker protocol feature, restart the broker to load it:

```bash
codex-cli --broker stop
codex-cli --broker start
```

## Exit behavior

Without `--agentic-error-code`, completed prompts exit with status 0. Invalid options, unavailable threads, and app-server errors generally exit nonzero. A timeout exits with status 124; an interrupted turn exits with status 130; a broker already serving another turn exits with status 75.

To use agentic exit codes with the broker, start or restart it once, then add `--agentic-error-code` to the prompt invocation:

```bash
codex-cli --broker start

codex-cli --broker --agentic-error-code \
  "Apply the fix and run npm test. The goal is achieved only if the edit is applied and npm test passes."

echo "$?"
```

For a standalone direct invocation, use:

```bash
codex-cli --direct --new --agentic-error-code \
  "Run npm test. The goal is achieved only if every test passes."
```

The caller writes the task and its success conditions normally. `codex-cli` automatically adds the JSON result instructions and output schema; the caller does not need to ask Codex to return JSON. On completion, stdout contains only Codex's validated summary and the process status contains the result:

- `0`: default code for goal achieved.
- `1`: default code for goal not achieved.
- `2-12`, `14-15`: optional outcomes whose meanings must be defined in the caller's prompt; they may represent either an achieved or unachieved goal.
- `13`: reserved and rejected.
- `16+`: CLI, broker, app-server, timeout, interruption, or invalid-contract failure.

To select a custom status, put an explicit mapping in the prompt, for example: `Agentic exit-code rules: use code 2 if the deployment succeeds but health checks fail; use code 3 if deployment itself fails; otherwise use code 0 when the goal is achieved or code 1 when it is not.` When multiple rules could match, specify their order. See [Control the exit code from the prompt](#control-the-exit-code-from-the-prompt) for the reusable template and complete weather example.

Capture nonzero agentic results without letting `set -e` terminate the script before `$?` is inspected:

```bash
#!/usr/bin/env bash
set -euo pipefail

if summary=$(codex-cli --broker --timeout 900 --agentic-error-code \
  "Deploy the change and verify health. Use code 2 if deployment succeeds but the health check fails."); then
  status=0
else
  status=$?
fi

if (( status >= 16 )); then
  printf 'codex-cli system failure (%d)\n' "$status" >&2
  exit "$status"
fi

case "$status" in
  0) printf 'goal achieved: %s\n' "$summary" ;;
  1) printf 'goal not achieved: %s\n' "$summary" >&2 ;;
  2) printf 'health check failed: %s\n' "$summary" >&2 ;;
  *) printf 'agentic outcome %d: %s\n' "$status" "$summary" >&2 ;;
esac

exit "$status"
```

Add `--json` when the script needs the validated fields instead of only the summary:

```bash
codex-cli --broker --agentic-error-code --json \
  "Check the release prerequisites. The goal is achieved only if every prerequisite is satisfied."
```

Example stdout:

```json
{"goal_achieved":true,"agentic_exit_code":0,"summary":"all release prerequisites are satisfied","reason":"configuration and required checks passed"}
```

Run `codex-cli --help` for the authoritative option list for the installed script version.
