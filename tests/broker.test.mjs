import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");
const fakeClipboard = path.join(root, "tests/fixtures/fake-cpb-paste.mjs");

function invoke(workspace, ...args) {
  return spawnSync(process.execPath, [cli, "--cwd", workspace, "--broker-socket", path.join(workspace, "broker.sock"), "--codex", fakeCodex, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl") } });
}

function invokeWithEnv(workspace, environment, ...args) {
  return spawnSync(process.execPath, [cli, "--cwd", workspace, "--broker-socket", path.join(workspace, "broker.sock"), "--codex", fakeCodex, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, ...environment, FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl") } });
}

function invokeAsync(workspace, ...args) {
  const child = spawn(process.execPath, [cli, "--cwd", workspace, "--broker-socket", path.join(workspace, "broker.sock"), "--codex", fakeCodex, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl") } });
  return { child, done: new Promise((resolve) => {
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  }) };
}

async function readTrace(workspace) {
  const contents = await readFile(path.join(workspace, "fake-codex-trace.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runInteractiveProtocol(workspace) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(workspace, "broker.sock"));
    let buffer = ""; let output = ""; let sawApproval = false;
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, type: "run", new: false, threadId: "thread-1", cwd: workspace, prompt: "approve interactive", model: null, approval: "decline", interactive: true, interruptPending: false, json: false, timeout: 5 })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline === -1) break;
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.type === "approval") { sawApproval = true; socket.write(`${JSON.stringify({ version: 1, type: "approval-response", requestId: message.requestId, decision: "accept" })}\n`); }
        if (message.type === "delta") output += message.delta;
        if (message.type === "error") reject(new Error(message.message));
        if (message.type === "completed") { socket.end(); resolve({ output, sawApproval }); }
      }
    });
  });
}

function runUserInputProtocol(workspace) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(workspace, "broker.sock"));
    let buffer = ""; let output = ""; let sawQuestion = false;
    socket.setEncoding("utf8"); socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, type: "run", new: false, threadId: "thread-1", cwd: workspace, prompt: "question test", model: null, approval: "decline", interactive: true, interruptPending: false, json: false, timeout: 5 })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline === -1) break;
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.type === "user-input") { sawQuestion = true; socket.write(`${JSON.stringify({ version: 1, type: "user-input-response", requestId: message.requestId, answers: { choice: { answers: ["Beta"] } } })}\n`); }
        if (message.type === "delta") output += message.delta;
        if (message.type === "error") reject(new Error(message.message));
        if (message.type === "completed") { socket.end(); resolve({ output, sawQuestion }); }
      }
    });
  });
}

function runCrashWithPendingApproval(workspace) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(workspace, "broker.sock"));
    let buffer = ""; let sawApproval = false; let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve({ sawApproval });
    };
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      if (sawApproval && ["ECONNRESET", "EPIPE"].includes(error.code)) finish();
      else finish(error);
    });
    socket.on("close", () => { if (sawApproval) finish(); });
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, type: "run", new: true, cwd: workspace, prompt: "crash with approval pending", model: null, approval: "decline", interactive: true, interruptPending: false, json: false, timeout: 5 })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline === -1) break;
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.type === "approval") sawApproval = true;
        if (message.type === "error" && sawApproval) finish();
      }
    });
  });
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

