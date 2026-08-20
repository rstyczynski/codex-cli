import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");

function invoke(workspace, args, options = {}) {
  const home = options.home ?? path.join(workspace, "home");
  return spawnSync(process.execPath, [cli, "--cwd", workspace, "--codex", fakeCodex, ...args], {
    cwd: options.invocationCwd ?? workspace,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      FAKE_CODEX_TRACE: path.join(workspace, "fake-codex-trace.jsonl"),
      ...options.env,
    },
  });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function initializeGit(directory) {
  const result = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function readTrace(workspace) {
  const contents = await readFile(path.join(workspace, "fake-codex-trace.jsonl"), "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("show-config defaults to configured values and all includes built-in defaults", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx config defaults "));
  let result = invoke(workspace, ["--show-config"], { home: path.join(workspace, "home") });
  assert.equal(result.status, 0, result.stderr);
  let shown = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(shown.values).sort(), ["codex", "cwd"]);
  assert.deepEqual(Object.keys(shown.sources).sort(), ["codex", "cwd"]);
  assert.equal(shown.sources.cwd.source, "--cwd");
  assert.equal(shown.sources.codex.source, "--codex");

  result = invoke(workspace, ["--show-config", "set", "--timeout", "120"], { home: path.join(workspace, "home") });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.timeout, 120);
  assert.equal(shown.sources.timeout.source, "--timeout");

  result = invoke(workspace, ["--show-config", "all"], { home: path.join(workspace, "home") });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.timeout, 120);
  assert.equal(shown.sources.timeout.layer, "default");

  result = invoke(workspace, ["--show-config", "--thread", "CLI target"], {
    home: path.join(workspace, "home"),
    env: { CDXCLI_THREAD_SWITCH: "environment target" },
  });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.thread, "CLI target");
  assert.equal(shown.sources.thread.source, "--thread");
  assert.equal(Object.hasOwn(shown.values, "threadSwitch"), false, "an overridden switch must not remain in resolved configuration");

  result = invoke(workspace, ["--show-config", "invalid"], { home: path.join(workspace, "home") });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--show-config must be set or all/);
});

test("thread target sources reject same-layer conflicts and honor new-selector precedence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx config thread target precedence "));
  const home = path.join(workspace, "home");
  const threadConfig = path.join(workspace, "thread.json");
  const newConfig = path.join(workspace, "new.json");
  const selectorConflict = path.join(workspace, "selector-conflict.json");
  const newConflict = path.join(workspace, "new-conflict.json");
  await writeJson(threadConfig, { thread: "configured target" });
  await writeJson(newConfig, { new: true });
  await writeJson(selectorConflict, { threadSwitch: "switch target", thread: "one-off target" });
  await writeJson(newConflict, { thread: "configured target", new: true });

  let result = invoke(workspace, ["--config", threadConfig, "--show-config", "--new"], { home });
  assert.equal(result.status, 0, result.stderr);
  let shown = JSON.parse(result.stdout);
  assert.equal(shown.values.new, true);
  assert.equal(Object.hasOwn(shown.values, "thread"), false, "higher-precedence --new must clear a configured selector");

  result = invoke(workspace, ["--config", newConfig, "--show-config", "--thread", "CLI target"], { home });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.thread, "CLI target");
  assert.equal(Object.hasOwn(shown.values, "new"), false, "a higher-precedence CLI selector must clear configured new=true");

  result = invoke(workspace, ["--config", threadConfig, "--show-config"], { home, env: { CDXCLI_NEW: "true" } });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.new, true);
  assert.equal(Object.hasOwn(shown.values, "thread"), false, "environment new=true must override a configured selector");

  result = invoke(workspace, ["--config", newConfig, "--show-config"], { home, env: { CDXCLI_THREAD: "environment target" } });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.thread, "environment target");
  assert.equal(Object.hasOwn(shown.values, "new"), false, "an environment selector must override configured new=true");

  for (const conflict of [
    { args: ["--config", selectorConflict, "--show-config"], env: {}, error: /thread and threadSwitch cannot be combined/ },
    { args: ["--config", newConflict, "--show-config"], env: {}, error: /new cannot be combined with thread/ },
    { args: ["--show-config"], env: { CDXCLI_THREAD: "one", CDXCLI_THREAD_SWITCH: "two" }, error: /CDXCLI_THREAD and CDXCLI_THREAD_SWITCH cannot be combined/ },
    { args: ["--show-config"], env: { CDXCLI_THREAD: "one", CDXCLI_NEW: "true" }, error: /CDXCLI_NEW cannot be combined with CDXCLI_THREAD/ },
  ]) {
    result = invoke(workspace, conflict.args, { home, env: conflict.env });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, conflict.error);
  }
});

