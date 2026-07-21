# codex-cli Attack Cases

This document records failure scenarios used to challenge `codex-cli` at its
input, filesystem, subprocess, broker, and app-server boundaries. It is a
reliability and local-safety catalogue, not a claim that the client provides an
operating-system security boundary.

Run the deterministic cases with:

```bash
npm run test:attack
```

## Threat model

The client must reject malformed CLI input, configuration, broker messages, and
attachment data before starting a Codex turn. It must protect files it creates
from accidental or same-user path collisions. It treats the configured Codex
binary, the local app-server, the workspace, clipboard providers, and other
processes running as the same OS user as trusted enough to invoke, but not
necessarily reliable.

## Tested Cases

| ID | Failure scenario | Expected result | Regression coverage |
| --- | --- | --- | --- |
| A-01 | Unknown flags, invalid enums, invalid JSON, missing `@FILE`, incompatible transports, or a missing prompt | Exit before Codex starts with status 2; agentic mode remaps wrapper failures to a system status | `tests/cli.test.mjs`, `tests/config.test.mjs` |
| A-02 | Malformed, unreadable, or unknown-key client configuration | Fail before Codex starts; preserve source-aware diagnostics | `tests/config.test.mjs` |
| A-03 | Auto-discovered project configuration widens approval, sandbox, executable, IPC, or raw-parameter authority | Apply documented configuration precedence and emit a warning when the auto-discovered value wins for a new thread | `tests/config.test.mjs` |
| A-04 | Corrupt saved state or no saved thread | Refuse invalid state and require `--new` or an explicit thread instead of guessing | `tests/cli.test.mjs`, `tests/broker.test.mjs` |
| A-05 | A pre-created symlink uses the former predictable state temporary-file name | Write a random `wx` temporary file, atomically rename it, leave the victim unchanged, and create the state file owner-only | `tests/attack.test.mjs` |
| A-06 | Image path is missing, not a regular file, empty, oversized, or has an unsupported signature | Reject before it reaches broker, direct, or socket transport | `tests/image-attachments.test.mjs` |
| A-07 | A prompt uses an unknown `<action>` marker, clipboard MIME lies, image bytes mismatch their MIME, or a temporary attachment must be cleaned up | Fail closed before the app-server; do not leak clipboard data through output or state | `tests/prompt-attachment-actions.test.mjs` |
| A-08 | Clipboard helper writes excessive stdout or stderr | Stop capture once combined helper output exceeds 20 MiB; do not keep buffering attacker-controlled output | `tests/attack.test.mjs` |
| A-09 | Broker receives invalid JSON, an over-4 MiB line, an incompatible version, wrong workspace, or malformed typed fields | Reply with a protocol error and close the peer without starting a turn | `tests/broker.test.mjs` |
| A-10 | A peer attempts to stop another broker or forge approval/user-input responses | Reject unless the broker instance and active peer/request ID match | `tests/broker.test.mjs` |
| A-11 | Broker app-server exits, returns system errors, reports empty session metadata transiently, or has a stale thread | Surface a concrete failure or recover only in the documented implicit-thread cases | `tests/broker.test.mjs` |
| A-12 | Managed socket returns an invalid WebSocket upgrade, closes with a pending request, coalesces frames, or uses large payloads | Reject or decode without corrupting JSON-RPC request state | `tests/websocket.test.mjs`, `tests/socket-cli.test.mjs` |
| A-13 | Agentic final output is malformed, missing, reserved, or a system failure occurs | Reject the contract with 72; retain system failures as 16+ statuses rather than presenting an agentic result | `tests/cli.test.mjs`, `tests/output.test.mjs` |
| A-14 | Windows is asked to use the unavailable managed Unix socket or a non-pipe broker endpoint | Explain the supported transport and reject invalid endpoint forms | `tests/cli.test.mjs` |

## Source-Derived Hardening

The following cases came from code inspection rather than a user-visible
failure report.

- State writes formerly used `${statePath}.${pid}.tmp`. A process sharing the
  workspace could pre-create that path as a symlink. State persistence now uses
  a random exclusive temporary file and atomic rename.
- Clipboard-helper capture formerly buffered all stdout and stderr before
  validating image size. Capture is now capped at 20 MiB across both streams.
- Broker request validation formerly relied on truthiness for fields including
  `new` and `interruptPending`. Those fields, along with `interactive`, `json`,
  `model`, and thread selection, are now type-checked before execution.

## Residual Risks

- `codex-cli` is not a sandbox against the same OS user. A same-user process
  can modify workspace files, connect to owner-accessible local endpoints, or
  replace an image after validation but before the app-server reads it. Use a
  private workspace and trusted local account for sensitive automation.
- File image validation detects format signatures and size; it does not fully
  decode every image format or make a copied immutable snapshot. The app-server
  remains responsible for safe image decoding.
- Direct and socket prompt payloads, app-server events, saved state, and
  configuration files are not globally size-limited. Excessively large trusted
  local input can still cause memory or latency pressure.
- Auto-discovered configuration is intentionally active. Risky winning values
  warn before creating a thread but do not require confirmation. Review project
  configuration before running in an untrusted checkout.
- The upstream app-server determines actual tool authorization and sandbox
  enforcement. `codex-cli` guards known turn-level sandbox gaps, but cannot
  correct an upstream policy defect.