test("broker persists a thread across CLI calls and logs approvals", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker test "));
  const longThreadTitle = `${"full-thread-title-".repeat(8)}tail`;
  t.after(() => invoke(workspace, "--broker", "stop"));

  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /codex-cli v1\.1\.0 — ready/);
  assert.match(result.stderr, /broker started/);
  assert.equal((await stat(path.join(workspace, "broker.sock"))).mode & 0o777, 0o600);

  result = invoke(workspace, "--broker", "--approval", "accept", "--approval-log", "approvals.toml", "--thread-label", longThreadTitle, "--prompt", "first");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: first/);
  assert.match(result.stderr, /started thread thread-1/);
  const state = JSON.parse(await readFile(path.join(workspace, ".codex-cli/codex-cli.json"), "utf8"));
  assert.equal(state.threadId, "thread-1");
  assert.equal(state.lastPrompt, "first");
  assert.equal(state.transport, "broker");
  assert.ok(state.brokerInstanceId);
  const firstBrokerInstanceId = state.brokerInstanceId;

  result = invoke(workspace, "--broker", "threads");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ID\tSTATUS\tARCHIVED\tCREATED\tUPDATED\tCWD\tTITLE$/m);
  assert.match(result.stdout, /^thread-1\t/m);
  assert.ok(result.stdout.includes(longThreadTitle), "the text thread listing must not truncate its selector label");

  result = invoke(workspace, "--broker", "threads", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, "thread-1");

  result = invoke(workspace, "--broker", "--approval", "accept-for-session", "--approval-log", "approvals.toml", "--prompt", "approve second");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 2: approve second \[acceptForSession\]/);
  assert.match(result.stderr, /approval requested for echo approved; acceptForSession/);
  const log = await readFile(path.join(workspace, "approvals.toml"), "utf8");
  assert.match(log, /command = "echo approved"/);
  assert.match(log, /decision = "acceptForSession"/);

  result = invoke(workspace, "--broker", "--approval", "accept", "--approval-log", "approvals.toml", "--prompt", "approve third");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[accept\]/);

  result = invoke(workspace, "--broker", "--approval", "accept", "--approval-log", "approvals.toml", "--prompt", "file approval broker");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file approval broker \[accept\]/);
  assert.match(result.stderr, /approval requested for update README\.md; accept/);

  result = invoke(workspace, "--broker", "--approval", "decline", "--approval-log", "approvals.toml", "--prompt", "approve fourth");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[decline\]/);

  result = invoke(workspace, "--broker", "--new", "--interactive", "approve from a non-terminal");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--interactive requires a terminal on standard input/);
  assert.doesNotMatch(result.stderr, /approval requested/);

  result = invoke(workspace, "--broker", "--approval", "accept", "--prompt", "unknown request");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[decline\]/);
  assert.match(result.stderr, /approval requested for unknown; decline/);
  result = invoke(workspace, "--broker", "--prompt", "elicitation request");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /elicitation request \[decline\]/);
  const elicitationResponse = (await readFile(path.join(workspace, "fake-codex-trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).findLast((message) => message.result?.action === "decline");
  assert.deepEqual(elicitationResponse?.result, { action: "decline" });
  const expandedLog = await readFile(path.join(workspace, "approvals.toml"), "utf8");
  assert.match(expandedLog, /decision = "accept"/);
  assert.match(expandedLog, /decision = "decline"/);

  const interactive = await runInteractiveProtocol(workspace);
  assert.equal(interactive.sawApproval, true);
  assert.match(interactive.output, /\[accept\]/);

  const userInput = await runUserInputProtocol(workspace);
  assert.equal(userInput.sawQuestion, true);
  assert.match(userInput.output, /\[Beta\]/);

  result = invoke(workspace, "--broker", "--prompt", "mixed messages");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "progress|final");

  result = invoke(workspace, "--broker", "--verbosity", "high", "--prompt", "rich items through broker");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply \d+: rich items through broker/);
  assert.match(result.stderr, /Reasoning:/);
  assert.match(result.stderr, /Command started: npm test/);
  assert.match(result.stderr, /all tests passed/);
  assert.match(result.stderr, /MCP tool completed/);

  const slow = invokeAsync(workspace, "--broker", "--new", "--timeout", "5", "--prompt", "slow turn");
  await new Promise((resolve) => setTimeout(resolve, 100));
  result = invoke(workspace, "--broker", "--new", "--prompt", "concurrent turn");
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /busy/);
  const slowResult = await slow.done;
  assert.equal(slowResult.status, 0, slowResult.stderr);

  const timedOut = invokeAsync(workspace, "--broker", "--new", "--timeout", "0.1", "--prompt", "slow resume");
  const timedOutResult = await timedOut.done;
  assert.equal(timedOutResult.status, 124, timedOutResult.stderr);
  result = invoke(workspace, "--broker", "--timeout", "5", "--prompt", "slow resume");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: slow resume/);
  const resumeTrace = await readTrace(workspace);
  assert.equal(resumeTrace.filter((message) => message.method === "turn/start" && message.params.input?.[0]?.text === "slow resume").length, 1);

  const missingMetadata = invokeAsync(workspace, "--broker", "--new", "--timeout", "0.1", "--prompt", "slow prompt metadata unavailable");
  const missingMetadataResult = await missingMetadata.done;
  assert.equal(missingMetadataResult.status, 124, missingMetadataResult.stderr);
  result = invoke(workspace, "--broker", "--timeout", "5", "--prompt", "slow prompt metadata unavailable");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: slow prompt metadata unavailable/);
  const metadataTrace = await readTrace(workspace);
  assert.equal(metadataTrace.filter((message) => message.method === "turn/start" && message.params.input?.[0]?.text === "slow prompt metadata unavailable").length, 1);

  result = invoke(workspace, "--broker", "status");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ready": true/);
  assert.deepEqual(new Set(JSON.parse(result.stdout).capabilities), new Set([
    "agentic-result-v1",
    "image-attachments-v1",
    "prompt-attachment-actions-v1",
    "thread-selectors-v1",
    "thread-label-v1",
    "turn-commit-ack-v1",
    "thread-id-action-context-v1",
  ]));

  result = invoke(workspace, "--broker", "stop");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /broker stopped/);

  result = invokeWithEnv(workspace, { FAKE_CODEX_RESUME_THREADS: "1" }, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--prompt", "stale continuation");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: stale continuation/);
  assert.match(result.stderr, /rejoining saved thread thread-4 after broker restart/);
  assert.doesNotMatch(result.stderr, /started thread/);
  const restartedState = JSON.parse(await readFile(path.join(workspace, ".codex-cli/codex-cli.json"), "utf8"));
  assert.notEqual(restartedState.brokerInstanceId, firstBrokerInstanceId);
  const stoppedRun = invokeAsync(workspace, "--broker", "--new", "--timeout", "5", "--prompt", "slow stop target");
  await new Promise((resolve) => setTimeout(resolve, 100));
  result = invoke(workspace, "--broker", "stop");
  assert.equal(result.status, 0, result.stderr);
  const stoppedResult = await stoppedRun.done;
  assert.equal(stoppedResult.status, 130, stoppedResult.stderr);
});

