import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");
const fakeClipboard = path.join(root, "tests/fixtures/fake-cpb-paste.mjs");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function clipboardEnvironment(workspace, values = {}) {
  return {
    NODE_ENV: "test",
    CDXCLI_TEST_CLIPBOARD_HELPER: fakeClipboard,
    FAKE_CLIPBOARD_TRACE: path.join(workspace, "clipboard-trace.log"),
    ...values,
  };
}

function invoke(workspace, args, options = {}) {
  return spawnSync(process.execPath, [cli, "--cwd", workspace, "--codex", fakeCodex, ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl"),
      ...options.env,
    },
  });
}

function invokeBroker(workspace, args, options = {}) {
  return invoke(workspace, ["--broker-socket", path.join(workspace, "broker.sock"), ...args], options);
}

async function readTrace(workspace) {
  const contents = await readFile(path.join(workspace, "fake-codex-trace.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readClipboardTrace(workspace) {
  return (await readFile(path.join(workspace, "clipboard-trace.log"), "utf8")).trim().split("\n").filter(Boolean);
}

test("clipboard text action preserves prompt ordering across direct and broker transports", async (t) => {
  await Promise.all([chmod(fakeCodex, 0o755), chmod(fakeClipboard, 0o755)]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli prompt actions "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => invokeBroker(workspace, ["--broker", "stop"]));
  const env = clipboardEnvironment(workspace, { FAKE_CLIPBOARD_TEXT: "clipboard secret" });

  let result = invoke(workspace, ["--direct", "--new", "before <clipboard> after"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /clipboard secret/);
  assert.doesNotMatch(result.stderr, /clipboard secret/);
  let trace = await readTrace(workspace);
  let turn = trace.find((entry) => entry.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "before ", text_elements: [] },
    { type: "text", text: "clipboard secret", text_elements: [] },
    { type: "text", text: " after", text_elements: [] },
  ]);
  assert.deepEqual(await readClipboardTrace(workspace), ["--mime", "--text"]);

  await rm(path.join(workspace, "fake-codex-trace.jsonl"));
  await rm(path.join(workspace, "clipboard-trace.log"));
  result = invokeBroker(workspace, ["--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);
  result = invokeBroker(workspace, ["--broker", "--new", "before <clipboard> after"], { env });
  assert.equal(result.status, 0, result.stderr);
  trace = await readTrace(workspace);
  turn = trace.find((entry) => entry.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "before ", text_elements: [] },
    { type: "text", text: "clipboard secret", text_elements: [] },
    { type: "text", text: " after", text_elements: [] },
  ]);
  assert.deepEqual(await readClipboardTrace(workspace), ["--mime", "--text"]);

  const state = await readFile(path.join(workspace, ".codex-cli", "codex-cli.json"), "utf8");
  assert.doesNotMatch(state, /clipboard secret/);
});

test("thread_id action inserts the saved thread ID across direct and broker transports", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli conversation id action "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => invokeBroker(workspace, ["--broker", "stop"]));
  const statePath = path.join(workspace, ".codex-cli", "codex-cli.json");
  const customStatePath = path.join(workspace, "custom-thread-state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, '{"threadId":"wrong-default-conversation-id"}\n', "utf8");
  await writeFile(customStatePath, '{"threadId":"saved-conversation-id"}\n', "utf8");

  let result = invoke(workspace, ["--state", customStatePath, "--direct", "--new", "before <thread_id> after"]);
  assert.equal(result.status, 0, result.stderr);
  let turn = (await readTrace(workspace)).find((entry) => entry.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "before ", text_elements: [] },
    { type: "text", text: "saved-conversation-id", text_elements: [] },
    { type: "text", text: " after", text_elements: [] },
  ]);

  await rm(path.join(workspace, "fake-codex-trace.jsonl"));
  await writeFile(customStatePath, '{"threadId":"saved-conversation-id"}\n', "utf8");
  result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  result = invokeBroker(workspace, ["--state", customStatePath, "--broker", "--new", "before <thread_id> after"]);
  assert.equal(result.status, 0, result.stderr);
  turn = (await readTrace(workspace)).find((entry) => entry.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "before ", text_elements: [] },
    { type: "text", text: "saved-conversation-id", text_elements: [] },
    { type: "text", text: " after", text_elements: [] },
  ]);
});

