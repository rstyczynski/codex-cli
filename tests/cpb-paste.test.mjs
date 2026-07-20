import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClipboardError,
  createClipboardAdapter,
  parseInvocation,
  renderClipboard,
  selectMime,
} from "../lib/cpb-paste.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cpbPaste = path.join(root, "bin/cpb-paste");

function representation(mime, value) {
  return { mime, data: Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8") };
}

function adapter({ text, image } = {}) {
  return {
    readText: async () => text,
    readImage: async () => image,
  };
}

function outputCapture() {
  const chunks = [];
  return {
    output: {
      write(value) {
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"));
      },
    },
    bytes() {
      return Buffer.concat(chunks);
    },
  };
}

function commandResult({ code = 0, stdout = "", stderr = "", error } = {}) {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), error };
}

test("cpb-paste validates its single output-mode option", () => {
  assert.deepEqual(parseInvocation([]), { mode: "stream" });
  assert.deepEqual(parseInvocation(["--text"]), { mode: "text" });
  assert.deepEqual(parseInvocation(["--json"]), { mode: "json" });
  assert.deepEqual(parseInvocation(["--help"]), { help: true });

  for (const argv of [["--stream"], ["--text", "--json"], ["-x"]]) {
    assert.throws(() => parseInvocation(argv), (error) => {
      assert.ok(error instanceof ClipboardError);
      assert.equal(error.exitCode, 2);
      return true;
    });
  }
});

test("cpb-paste matches supported MIME types case-insensitively", () => {
  assert.equal(selectMime(["TEXT/PLAIN", "image/PNG"], ["image/png", "text/plain"]), "image/PNG");
  assert.equal(selectMime(["image/tiff"], ["image/png"]), undefined);
});

test("cpb-paste stream mode preserves selected raw clipboard content", async () => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  let capture = outputCapture();
  await renderClipboard(adapter({ text: representation("text/plain", "Visible label"), image: representation("image/png", image) }), "stream", capture.output);
  assert.deepEqual(capture.bytes(), image);

  capture = outputCapture();
  await renderClipboard(adapter({ text: representation("text/plain", "Zażółć\n") }), "stream", capture.output);
  assert.equal(capture.bytes().toString("utf8"), "Zażółć\n");

  capture = outputCapture();
  await renderClipboard(adapter({ text: representation("text/plain", "") }), "stream", capture.output);
  assert.equal(capture.bytes().length, 0);
});

test("cpb-paste explicit modes emit only their requested representation", async () => {
  const image = Buffer.from([0x00, 0xff, 0x80, 0x41]);
  const both = adapter({ text: representation("text/plain", "line one\nline two"), image: representation("image/png", image) });

  let capture = outputCapture();
  await renderClipboard(both, "text", capture.output);
  assert.equal(capture.bytes().toString("utf8"), "line one\nline two");

  capture = outputCapture();
  await renderClipboard(both, "binary", capture.output);
  assert.deepEqual(capture.bytes(), image);

  capture = outputCapture();
  await renderClipboard(both, "base64", capture.output);
  assert.equal(capture.bytes().toString("utf8"), `${image.toString("base64")}\n`);

  capture = outputCapture();
  await renderClipboard(adapter({ text: representation("text/plain", "text only") }), "mime", capture.output);
  assert.equal(capture.bytes().toString("utf8"), "text/plain\n");
});

test("cpb-paste JSON reports every supported representation and default selection", async () => {
  const image = Buffer.from([0x01, 0x02, 0x03]);
  const capture = outputCapture();
  await renderClipboard(adapter({ text: representation("text/plain", "Visible label"), image: representation("image/png", image) }), "json", capture.output);
  assert.deepEqual(JSON.parse(capture.bytes().toString("utf8")), {
    selected_kind: "image",
    representations: [
      { kind: "text", mime: "text/plain", text: "Visible label" },
      { kind: "image", mime: "image/png", base64: image.toString("base64") },
    ],
  });
});

test("cpb-paste reports missing required clipboard representations", async () => {
  for (const mode of ["stream", "text", "binary", "base64", "json"]) {
    await assert.rejects(renderClipboard(adapter(), mode, outputCapture().output), (error) => {
      assert.ok(error instanceof ClipboardError);
      assert.equal(error.exitCode, 1);
      return true;
    });
  }
});