test("thread and turn parameters pass through JSON files and inline objects", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker params "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  await writeFile(path.join(workspace, "codex-config.json"), JSON.stringify({
    model_reasoning_effort: "high",
    model_verbosity: "low",
    feature_flags: { sample: true },
  }), "utf8");
  await writeFile(path.join(workspace, "thread-params.json"), JSON.stringify({
    baseInstructions: "Use concise answers.",
    personality: "pragmatic",
    ephemeral: true,
    model: "thread-json-model",
    config: { model_verbosity: "medium" },
  }), "utf8");
  await writeFile(path.join(workspace, "turn-params.json"), JSON.stringify({
    effort: "high",
    summary: "concise",
    personality: "friendly",
    sandbox: "read-only",
    model: null,
    outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  }), "utf8");

  let result = invoke(workspace, "--broker", "start", "--experimental-api");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace,
    "--broker", "--experimental-api", "--new",
    "--config-json", "codex-config.json",
    "--thread-params", "@thread-params.json",
    "--thread-params", JSON.stringify({ serviceTier: "fast" }),
    "--turn-params", "@turn-params.json",
    "--prompt", "parameter forwarding",
  );
  assert.equal(result.status, 0, result.stderr);

  let trace = await readTrace(workspace);
  const initialize = trace.find((message) => message.method === "initialize");
  assert.equal(initialize.params.capabilities.experimentalApi, true);
  const threadStart = trace.find((message) => message.method === "thread/start");
  assert.deepEqual(threadStart.params, {
    cwd: workspace,
    ephemeral: true,
    baseInstructions: "Use concise answers.",
    personality: "pragmatic",
    model: "thread-json-model",
    config: {
      model_reasoning_effort: "high",
      model_verbosity: "medium",
      feature_flags: { sample: true },
    },
    serviceTier: "fast",
    sandbox: "read-only",
  });
  const firstTurn = trace.find((message) => message.method === "turn/start");
  assert.deepEqual(firstTurn.params, {
    effort: "high",
    summary: "concise",
    personality: "friendly",
    model: null,
    outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
    threadId: "thread-1",
    cwd: workspace,
    input: [{ type: "text", text: "parameter forwarding", text_elements: [] }],
  });

  result = invoke(workspace, "--broker", "--prompt", "continuation omits one-turn overrides");
  assert.equal(result.status, 0, result.stderr);
  trace = await readTrace(workspace);
  const turns = trace.filter((message) => message.method === "turn/start");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].params, {
    threadId: "thread-1",
    cwd: workspace,
    input: [{ type: "text", text: "continuation omits one-turn overrides", text_elements: [] }],
  });
  assert.equal(trace.filter((message) => message.method === "thread/start").length, 1);

  result = invoke(workspace, "--broker", "--thread-params", "{}", "--prompt", "invalid continuation");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /appl(?:y|ies) only when creating a thread|apply only when creating a thread/);
  result = invoke(workspace, "--broker", "--turn-params", '{"sandbox":"read-only"}', "--prompt", "unsafe turn sandbox");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /turn-params sandbox is not enforced/);
  result = invoke(workspace, "--broker", "--turn-params", "[]", "--prompt", "invalid params");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /must contain a JSON object/);
  result = invoke(workspace, "--broker", "status");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"experimentalApi": true/);

  result = invoke(workspace, "--broker", "stop");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace,
    "--direct", "--experimental-api", "--new", "--model", "shortcut-model",
    "--thread-params", JSON.stringify({ developerInstructions: "Direct parity.", model: "raw-thread-model" }),
    "--turn-params", JSON.stringify({ effort: "low", model: "raw-turn-model" }),
    "--prompt", "direct parameter forwarding",
  );
  assert.equal(result.status, 0, result.stderr);
  trace = await readTrace(workspace);
  const directThread = trace.filter((message) => message.method === "thread/start").at(-1);
  const directTurn = trace.filter((message) => message.method === "turn/start").at(-1);
  assert.equal(directThread.params.model, "shortcut-model");
  assert.equal(directThread.params.developerInstructions, "Direct parity.");
  assert.equal(directTurn.params.model, "shortcut-model");
  assert.equal(directTurn.params.effort, "low");
});

