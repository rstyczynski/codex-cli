# CDX-15 hiai Broker Launcher Regression

## Goal

Ensure `hiai` selects the already implemented CDX-1 broker approval contract.
Codex sends approval requests to the broker, and the broker returns the decision
selected by `--approval`.

This is not a new broker feature. `examples/approvals-and-user-input.sh` already
demonstrates broker-owned automatic approval, approval logging, interactive
approval, and structured user input. `tests/broker.test.mjs` verifies `accept`,
`acceptForSession`, `decline`, interactive decisions, and the audit log.

## Reproduction

```bash
hiai --new sudo whoami --timeout 10 --approval accept
```

Previous result:

```text
codex-cli: --approval accept cannot be used because this app-server forbids the never approval policy; approve the request in its owning Codex UI or ask the administrator to allow never
```

The turn is rejected before it starts. This is not a `sudo` failure and no
approval request reaches `codex-cli`.

The repository wrapper already prepends `--broker`, but `package.json` installed
`hiai` as a direct link to `bin/codex-cli` and bypassed that wrapper. The
generated Bash fallback function also invoked `codex-cli` without `--broker`.
The intended invocation is equivalent to:

```bash
codex-cli --broker --new sudo whoami --timeout 10 --approval accept
```

## Root Cause

The installed and completion-generated `hiai` launch paths did not use the
existing `bin/hiai` broker wrapper. They therefore selected managed socket mode,
where automatic acceptance encountered a managed approval-policy restriction.

## Required Behavior

- Keep `bin/hiai` prepending `--broker` while preserving user arguments.
- Map the npm `hiai` command to `bin/hiai`, not directly to `bin/codex-cli`.
- Make the generated Bash fallback preserve the same broker-first behavior.
- Route approval requests to the `codex-cli` connection that started the turn.
- Return `accept` for `--approval accept`.
- Return `acceptForSession` for `--approval accept-for-session`.
- Preserve `decline` and interactive terminal decisions.
- Preserve `codex-cli` and `cdx` transport selection unchanged.
- Do not weaken the sandbox, bypass managed requirements, or reinterpret
  approval acceptance as `approvalPolicy: "never"`.

## Tests

- Launcher integration verifies that `hiai` prepends `--broker` and preserves
  the remaining arguments.
- Package metadata verifies that npm installs `hiai` through `bin/hiai`.
- Generated completion fallback selects broker mode and completes broker actions.
- End-to-end launcher integration starts a broker through `hiai`, receives an
  app-server approval request, and returns `acceptForSession`.
- `examples/approvals-and-user-input.sh` exercises `hiai` directly without an
  explicit `--broker`.
- Existing broker integration remains passing as the reference behavior for
  both acceptance modes.
- Existing decline, interactive, approval-log, sandbox, and system-error tests
  remain passing.
