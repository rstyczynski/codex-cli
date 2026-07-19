# Agentic Error Code Contract

## Purpose

`codex-cli` is used as an interface between scripts and Codex. Scripts need a simple process result:

- `0`: the prompt goal was achieved;
- `1-15`: agentic prompt result codes, with culturally loaded values such as `13` intentionally left unassigned;
- `16+`: `codex-cli`, app-server, broker, timeout, interruption, authentication, or other system-level failure.

This gives scripts a small, pragmatic slot for prompt-domain outcomes while keeping infrastructure failures separately diagnosable.

## Implemented Interface

Add an explicit mode:

```bash
codex-cli --agentic-error-code --prompt "..."
```

When enabled, `codex-cli` appends a conservative final-response contract to the prompt and sets `turn/start.outputSchema` to constrain the final assistant message. The CLI suppresses normal assistant streaming, reads the last assistant message from the completed turn, and validates strict JSON:

```json
{
  "goal_achieved": true,
  "agentic_exit_code": 0,
  "summary": "short human-readable result",
  "reason": "why the goal is achieved or not achieved"
}
```

`codex-cli` parses the final assistant message and maps it to the process exit code:

- `agentic_exit_code: 0` -> default prompt-goal-achieved outcome;
- `agentic_exit_code: 1` -> default prompt-goal-not-achieved outcome;
- `agentic_exit_code: 2-15` -> caller-defined outcome that may accompany either goal state, except unassigned values such as `13`;
- invalid or missing contract -> wrapper/system error `16+`.

## Defining Goal Achieved

The CLI-injected instruction should define goal achievement conservatively:

- Return `goal_achieved: true` only when the requested task is complete and no required work remains.
- If the prompt asks for edits, the needed edits must have been applied.
- If the prompt asks for checks or tests, they must have been run or the prompt must explicitly allow skipping them.
- If the task is only analysis or planning, the requested analysis or plan must be delivered.
- Return `goal_achieved: false` when work is partial, blocked, denied by permissions, impossible, uncertain in a material way, or verification required by the prompt was not completed.

This is intentionally agentic: `codex-cli` does not infer semantic success from arbitrary prose. It asks Codex to make the final success/failure judgment in a machine-readable form, then validates the shape.

## Exit Code Allocation

- `0`: default result when the agent reports the prompt goal was achieved.
- `1`: default result when the agent reports the prompt goal was not achieved.
- `2-15`: caller-defined agentic result codes that may accompany either goal state, except `13`, which is intentionally unassigned.
- `16+`: wrapper/system failures owned by `codex-cli` or the shell.
- `70`: generic wrapper/system failure when an existing low-number CLI failure would otherwise overlap the agentic range.
- `72`: missing, malformed, or invalid agentic result contract.
- `75`: broker busy, preserving current behavior.
- `124`: timeout.
- `130`: interrupted turn.
- `126-127`: avoid assigning new wrapper meanings because shells commonly use them for command execution problems.
- `128-255`: avoid assigning new custom meanings because shells commonly use `128+n` for signal exits.

System-level failures always take precedence over the agentic result. Avoid assigning culturally loaded or joke-number codes such as `13` or `66`; `13` is inside the agentic range but remains invalid/unassigned.

## Validation Rules

`codex-cli` should fail with a wrapper/system error when `--agentic-error-code` is enabled and:

- no final assistant message is available;
- the final assistant message is not valid JSON;
- the JSON value is not an object;
- `goal_achieved` is missing or not boolean;
- `agentic_exit_code` is missing, non-integer, or outside `0-15`;
- `agentic_exit_code` is `13`;
- `agentic_exit_code` is `0` while `goal_achieved` is `false`;
- `agentic_exit_code` is `1` while `goal_achieved` is `true`;
- `summary` is missing or not a string;
- `reason` is missing or not a string.

Contract validation failures use exit code `72`.

## Output Behavior

Default mode:

- stdout: `summary`;
- stderr: diagnostics and validation errors;
- process exit code: `0-15`, or system-level `16+`.

With `--json`:

- stdout: validated result object as JSON;
- stderr: diagnostics and validation errors;
- process exit code: `0-15`, or system-level `16+`.

Outside `--agentic-error-code`, current output and exit behavior should remain unchanged.

Raw app-server JSONL events are intentionally suppressed when `--json` and `--agentic-error-code` are combined, leaving exactly one validated result object on stdout.

## Prompt Helper Text

The wrapper should append concise instructions similar to:

```text
For script integration, finish your final answer as strict JSON only:
{
  "goal_achieved": boolean,
  "agentic_exit_code": integer,
  "summary": "short result",
  "reason": "why the goal was or was not achieved"
}
Set goal_achieved to true only if the user's requested goal is fully complete and no required work remains. Use agentic_exit_code 0 as the default when goal_achieved is true and 1 as the default when it is false. Use 2-15 only when the caller explicitly defines a more specific meaning; those caller-defined codes may accompany either goal_achieved value. Do not use agentic_exit_code 13.
```

## Test Cases

- Valid JSON with `goal_achieved: true` and `agentic_exit_code: 0` exits `0`.
- Valid JSON with `goal_achieved: false` and `agentic_exit_code: 1` exits `1`.
- Valid JSON with `goal_achieved: false` and `agentic_exit_code: 2` exits `2`.
- Valid JSON with `goal_achieved: true` and caller-defined `agentic_exit_code: 2` exits `2`.
- Malformed JSON exits wrapper/system error `72`.
- Missing final assistant message exits wrapper/system error `72`.
- Missing or non-boolean `goal_achieved` exits wrapper/system error `72`.
- Missing or out-of-range `agentic_exit_code` exits wrapper/system error `72`.
- `agentic_exit_code: 13` exits wrapper/system error `72`.
- Timeout still exits `124`.
- Interrupted turn still exits `130`.
- Broker busy still exits `75`.
- App-server/system error still exits wrapper/system code before parsing prompt output.
