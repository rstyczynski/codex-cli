# Prompt Attachment Actions

## Goal

Allow `codex-cli` prompts to contain explicit built-in action markers. The
first action is `<clipboard>`, which resolves clipboard content through
`cpb-paste` and injects it into the same Codex user turn.

```bash
codex-cli --broker --prompt 'Explain <clipboard> image.'
```

This is a prompt-processing feature, not part of the `cpb-paste` utility.

## Marker Contract

`<clipboard>` may appear anywhere in the user prompt. The client consumes the
marker and preserves ordered text around it as separate content items. For the
example above, the input is text "Explain ", the clipboard content item, then
text " image.".

Action markers match `<[a-z][a-z0-9-]*>`. Validate every marker before reading
the clipboard or connecting to Codex. Unknown markers fail locally, for
example: `unknown prompt action <paste>; supported actions: <clipboard>`.
Never execute shell substitutions, caller-provided commands, or arbitrary
angle-bracket text.

Keep the action registry compiled into `bin/codex-cli` near prompt handling:

```js
const PROMPT_ACTIONS = new Map([["<clipboard>", readClipboardAction]]);
```

## Dependencies

CDX-13 supplies a deterministic default representation through `--mime`.
Resolving `<clipboard>` invokes exactly two `cpb-paste` operations:

1. Run `cpb-paste --mime` and capture the selected MIME type.
2. For `text/plain`, run `cpb-paste --text`; for an image MIME type, run
   `cpb-paste --binary`.

The second operation is type-specific rather than parameter-free, so a
clipboard change cannot turn an expected image into bytes embedded as text or
vice versa. If it cannot produce the type reported by `--mime`, fail before
starting a Codex turn. `codex-cli` invokes its packaged helper directly, not an
arbitrary program found on `PATH`.

Text is captured in memory and inserted as a normal user text item:

```json
{ "type": "text", "text": "clipboard text", "text_elements": [] }
```

Image bytes are written once to an owner-only temporary file with an extension
derived from the MIME type. The prompt uses that file as a local image input;
this avoids Base64 expansion of the app-server request:

```json
{ "type": "localImage", "path": "/project/.codex-cli/session/clipboard-...png", "detail": "auto" }
```

## Reverse Engineering Findings

The local Codex 0.144.4 installation provides the source of truth for its own
experimental app-server protocol:

- `codex --image PATH` attaches one or more files to the initial user prompt.
- `codex debug prompt-input --image PATH -- PROMPT` renders the model-visible
  prompt and shows images as distinct attachments before surrounding text.
- `codex app-server generate-json-schema --experimental --out DIR` emits the
  version-matched protocol schema. The generated `TurnStartParams` defines
  `input` as `UserInput` items. It supports both a data URL image item
  (`type: "image"`, `url`, optional `detail`) and a local file image item
  (`type: "localImage"`, `path`, optional `detail`).

At implementation time, generate the schema from the exact `codex` binary used
by the test. For Codex 0.144.4, use the local file form:

```json
{ "type": "localImage", "path": "/project/.codex-cli/session/clipboard-...png", "detail": "auto" }
```

Use the MIME returned by CDX-13 to choose the file extension, then validate the
request with a local direct-mode fixture before starting a real turn. Do not
copy a schema from another Codex version.

## Broker and Safety

The client creates image files only under the workspace-local
`.codex-cli/session/` directory, created with owner-only permissions. Direct
and socket clients retain their files until process exit. A broker retains its
files until broker shutdown because the app-server may load a local image after
acknowledging `turn/start`; broker startup removes leftovers from an unclean
exit. Retain only content digests for active-turn reattachment, never clipboard
bytes. Do not expose the data in debug output, JSON events, state files,
metadata, or diagnostics.

## Tests

- Marker parsing preserves text and attachment ordering.
- Every unknown marker fails before a broker, app-server, or clipboard call.
- Mock the two `cpb-paste` calls for text, PNG, MIME/type mismatch, and
  unavailable clipboard cases.
- Direct, broker, and socket transports send the same validated input items.
- Bash completion derives every supported marker from the prompt-action
  registry, preserves text before a marker, and corrects unmatched marker
  prefixes to registered actions.
- A generated schema test asserts the supported current image item shape.
- A live parity test compares `codex --image` with `<clipboard>` using a
  deterministic fixture.