test("broker cleans up after app-server crash and can restart", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker crash "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  const pendingCrash = await runCrashWithPendingApproval(workspace);
  assert.equal(pendingCrash.sawApproval, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(stat(path.join(workspace, "broker.sock")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(workspace, "broker.pid")), { code: "ENOENT" });
  result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--timeout", "5", "--prompt", "crash app server");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broker app-server exited unexpectedly; restart the broker/);
  assert.doesNotMatch(result.stderr, /fake app-server crash diagnostic/);
  assert.doesNotMatch(result.stderr, /broker connection closed before completion/);
  assert.match(await readFile(path.join(workspace, "broker.pid.stderr.log"), "utf8"), /app-server exited unexpectedly \(exit code 7\)/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(stat(path.join(workspace, "broker.sock")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(workspace, "broker.pid")), { code: "ENOENT" });
  result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "stop");
  assert.equal(result.status, 0, result.stderr);
});

test("broker records a crashed procedure and resumes its former thread", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker recover crash "));
  t.after(() => invoke(workspace, "--broker", "stop"));

  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "conversation before failure");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: conversation before failure/);

  result = invoke(workspace, "--broker", "--prompt", "crash app server");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CRASH DETECTED: the Codex procedure for thread thread-1 terminated unexpectedly/);
  assert.match(result.stderr, /--thread thread-1/);
  const crashPath = path.join(workspace, ".codex-cli", "procedure-crash.json");
  const transcriptPath = path.join(workspace, ".codex-cli", "procedure-transcript.jsonl");
  const crash = JSON.parse(await readFile(crashPath, "utf8"));
  assert.equal(crash.threadId, "thread-1");
  assert.equal(crash.prompt, "crash app server");
  assert.equal(crash.clientExitCode, 2);
  assert.match(crash.brokerDiagnostic, /app-server exited unexpectedly/);

  await new Promise((resolve) => setTimeout(resolve, 100));
  result = invokeWithEnv(workspace, { FAKE_CODEX_RESUME_THREADS: "1" }, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--prompt", "continue after failure");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /recovering crashed procedure in thread thread-1/);
  assert.match(result.stdout, /reply 1: continue after failure/);
  const recovered = JSON.parse(await readFile(crashPath, "utf8"));
  assert.ok(recovered.recoveredAt);
  const transcript = await readFile(transcriptPath, "utf8");
  assert.match(transcript, /conversation before failure/);
  assert.match(transcript, /crash app server/);
  assert.match(transcript, /continue after failure/);
  const trace = await readTrace(workspace);
  assert.ok(trace.some((message) => message.method === "thread/resume" && message.params.threadId === "thread-1"));
  assert.equal(trace.filter((message) => message.method === "thread/start").length, 1);
});

test("broker records a killed broker process and resumes its former thread", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker killed process "));
  t.after(() => invoke(workspace, "--broker", "stop"));

  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "conversation before broker loss");
  assert.equal(result.status, 0, result.stderr);

  const inFlight = invokeAsync(workspace, "--broker", "--timeout", "5", "--prompt", "slow broker loss");
  await new Promise((resolve) => setTimeout(resolve, 100));
  result = invoke(workspace, "--broker", "status");
  assert.equal(result.status, 0, result.stderr);
  process.kill(JSON.parse(result.stdout).pid, "SIGKILL");
  const killed = await inFlight.done;
  assert.equal(killed.status, 2, killed.stderr);
  assert.match(killed.stderr, /CRASH DETECTED: the Codex procedure for thread thread-1 terminated unexpectedly/);

  const crashPath = path.join(workspace, ".codex-cli", "procedure-crash.json");
  const crash = JSON.parse(await readFile(crashPath, "utf8"));
  assert.equal(crash.threadId, "thread-1");
  assert.equal(crash.prompt, "slow broker loss");
  assert.match(crash.brokerDiagnostic, /broker connection (closed|failed)/);

  await new Promise((resolve) => setTimeout(resolve, 100));
  result = invokeWithEnv(workspace, { FAKE_CODEX_RESUME_THREADS: "1" }, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--prompt", "continue after broker loss");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /recovering crashed procedure in thread thread-1/);
  const recovered = JSON.parse(await readFile(crashPath, "utf8"));
  assert.ok(recovered.recoveredAt);
});

test("broker survives app-server diagnostics emitted after readiness", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker post-ready stderr "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  const marker = "fixture post-ready app-server diagnostic";
  let result = invokeWithEnv(workspace, { FAKE_CODEX_POST_READY_STDERR: marker }, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "post-ready diagnostic survives");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: post-ready diagnostic survives/);
  assert.match(await readFile(path.join(workspace, "broker.pid.stderr.log"), "utf8"), new RegExp(marker));
  result = invoke(workspace, "--broker", "status");
  assert.equal(result.status, 0, result.stderr);
});

test("broker identifies an incompatible upstream model cache in retained diagnostics", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx cache diag "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  const diagnostic = "ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `base_instructions` at line 98 column 5";
  let result = invokeWithEnv(workspace, { FAKE_CODEX_POST_READY_STDERR: diagnostic }, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "crash app server");
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /broker diagnostics|missing field `base_instructions`|incompatible model cache/i);
  result = invokeWithEnv(workspace, { FAKE_CODEX_POST_READY_STDERR: diagnostic }, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--diagnostics", "--broker", "--new", "crash app server");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broker diagnostics:.*missing field `base_instructions`/s);
  assert.match(result.stderr, /Codex has an incompatible model cache\. Quit Codex, then rename ~\/\.codex\/models_cache\.json and restart the broker\./);
});

