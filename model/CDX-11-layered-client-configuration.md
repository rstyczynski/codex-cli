# Layered Client Configuration

## Goal

Allow `codex-cli` to receive durable option defaults from JSON without requiring every invocation to repeat flags. Configuration should work for personal defaults, repository defaults, CI, and one-off wrapper scripts while preserving the principle that an explicit command is authoritative.

This concerns `codex-cli` options. It is distinct from the existing `--config-json` option, which forwards Codex per-thread configuration to `thread/start`.

Status: implemented in `bin/codex-cli`, with end-to-end coverage in
`tests/config.test.mjs`.

## Proposed Interface

Add a client configuration option:

```bash
codex-cli --config PATH --broker --prompt "Review the current change."
```

`--config PATH` accepts a JSON file and may be repeated. Each supplied file is loaded in command-line order. `CDX_CONFIG` accepts one JSON file path for shell or CI defaults.

Automatic discovery loads these files when present:

```text
~/.codex-cli/config.json
<git-root>/.codex-cli/config.json
<current-directory>/.codex-cli/config.json
```

`<git-root>` is discovered with `git rev-parse --show-toplevel` from the invocation directory. If the current directory is not in a Git worktree, that layer is skipped. Identical resolved paths are loaded only once, so invoking the CLI at the repository root does not apply the same file twice.

Relative `--config` and `CDX_CONFIG` paths are resolved from the invocation directory. Relative paths inside a configuration file, such as `state`, `approvalLog`, or `configJson`, are resolved from that file's directory. This keeps project configuration portable.

## Precedence

Use the conventional layered precedence: later sources override earlier sources.

| Priority | Source | Purpose |
| --- | --- | --- |
| Lowest | Built-in defaults | Stable behavior with no configuration |
| 1 | `~/.codex-cli/config.json` | Personal defaults |
| 2 | `<git-root>/.codex-cli/config.json` | Repository defaults |
| 3 | `<current-directory>/.codex-cli/config.json` | Directory-specific defaults |
| 4 | `CDX_CONFIG` file | Shell or CI selected configuration |
| 5 | Repeated `--config PATH` files | Explicit configuration overlays, left to right |
| 6 | `CDXCLI_*` option environment variables | Environment-specific option overrides |
| Highest | Explicit command-line options | One invocation's deliberate choice |

For example, a repository can default to `verbosity: "medium"`, CI can set `CDXCLI_TIMEOUT=900`, and `--timeout 60` still wins for one diagnostic run.

This intentionally changes the current behavior in which `CDXCLI_*` values override command-line options. CLI-over-environment is the common convention in Unix tools, Docker-style command runners, and configuration libraries: it lets a person override inherited CI or shell defaults without first unsetting variables. Document this as a compatibility change and provide source diagnostics during the transition.

Precedence resolves conflicts only. It does not restrict which documented values a valid configuration file may supply.

## JSON Shape

Use public camelCase option names, rather than internal parser fields or shell syntax:

```json
{
  "broker": true,
  "new": true,
  "approval": "decline",
  "timeout": 900,
  "verbosity": "medium",
  "threadParams": {
    "sandbox": "workspace-write"
  }
}
```

Supported keys correspond to documented persistent options, including transport selection, model, timeout, approval policy, output behavior, state paths, and `threadParams` or `turnParams`. Values use the same validation rules as their command-line forms.

Configuration files must not set invocation-only or recursive fields: `config`, `prompt`, `stdin`, `help`, Bash-completion generation, internal broker-serving flags, or raw positional arguments. A prompt remains visible at the call site or arrives through standard input.

Scalar values and booleans replace lower-priority values. `threadParams` and `turnParams` shallow-merge by key so a user configuration can set a general sandbox while a repository configuration adds a model parameter. Arrays replace rather than append, avoiding surprising duplication.

## Risk Warnings

Configuration files exist to automate `codex-cli` and are used as written once their values pass normal schema validation. Auto-discovered configuration files have the same ability to configure documented options as user-home, `CDX_CONFIG`, and `--config` files. The user is responsible for the files that their environment discovers.