test("config-enabled agentic mode maps empty thread selector validation to exit 70", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx config agentic selector "));
  const home = path.join(workspace, "home");

  for (const [field, option] of [["thread", "--thread"], ["threadSwitch", "--thread-switch"]]) {
    const config = path.join(workspace, `${field}.json`);
    await writeJson(config, { agenticErrorCode: true, [field]: "" });

    const result = invoke(workspace, ["--config", config], { home });
    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, new RegExp(`${option} selector must not be empty`));
  }
});

test("layered client configuration resolves files, environment, and CLI precedence", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "cdx config precedence "));
  const directory = path.join(project, "nested");
  const home = path.join(project, "home");
  await mkdir(directory, { recursive: true });
  initializeGit(project);
  await writeJson(path.join(home, ".codex-cli", "config.json"), { timeout: 10, threadParams: { home: true } });
  await writeJson(path.join(project, ".codex-cli", "config.json"), { timeout: 20, threadParams: { repository: true } });
  await writeJson(path.join(directory, ".codex-cli", "config.json"), { timeout: 30, threadParams: { directory: true } });
  await writeJson(path.join(directory, "environment.json"), { timeout: 40, threadParams: { environmentFile: true } });
  await writeJson(path.join(directory, "one.json"), { timeout: 50, threadParams: { explicitOne: true } });
  await writeJson(path.join(directory, "two.json"), { timeout: 60, threadParams: { explicitTwo: true } });

  const result = invoke(directory, [
    "--show-config", "--config", "one.json", "--config", "two.json", "--timeout", "80", "--thread-params", '{"cli":true}',
  ], {
    home,
    env: { CDX_CONFIG: "environment.json", CDXCLI_TIMEOUT: "70", CDXCLI_THREAD_PARAMS: '{"environmentVariable":true}' },
  });
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.values.timeout, 80);
  assert.equal(shown.sources.timeout.source, "--timeout");
  assert.deepEqual(shown.values.threadParams, {
    home: true,
    repository: true,
    directory: true,
    environmentFile: true,
    explicitOne: true,
    explicitTwo: true,
    environmentVariable: true,
    cli: true,
  });
  assert.equal(await realpath(shown.sources.threadParams.repository.source), await realpath(path.join(project, ".codex-cli", "config.json")));
  assert.equal(shown.sources.threadParams.repository.layer, "auto-git");
  assert.equal(shown.sources.threadParams.environmentVariable.source, "CDXCLI_THREAD_PARAMS");
  assert.equal(shown.sources.threadParams.cli.source, "--thread-params");
  await assert.rejects(stat(path.join(directory, "fake-codex-trace.jsonl")), { code: "ENOENT" });
});

test("automatic discovery deduplicates a Git-root configuration and skips the Git layer outside a worktree", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "cdx config discovery project "));
  const home = path.join(project, "home");
  initializeGit(project);
  await writeJson(path.join(project, ".codex-cli", "config.json"), { timeout: 44 });

  let result = invoke(project, ["--show-config"], { home });
  assert.equal(result.status, 0, result.stderr);
  let shown = JSON.parse(result.stdout);
  assert.equal(shown.values.timeout, 44);
  assert.equal(shown.sources.timeout.layer, "auto-git");

  const outside = await mkdtemp(path.join(os.tmpdir(), "cdx config discovery outside "));
  await writeJson(path.join(outside, ".codex-cli", "config.json"), { timeout: 55 });
  result = invoke(outside, ["--show-config"], { home: path.join(outside, "home") });
  assert.equal(result.status, 0, result.stderr);
  shown = JSON.parse(result.stdout);
  assert.equal(shown.values.timeout, 55);
  assert.equal(shown.sources.timeout.layer, "auto-directory");
});

