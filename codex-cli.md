# CDX-1: Codex CLI app-server client

## Goal

Provide a command-line interface for interacting with Codex app-server threads.
A developer should be able to submit a prompt from a terminal and receive the
response without losing workspace and thread context.

## Implementation

`bin/codex-cli` is a dependency-free JSON-RPC client for the Codex
app-server protocol. It connects to the managed daemon over its local Unix
socket and WebSocket transport, resumes or creates a thread, sends a prompt,
and streams assistant messages to standard output. `--verbosity medium` or
`--verbosity high` renders richer reasoning, plan, command, file-change, tool,
search, and subagent items to standard error. `--json` preserves app-server
events as JSON Lines, or emits one validated result when combined with
`--agentic-error-code`.

```bash
npm run help
codex app-server daemon start
codex-cli --new \
  "Review the current change"
```

`codex-cli` uses the managed Codex app-server or its own direct app-server
process. It intentionally does not scrape or automate editor UI. Threads are
Codex app-server threads and may be visible to other Codex surfaces that read
the same local thread store.

## CLI guide

### Start the managed app-server

Install the standalone Codex runtime once if `codex app-server daemon start`
reports that it is missing. Then start the daemon:

```bash
codex app-server daemon start
```

The command is safe to repeat. Check that it is running with:

```bash
codex app-server daemon version
```

### Start a new chat

Run `codex-cli` from the workspace that should be attached to the thread:

```bash
codex-cli --new "Review the current change"
```

The command prints the new thread ID to standard error and streams the
assistant response to standard output. It also saves the ID in
`.codex-cli/codex-cli.json` within the workspace.

The CLI waits for the persisted turn to complete, so it remains reliable even
when a live app-server completion event arrives before the terminal attaches.
It waits for at most 15 seconds by default and exits with code 124 if the turn
is still pending (for example, while it awaits an approval). Set a different
limit with `--timeout`:

```bash
codex-cli --timeout 15 "sudo ls /"
```

### Handle command approvals

Approval requests are normally routed to the app-server's owning UI client.
To authorize commands from this terminal invocation, opt in explicitly. The
client starts the turn with Codex's `never` approval policy, so it does not
wait for that remote UI callback:

```bash
codex-cli --approval accept "sudo ls /"
```

Use `--approval accept-for-session` only when it is appropriate to approve
future commands in the current Codex session. Both accepting modes require
the app-server configuration to allow the `never` approval policy.

### Diagnose a pending turn

Add `--debug` to print app-server events, approval callbacks, and changes to
the turn state on standard error:

```bash
codex-cli --debug --approval accept "sudo ls /"
```

If it shows that the approval was accepted but the turn remains `inProgress`,
the command itself is likely blocked; `sudo` commonly waits for an interactive
password. Prefer a non-interactive command, or use an authenticated mechanism
appropriate to the environment.

### Answer Codex questions in the terminal

Use `--interactive` when Codex sends a structured user-input request. The
client prints each question and accepts either an option number or free-form
answer on standard input:

```bash
codex-cli --interactive "Ask me before choosing a deployment region."
```

This does not forward a terminal to subprocesses. In particular, use `sudo -n`
so a missing `sudo` credential fails immediately rather than waiting for a
password prompt that the app-server cannot safely relay.

### Recover a thread with a pending approval

An earlier turn waiting on an approval prevents the app-server from accepting a
new turn in the same thread. The client reports its turn ID and exits with code
125. To deliberately cancel such active turns and continue the saved thread:

```bash
codex-cli --interrupt-pending "Run ls /."
```

Use `--new` instead when the pending turn should remain available for approval
in the original thread.

### Receive approvals in the terminal

The daemon-control socket can route approvals to another client. Use `--direct`
to run a direct app-server connection, then add `--interactive` to receive
approval questions in the terminal:

```bash
codex-cli --direct --interactive --new "Run ls /."
```

Answer `y` to approve or press Enter to decline. Direct mode starts a local
app-server process. Its threads are available only while that process runs, so
every direct invocation requires `--new` and cannot resume a saved thread.

