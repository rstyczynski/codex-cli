import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeClipboard = path.join(root, "tests/fixtures/fake-cpb-paste.mjs");

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
  if (buffer.length < 2) return;
  const lengthCode = buffer[1] & 127;
  const headerLength = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
  if (buffer.length < headerLength + 4) return;
  const payloadLength = lengthCode < 126 ? lengthCode : lengthCode === 126 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
  const frameLength = headerLength + 4 + payloadLength;
  if (buffer.length < frameLength) return;
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

function invokeCli(workspace, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--cwd", workspace, ...args], {
      cwd: workspace,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex-cli test command timed out: ${args.join(" ")}`));
    }, options.timeout ?? 10000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

class FakeSocketAppServer {
  constructor({ allowedNever = true } = {}) {
    this.allowedNever = allowedNever;
    this.requests = [];
    this.threads = new Map();
    this.pendingServerRequests = new Map();
    this.nextThread = 1;
    this.nextTurn = 1;
    this.nextServerRequest = 1;
  }

  async listen(socketPath) {
    this.socketPath = socketPath;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, resolve);
    });
  }

  async close() {
    if (!this.server?.listening) return;
    await new Promise((resolve) => this.server.close(resolve));
  }

  handleConnection(socket) {
    let handshake = "";
    let frames = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (handshake !== undefined) {
        handshake += chunk.toString("binary");
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.write(upgradeResponse(handshake));
        frames = Buffer.from(handshake.slice(end + 4), "binary");
        handshake = undefined;
      } else {
        frames = Buffer.concat([frames, chunk]);
      }

      for (;;) {
        const frame = readClientFrame(frames);
        if (!frame) break;
        frames = frame.rest;
        this.handleMessage(socket, frame.message);
      }
    });
  }

  send(socket, message) {
    if (!socket.destroyed) socket.write(encodeServerFrame(message));
  }

  response(socket, id, result) {
    this.send(socket, { jsonrpc: "2.0", id, result });
  }

  error(socket, id, message) {
    this.send(socket, { jsonrpc: "2.0", id, error: { code: -32000, message } });
  }

  serverRequest(socket, method, params, onResponse) {
    const id = `server-${this.nextServerRequest++}`;
    this.pendingServerRequests.set(id, onResponse);
    this.send(socket, { jsonrpc: "2.0", id, method, params });
  }

  completeTurn(socket, thread, turn, prompt, suffix = "") {
    let text = `socket reply ${thread.turns.length}: ${prompt}${suffix}`;
    if (prompt.includes("agentic achieved")) text = JSON.stringify({ goal_achieved: true, agentic_exit_code: 0, summary: "socket goal complete", reason: "socket path completed" });
    else if (prompt.includes("agentic not achieved")) text = JSON.stringify({ goal_achieved: false, agentic_exit_code: 1, summary: "socket goal incomplete", reason: "socket path reports remaining work" });
    const item = { id: `item-${turn.id}`, type: "agentMessage", text };
    turn.items = [item];
    turn.status = "completed";
    this.send(socket, { method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: text } });
    this.send(socket, { method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
  }

  handleMessage(socket, message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const callback = this.pendingServerRequests.get(message.id);
      if (callback) {
        this.pendingServerRequests.delete(message.id);
        callback(message.result);
      }
      return;
    }

    const { id, method, params = {} } = message;
    this.requests.push({ method, params });
    if (method === "initialize") return this.response(socket, id, { userAgent: "fake-socket-codex" });
    if (method === "configRequirements/read") {
      return this.response(socket, id, { requirements: { allowedApprovalPolicies: this.allowedNever ? ["never"] : [] } });
    }
    if (method === "thread/start") {
      const thread = { id: `thread-${this.nextThread++}`, cwd: params.cwd, turns: [], status: { type: "idle" } };
      this.threads.set(thread.id, thread);
      return this.response(socket, id, { thread });
    }
    if (method === "thread/resume") {
      let thread = this.threads.get(params.threadId);
      if (!thread && params.threadId?.startsWith("not-loaded-")) {
        thread = { id: params.threadId, cwd: params.cwd, turns: [], status: { type: "idle" } };
        this.threads.set(thread.id, thread);
      }
      if (!thread) return this.error(socket, id, `thread not found: ${params.threadId}`);
      return this.response(socket, id, { thread });
    }
    if (method === "thread/read") {
      const thread = this.threads.get(params.threadId);
      if (!thread && params.threadId?.startsWith("not-loaded-")) {
        return this.response(socket, id, { thread: { id: params.threadId, cwd: params.cwd, turns: [], status: { type: "notLoaded" } } });
      }
      if (!thread) return this.error(socket, id, `thread not found: ${params.threadId}`);
      return this.response(socket, id, { thread });
    }
    if (method === "turn/start") {
      const thread = this.threads.get(params.threadId);
      if (!thread) return this.error(socket, id, `thread not found: ${params.threadId}`);
      const prompt = params.input?.[0]?.text ?? "";
      const turn = { id: `turn-${this.nextTurn++}`, status: "inProgress", items: [{ id: `user-${this.nextTurn}`, type: "userMessage", content: params.input ?? [] }] };
      thread.turns.push(turn);
      this.response(socket, id, { turn });
      if (prompt.includes("slow")) return;
      if (prompt.includes("failed socket")) {
        turn.status = "failed";
        turn.error = { message: "simulated socket turn failure" };
        return this.send(socket, { method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
      }
      if (prompt.includes("unauthenticated socket")) {
        const error = {
          message: "socket received 401 Unauthorized",
          additionalDetails: "log in before retrying",
          codexErrorInfo: "unauthorized",
        };
        this.send(socket, { method: "error", params: { threadId: thread.id, turnId: turn.id, error, willRetry: false } });
        turn.status = "completed";
        turn.items = [];
        thread.status = { type: "systemError" };
        this.send(socket, { method: "thread/status/changed", params: { threadId: thread.id, status: thread.status } });
        return this.send(socket, { method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
      }
      if (prompt.includes("item completed only")) {
        const item = { id: `item-${turn.id}`, type: "agentMessage", text: "item completed only reply" };
        turn.items = [item];
        turn.status = "completed";
        this.send(socket, { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
        return this.send(socket, { method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
      }
      if (prompt.includes("approve")) {
        return this.serverRequest(socket, "item/commandExecution/requestApproval", {
          threadId: thread.id,
          turnId: turn.id,
          command: "echo socket approved",
          reason: "fake socket approval",
        }, (result) => this.completeTurn(socket, thread, turn, prompt, ` [${result?.decision ?? "missing"}]`));
      }
      return this.completeTurn(socket, thread, turn, prompt);
    }
    if (method === "turn/interrupt") {
      const turn = this.threads.get(params.threadId)?.turns.find((candidate) => candidate.id === params.turnId);
      if (turn) turn.status = "failed";
      return this.response(socket, id, {});
    }
    return this.error(socket, id, `unsupported fake socket method: ${method}`);
  }
}

test("socket mode creates, saves, and resumes a managed app-server thread", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket managed "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  let result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--approval", "accept", "--model", "socket-model", "approve socket"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /socket reply 1: approve socket \[accept\]/);
  assert.match(result.stderr, /started thread thread-1/);

  const state = JSON.parse(await readFile(path.join(workspace, ".codex-cli/codex-cli.json"), "utf8"));
  assert.equal(state.threadId, "thread-1");
  assert.equal(state.model, "socket-model");
  assert.ok(server.requests.some((request) => request.method === "configRequirements/read"));
  const firstTurn = server.requests.find((request) => request.method === "turn/start");
  assert.equal(firstTurn.params.approvalPolicy, "never");
  assert.equal(firstTurn.params.model, "socket-model");

  result = await invokeCli(workspace, ["--socket", socketPath, "item completed only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /item completed only reply/);
  assert.equal(server.requests.filter((request) => request.method === "thread/start").length, 1);
});

test("socket mode rejects --interactive without a terminal before starting a turn", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket interactive approval "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  const result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--interactive", "approve interactive socket"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--interactive requires a terminal on standard input/);
  assert.ok(!server.requests.some((request) => request.method === "thread\/start"));
});

test("socket mode attaches verified local images to the same user turn", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket image "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  const imagePath = path.join(workspace, "capture.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
  const canonicalImagePath = await realpath(imagePath);
  await server.listen(socketPath);
  t.after(() => server.close());

  const result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--image", "capture.png", "inspect socket image"]);
  assert.equal(result.status, 0, result.stderr);
  const turn = server.requests.find((request) => request.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "inspect socket image", text_elements: [] },
    { type: "localImage", path: canonicalImagePath, detail: "auto" },
  ]);
});

test("socket mode resolves clipboard prompt actions into ordered input items", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket clipboard action "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  const clipboardTrace = path.join(workspace, "clipboard-trace.log");
  await server.listen(socketPath);
  t.after(() => server.close());

  const result = await invokeCli(workspace, ["--socket", socketPath, "--new", "before <clipboard> after"], {
    env: {
      NODE_ENV: "test",
      CDXCLI_TEST_CLIPBOARD_HELPER: fakeClipboard,
      FAKE_CLIPBOARD_TRACE: clipboardTrace,
      FAKE_CLIPBOARD_TEXT: "socket clipboard text",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const turn = server.requests.find((request) => request.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "before ", text_elements: [] },
    { type: "text", text: "socket clipboard text", text_elements: [] },
    { type: "text", text: " after", text_elements: [] },
  ]);
  assert.deepEqual((await readFile(clipboardTrace, "utf8")).trim().split("\n"), ["--mime", "--text"]);
});

test("socket mode surfaces thread system errors even when the turn says completed", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket system error "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  const result = await invokeCli(workspace, ["--socket", socketPath, "--new", "unauthenticated socket"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error: socket received 401 Unauthorized — log in before retrying — unauthorized/);
  assert.match(result.stderr, /Codex thread entered systemError/);
});

test("socket mode applies the agentic result contract", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket agentic result "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  let result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--agentic-error-code", "agentic achieved"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "socket goal complete\n");
  const agenticTurn = server.requests.find((request) => request.method === "turn/start");
  assert.equal(agenticTurn.params.outputSchema.properties.goal_achieved.type, "boolean");
  assert.equal(agenticTurn.params.outputSchema.additionalProperties, false);

  result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--agentic-error-code", "--json", "agentic not achieved"]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    goal_achieved: false,
    agentic_exit_code: 1,
    summary: "socket goal incomplete",
    reason: "socket path reports remaining work",
  });
});

test("socket mode rejects approval automation when the app-server forbids it", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket approval "));
  const server = new FakeSocketAppServer({ allowedNever: false });
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  const result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--approval", "accept", "approve forbidden"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /forbids the never approval policy/);
  assert.ok(!server.requests.some((request) => request.method === "thread/start"));
});

test("socket mode resumes an explicit not-loaded thread by id", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket resume "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  const result = await invokeCli(workspace, ["--socket", socketPath, "--thread", "not-loaded-socket-thread", "attach socket"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /socket reply 1: attach socket/);
  assert.ok(server.requests.some((request) => request.method === "thread/resume" && request.params.threadId === "not-loaded-socket-thread"));
  assert.ok(server.requests.some((request) => request.method === "turn/start" && request.params.threadId === "not-loaded-socket-thread"));
});

test("socket mode reports and interrupts active turns on saved threads", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli socket active "));
  const server = new FakeSocketAppServer();
  const socketPath = path.join(workspace, "app.sock");
  await server.listen(socketPath);
  t.after(() => server.close());

  let result = await invokeCli(workspace, ["--socket", socketPath, "--new", "--timeout", "0.1", "slow socket"]);
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /timed out after 0.1 seconds/);

  result = await invokeCli(workspace, ["--socket", socketPath, "next socket"]);
  assert.equal(result.status, 125, result.stderr);
  assert.match(result.stderr, /has active turn/);

  result = await invokeCli(workspace, ["--socket", socketPath, "--interrupt-pending", "after interrupt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /socket reply 2: after interrupt/);
  assert.ok(server.requests.some((request) => request.method === "turn/interrupt"));
});