test("broker automatically recovers an implicit vanished saved thread", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker stale thread "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "create saved thread");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--prompt", "missing turn thread");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: missing turn thread/);
  assert.match(result.stderr, /started thread thread-2/);
  result = invoke(workspace, "--broker", "--thread", "thread-1", "--prompt", "missing turn thread");
  assert.equal(result.status, 66, result.stderr);
  assert.match(result.stderr, /no Codex thread matches selector/);
});

test("broker resumes an explicit not-loaded thread by id", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker not loaded thread "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);

  const notLoadedThreadId = "01900000-0000-7000-8000-000000000001";
  result = invoke(workspace, "--broker", "--thread", notLoadedThreadId, "--prompt", "attach by id");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: attach by id/);

  const trace = await readTrace(workspace);
  assert.ok(trace.some((message) => message.method === "thread/resume" && message.params.threadId === notLoadedThreadId));
  assert.ok(trace.some((message) => message.method === "turn/start" && message.params.threadId === notLoadedThreadId));

  const resumeErrorThreadId = "01900000-0000-7000-8000-000000000002";
  result = invoke(workspace, "--broker", "--thread", resumeErrorThreadId, "--prompt", "propagate resume failure");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /simulated resume backend failure/);
  assert.doesNotMatch(result.stderr, /no Codex thread matches selector/);
  const failedTrace = await readTrace(workspace);
  assert.equal(failedTrace.filter((message) => message.method === "thread/resume" && message.params.threadId === resumeErrorThreadId).length, 1, "a non-not-found resume error must be propagated without a second attempt");
});

test("broker resolves thread labels deterministically and reports stable selector errors", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker thread selectors "));
  const statePath = path.join(workspace, ".codex-cli", "codex-cli.json");
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);

  result = invoke(workspace, "--broker", "--new", "--thread-label", "Exact target", "seed exact thread");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--thread-label", "Other target", "Discuss Exact target notes");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--broker", "--thread", "Exact target", "selected exact native name");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 2: selected exact native name/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2", "an exact-name one-off must not switch saved state");

  result = invoke(workspace, "--broker", "--thread", "Exact target notes", "hidden preview must not select a named thread");
  assert.equal(result.status, 66, result.stderr);
  assert.match(result.stderr, /no (?:Codex )?thread matches/i);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--broker", "--thread", "thread", "ambiguous id prefix");
  assert.equal(result.status, 65, result.stderr);
  assert.match(result.stderr, /ambiguous/i);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--broker", "--thread", "selector that does not exist", "unmatched selector");
  assert.equal(result.status, 66, result.stderr);
  assert.match(result.stderr, /no (?:Codex )?thread matches/i);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--broker", "--thread", "   ", "blank selector");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /thread selector|--thread.*empty|no (?:Codex )?thread matches/i);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--broker", "--new", "Discuss Exact target notes");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--thread", "Exact target", "exact label beats visible fragment");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exact label beats visible fragment/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-3", "exact-label one-off selection must preserve current state");

  result = invoke(workspace, "--broker", "--thread", "target", "ambiguous displayed-label fragment");
  assert.equal(result.status, 65, result.stderr);
  assert.match(result.stderr, /ambiguous/i);

  result = invoke(workspace, "--broker", "--new", "Exact target");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--thread", "Exact target", "ambiguous displayed label");
  assert.equal(result.status, 65, result.stderr);
  assert.match(result.stderr, /ambiguous/i);

  result = invoke(workspace, "--broker", "--new", "--thread-label", "thread-404", "non-UUID-shaped label");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--thread", "thread-404", "select non-UUID-shaped label");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /select non-UUID-shaped label/);

  result = invoke(workspace, "--broker", "--new", "--thread-label", "Duplicate label", "first duplicate");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--thread-label", "Duplicate label", "second duplicate");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--thread", "Duplicate label", "ambiguous exact label");
  assert.equal(result.status, 65, result.stderr);
  assert.match(result.stderr, /ambiguous/i);
});

