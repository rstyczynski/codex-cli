# codex-cli examples

These examples are small, runnable tours of the capabilities in the main
README. Run them from the repository root after putting `bin/` on `PATH`:

```bash
export PATH="$PWD/bin:$PATH"
./examples/intro.sh
```

Most broker examples start a broker only when one is not already running and
stop only the broker they started. Prompts are deliberately read-only unless
the example is specifically demonstrating approvals. Examples that start a
Codex turn require an authenticated `codex` CLI; the layered configuration
example only inspects configuration and does not contact Codex.

| README capability | Example | What to look for |
| --- | --- | --- |
| Requirements and help | [`setup-and-help.sh`](setup-and-help.sh) | Check prerequisites and discover options |
| Quick introduction | [`intro.sh`](intro.sh) | Complete automation-friendly workflow |
| Broker mode | [`broker-mode.sh`](broker-mode.sh) | Start, continue, inspect, and clean up a broker |
| Threads | [`threads.sh`](threads.sh) | Create, list, and explicitly select threads |
| Approvals and user input | [`approvals-and-user-input.sh`](approvals-and-user-input.sh) | `hiai` broker approvals, audit log, and interactive questions |
| Client configuration | [`layered-config.sh`](layered-config.sh) | Inspect automatic files, overlays, environment, and CLI precedence |
| Environment overrides | [`env-config.sh`](env-config.sh) | Configure a run with `CDXCLI_*` variables |
| Image attachments | [`image-attachments.sh`](image-attachments.sh) | Attach the included sample PNG or a supplied local image to one read-only prompt |
| Prompt attachment actions | [`prompt-attachment-actions.sh`](prompt-attachment-actions.sh) | Insert clipboard text or an image at `<clipboard>` in one read-only prompt |
| Timeouts and diagnostics | [`timeouts-and-diagnostics.sh`](timeouts-and-diagnostics.sh) | Reattach after timeout, debug, and interrupt |
| Model and Codex configuration | [`model-and-config.sh`](model-and-config.sh) | Model selection, config JSON, and raw parameters |
| Agentic exit codes | [`agentic-exit-codes.sh`](agentic-exit-codes.sh) | Map task outcomes to shell status codes |
| Input and output | [`input-and-output.sh`](input-and-output.sh) | Positional, flag, stdin, verbosity, and JSONL forms |
| Direct mode | [`direct-mode.sh`](direct-mode.sh) | Isolated app-server turn and optional REPL |
| Existing app-server socket | [`existing-socket.sh`](existing-socket.sh) | Connect to a socket owned by another process |
| Bash completion | [`bash-completion.sh`](bash-completion.sh) | Complete options, models, and registered prompt-action tokens |
| Local files and lifecycle | [`local-files-and-lifecycle.sh`](local-files-and-lifecycle.sh) | State files and safe broker restart/cleanup |
| Exit behavior | [`exit-behavior.sh`](exit-behavior.sh) | Separate agent outcomes from system failures |

The JSON files next to the scripts are intentionally committed so the
configuration example can show the exact objects passed to the app-server.
