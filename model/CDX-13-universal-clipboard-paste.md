# Universal Clipboard Paste

## Goal

Rename `bin/clipboard-image` to `bin/cpb-paste` and make it a portable clipboard reader for text and images. It must be useful in shell pipelines without guessing an unsafe output representation.

The existing image modes remain compatible under the new name. Text support is added as a first-class capability rather than bolted onto image extraction.

Status: implemented in `bin/cpb-paste` and `lib/cpb-paste.mjs`.

## Proposed Interface

With no parameter, dump the selected clipboard representation directly to
standard output:

```bash
cpb-paste
cpb-paste --text
cpb-paste --binary
cpb-paste --base64
cpb-paste --mime
cpb-paste --json
```

- no parameter: write UTF-8 text unchanged or image bytes unchanged. This is
  the utility's natural stream mode for pipelines.
- `--text`: write clipboard text exactly as UTF-8. Fail when no text representation is available.
- `--binary`: write image bytes. Preserve the current image behavior and fail when no image is available.
- `--base64`: write image bytes as Base64 plus one terminating newline.
- `--mime`: write the selected default representation's MIME type. Support `text/plain` and the supported image types.
- `--json`: write one UTF-8 JSON object containing every supported clipboard
  representation and the deterministic default selection.

The default selection prefers an image when both an image and text are present;
otherwise it uses text. This preserves clipboard fidelity for pipelines such as
an image attachment handoff. Callers that require text or image use `--text` or
`--binary` rather than assuming the default type.

## Representation Selection

`--text` always selects text. Image modes always select an image. The default,
and `--mime` select an image when one is present, because it preserves clipboard
fidelity; otherwise they select text. `--json` reports both when both are
available, with `selected_kind` set to the same default selection.

For example, a copied browser element may expose both `text/plain` and
`image/png`. `--json` preserves that fact:

```json
{
  "selected_kind": "image",
  "representations": [
    { "kind": "text", "mime": "text/plain", "text": "Visible label" },
    { "kind": "image", "mime": "image/png", "base64": "..." }
  ]
}
```

Raw stream output cannot carry two unframed formats at once, so it emits only
the selected representation. Consumers needing a specific kind use `--text` or
`--binary`; consumers needing every available form use `--json`.

When an image is selected, use the current normalization rules: native macOS and Windows adapters produce PNG, while Linux preserves a supported offered MIME type. Text must not gain or lose a newline, alter Unicode normalization, or be interpreted as shell syntax.

## Platform Adapters

- **macOS:** AppKit `NSPasteboard` reads `public.utf8-plain-text` and PNG or a convertible `NSImage`.
- **Windows:** PowerShell running in STA reads `Clipboard.ContainsText()` and `Clipboard.ContainsImage()` through Windows Forms. Encode text as UTF-8 and images as PNG.
- **Linux:** first use Wayland `wl-paste`; otherwise use X11 `xclip`. Discover target types before extraction, support common `text/plain` variants, and retain the current supported image MIME list.

When no supported clipboard backend is installed or exposed, fail with an actionable platform-specific diagnostic. Never fall back to a different display server after a successful type query that proves the requested representation is absent.

## Errors and Exit Behavior

Use exit status `2` for invalid or conflicting options and `1` for unavailable clipboard content, unavailable platform backend, or extraction failure. Diagnostics go to stderr; text, binary data, Base64, MIME values, and JSON go only to stdout. No parameter is valid and never prints usage.

Reject conflicting output modes. Do not print binary data, Base64, or clipboard text in diagnostics. Avoid clipboard reads in `--help` and validation-only paths.

## Tests

Separate platform-independent behavior from platform adapters. Unit-test option validation, MIME selection, Base64 streaming, JSON serialization, and error routing with mocked adapters. Add platform-specific integration tests only on runners that expose a controllable clipboard; otherwise skip with an explicit reason.

Test text preservation with empty strings, trailing newlines, Unicode, and large content. Test images through deterministic PNG fixtures and verify that the generated JSON and Base64 round-trip to the original normalized bytes.

## Boundaries

`cpb-paste` only reads and serializes clipboard representations. Prompt markers,
Codex app-server input items, broker state, and attachment retry behavior belong
to CDX-14.
