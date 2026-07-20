# Image Attachments

## Goal

Allow a `codex-cli` prompt to include one or more local image files, equivalent to attaching images with direct Codex. The primary interface is:

```bash
codex-cli --broker --new \
  --image screenshots/failure.png \
  --prompt "Explain the visible test failure."
```

`--image PATH` is repeatable. Images retain the command-line order and are attached with the prompt as one user turn.

## Scope

Support the same option in broker, direct, and managed-socket modes. The option is an invocation input, like a positional prompt or `--stdin`; it is not a persistent configuration value and must not be read from auto-discovered configuration files.

Direct Codex already offers file attachment through `codex exec -i FILE`. `codex-cli` should provide the equivalent user experience while mapping attachments to the local app-server protocol.

Clipboard extraction and prompt markers are outside this item. CDX-13 owns the
standalone `cpb-paste` utility; CDX-14 owns prompt actions that may consume it.

## App-Server Compatibility Adapter

Verified against the installed Codex 0.144.4 app-server by generating its v2
JSON Schema. `turn/start.params.input` accepts `UserInput` items, including a
local-file image form used for both new and resumed threads:

```json
{ "type": "localImage", "path": "/absolute/path/image.png", "detail": "auto" }
```

The schema also supports data-URL image items, but the local-file form keeps
original bytes out of the JSON-RPC request. The current schema has no declared
byte limit, so `codex-cli` applies a documented 20 MiB per-image client limit.
The compatibility adapter owns this item shape separately from prompt parsing,
so a future app-server protocol change has one clear update point.

## File Handling

Resolve each image path from the invocation directory. Fail before contacting Codex when a path does not exist, is not a regular readable file, is empty, exceeds the documented limit, or has an unsupported media type.

Initial media support should be limited to formats confirmed by the app-server, expected to include PNG, JPEG, WebP, and GIF. Detect type from file content or a well-tested media parser rather than trusting the extension. Preserve the original bytes; do not recompress or transform images in the CLI.

Read images only after option validation succeeds. Treat every image as sensitive user input:

- do not print encoded bytes in normal, debug, or JSON output;
- do not persist image data in `.codex-cli` state or broker metadata; the
  CDX-14 `<clipboard>` action may stage a live image only in
  `.codex-cli/session/`, with owner-only permissions and lifecycle cleanup;
- log at most the supplied path, detected media type, and byte size under `--debug`;
- clear in-memory buffers after the app-server request where practical.

## Interface and Validation

Add to help, Bash completion, the option schema, environment mapping, and documentation:

```text
--image PATH    Attach a local image to the prompt (repeatable)
```

`CDXCLI_IMAGE` may provide one path for wrapper or CI use, consistent with other repeatable options. Command-line `--image` values append after the environment value in their supplied order.

Reject image use with modes that have no prompt turn, including broker lifecycle actions such as `start`, `status`, `stop`, and `threads`, Bash-completion generation, and help. Require a prompt from a positional argument, `--prompt`, or `--stdin`; an image alone is not a complete user turn.

Do not support image paths inside JSON `--thread-params`, `--turn-params`, `--config-json`, or the proposed CDX-11 configuration files. This keeps file reads explicit in the shell invocation.

## Broker Behavior

The broker request protocol must carry image metadata and content safely from the client process to the workspace broker. The broker remains responsible for forwarding the attachment into the app-server request. File-based `--image` input does not create copies; CDX-14 clipboard input stages its own owner-only session file in `.codex-cli/session/`.

Broker turn reattachment needs a clear rule. If an image-bearing prompt times out, only the exact same prompt plus the same ordered images may reattach. Compare normalized paths and a content digest, not only filenames, to prevent accidentally attaching a changed file to a running turn.

## Errors and Exit Behavior

Input validation failures use the existing invalid-option or local-input nonzero behavior before a thread starts. App-server rejection of an image attachment is surfaced as a normal Codex error and retains the existing transport-specific failure handling.

With `--agentic-error-code`, image parsing, attachment, or app-server failures remain wrapper or system errors (`16+`); they must not be misreported as an agentic prompt result.

## Tests

- A minimal fixture image reaches the fake app-server with the verified content shape, MIME type, and original bytes or digest.
- Multiple `--image` options preserve order; `CDXCLI_IMAGE` combines predictably with CLI values.
- Broker, direct, and socket modes deliver the same image turn input.
- Missing, directory, unreadable, empty, oversized, and unsupported files fail before app-server connection.
- Lifecycle commands reject `--image` without creating a broker or thread.
- Debug and JSON output never expose image bytes.
- Timed-out image turns reattach only when prompt and ordered image digests match.
- A live parity case compares `codex exec -i` with `codex-cli --image` using a non-sensitive fixture image.