test("thread selectors from configuration and environment retain one-off and switch semantics", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker selector sources "));
  const statePath = path.join(workspace, ".codex-cli", "codex-cli.json");
  const oneOffConfig = path.join(workspace, "one-off.json");
  const switchConfig = path.join(workspace, "switch.json");
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);

  result = invoke(workspace, "--broker", "--new", "--thread-label", "Configuration target", "configuration target seed");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--thread-label", "Saved target", "saved target seed");
  assert.equal(result.status, 0, result.stderr);
  await writeFile(oneOffConfig, JSON.stringify({ thread: "Configuration target" }), "utf8");
  await writeFile(switchConfig, JSON.stringify({ threadSwitch: "Configuration target" }), "utf8");

  result = invoke(workspace, "--config", oneOffConfig, "--broker", "configuration one-off");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 2: configuration one-off/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invokeWithEnv(workspace, { CDXCLI_THREAD: "Configuration target" }, "--broker", "environment one-off");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 3: environment one-off/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--config", switchConfig, "--broker", "configuration switch");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 4: configuration switch/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-1");

  result = invokeWithEnv(workspace, { CDXCLI_THREAD_SWITCH: "Configuration target" }, "--broker", "--thread", "Saved target", "CLI one-off overrides environment switch");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 2: CLI one-off overrides environment switch/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-1");

  result = invokeWithEnv(workspace, { CDXCLI_THREAD_SWITCH: "Saved target" }, "--broker", "environment switch");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 3: environment switch/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");
});

test("thread label failures preserve completed switch semantics", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker deferred label "));
  const statePath = path.join(workspace, ".codex-cli", "codex-cli.json");
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--thread-label", "Stable label", "stable label seed");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--thread-label", "Saved label", "saved label seed");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2");

  result = invoke(workspace, "--broker", "--thread-switch", "Stable label", "--thread-label", "Rejected label", "failed turn");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /simulated turn failure/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-2", "a failed turn must not persist its requested switch");

  result = invoke(workspace, "--broker", "--thread-switch", "Stable label", "--thread-label", "Rejected label", "completed turn before label failure");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /simulated thread label failure/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).threadId, "thread-1", "a completed turn must persist its switch before a later label failure");

  result = invoke(workspace, "--broker", "--thread", "Stable label", "old label remains usable");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /old label remains usable/);
  result = invoke(workspace, "--broker", "--thread", "Rejected label", "new label was not applied");
  assert.equal(result.status, 66, result.stderr);
});

test("broker waits out a transient interrupted thread read", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli transient interruption "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "transient interrupted");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: transient interrupted/);
});

test("broker retries a transient empty session metadata read", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli transient metadata "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "transient session metadata");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: transient session metadata/);
});

test("explicit CLI options override their matching CDXCLI environment variables", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli approval environment "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invokeWithEnv(workspace, { CDXCLI_BROKER: "start" });
  assert.equal(result.status, 0, result.stderr);
  result = invokeWithEnv(workspace, {
    CdxCLI_BROKER: "true",
    CdxCLI_NEW: "true",
    CdxCLI_PROMPT: "approve environment override",
    CdxCLI_APPROVAL: "accept",
    CdxCLI_TIMEOUT: "5",
  }, "--broker", "--new", "--approval", "decline", "--prompt", "command-line prompt");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\[accept\]/);
  assert.match(result.stdout, /command-line prompt/);
  assert.doesNotMatch(result.stdout, /approve environment override/);
  result = invokeWithEnv(workspace, { CDXCLI_APPROVAL: "invalid" }, "--broker", "--prompt", "ignored");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CDXCLI_APPROVAL must be decline, accept, or accept-for-session/);
});

test("broker reports app-server interruption details", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli interruption details "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "--new", "--prompt", "interrupted reason");
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stderr, /Codex turn was interrupted: simulated interruption — simulated diagnostic detail/);
});

test("agentic mode rejects a legacy broker with restart guidance", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli legacy broker "));
  const socketPath = path.join(workspace, "broker.sock");
  let runRequests = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.type === "run") runRequests += 1;
      socket.end(`${JSON.stringify({ version: 1, type: "status", ready: true, pid: process.pid, instanceId: "legacy", active: false })}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await invokeAsync(workspace, "--broker", "--new", "--agentic-error-code", "--prompt", "agentic achieved").done;
  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /running broker does not support --agentic-error-code/);
  assert.match(result.stderr, /broker stop.*broker start/);
  assert.equal(runRequests, 0, "the client must reject the stale broker before submitting a turn");
});

test("image attachments reject a broker that lacks image capability", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli legacy image broker "));
  const socketPath = path.join(workspace, "broker.sock");
  const imagePath = path.join(workspace, "image.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let runRequests = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.type === "run") runRequests += 1;
      socket.end(`${JSON.stringify({ version: 1, type: "status", ready: true, pid: process.pid, instanceId: "legacy", active: false, capabilities: ["agentic-result-v1"] })}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await invokeAsync(workspace, "--broker", "--new", "--image", imagePath, "--prompt", "inspect image").done;
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /running broker does not support --image/);
  assert.match(result.stderr, /broker stop.*broker start/);
  assert.equal(runRequests, 0, "the client must reject the stale broker before submitting an image turn");
});

