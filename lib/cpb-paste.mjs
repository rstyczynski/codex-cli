import { spawn } from "node:child_process";

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_MIME_CANDIDATES = ["text/plain;charset=utf-8", "text/plain", "utf8_string", "utf-8", "string"];
const MODES = new Set(["stream", "text", "binary", "base64", "mime", "json"]);

export class ClipboardError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function usage() {
  return `Usage: cpb-paste [--text | --binary | --base64 | --mime | --json]

Read text or an image from the operating-system clipboard.
  (no option) Write the selected text or image bytes to standard output
  --text      Write clipboard text as UTF-8
  --binary    Write clipboard image bytes
  --base64    Write clipboard image bytes as Base64
  --mime      Write the selected representation MIME type
  --json      Write all supported representations as JSON

The default and --mime prefer an image when one is available; otherwise they
select text. --json reports every supported text and image representation.
`;
}

export function parseInvocation(argv) {
  if (argv.length === 0) return { mode: "stream" };
  if (argv.length !== 1) throw new ClipboardError("accepts at most one option", 2);
  const [argument] = argv;
  if (argument === "--help" || argument === "-h") return { help: true };
  const mode = argument.startsWith("--") ? argument.slice(2) : undefined;
  if (!MODES.has(mode) || mode === "stream") throw new ClipboardError(`unknown option: ${argument}`, 2);
  return { mode };
}

function macosTextSource() {
  const script = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");
ObjC.import("stdlib");
const value = $.NSPasteboard.generalPasteboard.stringForType($("public.utf8-plain-text"));
if (value.isNil()) $.exit(1);
const data = value.dataUsingEncoding($.NSUTF8StringEncoding);
$.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
`;
  return { command: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", script], mime: "text/plain" };
}

function macosImageSource() {
  const script = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");
ObjC.import("stdlib");

const pasteboard = $.NSPasteboard.generalPasteboard;
let png = pasteboard.dataForType($("public.png"));
if (png.isNil()) {
  const image = $.NSImage.alloc.initWithPasteboard(pasteboard);
  if (image.isNil()) $.exit(1);
  const tiff = image.TIFFRepresentation;
  if (tiff.isNil()) $.exit(1);
  const representation = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (representation.isNil()) $.exit(1);
  png = representation.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (png.isNil()) $.exit(1);
}
$.NSFileHandle.fileHandleWithStandardOutput.writeData(png);
`;
  return { command: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", script], mime: "image/png" };
}

function windowsTextSource() {
  const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { exit 1 }
$text = [System.Windows.Forms.Clipboard]::GetText()
$bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
`;
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script], mime: "text/plain" };
}

function windowsImageSource() {
  const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 1 }
$image = [System.Windows.Forms.Clipboard]::GetImage()
$stream = [System.IO.MemoryStream]::new()
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`;
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script], mime: "image/png" };
}

export function selectMime(types, candidates) {
  const offered = new Map(types.map((type) => [type.trim().toLowerCase(), type.trim()]));
  for (const candidate of candidates) {
    const match = offered.get(candidate);
    if (match) return match;
  }
  return undefined;
}

function toSource(command, args, mime) {
  return { command, args, mime };
}

function captureFailureMessage(result) {
  return result.error?.message || result.stderr.toString("utf8").trim() || "unknown error";
}

