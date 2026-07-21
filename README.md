# codex-cli

`codex-cli` is a Node.js client for the local Codex app-server. It sends prompts to Codex threads, streams responses, handles approvals and structured user input in the terminal, and maps validated agentic outcomes to process exit codes for reliable shell automation.

## Table of contents

- [Quick introduction](#quick-introduction)
- [Requirements](#requirements)
- [Examples](#examples)
- [Broker mode](#broker-mode)
- [Threads](#threads)
- [Approvals and user input](#approvals-and-user-input)
- [Client configuration](#client-configuration)
- [Environment overrides](#environment-overrides)
- [Timeouts, active turns, and diagnostics](#timeouts-active-turns-and-diagnostics)
- [Model and Codex configuration](#model-and-codex-configuration)
  - [Raw app-server parameters](#raw-app-server-parameters)
- [Agentic exit codes for scripts](#agentic-exit-codes-for-scripts)
  - [Control the exit code from the prompt](#control-the-exit-code-from-the-prompt)
- [Input and output](#input-and-output)
- [Image attachments](#image-attachments)
- [Prompt attachment actions](#prompt-attachment-actions)
- [Special-purpose modes](#special-purpose-modes)
  - [Direct mode](#direct-mode)
  - [Existing app-server socket](#existing-app-server-socket)
- [Bash completion](#bash-completion)
- [Local files and lifecycle](#local-files-and-lifecycle)
- [Exit behavior](#exit-behavior)
- [Clipboard utility](#clipboard-utility)

## Quick introduction

From the repository root, make the local launchers available and run the
end-to-end introduction:

```bash
export PATH="$PWD/bin:$PATH"
source <(codex-cli --bash-completion)
./examples/intro.sh
```

The example starts the workspace broker when needed, opens a fresh Codex
thread, automatically handles normal Codex approval requests for the session,
shows actions as they happen, converts the agentic outcome to `$?`, and cleans
up only the broker instance it started.

`--approval accept-for-session` makes the broker answer Codex approval requests
with session-wide acceptance, so the master script does not depend on another
Codex UI or a terminal confirmation. Whether a command requests approval is
still determined by the active Codex sandbox and policy. Use automatic
acceptance only in a controlled runner with an appropriate sandbox; omit the
option to decline by default, or use `--interactive` when a human must approve
each request.

## Requirements

- Node.js
- The `codex` CLI installed and authenticated

macOS and Linux support broker, direct, and existing Unix-socket transports.
Native Windows supports broker mode through a workspace-scoped named pipe and
direct mode through standard I/O. The managed app-server control socket is a
Unix-socket transport, so on Windows use `--broker` or `--direct`; an explicit
`--socket \\.\pipe\NAME` works when another process provides a compatible named
pipe.

Make the executables and their Bash completion available in the current shell
from the repository root:

```bash
export PATH="$PWD/bin:$PATH"
source <(codex-cli --bash-completion)
```

This makes `codex-cli`, `cdx`, and `hiai` available in this Bash session; it
also registers completion for all three names. `hiai` automatically adds
`--broker --agentic-error-code`. The `export` and `source` commands must run in
the shell you intend to use. In particular, `PATH="$PWD/bin:$PATH" ./examples/setup-and-help.sh`
sets `PATH` only for that one child process and cannot configure the calling
shell.

Then run the requirements and option-discovery example:

```bash
./examples/setup-and-help.sh
```

To make this persistent, add equivalent commands using the repository's
absolute path to your Bash startup file. When installed with npm, its command
entries are available through the platform's normal launcher mechanism. The
`codex` executable must also be available on `PATH` (or supplied with
`--codex PATH`).

## Examples

The [`examples/`](examples/README.md) directory contains small, commented scripts for every capability described below. Start with `intro.sh`, then use the examples index to find a focused broker, thread, approval, layered configuration, image attachment, prompt action, output, transport, completion, lifecycle, or exit-code workflow.

## Broker mode

Broker mode is the primary way to use `codex-cli`. It keeps one local `codex app-server --stdio` process alive for the workspace, preserves the selected thread across CLI invocations, and supports normal prompts, scripts, approvals, user input, and agentic exit codes.

The `hiai` launcher selects broker mode and agentic exit-code mode
automatically, so these commands are equivalent:

```bash
hiai --new "Summarize the current Git status"
codex-cli --broker --agentic-error-code --new "Summarize the current Git status"
```

```bash
./examples/broker-mode.sh
```

The first prompt automatically creates a thread. The selected thread is saved in `.codex-cli/codex-cli.json`, so later broker invocations continue it without requiring `--thread` or `--new`.

One broker serves one workspace and permits one active turn at a time. A second prompt while a turn is active exits with a busy error. Use `--interrupt-pending` only when you deliberately want to cancel the active turn before sending the next one.

An implicit saved thread is intentionally replaced with a new one if the broker has restarted or if the saved thread is no longer available. An explicit `--thread THREAD_ID` is strict: it reports a missing thread rather than silently switching to another conversation.

Stop the workspace broker when it is no longer needed. The example stops only
the broker instance that it started.

## Threads

Broker mode can list every non-deleted thread visible in the local Codex thread
database, including archived and non-broker threads. The default output is
tab-separated and sorted by creation time from oldest to newest; JSONL output
is also available. A thread ID may be passed explicitly for strict selection.

```bash
./examples/threads.sh
```

Broker-created threads belong to the broker's running app-server. After a broker restart, the next implicit prompt starts a fresh thread. The old thread may still appear in `--broker threads`, but its ID is not assumed resumable by the new broker instance.

## Approvals and user input

Approval requests default to `decline` so automation does not accidentally
authorize a command. Choose a policy explicitly; the example demonstrates an
approval audit log and, when a terminal is attached, structured user input. It
uses `hiai` without an explicit `--broker`, validating the broker-first launcher,
and `sudo -n` so the command cannot block waiting for a password.

```bash
./examples/approvals-and-user-input.sh
```

## Client configuration

`codex-cli` loads optional JSON defaults in this order, with later sources
overriding earlier scalar values:

1. `~/.codex-cli/config.json`
2. `<git-root>/.codex-cli/config.json`
3. `<current-directory>/.codex-cli/config.json`
4. The file named by `CDX_CONFIG`
5. Repeated `--config PATH` files, left to right
6. `CDXCLI_*` option variables
7. Explicit command-line options

`--config` and `CDX_CONFIG` paths are relative to the invocation directory.
Paths inside a configuration file, including `state`, `approvalLog`, and
`configJson`, are relative to that file. The Git-root and current-directory
files are deduplicated when they are the same path. Missing automatic files are
ignored; an explicit or existing invalid file stops the invocation before
Codex is contacted.

Use public camelCase option names. `threadParams` and `turnParams` shallow-merge
by key; other values replace lower-priority values. Configuration cannot supply
a prompt, standard input, help, completion, broker-serving flags, or another
configuration path.

```json
{
  "broker": true,
  "new": true,
  "timeout": 900,
  "verbosity": "medium",
  "threadParams": { "sandbox": "workspace-write" }
}
```

Inspect configured values, their winning sources, and risk classifications
without contacting Codex. With no mode, `--show-config` is equivalent to
`--show-config set` and omits fields whose winning source is the built-in
default. A value explicitly set to the same value as its default is still
shown. Use `all` to include built-in defaults:

```bash
codex-cli --config ci.json --show-config       # configured fields only
codex-cli --config ci.json --show-config set   # same, explicitly
codex-cli --config ci.json --show-config all   # every resolved field
```

Run the self-contained CDX-11 example to see automatic user, Git-root, and
current-directory configuration files followed by `CDX_CONFIG`, `--config`,
`CDXCLI_*`, and command-line overrides. It creates only a temporary workspace
and prints the configured portion of the resolved configuration; Codex is not
contacted.

```bash
./examples/layered-config.sh
```

Before a new thread starts, a Git-root or current-directory configuration emits
a stderr warning if its winning value enables approval automation, relaxes the
sandbox, changes the Codex executable or IPC boundary, changes `cwd` outside
the invocation workspace, or contains an unclassified raw app-server field.
Warnings do not alter exit status and do not pollute JSON stdout. `--debug`
also reports the winning source and classification for every effective field.

### Environment overrides

Most declared long options have an environment equivalent: remove the leading
`--`, uppercase it, and replace hyphens with underscores. `CDX_CONFIG` is the
exception for selecting one client configuration file.

Environment values are lower priority than explicit command-line options. This
is a compatibility change: a one-off command now overrides inherited shell or
CI defaults without unsetting them first.

```bash
./examples/env-config.sh
```

For example, `--broker-socket` maps to `CDXCLI_BROKER_SOCKET`, `--thread-params` maps to `CDXCLI_THREAD_PARAMS`, and `--bash_completion` maps to `CDXCLI_BASH_COMPLETION`. Boolean values accept `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off`; `CDXCLI_BROKER` also accepts `start`, `status`, `stop`, or `threads`.

Use `--approval-log` to record each approval request and decision. Use
`--interactive` to answer Codex approval prompts and structured questions from
the terminal. It requires standard input to be a terminal; `codex-cli` fails
before starting a turn when it is run from a non-interactive runner.

`--interactive` answers Codex protocol requests; it does not attach terminal
input to child processes. In particular, use non-interactive forms such as
`sudo -n` for automated commands so a missing credential fails instead of
waiting for a password prompt.

## Timeouts, active turns, and diagnostics

The default timeout is 120 seconds. Set a longer time for work that is expected
to take longer.

```bash
./examples/timeouts-and-diagnostics.sh
```

A timeout ends the CLI invocation but leaves the Codex turn running. Re-run the
exact same prompt to attach and continue listening to that active turn. The
broker stores the most recent prompt with the selected-thread state, so this
exact-match continuation also survives a broker restart or an app-server
response that omits the user-message item. For an older state file without a
stored prompt, it attaches when there is exactly one active turn. A different
prompt reports the active turn instead of changing it; wait for it or explicitly
interrupt it.

Use `--debug` to show connection details, events, approval callbacks, and turn
status on standard error.

Every Codex error notification is written to standard error as it arrives, including errors that Codex plans to retry. The diagnostic includes the app-server message, additional details, Codex error kind, and upstream HTTP status when supplied. Errors are classified for the current turn using these rules:

- **Correctable:** the app-server explicitly promises a retry and the failure is not definitive. This covers transient connection failures, timeouts, rate limits, and most server errors.
- **Definitive:** authentication or authorization failures; non-transient HTTP 4xx failures (except 408, 409, 421, 425, and 429); HTTP 501 or 505; or any error for which the app-server does not explicitly promise a retry.

A definitive classification overrides an inconsistent `willRetry: true` notification. The CLI reports `retry suppressed`, interrupts the turn to stop further attempts, and exits nonzero. A terminal thread `systemError` also always exits nonzero, even if the app-server labels its empty turn `completed`. With `--json`, the raw error notification remains in the JSONL event stream and the process still exits nonzero for a terminal error.

If Codex marks a turn interrupted, the CLI also prints any error message and additional diagnostic details supplied by the app-server. Use broker `--debug` to display turn lifecycle events; some app-server interruptions have no supplied reason.

## Model and Codex configuration

Use `--model` to set and remember a model for the selected workspace thread,
and `--clear-model` to remove the remembered override. Codex still reads its
usual global and project `config.toml` files. For per-thread overrides, provide
a JSON object through `--config-json` while creating a thread. The maintained
example uses the committed JSON files in `examples/`:

```bash
./examples/model-and-config.sh
```

The first implicit broker prompt also creates a thread, so it may use `--config-json` or `--thread-params` without a redundant `--new`.

### Raw app-server parameters

`--thread-params` supplies a JSON object to `thread/start`; `--turn-params` supplies one to `turn/start`. Values can be inline or loaded from `@FILE`; the options may be repeated and are shallow-merged from left to right.

Sandbox overrides are guarded because current app-server versions do not enforce `sandbox` reliably when it is supplied only to `turn/start`. For a new thread, `--turn-params '{"sandbox":"read-only"}'` is promoted to `thread/start`. For an existing thread, set sandbox on a new thread with `--new --thread-params '{"sandbox":"read-only"}'`; turn-level sandbox changes are rejected rather than silently running with the previous thread permissions.

To allow Codex to modify only the current workspace, create a new `workspace-write` thread:

```bash
codex-cli --broker --new \
  --thread-params '{"sandbox":"workspace-write"}' \
  --prompt "Apply the requested fix and run the focused tests."
```

Thread parameters and `--config-json` apply only while creating a thread. `--model` takes precedence over a raw `model` field. The utility owns `cwd`, `threadId`, and `input`; do not provide these inside raw parameter objects.

With `--agentic-error-code`, the utility also owns `turn/start.outputSchema`; do not set `outputSchema` through `--turn-params` in that mode.

For experimental app-server fields, start the broker with
`--experimental-api`. The model/configuration example supports this through
its `EXPERIMENTAL_API` environment switch.

## Agentic exit codes for scripts

Use `--agentic-error-code` with `codex-cli` or `cdx` when a script needs the
prompt outcome in `$?`, rather than treating every completed Codex turn as
success. `hiai` enables this mode automatically:

```bash
./examples/agentic-exit-codes.sh
```

### Control the exit code from the prompt

There is no separate CLI option for defining what codes `1-12` and `14-15`
mean. Define each code and its condition directly in the prompt. The
instruction is natural language evaluated by Codex; `codex-cli` validates the
returned result and copies `agentic_exit_code` to the process status, but it
does not evaluate the condition itself.

Write the task and observable completion criteria first, then add ordered
agentic exit-code rules that define each caller-specific condition. Include the
default code `0` for an achieved goal and code `1` for an unachieved goal when
no custom condition applies.

Code `0` is reserved for success. Code `1` defaults to an unachieved goal, but
the prompt may explicitly use it for a completed check with a failing outcome.
Codes `2-12` and `14-15` are likewise caller-defined; code `13` is reserved.
State what should happen when several conditions match, usually by saying to
evaluate the rules in order. For example, checking the weather can achieve its
goal while returning code `2` to mean that rain is forecast. The example also
shows how a `set -e` script captures and branches on nonzero agentic outcomes
without confusing them with system failures.

The mode appends conservative completion rules to the prompt and supplies a JSON Schema through `turn/start.outputSchema`. It then validates the final assistant message before choosing the process status. Codex makes the semantic judgment, so prompts should state observable success criteria such as required file changes, commands, and test results.

Exit allocation in this mode is:

- `0`: default outcome when Codex reports the prompt goal achieved.
- `1`: default outcome when Codex reports the prompt goal not achieved; the prompt may also explicitly use it for a completed check's failing outcome.
- `2-12`, `14-15`: caller-defined prompt outcomes that may accompany either goal state; `13` is reserved and rejected.
- `16+`: wrapper or system failures. Generic low-number failures are promoted to `70`; invalid or missing result contracts use `72`. Existing operational statuses such as broker busy (`75`), timeout (`124`), and interrupted turn (`130`) retain their meanings.

Normal output is the result's `summary` followed by a newline. With `--json`,
standard output is exactly one validated object containing `goal_achieved`,
`agentic_exit_code`, `summary`, and `reason`.

System failures take precedence and do not attempt to parse or honor an agentic result. The shell exposes process statuses in the range `0-255`; this CLI does not assign new meanings to `126-127` or signal-style statuses `128-255`.

## Input and output

Use a positional prompt, `--prompt`, or `--stdin`:

```bash
./examples/input-and-output.sh
```

Assistant messages are written to standard output. Select how much of the richer app-server item stream is rendered with `--verbosity`:

- `low` (default) preserves the original behavior and prints assistant messages only.
- `medium` also prints reasoning summaries, plans, and concise command, file-change, tool, search, and subagent lifecycle entries.
- `high` adds the details supplied by the app-server, including reasoning content, command output, diffs, and tool arguments/results when available.

Rich item details, operational messages, approval decisions, and errors are written to standard error, so standard output remains suitable for consuming assistant messages. These levels control terminal rendering; they do not change the model's reasoning effort or `model_verbosity` setting.

The progress spinner is enabled by default on standard error while a terminal
is waiting for its first visible message or action. `--progress` may still be
supplied explicitly. The spinner is independent of verbosity, clears before
streamed output, and is automatically disabled when standard error is
redirected or `--json` is active.

Outside `--agentic-error-code`, `--json` emits newline-delimited raw app-server events instead of human-formatted output and is the lossless choice for scripts that need every protocol event. In agentic error-code mode it emits only the single validated result object described above.

## Image attachments

Attach one or more local images to the same user turn with repeatable `--image`
options. The text prompt remains the first input item and images retain the
order supplied on the command line:

```bash
codex-cli --broker --new \
  --image screenshots/failure.png \
  --image screenshots/expected.png \
  --prompt "Compare these screenshots and explain the visible regression."
```

The example uses the committed sample
[`examples/image-attachment-example.png`](examples/image-attachment-example.png)
by default. Supply an argument or `IMAGE_PATH` to inspect a real image:

```bash
./examples/image-attachments.sh
IMAGE_PATH="$PWD/examples/image-attachment-example.png" ./examples/image-attachments.sh
```

Each image must be a readable regular file, contain a supported image
signature, and be no larger than 20 MiB. Paths resolve from the directory in
which `codex-cli` is invoked, not from `--cwd`; the client canonicalizes them
before use. It sends Codex 0.144.4's `turn/start` local-image input shape
(`type: "localImage"`, `path`, `detail: "auto"`), so it neither recompresses
the file nor encodes its bytes into the app-server request.

Images work with broker, direct, and existing app-server socket modes. An
image needs a positional prompt, `--prompt`, or `--stdin`; it cannot be used
with broker lifecycle actions, completion output, configuration inspection,
help, or the direct REPL. Image paths are deliberately not accepted from JSON
client configuration, raw parameter objects, or `--config-json`.

The broker advertises image support as `image-attachments-v1`. After upgrading
`codex-cli`, restart any already-running broker once before sending `--image`
turns:

```bash
codex-cli --broker stop
codex-cli --broker start
```

An older broker is detected before the turn starts and reports this restart
command instead of silently omitting the image.

`CDXCLI_IMAGE` supplies one environment image for CI or wrapper scripts. It is
prepended to repeatable command-line `--image` values. Under `--debug`, the
client reports only the canonical path, detected MIME type, and byte size.
Image bytes are never written to normal output, JSON output, debug output,
broker metadata, or saved thread state.

When a broker image turn times out, rerun the exact prompt with the same image
paths and unchanged ordered file contents to reattach. The broker compares
canonical paths and SHA-256 digests before it resumes a pending turn.

## Prompt attachment actions

Prompt actions are explicit markers interpreted by `codex-cli`. The first
built-in action is `<clipboard>`, which inserts the currently selected
clipboard representation at that exact point in the same user turn:

```bash
codex-cli --broker --new --prompt 'Explain <clipboard> image.'
```

For clipboard text, the marker becomes a normal text input item. For PNG,
JPEG, WebP, or GIF content, it becomes a local image input item between the
surrounding text items. `codex-cli` invokes its packaged `cpb-paste` helper
exactly twice: first `--mime`, then `--text` or `--binary` for that MIME type.
It does not execute shell substitutions, commands, or arbitrary angle-bracket
content.

Only `<clipboard>` is currently supported. Markers that match the action form
`<[a-z][a-z0-9-]*>` but are not registered fail locally before clipboard,
broker, or Codex access. Clipboard image bytes are stored only in an
owner-only `.codex-cli/session/clipboard-*` file. Direct and socket clients
remove it when they exit; a broker retains it until the broker exits, so the
app-server can load the image asynchronously after acknowledging `turn/start`.
Broker reattachment retains action SHA-256 digests, never clipboard bytes.

After loading Bash completion, type an opening `<` in a prompt and press Tab to
complete any registered prompt-action token. Completion preserves text before
the marker and can correct an unmatched partial marker; for example,
`<cliboard<Tab>` completes to `<clipboard>`.

Copy text or an image, then run the maintained read-only example:

```bash
./examples/prompt-attachment-actions.sh
```

After upgrading `codex-cli`, restart an already-running broker once before
using prompt actions:

```bash
./bin/codex-cli --broker stop
./bin/codex-cli --broker start
```

Run the repository copy explicitly as above, or put `./bin` first on `PATH`,
so an older globally installed `codex-cli` does not forward `<clipboard>` as
literal prompt text.

## Special-purpose modes

Broker mode should be used for normal conversations and scripts. The following transports are add-ons for cases that need a different app-server lifecycle.

### Direct mode

`--direct` launches an isolated, short-lived app-server process over standard I/O. Use it for broker-independent diagnostics, a one-process integration, or the direct REPL. Each invocation requires `--new` and cannot resume the broker's saved thread.

```bash
./examples/direct-mode.sh
```

Pass `--repl` to the example only when that isolated process must handle
several terminal turns.

Enter `/exit` or an empty line to leave the REPL.

### Existing app-server socket

Use the managed daemon or an explicit socket only when another process owns the
app-server lifecycle. On macOS and Linux, pass the path of a Unix socket
exposed by an app-server to the example:

```bash
./examples/existing-socket.sh /path/to/app-server.sock
```

On Windows, managed daemon control sockets are unavailable. Use broker or
direct mode, or pass a named pipe explicitly when another compatible
app-server owns it:

```powershell
codex-cli --socket '\\.\pipe\codex-app-server' --new "Review the current change"
```

## Bash completion

After putting `bin/` on `PATH`, enable completion in the current Bash shell:

```bash
source <(codex-cli --bash-completion)
```

To enable it in every new Bash shell, add that `source` command to `~/.bashrc`,
then reload the file:

```bash
source ~/.bashrc
```

Completion is now available under every command name. For example, type one of
these commands and press Tab at `<Tab>`:

```text
codex-cli --bro<Tab>
cdx --thr<Tab>
hiai --model <Tab>
hiai --prompt \<clip<Tab>
```

The repository also includes an executable example that loads and displays the
registered completion definitions:

```bash
./examples/bash-completion.sh
```

It registers the same completion for `codex-cli`, `cdx`, and `hiai`, covering options, broker actions, file arguments, approval modes, models, and every registered prompt-action token. Model completion first uses Codex's local catalog cache and falls back to the local app-server when necessary. The model result is cached in Bash for 30 seconds.

After sourcing, completion is registered for `codex-cli`, `cdx`, and `hiai`.
When a name is not installed or present on `PATH`, the sourced code also
supplies a shell function for it.

## Local files and lifecycle

Broker mode creates workspace-scoped files. On macOS and Linux these are:

- `.codex-cli/codex-cli-broker.sock`: private Unix socket
- `.codex-cli/codex-cli-broker.pid`: broker metadata
- `.codex-cli/codex-cli.json`: selected thread and model state

On Windows, the broker endpoint is a workspace-hashed private named pipe and
the metadata file is `.codex-cli/broker-<hash>.pid`; the selected-thread state
remains `.codex-cli/codex-cli.json`.

```bash
./examples/local-files-and-lifecycle.sh
```

The broker socket and metadata are owner-restricted. Do not expose the socket over TCP or share its path with untrusted users: a connected client can submit prompts and respond to approval requests under your local Codex account.

If code changes add a broker protocol feature, restart the broker to load it.
The example demonstrates this only when it owns the running broker.

## Exit behavior

Without `--agentic-error-code`, completed `codex-cli` and `cdx` prompts exit
with status 0. `hiai` enables the mode by default. Invalid options, unavailable
threads, and app-server errors generally exit nonzero. A timeout exits with
status 124; an interrupted turn exits with status 130; a broker already serving
another turn exits with status 75.

```bash
./examples/exit-behavior.sh
```

To use agentic exit codes with the broker, start or restart it once, then add
`--agentic-error-code` to a `codex-cli` or `cdx` prompt invocation. `hiai`
already enables it. A standalone direct invocation uses
`--direct --new --agentic-error-code`.

The caller writes the task and its success conditions normally. `codex-cli` automatically adds the JSON result instructions and output schema; the caller does not need to ask Codex to return JSON. On completion, stdout contains only Codex's validated summary and the process status contains the result:

- `0`: default code for goal achieved.
- `1`: default code for goal not achieved; it may also be an explicitly defined failing outcome after a completed check.
- `2-12`, `14-15`: optional outcomes whose meanings must be defined in the caller's prompt; they may represent either an achieved or unachieved goal.
- `13`: reserved and rejected.
- `16+`: CLI, broker, app-server, timeout, interruption, or invalid-contract failure.

To select a custom status, put an explicit mapping in the prompt. When multiple
rules could match, specify their order. Capture nonzero agentic results before
`set -e` can terminate the script, and handle system statuses separately. Add
`--json` when the caller needs all validated fields instead of only the
summary. See [Control the exit code from the prompt](#control-the-exit-code-from-the-prompt)
for the full contract.

Run `codex-cli --help` for the authoritative option list for the installed script version.

## Clipboard utility

`cpb-paste` is a standalone, single-file cross-platform reader for clipboard text and images. With no option it writes one raw selected representation to standard output, preferring an image when both image and text are available. Use an explicit mode when a script requires a particular representation:

```bash
cpb-paste                 # selected text or image bytes
cpb-paste --text          # text as UTF-8
cpb-paste --binary        # image bytes
cpb-paste --base64        # image as Base64
cpb-paste --mime          # selected representation MIME type
cpb-paste --json          # every supported text/image representation
```

On macOS it uses the native pasteboard. On Windows it uses an STA PowerShell clipboard bridge. On Linux it uses `wl-paste` (Wayland) or `xclip` (X11).

Use `<clipboard>` in a `codex-cli` prompt to translate the selected clipboard
representation into a Codex text or image input item.