test("thread selectors and labels reject brokers that lack their advertised capabilities", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli legacy thread broker "));
  const socketPath = path.join(workspace, "broker.sock");
  let capabilities = ["agentic-result-v1", "image-attachments-v1", "prompt-attachment-actions-v1"];
  let runRequests = 0;
  let threadListRequests = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.type === "run") runRequests += 1;
      if (message.type === "threads") threadListRequests += 1;
      socket.end(`${JSON.stringify({ version: 1, type: "status", ready: true, pid: process.pid, instanceId: "legacy", active: false, capabilities })}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let result = await invokeAsync(workspace, "--broker", "--completion-threads").done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(threadListRequests, 0, "completion must not send its extended list request to an older broker");

  await mkdir(path.join(workspace, ".codex-cli"), { recursive: true });
  await writeFile(path.join(workspace, ".codex-cli", "codex-cli.json"), '{"threadId":"saved-thread"}\n', "utf8");
  result = await invokeAsync(workspace, "--broker", "--new", "--prompt", "reference <thread_id>").done;
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /does not support client-state <thread_id> expansion/);
  assert.match(result.stderr, /broker stop.*broker start/);
  assert.equal(runRequests, 0, "the client must not send a state-dependent prompt action to an older broker");

  result = await invokeAsync(workspace, "--broker", "--thread", "Some label", "--prompt", "selector capability").done;
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /running broker does not support thread selectors/);
  assert.match(result.stderr, /broker stop.*broker start/);
  assert.equal(runRequests, 0, "the client must reject an unsupported selector before submitting a turn");

  capabilities = [...capabilities, "thread-selectors-v1"];
  result = await invokeAsync(workspace, "--broker", "--new", "--thread-label", "New label", "--prompt", "label capability").done;
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /running broker does not support --thread-label/);
  assert.match(result.stderr, /broker stop.*broker start/);
  assert.equal(runRequests, 0, "the client must reject an unsupported label before submitting a turn");

  capabilities = [...capabilities, "thread-label-v1"];
  result = await invokeAsync(workspace, "--broker", "--thread-switch", "Some label", "--thread-label", "New label", "--prompt", "atomic switch capability").done;
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot preserve a completed --thread-switch across a label failure/);
  assert.match(result.stderr, /broker stop.*broker start/);
  assert.equal(runRequests, 0, "the client must reject a combined switch and label when atomic commit is unsupported");
});

test("broker carries agentic outcomes without masking broker or app-server failures", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli broker agentic result "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);

  result = invoke(workspace, "--broker", "--new", "--agentic-error-code", "--prompt", "agentic achieved");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "goal complete\n");
  assert.match(result.stderr, /codex-cli: goal complete/);
  assert.doesNotMatch(result.stderr, /\{"goal_achieved"/);
  const agenticTurn = (await readTrace(workspace)).find((message) => message.method === "turn/start" && message.params.input?.[0]?.text.includes("agentic achieved"));
  assert.equal(agenticTurn.params.outputSchema.properties.agentic_exit_code.enum.includes(13), false);
  assert.deepEqual(agenticTurn.params.outputSchema.required, ["goal_achieved", "agentic_exit_code", "summary", "reason"]);

  result = invoke(workspace, "--broker", "--new", "--agentic-error-code", "--json", "--prompt", "agentic not achieved");
  assert.equal(result.status, 1, result.stderr);
  const agenticEvents = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(agenticEvents.length > 1, "agentic JSON mode should preserve interim protocol events");
  assert.deepEqual(agenticEvents.at(-1), {
    goal_achieved: false,
    agentic_exit_code: 1,
    summary: "goal incomplete",
    reason: "required work remains",
  });

  result = invoke(workspace, "--broker", "--new", "--agentic-error-code", "--prompt", "agentic malformed");
  assert.equal(result.status, 72, result.stderr);
  assert.equal(result.stdout, "");

  result = invoke(workspace, "--broker", "--new", "--agentic-error-code", "--prompt", "interrupted reason");
  assert.equal(result.status, 130, result.stderr);

  result = invoke(workspace, "--broker", "--new", "--agentic-error-code", "--prompt", "unauthenticated");
  assert.equal(result.status, 70, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex thread entered systemError/);

  const slow = invokeAsync(workspace, "--broker", "--new", "--timeout", "5", "--prompt", "slow turn");
  await new Promise((resolve) => setTimeout(resolve, 100));
  result = invoke(workspace, "--broker", "--new", "--agentic-error-code", "--prompt", "agentic achieved");
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /broker is busy/);
  assert.equal((await slow.done).status, 0);
});

test("broker forwards Codex errors and fails on thread systemError", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli broker system error "));
  t.after(() => invoke(workspace, "--broker", "stop"));
  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);

  result = invoke(workspace, "--broker", "--new", "--prompt", "retrying error");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: retrying error/);
  assert.match(result.stderr, /Codex correctable error \(will retry\): temporary upstream failure — retrying request — responseStreamConnectionFailed \(HTTP 503\)/);

  result = invoke(workspace, "--broker", "--new", "--prompt", "misclassified 401");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error \(retry suppressed\): unexpected status 401 Unauthorized/);
  assert.match(result.stderr, /Codex reported a terminal error/);
  assert.ok((await readTrace(workspace)).some((entry) => entry.method === "turn/interrupt"), "broker should interrupt a definitively failed turn");

  result = invoke(workspace, "--broker", "--new", "--prompt", "unauthenticated");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error: unexpected status 401 Unauthorized from \/v1\/responses — authentication required — unauthorized/);
  assert.match(result.stderr, /Codex thread entered systemError/);

  result = invoke(workspace, "--broker", "--new", "--prompt", "terminal notification");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex reported a terminal error: terminal notification failure — internalServerError/);

  result = invoke(workspace, "--broker", "--new", "--prompt", "empty terminal error");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error: Codex reported an error without details/);
  assert.match(result.stderr, /Codex reported a terminal error: Codex reported an error without details/);
});

test("direct JSON output remains parseable when completed turns include assistant text", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli direct json "));
  const result = invoke(workspace, "--direct", "--json", "--new", "--prompt", "mixed messages");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), line);
  assert.ok(lines.some((line) => JSON.parse(line).method === "turn/completed"));
});

test("broker start never deletes a non-socket path", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx broker file "));
  await writeFile(path.join(workspace, "broker.sock"), "keep-me", "utf8");
  const result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /refusing to remove non-socket/);
  assert.equal(await readFile(path.join(workspace, "broker.sock"), "utf8"), "keep-me");
});

test("broker rejects malformed and incompatible protocol messages", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli broker protocol "));
  const socketPath = path.join(workspace, "broker.sock");
  t.after(() => invoke(workspace, "--broker", "stop"));

  let result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  result = invoke(workspace, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /already running/);
  result = invoke(workspace, "--broker", "start", "--experimental-api");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /already running without --experimental-api/);

  let response = await brokerExchange(socketPath, "not-json\n");
  assert.equal(response.code, "INVALID_JSON");

  response = await brokerExchange(socketPath, "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(response.code, "MESSAGE_TOO_LARGE");

  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 99, type: "status" })}\n`);
  assert.equal(response.code, "VERSION");

  response = await brokerExchange(socketPath, `${JSON.stringify({
    version: 1,
    type: "run",
    new: true,
    cwd: path.join(workspace, "wrong"),
    prompt: "prompt",
    approval: "decline",
    timeout: 5,
  })}\n`);
  assert.equal(response.code, "INVALID_REQUEST");
  assert.match(response.message, /cwd does not match/);

  const validRun = { version: 1, type: "run", new: true, cwd: workspace, prompt: "prompt", approval: "decline", timeout: 5 };
  for (const [field, value, message] of [
    ["new", "true", /broker new must be a boolean/],
    ["interactive", "yes", /broker interactive must be a boolean/],
    ["json", "yes", /broker json must be a boolean/],
    ["interruptPending", "yes", /broker interruptPending must be a boolean/],
    ["model", {}, /broker model must be a string or null/],
  ]) {
    response = await brokerExchange(socketPath, `${JSON.stringify({ ...validRun, [field]: value })}\n`);
    assert.equal(response.code, "INVALID_REQUEST");
    assert.match(response.message, message);
  }

  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 1, type: "stop", instanceId: "other-broker" })}\n`);
  assert.equal(response.code, "INSTANCE");
  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 1, type: "approval-response", requestId: "forged", decision: "accept" })}\n`);
  assert.equal(response.code, "APPROVAL_ID");
  response = await brokerExchange(socketPath, `${JSON.stringify({ version: 1, type: "user-input-response", requestId: "forged", answers: {} })}\n`);
  assert.equal(response.code, "USER_INPUT_ID");

  result = invoke(workspace, "--broker", "--new", "--prompt", "failed turn");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /simulated turn failure/);
});