Use `--repl` to keep the direct app-server and its thread open for consecutive
terminal turns. Type `/exit` or submit an empty line to end it:

```bash
codex-cli --direct --interactive --repl --new "Review this workspace."
```

### Continue direct conversations through the broker

Broker mode keeps a direct app-server alive while each prompt remains a normal
short CLI invocation. Start one broker per workspace:

```bash
codex-cli --broker start
```

Create a thread, then continue it without copying the thread ID. The existing
`.codex-cli/codex-cli.json` state file selects it transparently:

```bash
codex-cli --broker --new --prompt "Review this workspace."
codex-cli --broker --prompt "Now suggest focused tests."
```

Broker turns support the same approval modes and audit log as direct turns:

```bash
codex-cli --broker --approval accept \
  --approval-log .codex-cli/approval-history.toml \
  --prompt "Run a read-only command."
```

Select a model with the existing shortcut:

```bash
codex-cli --broker --new --model gpt-5.6-sol \
  --prompt "Review this workspace."
```

The app-server automatically reads the normal Codex `config.toml` files. To
add per-thread overrides from a JSON file containing the same Codex config
keys, use `--config-json` with `--new`:

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

For fields exposed directly by the installed app-server API, pass JSON objects
to the matching request. Values may be inline or read from `@FILE`; repeated
options are shallow-merged from left to right:

```bash
codex-cli --broker --new \
  --thread-params '{"personality":"pragmatic","serviceTier":"fast"}' \
  --turn-params @turn-params.json \
  --prompt "Perform a detailed review."
```

For example, `turn-params.json` can contain:

```json
{
  "effort": "high",
  "summary": "concise",
  "outputSchema": {
    "type": "object",
    "properties": { "summary": { "type": "string" } },
    "required": ["summary"]
  }
}
```

`--thread-params` and `--config-json` apply only to `--new`. The client reserves
the request envelope fields (`cwd`, `threadId`, and `input`); the installed
Codex version validates every other field. Dedicated `--model` takes precedence
over raw `model`. To use experimental fields, start the broker with:

```bash
codex-cli --broker start --experimental-api
```

### Enable Bash completion

Generate and source the self-contained completion script:

```bash
source <(codex-cli --bash_completion)
```

It registers a `codex-cli` shell function when that command is not already
installed, and also completes the direct Node invocation, so subsequent calls
can use either:

```bash
codex-cli --model <Tab>
codex-cli --model <Tab>
```

Model choices come first from Codex's local model catalog cache, so completion
works even before a broker starts. If that cache is unavailable, it falls back
to the local app-server `model/list` API. Results are cached for 30 seconds and
the fallback lookup is limited to 10 seconds. Completion also covers flags,
approval modes, broker actions, paths, JSON parameter files, and `--codex`. To
use a different Codex binary as the completion default:

```bash
source <(codex-cli --bash_completion --codex /path/to/codex)
```

Use `--interactive` to answer each approval in the invoking terminal. Inspect
or stop the broker with `--broker status` and `--broker stop`. A broker restart
invalidates its in-memory thread IDs; use `--new` after restarting.

### Keep an approval audit log

Use `--approval-log` to append command approval requests and decisions to a
TOML file. The log is an audit trail only; it does not grant future approvals.

```bash
codex-cli --direct --approval accept \
  --approval-log .codex-cli/approval-history.toml --new "Run a read-only command."
```

The log can contain complete command lines, so store it as sensitive local
workspace data.

### Continue a chat

After a chat has been created, omit `--new` and `--thread` to continue the
saved workspace chat automatically:

```bash
codex-cli "Now suggest focused tests"
```

Pass `--thread` to select a different conversation. The selected thread then
becomes the saved workspace chat:

```bash
codex-cli \
  --thread THREAD_ID \
  "Now suggest focused tests"
```

Use `--state PATH` to store the thread selection somewhere other than the
default `.codex-cli/codex-cli.json`.

### Set or change the model