test("clipboard image action survives asynchronous app-server loading and is removed at client or broker exit", async (t) => {
  await Promise.all([chmod(fakeCodex, 0o755), chmod(fakeClipboard, 0o755)]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli clipboard image "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let brokerStarted = false;
  t.after(() => { if (brokerStarted) invokeBroker(workspace, ["--broker", "stop"]); });
  const env = clipboardEnvironment(workspace, {
    FAKE_CLIPBOARD_MIME: "image/png",
    FAKE_CLIPBOARD_BINARY_BASE64: png.toString("base64"),
  });

  let result = invoke(workspace, ["--direct", "--new", "read image after acknowledgement <clipboard> after"], { env });
  assert.equal(result.status, 0, result.stderr);
  let trace = await readTrace(workspace);
  let turn = trace.find((entry) => entry.method === "turn/start");
  assert.deepEqual(turn.params.input.slice(0, 1), [{ type: "text", text: "read image after acknowledgement ", text_elements: [] }]);
  assert.equal(path.dirname(turn.params.input[1].path), await realpath(path.join(workspace, ".codex-cli", "session")));
  assert.match(path.basename(turn.params.input[1].path), /^clipboard-[a-f0-9]+\.png$/);
  assert.deepEqual(turn.params.input.slice(2), [{ type: "text", text: " after", text_elements: [] }]);
  await assert.rejects(stat(turn.params.input[1].path), { code: "ENOENT" });
  assert.deepEqual(await readClipboardTrace(workspace), ["--mime", "--binary"]);
  assert.doesNotMatch(result.stdout, new RegExp(png.toString("base64")));

  await rm(path.join(workspace, "fake-codex-trace.jsonl"));
  await rm(path.join(workspace, "clipboard-trace.log"));
  result = invokeBroker(workspace, ["--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);
  brokerStarted = true;
  result = invokeBroker(workspace, ["--broker", "--new", "read image after acknowledgement <clipboard> after"], { env });
  assert.equal(result.status, 0, result.stderr);
  trace = await readTrace(workspace);
  turn = trace.find((entry) => entry.method === "turn/start");
  await stat(turn.params.input[1].path);
  result = invokeBroker(workspace, ["--broker", "stop"], { env });
  assert.equal(result.status, 0, result.stderr);
  brokerStarted = false;
  await assert.rejects(stat(turn.params.input[1].path), { code: "ENOENT" });
});

test("broker reattaches a clipboard turn only when the resolved action digest matches", async (t) => {
  await Promise.all([chmod(fakeCodex, 0o755), chmod(fakeClipboard, 0o755)]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli clipboard reattach "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => invokeBroker(workspace, ["--broker", "stop"]));
  const env = clipboardEnvironment(workspace, { FAKE_CLIPBOARD_TEXT: "stable clipboard text" });

  let result = invokeBroker(workspace, ["--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);
  result = invokeBroker(workspace, ["--broker", "--new", "--timeout", "0.1", "slow <clipboard>"], { env });
  assert.equal(result.status, 124, result.stderr);
  result = invokeBroker(workspace, ["--broker", "--timeout", "5", "slow <clipboard>"], { env });
  assert.equal(result.status, 0, result.stderr);

  const trace = await readTrace(workspace);
  assert.equal(trace.filter((entry) => entry.method === "turn/start").length, 1);
  assert.deepEqual(await readClipboardTrace(workspace), ["--mime", "--text", "--mime", "--text"]);
  const state = await readFile(path.join(workspace, ".codex-cli", "codex-cli.json"), "utf8");
  assert.doesNotMatch(state, /stable clipboard text/);
});

test("prompt actions fail closed before broker, app-server, or clipboard access", async (t) => {
  await chmod(fakeClipboard, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli prompt action validation "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const env = clipboardEnvironment(workspace);

  let result = invokeBroker(workspace, ["--broker", "--new", "inspect <paste>"], { env });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unknown prompt action <paste>; supported actions: <clipboard>/);
  await assert.rejects(stat(path.join(workspace, "clipboard-trace.log")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(workspace, "fake-codex-trace.jsonl")), { code: "ENOENT" });

  result = invoke(workspace, ["--direct", "--new", "inspect <clipboard>"], {
    env: clipboardEnvironment(workspace, { FAKE_CLIPBOARD_FAIL_MODE: "--mime" }),
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /clipboard action failed: clipboard unavailable/);
  await assert.rejects(stat(path.join(workspace, "fake-codex-trace.jsonl")), { code: "ENOENT" });

  result = invoke(workspace, ["--direct", "--new", "inspect <clipboard>"], {
    env: clipboardEnvironment(workspace, {
      FAKE_CLIPBOARD_MIME: "image/png",
      FAKE_CLIPBOARD_BINARY_BASE64: Buffer.from("not an image").toString("base64"),
    }),
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /clipboard image does not match MIME type image\/png/);
  await assert.rejects(stat(path.join(workspace, "fake-codex-trace.jsonl")), { code: "ENOENT" });
});

test("broker startup removes stale clipboard action files", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli clipboard cleanup "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => invokeBroker(workspace, ["--broker", "stop"]));
  const stale = path.join(workspace, ".codex-cli", "session", "clipboard-leftover.png");
  await mkdir(path.dirname(stale), { recursive: true, mode: 0o700 });
  await writeFile(stale, png, { mode: 0o600 });

  const result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(stale), { code: "ENOENT" });
});