test("current broker expands prompt actions sent by a legacy client request", async (t) => {
  await Promise.all([chmod(fakeCodex, 0o755), chmod(fakeClipboard, 0o755)]);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli legacy prompt action "));
  const socketPath = path.join(workspace, "broker.sock");
  t.after(() => invoke(workspace, "--broker", "stop"));
  const environment = {
    NODE_ENV: "test",
    CDXCLI_TEST_CLIPBOARD_HELPER: fakeClipboard,
    FAKE_CLIPBOARD_TEXT: "legacy clipboard text",
    FAKE_CLIPBOARD_TRACE: path.join(workspace, "clipboard-trace.log"),
  };
  let result = invokeWithEnv(workspace, environment, "--broker", "start");
  assert.equal(result.status, 0, result.stderr);

  const response = await brokerExchange(socketPath, `${JSON.stringify({
    version: 1,
    type: "run",
    new: true,
    cwd: workspace,
    prompt: "before <clipboard> after",
    approval: "decline",
    timeout: 5,
  })}\n`);
  assert.equal(response.type, "thread");
  const trace = await readTrace(workspace);
  const turn = trace.find((message) => message.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text: "before ", text_elements: [] },
    { type: "text", text: "legacy clipboard text", text_elements: [] },
    { type: "text", text: " after", text_elements: [] },
  ]);
  assert.equal(await readFile(path.join(workspace, "clipboard-trace.log"), "utf8"), "--mime\n--text\n");
});