Set a model while creating or continuing a thread with `--model`. The selected
model is saved in `.codex-cli/codex-cli.json` and is reused for later calls in that
workspace:

```bash
codex-cli --model gpt-5.6-sol "Continue with this model"
```

Use a model ID available in your Codex account. To stop overriding the model
and use Codex's default again:

```bash
codex-cli --clear-model "Use the default model again"
```

### Send a prompt from standard input

Use `--stdin` when another command generates the prompt:

```bash
printf '%s' 'Summarize the changed files.' | \
  codex-cli --stdin --new
```

### Consume events from a script

Use `--json` for JSON Lines output. Outside agentic error-code mode, it includes
the raw Codex app-server events instead of rendering only assistant text:

```bash
codex-cli --json --thread THREAD_ID "Report status"
```

Use `--agentic-error-code` when the script needs goal completion in the process
status. Exit `0` is the default achieved result, `1` is the default
not-achieved result, `2-15` are caller-defined outcomes except reserved code
`13`, and `16+` are wrapper or system failures:

```bash
codex-cli --broker --agentic-error-code \
  "Apply the fix and run npm test. Succeed only if the edit is applied and tests pass."
status=$?
```

See [the script examples](./bin/README.md#agentic-exit-codes-for-scripts) for
safe shell branching and JSON output.

### Show reasoning and actions in the terminal

Human-readable output defaults to `--verbosity low`, which streams assistant
messages only. Use `medium` for reasoning summaries and concise action
lifecycle entries, or `high` for the detailed payloads exposed by the
app-server, including command output, diffs, and tool arguments/results when
available. Rich entries use Unicode type icons and a blank line when the item
type changes, while lifecycle entries of the same type stay grouped:

```bash
codex-cli --verbosity medium "Review and test this change."
codex-cli --verbosity high "Diagnose this failure and show action details."
```

These levels affect rendering only; they do not alter model reasoning effort
or the model's response-verbosity setting. Rich item details go to standard
error, while assistant messages remain on standard output.

The progress spinner is enabled by default while a terminal waits for the
first visible output, including with low verbosity. `--progress` may still be
supplied explicitly:

```bash
codex-cli --verbosity low --progress "Run the checks and summarize them."
```

The spinner clears before message/action output and is disabled for redirected
standard error and JSON mode.

### Cross-surface visibility

Threads are persisted by Codex app-server for the current workspace. Other
Codex surfaces may show the same thread after they refresh their local thread
history, but `codex-cli` does not depend on an editor or control one.

### Advanced: explicit socket

The managed daemon socket is used by default. `--socket PATH` is only needed
when a host provides another Codex app-server socket explicitly:

```bash
codex-cli \
  --socket /path/to/app-server-control.sock \
  --thread THREAD_ID \
  "Continue the review"
```

## User flow

1. From a terminal in a repository, the developer runs a CLI command with
   a prompt.
2. The CLI creates or resumes a managed Codex thread for that workspace.
3. The response is streamed to standard output.

## Scope

- Provide a CLI entry point that accepts a prompt and optional session or
  workspace selector.
- Use the terminal's current workspace for new threads and resume a specified
  Codex thread when its ID is supplied.
- Stream assistant output to the terminal, with an option for machine-readable
  output for scripts.
- Report actionable errors when the daemon is unavailable or a thread cannot
  be found.
- Document setup, invocation, session selection, and limitations.

## Non-goals

- Replacing the standalone `codex` CLI or its `codex exec` workflow.
- Automating arbitrary editor UI actions.
- Silently creating a new editor window or UI chat session when no matching
  target is available.

## Acceptance criteria

- A CLI command creates or resumes a persisted Codex thread for the current
  workspace.
- A thread ID can be used to select a previous conversation.
- Responses are streamed to the terminal and the session is persisted by Codex
  app-server.
- Failures explain what is unavailable and how to recover.
- Examples cover an interactive prompt, non-interactive input, and
  machine-readable output.

## Open design questions

- Should the CLI offer `--list-threads` to avoid copying thread IDs manually?
- Should the CLI expose the created thread ID in a structured completion
  event for automation?