async function linuxSources(runCapture) {
  const wayland = await runCapture("wl-paste", ["--list-types"]);
  if (!wayland.error && wayland.code === 0) {
    const types = wayland.stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
    const imageMime = selectMime(types, IMAGE_MIMES);
    const textMime = selectMime(types, TEXT_MIME_CANDIDATES);
    return {
      text: textMime ? toSource("wl-paste", ["--type", textMime], "text/plain") : undefined,
      image: imageMime ? toSource("wl-paste", ["--type", imageMime], imageMime.toLowerCase()) : undefined,
    };
  }

  const x11 = await runCapture("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
  if (!x11.error && x11.code === 0) {
    const types = x11.stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
    const imageMime = selectMime(types, IMAGE_MIMES);
    const textMime = selectMime(types, TEXT_MIME_CANDIDATES);
    return {
      text: textMime ? toSource("xclip", ["-selection", "clipboard", "-t", textMime, "-o"], "text/plain") : undefined,
      image: imageMime ? toSource("xclip", ["-selection", "clipboard", "-t", imageMime, "-o"], imageMime.toLowerCase()) : undefined,
    };
  }

  if (wayland.error?.code !== "ENOENT") throw new ClipboardError(`cannot inspect the Wayland clipboard: ${captureFailureMessage(wayland)}`);
  if (x11.error?.code !== "ENOENT") throw new ClipboardError(`cannot inspect the X11 clipboard: ${captureFailureMessage(x11)}`);
  throw new ClipboardError("clipboard backend unavailable; install wl-clipboard for Wayland or xclip for X11");
}

export function runCapture(command, args, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => resolve({ code: undefined, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error }));
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

function sourceReader(source, run) {
  if (!source) return async () => undefined;
  return async () => {
    const result = await run(source.command, source.args);
    if (result.error) throw new ClipboardError(`cannot read clipboard with ${source.command}: ${result.error.message}`);
    if (result.code !== 0) return undefined;
    return { mime: source.mime, data: result.stdout };
  };
}

export async function createClipboardAdapter(platform = process.platform, run = runCapture) {
  let sources;
  if (platform === "darwin") sources = { text: macosTextSource(), image: macosImageSource() };
  else if (platform === "win32") sources = { text: windowsTextSource(), image: windowsImageSource() };
  else if (platform === "linux") sources = await linuxSources(run);
  else throw new ClipboardError(`unsupported platform: ${platform}`);
  return { readText: sourceReader(sources.text, run), readImage: sourceReader(sources.image, run) };
}

async function requireRepresentation(read, kind) {
  const representation = await read();
  if (!representation) throw new ClipboardError(`clipboard does not contain ${kind}`);
  return representation;
}

async function selectedRepresentation(adapter) {
  const image = await adapter.readImage();
  if (image) return { kind: "image", ...image };
  const text = await adapter.readText();
  if (text) return { kind: "text", ...text };
  throw new ClipboardError("clipboard has no supported text or image representation");
}

function jsonRepresentation(kind, representation) {
  return kind === "text"
    ? { kind, mime: representation.mime, text: representation.data.toString("utf8") }
    : { kind, mime: representation.mime, base64: representation.data.toString("base64") };
}

export async function renderClipboard(adapter, mode, output) {
  if (mode === "text") {
    output.write((await requireRepresentation(adapter.readText, "text")).data);
    return;
  }
  if (mode === "binary") {
    output.write((await requireRepresentation(adapter.readImage, "an image")).data);
    return;
  }
  if (mode === "base64") {
    output.write(`${(await requireRepresentation(adapter.readImage, "an image")).data.toString("base64")}\n`);
    return;
  }
  if (mode === "json") {
    const [text, image] = await Promise.all([adapter.readText(), adapter.readImage()]);
    const representations = [text && jsonRepresentation("text", text), image && jsonRepresentation("image", image)].filter(Boolean);
    if (representations.length === 0) throw new ClipboardError("clipboard has no supported text or image representation");
    const selected = image ? "image" : "text";
    output.write(`${JSON.stringify({ selected_kind: selected, representations })}\n`);
    return;
  }
  const selected = await selectedRepresentation(adapter);
  if (mode === "mime") output.write(`${selected.mime}\n`);
  else output.write(selected.data);
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  const invocation = parseInvocation(argv);
  if (invocation.help) { process.stderr.write(usage()); return; }
  const adapter = await createClipboardAdapter();
  await renderClipboard(adapter, invocation.mode, output);
}
