#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const mode = process.argv[2];
if (process.env.FAKE_CLIPBOARD_TRACE) appendFileSync(process.env.FAKE_CLIPBOARD_TRACE, `${mode ?? ""}\n`, { encoding: "utf8", mode: 0o600 });

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!["--mime", "--text", "--binary"].includes(mode)) fail(`unsupported fake clipboard mode: ${mode ?? "(missing)"}`);
else if (process.env.FAKE_CLIPBOARD_FAIL_MODE === mode) fail(process.env.FAKE_CLIPBOARD_FAILURE ?? "clipboard unavailable");
else if (mode === "--mime") process.stdout.write(`${process.env.FAKE_CLIPBOARD_MIME ?? "text/plain"}\n`);
else if (mode === "--text") process.stdout.write(process.env.FAKE_CLIPBOARD_TEXT ?? "");
else process.stdout.write(Buffer.from(process.env.FAKE_CLIPBOARD_BINARY_BASE64 ?? "", "base64"));
