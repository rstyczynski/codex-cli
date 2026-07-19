# Codex automation with shared context

For submitting prompts to an existing Codex app-server thread from a terminal,
see [codex-cli app-server client](./codex-cli.md). The CLI client is
intentionally separate from the automation examples below because it preserves a
selected interactive thread rather than starting a standalone `codex exec` run.

Use `codex exec` when automation needs Codex without opening the interactive UI. The common pattern is to wrap each automation entry point with the same invocation contract, then let Codex load shared context from a controlled home directory, the target repository, and resumable session state.

## Pattern

1. Run Codex from any place with an explicit target directory:

   ```bash
   mkdir -p "$PWD/.codex" "$PWD/work/repos/service-a" "$PWD/run_outputs"

   CODEX_HOME="$PWD/.codex" \
   codex exec \
     --cd "$PWD/work/repos/service-a" \
     --profile automation \
     --sandbox workspace-write \
     --json \
     --output-last-message "$PWD/run_outputs/codex-summary.md" \
     "Review the current branch, apply the repository instructions, and report only actionable findings."
   ```

2. Put durable context where Codex already looks:

   - `CODEX_HOME`: shared Codex state such as config, profiles, sessions, skills, logs, and credentials.
   - `$CODEX_HOME/automation.config.toml`: automation-specific defaults selected with `--profile automation`.
   - `AGENTS.md`: repository and nested directory instructions loaded for each run.
   - `.codex/config.toml`: trusted project-local Codex configuration.
   - Checked-in docs and runbooks: domain context that should be reviewable with the code.

3. Share task continuity deliberately:

   - Use `codex exec resume --last "next instruction"` for a staged pipeline on the same runner.
   - Use `codex exec resume <SESSION_ID> "next instruction"` when the orchestrator stores the session ID.
   - Use files as contracts between places: `--json` for event streams, `--output-last-message` for human-readable summaries, and `--output-schema` when downstream steps need stable JSON.

## Use `codex-cli` as a script decision

`--agentic-error-code` turns one prompt into a process result. It supplies an output schema, asks Codex to judge whether the prompt's goal is complete, validates the final object, and then exits with:

- `0` as the default when Codex reports that the goal was achieved;
- `1` as the default when Codex reports that the goal was not achieved;
- `2-15` for meanings explicitly defined by the caller, with either goal state, except reserved code `13`;
- `16+` for CLI, broker, app-server, timeout, interruption, or contract failures.

By default stdout contains only the validated summary. Add `--json` to receive the single validated result object instead. This mode deliberately suppresses the normal assistant stream and raw JSONL event stream.

### Control the code from the prompt

Define custom exit-code meanings inside the prompt. “Use code 2 if …” is a natural-language instruction to Codex, not special shell syntax. `codex-cli` validates Codex's selected code and maps it to `$?`; it does not independently evaluate the condition.

```text
Perform <task>. The goal is achieved when <completion criteria>.

Agentic exit-code rules, evaluated in this order:
- Use code 2 if <condition A>.
- Use code 3 if <condition B>.
- Otherwise use code 0 when the goal is achieved.
- Use code 1 when the goal is not achieved.
```

