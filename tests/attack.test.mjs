import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonRpcClient, captureProcess, parseAgenticResult, saveThread } from "../bin/codex-cli";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");
const fakeClipboard = path.join(root, "tests/fixtures/fake-cpb-paste.mjs");
const win32Platform = path.join(root, "tests/fixtures/platform-win32.cjs");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function invoke(workspace, args, options = {}) {
  const home = options.home ?? path.join(workspace, "home");
  const nodeArgs = options.platform === "win32" ? ["--require", win32Platform, cli] : [cli];
  const cwdArgs = options.cwd === false ? [] : ["--cwd", workspace];
  const codexArgs = options.codex === false ? [] : ["--codex", options.codex ?? fakeCodex];
  return spawnSync(process.execPath, [...nodeArgs, ...cwdArgs, ...codexArgs, ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 10000,
    input: options.input,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl"),
      ...options.env,
    },
  });
}

function invokeBroker(workspace, args, options = {}) {
  return invoke(workspace, ["--broker-socket", path.join(workspace, "broker.sock"), ...args], options);
}

async function assertCodexWasNotStarted(workspace) {
  await assert.rejects(stat(path.join(workspace, "fake-codex-trace.jsonl")), { code: "ENOENT" });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function brokerExchange(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("close", () => { if (!settled) finish(new Error("broker closed without a response")); });
  });
}

function encodeServerFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length < 126) return Buffer.concat([Buffer.from([129, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 129;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function readClientFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const lengthCode = buffer[1] & 127;
  const headerLength = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
  if (buffer.length < headerLength + 4) return undefined;
  const payloadLength = lengthCode < 126 ? lengthCode : lengthCode === 126 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
  const frameLength = headerLength + 4 + payloadLength;
  if (buffer.length < frameLength) return undefined;
  const mask = buffer.subarray(headerLength, headerLength + 4);
  const payload = Buffer.from(buffer.subarray(headerLength + 4, frameLength));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { message: JSON.parse(payload.toString("utf8")), rest: buffer.subarray(frameLength) };
}

function upgradeResponse(handshake) {
  const key = handshake.match(/Sec-WebSocket-Key: (.+)\r\n/i)?.[1].trim();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
}

async function withWebSocketServer(workspace, name, onConnection, run) {
  const socketPath = path.join(workspace, `${name}.sock`);
  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await run(socketPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("A-01 rejects malformed CLI input before starting Codex", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack input "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const cases = [
    ["--unknown"],
    ["--direct", "--new", "--approval", "always", "prompt"],
    ["--direct", "--new", "--thread-params", "[]", "prompt"],
    ["--direct", "--new", "--thread-params", "@missing.json", "prompt"],
    ["--direct", "--new", "--socket", "app.sock", "prompt"],
    ["--direct", "--new"],
  ];

  for (const args of cases) {
    const result = invoke(workspace, args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
  }
  await assertCodexWasNotStarted(workspace);
});

test("A-02 rejects malformed, unknown, and unreadable client configuration before starting Codex", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack config "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const cases = [
    ["malformed.json", "{", /must contain valid JSON/],
    ["unknown.json", '{"unknown":true}', /unknown configuration key: unknown/],
    ["wrong-type.json", '{"timeout":"later"}', /timeout must be a positive number/],
  ];

  for (const [name, contents, expected] of cases) {
    await writeFile(path.join(workspace, name), contents, "utf8");
    const result = invoke(workspace, ["--direct", "--new", "--config", name, "prompt"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, new RegExp(name.replace(".", "\\.")));
  }
  const missing = invoke(workspace, ["--direct", "--new", "--config", "missing.json", "prompt"]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /configuration file .*missing\.json: cannot read/);
  await assertCodexWasNotStarted(workspace);
});

test("A-03 warns when auto-discovered configuration wins risky new-thread settings", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack auto config "));
  const outsideWorkspace = await mkdtemp("/tmp/cdx-a03-outside-");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(outsideWorkspace, { recursive: true, force: true }));
  await writeJson(path.join(workspace, ".codex-cli", "config.json"), {
    direct: true,
    new: true,
    cwd: outsideWorkspace,
    codex: fakeCodex,
    brokerSocket: "/tmp/cdx-auto-config.sock",
    approval: "accept-for-session",
    threadParams: { sandbox: "workspace-write", unclassifiedFutureSetting: true },
  });

  let result = invoke(workspace, ["safe prompt"], { codex: false, cwd: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: new thread uses approval=accept-for-session/);
  assert.match(result.stderr, /warning: new thread uses codex=/);
  assert.match(result.stderr, /warning: new thread uses brokerSocket=\/tmp\/cdx-auto-config\.sock/);
  assert.match(result.stderr, /warning: new thread uses cwd=/);
  assert.match(result.stderr, /warning: new thread uses threadParams\.sandbox=workspace-write/);
  assert.match(result.stderr, /warning: new thread uses unclassified threadParams\.unclassifiedFutureSetting/);

  result = invoke(workspace, ["--broker-socket", "broker.sock", "--approval", "decline", "--thread-params", '{"sandbox":"read-only","unclassifiedFutureSetting":false}', "overridden prompt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /warning: new thread uses/);
});

test("A-04 refuses corrupt or absent saved state instead of guessing a thread", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack state read "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const statePath = path.join(workspace, "state.json");
  await writeFile(statePath, "{", "utf8");

  let result = invoke(workspace, ["--state", statePath, "prompt"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot read thread state/);

  await rm(statePath);
  result = invoke(workspace, ["--direct", "prompt"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /use --new/);
  await assertCodexWasNotStarted(workspace);
});

test("A-05 state persistence does not follow a predictable temporary-file symlink", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack state "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const stateDirectory = path.join(workspace, "state");
  const statePath = path.join(stateDirectory, "thread.json");
  const victimPath = path.join(workspace, "victim.txt");
  const legacyTemporaryPath = `${statePath}.${process.pid}.tmp`;
  await mkdir(stateDirectory);
  await writeFile(victimPath, "do not overwrite", "utf8");
  await symlink(victimPath, legacyTemporaryPath);

  await saveThread(statePath, "thread-attack", undefined);

  assert.equal(await readFile(victimPath, "utf8"), "do not overwrite");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { threadId: "thread-attack" });
  assert.equal((await stat(statePath)).mode & 0o077, 0);
});

test("A-06 rejects invalid image files locally before any transport starts", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack image "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "directory.image"));
  await writeFile(path.join(workspace, "empty.image"), Buffer.alloc(0));
  await writeFile(path.join(workspace, "unsupported.image"), "not an image", "utf8");
  await writeFile(path.join(workspace, "oversized.image"), png);
  await truncate(path.join(workspace, "oversized.image"), 20 * 1024 * 1024 + 1);
  const cases = [
    ["missing.image", /image file does not exist/],
    ["directory.image", /not a regular file/],
    ["empty.image", /image file is empty/],
    ["oversized.image", /exceeds the 20 MiB limit/],
    ["unsupported.image", /unsupported image type/],
  ];

  for (const [image, expected] of cases) {
    const result = invoke(workspace, ["--direct", "--new", "--image", image, "inspect image"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, expected);
  }
  await assertCodexWasNotStarted(workspace);
});

test("A-07 prompt actions fail closed and discard temporary clipboard images", async (t) => {
  await Promise.all([chmod(fakeCodex, 0o755), chmod(fakeClipboard, 0o755)]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack prompt action "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const clipboardEnvironment = {
    NODE_ENV: "test",
    CDXCLI_TEST_CLIPBOARD_HELPER: fakeClipboard,
    FAKE_CLIPBOARD_TRACE: path.join(workspace, "clipboard-trace.log"),
  };

  let result = invoke(workspace, ["--direct", "--new", "inspect <paste>"], { env: clipboardEnvironment });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unknown prompt action <paste>/);
  await assertCodexWasNotStarted(workspace);

  result = invoke(workspace, ["--direct", "--new", "inspect <clipboard>"], {
    env: { ...clipboardEnvironment, FAKE_CLIPBOARD_MIME: "image/png", FAKE_CLIPBOARD_BINARY_BASE64: Buffer.from("not an image").toString("base64") },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /clipboard image does not match MIME type image\/png/);
  await assertCodexWasNotStarted(workspace);

  result = invoke(workspace, ["--direct", "--new", "read image after acknowledgement <clipboard>"], {
    env: { ...clipboardEnvironment, FAKE_CLIPBOARD_MIME: "image/png", FAKE_CLIPBOARD_BINARY_BASE64: png.toString("base64") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(png.toString("base64")));
  const trace = (await readFile(path.join(workspace, "fake-codex-trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const image = trace.find((entry) => entry.method === "turn/start").params.input.find((item) => item.type === "localImage");
  await assert.rejects(stat(image.path), { code: "ENOENT" });
});

test("A-08 subprocess capture bounds combined stdout and stderr before they exhaust memory", async () => {
  for (const source of [
    'process.stdout.write("x".repeat(4096))',
    'process.stderr.write("x".repeat(4096))',
    'process.stdout.write("x".repeat(768)); process.stderr.write("y".repeat(768))',
  ]) {
    const result = await captureProcess(process.execPath, ["-e", source], { maxOutputBytes: 1024 });
    assert.match(result.error?.message ?? "", /subprocess output exceeds 1024 bytes/);
    assert.ok(result.stdout.length + result.stderr.length <= 1024);
  }
});

test("A-09 rejects malformed, oversized, incompatible, and cross-workspace broker requests", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp("/tmp/cdx-a09-");
  t.after(async () => {
    invokeBroker(workspace, ["--broker", "stop"]);
    await rm(workspace, { recursive: true, force: true });
  });
  let result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  const socketPath = path.join(workspace, "broker.sock");

  let response = await brokerExchange(socketPath, "not-json\n");
  assert.equal(response.code, "INVALID_JSON");
  response = await brokerExchange(socketPath, "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(response.code, "MESSAGE_TOO_LARGE");
  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 99, type: "status" })}\n`);
  assert.equal(response.code, "VERSION");
  response = await brokerExchange(socketPath, `${JSON.stringify({
    version: 1,
    type: "run",
    new: "true",
    cwd: path.join(workspace, "other"),
    prompt: "prompt",
    approval: "decline",
    timeout: 5,
  })}\n`);
  assert.equal(response.code, "INVALID_REQUEST");
  assert.match(response.message, /cwd does not match/);

  response = await brokerExchange(socketPath, `${JSON.stringify({
    version: 1,
    type: "run",
    new: "true",
    cwd: workspace,
    prompt: "prompt",
    approval: "decline",
    timeout: 5,
  })}\n`);
  assert.equal(response.code, "INVALID_REQUEST");
  assert.match(response.message, /broker new must be a boolean/);
});

test("A-10 broker control and interactive responses require matching instance and request IDs", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp("/tmp/cdx-a10-");
  t.after(async () => {
    invokeBroker(workspace, ["--broker", "stop"]);
    await rm(workspace, { recursive: true, force: true });
  });
  const result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  const socketPath = path.join(workspace, "broker.sock");

  let response = await brokerExchange(socketPath, `${JSON.stringify({ version: 1, type: "stop", instanceId: "other-broker" })}\n`);
  assert.equal(response.code, "INSTANCE");
  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 1, type: "approval-response", requestId: "forged", decision: "accept" })}\n`);
  assert.equal(response.code, "APPROVAL_ID");
  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 1, type: "user-input-response", requestId: "forged", answers: {} })}\n`);
  assert.equal(response.code, "USER_INPUT_ID");
});

test("A-11 broker surfaces app-server system errors and stale explicit threads", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp("/tmp/cdx-a11-");
  t.after(async () => {
    invokeBroker(workspace, ["--broker", "stop"]);
    await rm(workspace, { recursive: true, force: true });
  });
  let result = invokeBroker(workspace, ["--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);

  result = invokeBroker(workspace, ["--broker", "--new", "unauthenticated"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Codex thread entered systemError/);

  result = invokeBroker(workspace, ["--broker", "--thread", "missing-thread", "continue"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /thread not found in this broker instance: missing-thread; use --new/);
});

test("A-12 handles hostile WebSocket upgrades, frames, and connection closure", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack websocket "));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  await withWebSocketServer(workspace, "rejected", (socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  }, async (socketPath) => {
    const client = new JsonRpcClient(socketPath, () => {}, () => {});
    try {
      await assert.rejects(client.ready, /rejected WebSocket upgrade/);
    } finally {
      client.close();
    }
  });

  const event = { method: "server/ready", params: { ready: true } };
  await withWebSocketServer(workspace, "coalesced", (socket) => {
    socket.once("data", (chunk) => socket.write(Buffer.concat([Buffer.from(upgradeResponse(chunk.toString("binary")), "binary"), encodeServerFrame(event)])));
  }, async (socketPath) => {
    let received;
    const client = new JsonRpcClient(socketPath, (message) => { received = message; }, () => {});
    try {
      await client.ready;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(received, event);
    } finally {
      client.close();
    }
  });

  let receivedTextLength = 0;
  await withWebSocketServer(workspace, "large", (socket) => {
    let handshake = "";
    let frames = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (handshake !== undefined) {
        handshake += chunk.toString("binary");
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.write(upgradeResponse(handshake));
        frames = Buffer.from(handshake.slice(end + 4), "binary");
        handshake = undefined;
      } else frames = Buffer.concat([frames, chunk]);
      const frame = readClientFrame(frames);
      if (!frame) return;
      frames = frame.rest;
      receivedTextLength = frame.message.params.text.length;
      socket.write(encodeServerFrame({ jsonrpc: "2.0", id: frame.message.id, result: { ok: true } }));
    });
  }, async (socketPath) => {
    const client = new JsonRpcClient(socketPath, () => {}, () => {});
    try {
      assert.deepEqual(await client.request("large/payload", { text: "x".repeat(70000) }), { ok: true });
      assert.equal(receivedTextLength, 70000);
    } finally {
      client.close();
    }
  });

  await withWebSocketServer(workspace, "closed", (socket) => {
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (!upgraded) {
        upgraded = true;
        socket.write(upgradeResponse(chunk.toString("binary")));
      } else socket.end();
    });
  }, async (socketPath) => {
    const client = new JsonRpcClient(socketPath, () => {}, () => {});
    try {
      await assert.rejects(client.request("never/replies", {}), /closed the WebSocket connection/);
    } finally {
      client.close();
    }
  });
});

test("A-13 rejects malformed agentic contracts and keeps system errors out of the agent range", async (t) => {
  for (const [message, expected] of [
    [undefined, /message is missing/],
    ["not JSON", /not valid JSON/],
    ['{"goal_achieved":false,"agentic_exit_code":13,"summary":"reserved","reason":"invalid"}', /13 is reserved/],
    ['{"goal_achieved":false,"agentic_exit_code":0,"summary":"wrong","reason":"invalid"}', /code 0 requires goal_achieved true/],
  ]) {
    assert.throws(() => parseAgenticResult(message), (error) => error.exitCode === 72 && expected.test(error.message));
  }
  assert.equal(parseAgenticResult('{"goal_achieved":true,"agentic_exit_code":1,"summary":"condition found","reason":"the completed check found it"}').agentic_exit_code, 1);

  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack agentic "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "unauthenticated"]);
  assert.equal(result.status, 70, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex thread entered systemError/);
});

test("A-14 rejects unsupported Windows managed-socket and broker endpoints", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli attack Windows transport "));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  let result = invoke(workspace, ["--new", "prompt"], { platform: "win32" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /managed app-server socket mode is unavailable on Windows/);

  result = invoke(workspace, ["--broker", "status", "--broker-socket", "broker.sock"], { platform: "win32" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--broker-socket must be a Windows named pipe/);
});
