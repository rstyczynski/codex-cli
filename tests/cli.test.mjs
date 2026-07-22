import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");
const win32Platform = path.join(root, "tests/fixtures/platform-win32.cjs");

function invoke(workspace, args, options = {}) {
  const nodeArgs = options.platform === "win32" ? ["--require", win32Platform, cli] : [cli];
  return spawnSync(process.execPath, [...nodeArgs, "--cwd", workspace, "--codex", fakeCodex, ...args], {
    encoding: "utf8",
    timeout: 10000,
    input: options.input,
    env: { ...process.env, ...options.env },
  });
}

test("CLI rejects invalid options and incompatible modes", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli validation "));
  const cases = [
    { args: ["--unknown"], error: /unknown option/ },
    { args: ["--timeout"], error: /requires a value/ },
    { args: ["--timeout", "0"], error: /positive number/ },
    { args: ["--approval", "always"], error: /must be decline, accept, or accept-for-session/ },
    { args: ["--verbosity", "everything"], error: /must be low, medium, or high/ },
    { args: ["--broker", "--direct", "--new", "prompt"], error: /--broker cannot be combined/ },
    { args: ["--direct", "prompt"], error: /use --new for each direct invocation/ },
    { args: ["--direct", "--new", "--socket", "server.sock", "prompt"], error: /cannot be used together/ },
    { args: ["--thread", "thread-1", "--new", "prompt"], error: /cannot be used together/ },
    { args: ["--repl", "--new", "prompt"], error: /requires --direct/ },
    { args: ["--direct", "--repl", "--new", "prompt"], error: /requires a terminal/ },
    { args: ["--direct", "--new", "--model", "one", "--clear-model", "prompt"], error: /cannot be used together/ },
    { args: ["--direct", "--new", "--clear-model", "--thread-params", '{"model":"one"}', "prompt"], error: /cannot be combined/ },
    { args: ["--direct", "--new", "--thread-params", '{"cwd":"elsewhere"}', "prompt"], error: /CLI-managed cwd/ },
    { args: ["--direct", "--new", "--turn-params", '{"threadId":"other"}', "prompt"], error: /CLI-managed threadId/ },
    { args: ["--direct", "--new", "--turn-params", '{"sandbox":"workspace-read"}', "prompt"], error: /sandbox must be read-only, workspace-write, or danger-full-access/ },
    { args: ["--direct", "--new", "--turn-params", "[]", "prompt"], error: /must contain a JSON object/ },
    { args: ["--direct", "--new", "--thread-params", "{", "prompt"], error: /must be valid JSON/ },
    { args: ["--direct", "--new", "--thread-params", "@", "prompt"], error: /requires a file path/ },
    { args: ["--direct", "--new", "--thread-params", "@missing.json", "prompt"], error: /cannot read --thread-params file/ },
    { args: ["--direct", "--new"], error: /a prompt is required/ },
  ];

  for (const entry of cases) {
    const result = invoke(workspace, entry.args);
    assert.equal(result.status, 2, `${entry.args.join(" ")}\n${result.stderr}`);
    assert.match(result.stderr, entry.error, entry.args.join(" "));
  }

  let result = invoke(workspace, ["--direct", "--new", "prompt"], { env: { CDXCLI_NEW: "maybe" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CDXCLI_NEW must be true or false/);

  const invalidWorkspace = path.join(workspace, "missing");
  result = invoke(invalidWorkspace, ["--direct", "--new", "prompt"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /workspace directory does not exist/);

  const workspaceFile = path.join(workspace, "not-a-directory");
  await writeFile(workspaceFile, "file", "utf8");
  result = invoke(workspaceFile, ["--direct", "--new", "prompt"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a directory/);
});

test("CLI version exits successfully without requiring a workspace or Codex", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "codex-cli 1.0.10\n");
  assert.equal(result.stderr, "");
});

test("CLI reports invalid state and configuration files", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli files "));
  const state = path.join(workspace, "state.json");
  await writeFile(state, "not-json", "utf8");

  let result = invoke(workspace, ["--state", state, "prompt"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read thread state/);

  const config = path.join(workspace, "config.json");
  await writeFile(config, '{"model":"fake"}', "utf8");
  result = invoke(workspace, ["--direct", "--new", "--config-json", config, "--thread-params", '{"config":"invalid"}', "prompt"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /config must be a JSON object/);
});

test("broker control commands report a broker that is not running", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli absent broker "));

  let result = invoke(workspace, ["--broker", "status"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /broker is not running/);

  result = invoke(workspace, ["--broker", "stop"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /broker is not running/);

  result = invoke(workspace, ["--broker", "threads"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broker is not running/);
});

test("managed socket mode explains how to start a missing daemon", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli missing daemon "));
  const codexHome = await mkdtemp("/tmp/cdxhome-");

  const result = invoke(workspace, ["--new", "prompt"], { env: { CODEX_HOME: codexHome } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Start the managed server with: codex app-server daemon start/);
});

test("Windows directs users away from the unavailable managed Unix socket", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli Windows transport "));

  let result = invoke(workspace, ["--new", "prompt"], { platform: "win32" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /managed app-server socket mode is unavailable on Windows/);
  assert.match(result.stderr, /--broker, --direct, or --socket/);

  result = invoke(workspace, ["--direct", "--new", "Windows direct prompt"], { platform: "win32" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: Windows direct prompt/);
});

test("Windows broker configuration requires a named pipe", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli Windows broker "));
  let result = invoke(workspace, ["--broker", "status", "--broker-socket", "broker.sock"], { platform: "win32" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--broker-socket must be a Windows named pipe/);

  result = invoke(workspace, ["--broker", "status"], { platform: "win32" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\\\\\.\\pipe\\codex-cli-[0-9a-f]{16}/);
});

test("direct mode accepts positional and standard-input prompts", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli input "));

  let result = invoke(workspace, ["--direct", "--new", "positional prompt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: positional prompt/);

  result = invoke(workspace, ["--direct", "--new", "--stdin"], { input: "standard input prompt\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: standard input prompt/);

  result = invoke(workspace, ["--direct", "--new", "transient session metadata"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: transient session metadata/);

  result = invoke(workspace, ["--direct", "--new", "transient interrupted"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: transient interrupted/);
});

test("agentic error-code mode maps validated outcomes and preserves system failures", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli agentic result "));

  let result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "agentic achieved"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "goal complete\n");
  assert.match(result.stderr, /codex-cli: goal complete/);
  assert.doesNotMatch(result.stderr, /\{"goal_achieved"/);

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "--json", "agentic achieved"]);
  assert.equal(result.status, 0, result.stderr);
  const agenticEvents = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(agenticEvents.length > 1, "agentic JSON mode should preserve interim protocol events");
  assert.deepEqual(agenticEvents.at(-1), {
    goal_achieved: true,
    agentic_exit_code: 0,
    summary: "goal complete",
    reason: "requested work and checks completed",
  });
  assert.equal(result.stdout.trim().split("\n").length, agenticEvents.length);

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "agentic not achieved"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "goal incomplete\n");

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "agentic custom success one"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "observed failing condition\n");

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "agentic custom two"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "caller outcome two\n");

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "agentic custom success two"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "caller success outcome two\n");

  for (const prompt of ["agentic malformed", "agentic missing final", "agentic reserved thirteen"]) {
    result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", prompt]);
    assert.equal(result.status, 72, `${prompt}\n${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid agentic result contract/);
  }

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "--timeout", "0.1", "slow direct"]);
  assert.equal(result.status, 124, result.stderr);

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "interrupted reason"]);
  assert.equal(result.status, 130, result.stderr);

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "unauthenticated"]);
  assert.equal(result.status, 70, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex thread entered systemError/);

  result = invoke(workspace, ["--agentic-error-code", "--direct", "prompt"]);
  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /use --new/);

  result = invoke(workspace, ["--direct", "--repl", "--new", "--agentic-error-code", "prompt"]);
  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /cannot be combined with --repl/);

  result = invoke(workspace, ["--direct", "--new", "--agentic-error-code", "--turn-params", '{"outputSchema":{}}', "agentic achieved"]);
  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /CLI-managed outputSchema/);
});

test("interim activity is visible by default and verbosity controls its detail", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli verbosity "));

  let result = invoke(workspace, ["--direct", "--new", "rich items low"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: rich items low/);
  assert.doesNotMatch(result.stderr, /Reasoning:|Plan:|Command |File change|MCP tool|Web search/);
  assert.doesNotMatch(result.stderr, /Detailed reasoning trace|all tests passed|"query": "protocol"/);

  result = invoke(workspace, ["--direct", "--new", "--verbosity", "medium", "rich items medium"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: rich items medium/);
  assert.match(result.stderr, /Reasoning:\n  Inspecting the workspace/);
  assert.match(result.stderr, /Plan:\n  1\. Inspect/);
  assert.doesNotMatch(result.stderr, /Command |File change|MCP tool|Web search/);
  assert.doesNotMatch(result.stderr, /Detailed reasoning trace|all tests passed|"query": "protocol"/);

  result = invoke(workspace, ["--direct", "--new", "--verbosity", "high", "rich items high"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: rich items high/);
  assert.match(result.stderr, /Detailed reasoning trace/);
  assert.match(result.stderr, /all tests passed/);
  assert.match(result.stderr, /"query": "protocol"/);
  assert.match(result.stderr, /diff for README\.md/);
});

test("direct mode covers approvals, JSON requests, failures, and timeouts", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli direct paths "));
  const approvalLog = path.join(workspace, "approvals.toml");

  let result = invoke(workspace, ["--direct", "--new", "--approval", "accept-for-session", "--approval-log", approvalLog, "approve direct"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acceptForSession/);
  assert.match(await readFile(approvalLog, "utf8"), /decision = "acceptForSession"/);

  result = invoke(workspace, ["--direct", "--new", "--approval", "accept", "--approval-log", approvalLog, "file approval direct"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file approval direct \[accept\]/);
  assert.match(await readFile(approvalLog, "utf8"), /method = "item\/fileChange\/requestApproval"/);

  result = invoke(workspace, ["--direct", "--new", "--approval", "accept", "--approval-log", workspace, "approve log failure"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /could not write approval log/);

  result = invoke(workspace, ["--direct", "--new", "unknown request"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /unsupported app-server request/);

  result = invoke(workspace, ["--direct", "--new", "--json", "unknown request"]);
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.method === "item/unknown/requestPermission"));

  result = invoke(workspace, ["--direct", "--new", "interrupted reason"]);
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stderr, /simulated interruption/);

  result = invoke(workspace, ["--direct", "--new", "failed turn"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /simulated turn failure/);

  result = invoke(workspace, ["--direct", "--new", "retrying error"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reply 1: retrying error/);
  assert.match(result.stderr, /Codex correctable error \(will retry\): temporary upstream failure — retrying request — responseStreamConnectionFailed \(HTTP 503\)/);

  result = invoke(workspace, ["--direct", "--new", "misclassified 401"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error \(retry suppressed\): unexpected status 401 Unauthorized/);
  assert.match(result.stderr, /Codex reported a terminal error/);

  result = invoke(workspace, ["--direct", "--new", "unauthenticated"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error: unexpected status 401 Unauthorized from \/v1\/responses — authentication required — unauthorized/);
  assert.match(result.stderr, /Codex thread entered systemError/);

  result = invoke(workspace, ["--direct", "--new", "terminal notification"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex reported a terminal error: terminal notification failure — internalServerError/);

  result = invoke(workspace, ["--direct", "--new", "flat terminal error"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Codex definitive error: flat Codex failure — diagnostic was not nested/);
  assert.match(result.stderr, /Codex reported a terminal error: flat Codex failure — diagnostic was not nested/);

  result = invoke(workspace, ["--direct", "--json", "--new", "unauthenticated"]);
  assert.equal(result.status, 2, result.stderr);
  const errorEvents = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(errorEvents.some((event) => event.method === "error" && event.params.error.codexErrorInfo === "unauthorized"));
  assert.match(result.stderr, /Codex definitive error: unexpected status 401 Unauthorized/);
  assert.match(result.stderr, /Codex thread entered systemError/);

  result = invoke(workspace, ["--direct", "--new", "--timeout", "0.1", "slow direct"]);
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /timed out after 0.1 seconds/);

  result = invoke(workspace, ["--direct", "--new", "crash direct"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /direct app-server (?:exited|is not running)/);
});