test("configuration paths are relative to their file and configJson remains thread-only", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx config paths "));
  const profile = path.join(workspace, "profiles", "client.json");
  await writeJson(path.join(workspace, "profiles", "codex-overrides.json"), { model_verbosity: "low" });
  await writeJson(profile, {
    direct: true,
    new: true,
    state: "state.json",
    approvalLog: "approvals.toml",
    configJson: "codex-overrides.json",
    threadParams: { baseInstructions: "Use concise answers." },
    turnParams: { effort: "low" },
  });

  let result = invoke(workspace, ["--config", "profiles/client.json", "relative config"]);
  assert.equal(result.status, 0, result.stderr);
  const trace = await readTrace(workspace);
  const threadStart = trace.find((message) => message.method === "thread/start");
  assert.deepEqual(threadStart.params.config, { model_verbosity: "low" });
  assert.equal(threadStart.params.baseInstructions, "Use concise answers.");
  const turnStart = trace.find((message) => message.method === "turn/start");
  assert.equal(turnStart.params.effort, "low");

  result = invoke(workspace, ["--config", "profiles/client.json", "--show-config"]);
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  const resolvedProfile = await realpath(path.join(workspace, "profiles"));
  assert.equal(await realpath(path.dirname(shown.values.state)), resolvedProfile);
  assert.equal(path.basename(shown.values.state), "state.json");
  assert.equal(await realpath(path.dirname(shown.values.approvalLog)), resolvedProfile);
  assert.equal(path.basename(shown.values.approvalLog), "approvals.toml");
  assert.equal(await realpath(shown.values.configJson), await realpath(path.join(workspace, "profiles", "codex-overrides.json")));
});

test("configuration errors stop before Codex starts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx config errors "));
  const cases = [
    { name: "invalid.json", value: "{", error: /must contain valid JSON/ },
    { name: "unknown.json", value: '{"unknown":true}', error: /unknown configuration key: unknown/ },
    { name: "wrong-type.json", value: '{"timeout":"slow"}', error: /timeout must be a positive number/ },
  ];
  for (const entry of cases) {
    const filePath = path.join(workspace, entry.name);
    await writeFile(filePath, entry.value, "utf8");
    const result = invoke(workspace, ["--direct", "--new", "--config", entry.name, "prompt"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, entry.error);
  }
  const missing = invoke(workspace, ["--direct", "--new", "--config", "missing.json", "prompt"]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /cannot read/);
  await assert.rejects(stat(path.join(workspace, "fake-codex-trace.jsonl")), { code: "ENOENT" });
});

test("auto-discovered risky configuration warns only while it wins on a new thread", async () => {
  await chmod(fakeCodex, 0o755);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cdx config warnings "));
  initializeGit(workspace);
  await writeJson(path.join(workspace, ".codex-cli", "config.json"), {
    direct: true,
    new: true,
    approval: "accept-for-session",
    threadParams: { sandbox: "workspace-write", opaqueFutureField: true },
  });

  let result = invoke(workspace, ["--json", "approve direct"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: new thread uses approval=accept-for-session/);
  assert.match(result.stderr, /warning: new thread uses threadParams\.sandbox=workspace-write/);
  assert.match(result.stderr, /warning: new thread uses unclassified threadParams\.opaqueFutureField/);
  assert.ok(result.stdout.trim().split("\n").map((line) => JSON.parse(line)).length > 0);

  await writeJson(path.join(workspace, ".codex-cli", "config.json"), {
    direct: true,
    new: true,
    approval: "accept",
    threadParams: { sandbox: "workspace-write" },
  });
  result = invoke(workspace, ["--approval", "decline", "--thread-params", '{"sandbox":"read-only"}', "suppressed warning"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /warning: new thread uses/);
});