When `codex-cli` is about to create a thread, emit an informational warning on stderr for each risky effective setting whose winning source is an auto-discovered Git-root or current-directory configuration file. This includes explicit `--new` and an implicit first thread created by a normal broker invocation.

### CLI-Owned Risk Catalog

Define a configuration value as risky when it changes the authority of the agent or the execution boundary of the wrapper. The catalog is owned and versioned by `codex-cli`; it is not configurable from a JSON file. This prevents a configuration file from suppressing its own warning.

Store risk classification as metadata beside the public option schema, with nested classifiers for raw parameter objects. Every supported configuration key must be classified as `safe`, `warn`, or `unclassified`, and a unit test must fail when a new key has no classification.

The initial `warn` catalog includes:

- approval automation (`approval: "accept"` or `"accept-for-session"`);
- `threadParams.sandbox: "workspace-write"` or `"danger-full-access"`;
- a non-default `codex` executable path;
- a socket or broker socket path outside the workspace.

`cwd` that resolves outside the invocation workspace should also warn because it changes the files available to an agent. Values such as `timeout`, `verbosity`, `model`, `debug`, and `state` are initially `safe`.

Raw `threadParams`, `turnParams`, and `configJson` can carry app-server fields added after this CLI version. Known nested paths receive the classifications above. An unknown raw field is `unclassified`: it remains valid and is forwarded, but an auto-discovered configuration file triggers one generic stderr warning naming the source file and field. This preserves automation while making new or opaque app-server capabilities visible.

Publish the active catalog in the configuration documentation and include each warning's category and source in `--show-config`. Do not use a user-editable allowlist or denylist for this policy.

For example:

```text
codex-cli: warning: new thread uses approval=accept-for-session from /repo/.codex-cli/config.json
codex-cli: warning: new thread uses threadParams.sandbox=workspace-write from /repo/.codex-cli/config.json
```

Warnings appear before `thread/start`, go to stderr so JSON output remains parseable, do not change the exit status, and do not require an extra confirmation. Do not warn when a higher-priority environment variable or CLI option replaces the risky configuration value. `--debug` should show the winning source for every effective option.

## Loading and Errors

Missing auto-discovered files are normal and ignored. Any discovered file that exists but is unreadable, non-object JSON, malformed JSON, or has an unknown key fails the invocation before contacting Codex. Explicit `CDX_CONFIG` and `--config` paths must exist and pass the same validation.

Do not support includes, JSON comments, command interpolation, shell expansion, or configuration-driven executable commands. One JSON object per file keeps loading deterministic and auditable.

Add `--show-config` to print the resolved configuration as JSON with the source of every field. It should be safe to run without contacting Codex and must redact any future secret-bearing fields.

## Parsing Strategy

1. Parse only bootstrap arguments needed to locate configuration: `--config` and the normal invocation directory.
2. Load and merge discovered and explicit JSON files in precedence order.
3. Apply `CDXCLI_*` option variables.
4. Parse the full command line and overlay its explicit options.
5. Validate the resulting configuration once, then run the existing command path.

Track an option's source while merging. This enables `--debug` and `--show-config` to explain why a value won, and prevents a configuration file from being mistaken for an explicitly supplied `--thread` or `--model` override.

## Tests

- User, repository, current-directory, `CDX_CONFIG`, repeated `--config`, environment, and CLI sources obey the precedence table.
- A repository-root invocation deduplicates the root and current-directory file.
- A non-Git current directory skips only the repository layer.
- Explicit missing or malformed configuration files fail clearly without starting Codex.
- Unknown keys and wrong value types fail using the documented option name.
- `threadParams` and `turnParams` shallow-merge; scalars replace.
- Explicit CLI values override `CDXCLI_*` values after the compatibility change.
- Auto-discovered configuration files apply documented risky settings and emit a stderr warning when those settings win for a new thread.
- Higher-priority environment or CLI values suppress a warning for a lower-priority risky value that does not win.
- Warnings precede `thread/start`, preserve stdout and JSON output, and do not alter the exit status.
- The CLI-owned risk catalog classifies every supported configuration key and warns about unclassified raw app-server fields from auto-discovered configuration files.
- `--config-json` continues to affect only Codex `thread/start` configuration.
- `--show-config` reports effective values and sources without contacting Codex.
