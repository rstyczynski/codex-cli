import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");
const payload = "SENSITIVE_IMAGE_PAYLOAD";

const imageBytes = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(payload)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.from(payload)]),
  gif: Buffer.concat([Buffer.from("GIF89a"), Buffer.from(payload)]),
  webp: Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBP"), Buffer.from(payload)]),
};

function invoke(workspace, args, options = {}) {
  return spawnSync(process.execPath, [cli, "--cwd", workspace, "--codex", fakeCodex, ...args], {
    cwd: options.cwd ?? workspace,
    encoding: "utf8",
    timeout: 10000,
    input: options.input,
    env: { ...process.env, FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl"), ...options.env },
  });
}

function invokeBroker(workspace, args, options = {}) {
  return invoke(workspace, ["--broker-socket", path.join(workspace, "broker.sock"), ...args], options);
}

async function readTrace(workspace) {
  const contents = await readFile(path.join(workspace, "fake-codex-trace.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeFixtures(workspace) {
  const files = {};
  for (const [name, bytes] of Object.entries(imageBytes)) {
    const filePath = path.join(workspace, `${name}.image`);
    await writeFile(filePath, bytes);
    files[name] = filePath;
  }
  return files;
}

function expectedInput(prompt, imagePaths) {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...imagePaths.map((filePath) => ({ type: "localImage", path: filePath, detail: "auto" })),
  ];
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

test("included image attachment example is a complete, valid PNG", async () => {
  const image = await readFile(path.join(root, "examples", "image-attachment-example.png"));
  assert.deepEqual(image.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let offset = 8;
  const chunks = new Map();
  const idat = [];
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= image.length, `${type} chunk is truncated`);
    const data = image.subarray(dataStart, dataEnd);
    assert.equal(image.readUInt32BE(dataEnd), crc32(image.subarray(offset + 4, dataEnd)), `${type} CRC`);
    chunks.set(type, data);
    if (type === "IDAT") idat.push(data);
    offset = dataEnd + 4;
  }

  assert.equal(offset, image.length);
  assert.equal(chunks.get("IHDR")?.length, 13);
  assert.ok(chunks.get("IHDR").readUInt32BE(0) > 0, "PNG width");
  assert.ok(chunks.get("IHDR").readUInt32BE(4) > 0, "PNG height");
  assert.ok(inflateSync(Buffer.concat(idat)).length > 0, "PNG image data");
  assert.ok(chunks.has("IEND"));
});

test("direct and broker modes preserve image order and send local-image input items", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli images transports "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => invokeBroker(workspace, ["--broker", "stop"]));
  const files = await writeFixtures(workspace);
  const ordered = await Promise.all([files.gif, files.png, files.jpeg, files.webp].map((filePath) => realpath(filePath)));

  let result = invoke(workspace, [
    "--direct", "--new", "--debug",
    "--image", "png.image", "--image", "jpeg.image", "--image", "webp.image",
    "--prompt", "inspect direct images",
  ], { env: { CDXCLI_IMAGE: "gif.image" } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(payload));
  assert.doesNotMatch(result.stderr, new RegExp(payload));
  for (const mime of ["image/gif", "image/png", "image/jpeg", "image/webp"]) assert.match(result.stderr, new RegExp(mime));

  let trace = await readTrace(workspace);
  const directTurn = trace.find((entry) => entry.method === "turn/start" && entry.params.input?.[0]?.text === "inspect direct images");
  assert.deepEqual(directTurn.params.input, expectedInput("inspect direct images", ordered));

  result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  result = invokeBroker(workspace, [
    "--broker", "--new", "--debug",
    "--image", "png.image", "--image", "jpeg.image", "--image", "webp.image",
    "--prompt", "inspect broker images",
  ], { env: { CDXCLI_IMAGE: "gif.image" } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(payload));
  assert.doesNotMatch(result.stderr, new RegExp(payload));

  trace = await readTrace(workspace);
  const brokerTurn = trace.find((entry) => entry.method === "turn/start" && entry.params.input?.[0]?.text === "inspect broker images");
  assert.deepEqual(brokerTurn.params.input, expectedInput("inspect broker images", ordered));

  result = invoke(workspace, ["--direct", "--new", "--json", "--image", "png.image", "inspect JSON image"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(payload));
  assert.doesNotMatch(result.stderr, new RegExp(payload));
});

test("image validation fails locally and rejects no-turn modes", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli image validation "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const files = await writeFixtures(workspace);
  const empty = path.join(workspace, "empty.image");
  const unsupported = path.join(workspace, "unsupported.image");
  const oversized = path.join(workspace, "oversized.image");
  await writeFile(empty, Buffer.alloc(0));
  await writeFile(unsupported, "not an image", "utf8");
  await writeFile(oversized, imageBytes.png);
  await truncate(oversized, 20 * 1024 * 1024 + 1);
  await mkdir(path.join(workspace, "directory.image"));

  const cases = [
    { image: "missing.image", error: /image file does not exist/ },
    { image: "directory.image", error: /not a regular file/ },
    { image: "empty.image", error: /image file is empty/ },
    { image: "oversized.image", error: /exceeds the 20 MiB limit/ },
    { image: "unsupported.image", error: /unsupported image type/ },
  ];
  for (const entry of cases) {
    const result = invoke(workspace, ["--direct", "--new", "--image", entry.image, "validate image"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, entry.error);
  }

  const unreadable = path.join(workspace, "unreadable.image");
  await writeFile(unreadable, imageBytes.png);
  if (process.getuid?.() !== 0) {
    await chmod(unreadable, 0o000);
    try {
      const result = invoke(workspace, ["--direct", "--new", "--image", "unreadable.image", "validate image"]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /cannot read image file/);
    } finally {
      await chmod(unreadable, 0o600);
    }
  }

  let result = invoke(workspace, ["--broker", "start", "--image", "png.image"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot be used with --broker start/);
  result = invoke(workspace, ["--bash-completion", "--image", "png.image"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot be used with completion output/);
  result = invoke(workspace, ["--help", "--image", "png.image"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot be used with --help/);
  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "--image", "missing.image", "validate image"]);
  assert.equal(result.status, 70, result.stderr);

  await mkdir(path.join(workspace, ".codex-cli"));
  await writeFile(path.join(workspace, ".codex-cli", "config.json"), JSON.stringify({ image: files.png }));
  result = invoke(workspace, ["--show-config"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unknown configuration key: image/);
});

test("broker reattaches an image turn only while its ordered image digests match", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli image reattach "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => invokeBroker(workspace, ["--broker", "stop"]));
  const files = await writeFixtures(workspace);

  let result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  result = invokeBroker(workspace, ["--broker", "--new", "--image", "png.image", "--timeout", "0.1", "slow unchanged image"]);
  assert.equal(result.status, 124, result.stderr);
  result = invokeBroker(workspace, ["--broker", "--image", "png.image", "--timeout", "5", "slow unchanged image"]);
  assert.equal(result.status, 0, result.stderr);
  let trace = await readTrace(workspace);
  assert.equal(trace.filter((entry) => entry.method === "turn/start" && entry.params.input?.[0]?.text === "slow unchanged image").length, 1);

  result = invokeBroker(workspace, ["--broker", "--new", "--image", "png.image", "--timeout", "0.1", "slow changed image"]);
  assert.equal(result.status, 124, result.stderr);
  await writeFile(files.png, Buffer.concat([imageBytes.png, Buffer.from("changed")]));
  result = invokeBroker(workspace, ["--broker", "--image", "png.image", "--timeout", "5", "slow changed image"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /thread has active turn/);
  trace = await readTrace(workspace);
  assert.equal(trace.filter((entry) => entry.method === "turn/start" && entry.params.input?.[0]?.text === "slow changed image").length, 1);
});