Use custom codes `2-12` or `14-15`; code `13` is reserved. Custom codes may accompany either goal state. For example, a successful weather lookup may return `goal_achieved: true` and code `2` to mean “rain forecast.” See the [complete prompt examples](./bin/README.md#control-the-exit-code-from-the-prompt).

The judgment is made by Codex, not independently proven by the wrapper. Put observable completion criteria in the prompt, especially required edits and tests:

```bash
#!/usr/bin/env bash
set -u

prompt='Update the parser to reject empty input and run npm test. The goal is achieved only if the edit is applied and npm test passes. Use agentic exit code 2 if the edit is complete but tests fail.'

if summary=$(codex-cli --broker --timeout 900 --agentic-error-code "$prompt"); then
  status=0
else
  status=$?
fi

if (( status >= 16 )); then
  printf 'codex-cli system failure (%d)\n' "$status" >&2
  exit "$status"
fi

case "$status" in
  0) printf 'completed: %s\n' "$summary" ;;
  1) printf 'not completed: %s\n' "$summary" >&2 ;;
  2) printf 'tests failed: %s\n' "$summary" >&2 ;;
  *) printf 'agentic outcome %d: %s\n' "$status" "$summary" >&2 ;;
esac

exit "$status"
```

For structured script output:

```bash
if result=$(codex-cli --broker --agentic-error-code --json \
  "Inspect the deployment configuration. Succeed only if every required setting is present."); then
  jq -r '.summary' <<<"$result"
else
  status=$?
  printf 'status=%d result=%s\n' "$status" "$result" >&2
fi
```

## Multi-place execution model

Typical entry points can be a developer laptop script, a CI job, a scheduler, a release bot, or another internal automation agent. Each entry point should pass:

- the intended workspace with `--cd`;
- the shared context root with `CODEX_HOME`;
- the right profile with `--profile`;
- the narrowest useful sandbox;
- a prompt that states the task, expected output, and stop conditions.

This keeps the automation portable while preserving context through the same configuration, instructions, sessions, and artifacts.

## Safety defaults

- Prefer `read-only` for inspection and `workspace-write` for controlled edits.
- In managed workspaces, use only approval policies allowed by your organization's requirements. If `approval_policy = "never"` is blocked, use `approval_policy = "on-request"` and keep unattended prompts within the sandbox.
- Use `danger-full-access` only inside an externally isolated runner.
- Treat `CODEX_HOME/auth.json` and API keys as secrets.
- Do not run browser login inside an unattended automation job. Provision `.codex` first with device auth, or inject a prepared `CODEX_ACCESS_TOKEN` from a secret manager.
- In CI, avoid exposing API keys to untrusted setup or test commands. For GitHub Actions, prefer `openai/codex-action`.
- Codex expects to run in a Git repository; use `--skip-git-repo-check` only for intentionally prepared non-Git workspaces.

See also: [codex-automation-context.drawio](./codex-automation-context.drawio).

## Copy/paste demo

These snippets use `./.codex` in this repository as the shared Codex home and create a target workspace at `./work/repos/service-a`. The `.codex` directory stores Codex state such as config, sessions, logs, and credentials, so treat it as local runtime state. `codex-cli` keeps its separate broker and selected-thread state under `./.codex-cli`.

### 1. Prepare shared context

```bash
mkdir -p .codex work/repos/service-a/.codex run_outputs

cat > .codex/.gitignore <<'EOF'
*
!.gitignore
EOF

cat > work/.gitignore <<'EOF'
*
!.gitignore
EOF

cat > run_outputs/.gitignore <<'EOF'
*
!.gitignore
EOF

cat > .codex/automation.config.toml <<'EOF'
sandbox_mode = "read-only"
approval_policy = "on-request"
model_verbosity = "low"
EOF

cat > .codex/AGENTS.md <<'EOF'
# Automation defaults

- Be concise.
- Prefer machine-readable output when requested.
- Do not modify files unless the prompt explicitly asks for edits.
EOF

cat > work/repos/service-a/AGENTS.md <<'EOF'
# Demo service instructions

- Treat this as a tiny service repository.
- Mention whether the current task used repository instructions.
EOF

cat > work/repos/service-a/README.md <<'EOF'
# service-a

This small folder represents a target repository or service.
EOF

git -C work/repos/service-a init
git -C work/repos/service-a add README.md AGENTS.md
git -C work/repos/service-a diff --cached --quiet || \
  git -C work/repos/service-a \
    -c user.name="Codex Demo" \
    -c user.email="codex-demo@example.local" \
    commit -m "Create demo service"
```

### 2. Provision authentication outside the unattended run

Use one of these provisioning options before running automation. This step may involve a browser, but it is not part of the unattended `codex exec` flow. The unattended job starts after `.codex` is already authenticated, or after `CODEX_ACCESS_TOKEN` has been injected from a secret manager.

Device-code provisioning stores credentials under `./.codex`; use it for one-time local or runner bootstrap:

```bash
CODEX_HOME="$PWD/.codex" codex login --device-auth
CODEX_HOME="$PWD/.codex" codex login status
```

Token provisioning consumes a Codex access token that was created in advance, for example through the ChatGPT workspace access-token page and stored in a secret manager:

```bash
test -n "${CODEX_ACCESS_TOKEN:?Set CODEX_ACCESS_TOKEN from your secret manager first}"

printf '%s' "$CODEX_ACCESS_TOKEN" | \
  CODEX_HOME="$PWD/.codex" \
  codex login --with-access-token

CODEX_HOME="$PWD/.codex" codex login status
```

### 3. Run Codex from this repo against the service workspace

```bash
CODEX_HOME="$PWD/.codex" \
codex exec \
  --cd "$PWD/work/repos/service-a" \
  --profile automation \
  --sandbox read-only \
  --output-last-message "$PWD/run_outputs/service-summary.md" \
  "Summarize this workspace in 5 bullets. Confirm which instruction sources affected the answer."
```

For an ephemeral runner, skip persistent login and inject the prepared token only for the Codex process:

```bash
test -n "${CODEX_ACCESS_TOKEN:?Set CODEX_ACCESS_TOKEN from your secret manager first}"

CODEX_HOME="$PWD/.codex" \
CODEX_ACCESS_TOKEN="$CODEX_ACCESS_TOKEN" \
codex exec \
  --cd "$PWD/work/repos/service-a" \
  --profile automation \
  --sandbox read-only \
  --output-last-message "$PWD/run_outputs/service-summary.md" \
  "Summarize this workspace in 5 bullets. Confirm which instruction sources affected the answer."
```

### 4. Consume the final artifact

```bash
cat run_outputs/service-summary.md
```

### 5. Ask for structured output

```bash
cat > run_outputs/schema.json <<'EOF'
{
  "type": "object",
  "properties": {
    "workspace": { "type": "string" },
    "instructions_seen": {
      "type": "array",
      "items": { "type": "string" }
    },
    "recommended_next_step": { "type": "string" }
  },
  "required": ["workspace", "instructions_seen", "recommended_next_step"],
  "additionalProperties": false
}
EOF

CODEX_HOME="$PWD/.codex" \
codex exec \
  --cd "$PWD/work/repos/service-a" \
  --profile automation \
  --sandbox read-only \
  --output-schema "$PWD/run_outputs/schema.json" \
  --output-last-message "$PWD/run_outputs/service-summary.json" \
  "Return structured metadata for this workspace."

cat run_outputs/service-summary.json
```

### 6. Resume shared context

```bash
CODEX_HOME="$PWD/.codex" \
codex exec \
  --cd "$PWD/work/repos/service-a" \
  --profile automation \
  --sandbox read-only \
  resume --last \
  "Using the previous context, suggest one safe automation follow-up."
```