test("Linux adapter discovers Wayland types before reading selected bytes", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "--list-types") return commandResult({ stdout: "text/plain;charset=utf-8\nimage/png\n" });
    if (args[1] === "text/plain;charset=utf-8") return commandResult({ stdout: "text value" });
    if (args[1] === "image/png") return commandResult({ stdout: Buffer.from([0x01, 0x02]) });
    throw new Error(`unexpected clipboard command: ${command} ${args.join(" ")}`);
  };

  const clipboard = await createClipboardAdapter("linux", run);
  assert.deepEqual(await clipboard.readText(), representation("text/plain", "text value"));
  assert.deepEqual(await clipboard.readImage(), representation("image/png", Buffer.from([0x01, 0x02])));
  assert.deepEqual(calls, [
    ["wl-paste", ["--list-types"]],
    ["wl-paste", ["--type", "text/plain;charset=utf-8"]],
    ["wl-paste", ["--type", "image/png"]],
  ]);
});

test("Linux adapter falls back to X11 and diagnoses absent backends", async () => {
  const missing = { code: "ENOENT", message: "not found" };
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "wl-paste") return commandResult({ error: missing });
    if (args.includes("TARGETS")) return commandResult({ stdout: "UTF8_STRING\nimage/jpeg\n" });
    if (args.includes("UTF8_STRING")) return commandResult({ stdout: "x11 text" });
    if (args.includes("image/jpeg")) return commandResult({ stdout: Buffer.from([0xff, 0xd8]) });
    throw new Error(`unexpected clipboard command: ${command} ${args.join(" ")}`);
  };

  const clipboard = await createClipboardAdapter("linux", run);
  assert.deepEqual(await clipboard.readText(), representation("text/plain", "x11 text"));
  assert.deepEqual(await clipboard.readImage(), representation("image/jpeg", Buffer.from([0xff, 0xd8])));
  assert.equal(calls[1][0], "xclip");

  await assert.rejects(createClipboardAdapter("linux", async () => commandResult({ error: missing })), /clipboard backend unavailable/);
});

test("macOS and Windows adapters use their native clipboard bridges", async () => {
  const macCalls = [];
  const mac = await createClipboardAdapter("darwin", async (command, args) => {
    macCalls.push([command, args]);
    return commandResult({ stdout: macCalls.length === 1 ? "mac text" : Buffer.from([0x89, 0x50]) });
  });
  assert.deepEqual(await mac.readText(), representation("text/plain", "mac text"));
  assert.deepEqual(await mac.readImage(), representation("image/png", Buffer.from([0x89, 0x50])));
  assert.equal(macCalls[0][0], "/usr/bin/osascript");
  assert.ok(macCalls[0][1].includes("JavaScript"));
  assert.match(macCalls[0][1].at(-1), /public\.utf8-plain-text/);
  assert.match(macCalls[1][1].at(-1), /NSBitmapImageFileTypePNG/);

  const windowsCalls = [];
  const windows = await createClipboardAdapter("win32", async (command, args) => {
    windowsCalls.push([command, args]);
    return commandResult({ stdout: windowsCalls.length === 1 ? "Windows text" : Buffer.from([0x89, 0x50]) });
  });
  assert.deepEqual(await windows.readText(), representation("text/plain", "Windows text"));
  assert.deepEqual(await windows.readImage(), representation("image/png", Buffer.from([0x89, 0x50])));
  assert.equal(windowsCalls[0][0], "powershell.exe");
  assert.ok(windowsCalls[0][1].includes("-Sta"));
  assert.match(windowsCalls[0][1].at(-1), /ContainsText/);
  assert.match(windowsCalls[1][1].at(-1), /ContainsImage/);
});

test("cpb-paste --help does not require clipboard access or duplicate usage", () => {
  const result = spawnSync(process.execPath, [cpbPaste, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Usage: cpb-paste/m);
  assert.equal((result.stderr.match(/^Usage: cpb-paste/gm) || []).length, 1);
});
