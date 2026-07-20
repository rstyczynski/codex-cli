# Codex Response Comparison

## Goal

Establish whether `codex-cli` produces materially equivalent answers to direct Codex for representative user prompts. The comparison should reveal transport, thread-lifecycle, approval, rendering, or error-handling differences that affect a caller.

This is a behavioral comparison, not a byte-for-byte output test. Codex answers are nondeterministic; the useful question is whether each path completes the requested task to the same standard under equivalent conditions.

## Baseline and Candidate

- **Baseline:** direct Codex using the locally installed Codex release and normal user-facing workflow.
- **Candidate:** `codex-cli` through its normal broker mode. Add direct and managed-socket modes only when a discrepancy needs transport isolation.

Record the exact Codex version, `codex-cli` revision, selected model, workspace, sandbox, approval policy, and invocation for every run. Use fresh threads or sessions for each comparison pair so prior conversation context cannot influence one side.

## Representative Prompt Set

Start with a small, version-controlled corpus that covers the main behavioral surface:

- A general knowledge or explanation request with no tools.
- A read-only workspace inspection and concise summary.
- A bounded code-review request with explicit findings criteria and 10-20 numbered sentences, one per line, so response detail is verifiable.
- A request requiring a read-only command and an approval decision.
- A structured configuration request using thread and turn parameters.
- A write request in a disposable workspace using `workspace-write`, including a focused verification command.
- An expected failure: unavailable command, denied approval, invalid thread, timeout, or interrupted turn.
- An `--agentic-error-code` request with explicit success criteria and a custom result code.

Each prompt must state observable completion criteria. Prompts that write files must run only in a temporary fixture workspace and compare both the final files and command results.

## Controlled Execution

For a valid pair, keep these conditions equal:

- Prompt text and any attached input.
- Model and model configuration.
- Working directory and repository revision.
- Sandbox and approval policy.
- Authentication identity and available tools.
- Fresh conversation state.

Run each pair multiple times when outcome variance is expected. Capture stdout, stderr, exit status, visible tool activity, approval events, final workspace state, and elapsed time. Redact tokens, secrets, and personal paths before storing artifacts.

## Evaluation Rubric

Score each run against the prompt's criteria rather than prose similarity:

- **Completion:** requested task is complete.
- **Correctness:** claims, edits, and command results are valid.
- **Safety:** sandbox and approval boundaries are respected.
- **Tool behavior:** expected commands or file changes occur; unsupported operations fail clearly.
- **Interface behavior:** output routing, JSON shape, exit status, and error diagnostics match the documented contract.

Classify a difference as expected, benign variation, regression, or inconclusive. A regression is any repeatable case where the candidate fails a criterion that the baseline satisfies under equivalent conditions.

## Deliverables

- Versioned prompt corpus and disposable workspace fixtures.
- A repeatable runner for baseline and candidate captures.
- Per-prompt comparison records with environment metadata and rubric results.
- A short report of regressions, expected differences, and follow-up backlog items.

## Initial Test Layout

The first implementation is an opt-in Node integration test:

```bash
npm run test:parity
```

Its versioned corpus and read-only fixture live in `tests/parity/`. It invokes
`codex exec` as the baseline and broker-mode `codex-cli` as the candidate, with
a fresh copied fixture for each side. Captures are retained locally under
`tests/results/parity/<run-id>/` and ignored by Git.

The standard `npm test` suite remains deterministic and does not contact
Codex. Set `CODEX_PARITY_CASE` to one case ID to run a focused comparison, or
set `CODEX_PARITY_TIMEOUT` to change the per-command timeout in seconds.

## Non-Goals

- Requiring identical wording, reasoning, tool order, or token usage.
- Benchmarking model quality across different Codex versions or models.
- Treating direct Codex as a perfect oracle when both paths fail the same criterion.
