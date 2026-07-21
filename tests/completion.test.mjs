import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/codex-cli");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function invoke(args = [], { cliPath = cli, cwd = root, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}

function sourceCommand({ cliPath = cli, codexPath = fakeCodex } = {}) {
  return `${shellQuote(process.execPath)} ${shellQuote(cliPath)} --bash_completion --codex ${shellQuote(codexPath)}`;
}

function runBash(script, { cwd = root, env = {} } = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}

function completion(words, {
  cword = words.length - 1,
  handler = "_codex_cli_complete",
  cliPath = cli,
  codexPath = fakeCodex,
  cwd = root,
  env = {},
  beforeSource = "",
} = {}) {
  const result = runBash([
    beforeSource,
    `source <(${sourceCommand({ cliPath, codexPath })})`,
    `COMP_WORDS=(${words.map(shellQuote).join(" ")})`,
    `COMP_CWORD=${cword}`,
    "COMPREPLY=()",
    handler,
    "if ((${#COMPREPLY[@]})); then printf '%s\\0' \"${COMPREPLY[@]}\"; fi",
  ].join("\n"), { cwd, env });
  return {
    ...result,
    replies: result.stdout.split("\0").filter(Boolean),
  };
}

async function temporaryDirectory(t, prefix = "codex completion ") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("generated Bash completion is valid and embeds safely quoted executable paths", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "codex completion's quoted paths ");
  const copiedCli = path.join(workspace, "codex cli's copy.mjs");
  const copiedCodex = path.join(workspace, "fake codex's copy.mjs");
  await copyFile(cli, copiedCli);
  await copyFile(fakeCodex, copiedCodex);
  await chmod(copiedCli, 0o755);
  await chmod(copiedCodex, 0o755);

  const generated = invoke(["--bash-completion", "--codex", copiedCodex], { cliPath: copiedCli });
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /^# Bash completion for codex-cli/m);
  assert.match(generated.stdout, /_codex_cli_complete/);
  assert.match(generated.stdout, /complete .*codex-cli cdx hiai/);
  assert.doesNotMatch(generated.stdout, /codex-cli codex-cli/, "completion target should only be registered once");

  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
    input: generated.stdout,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const emptyCodexHome = await temporaryDirectory(t, "codex completion empty home ");
  const completed = completion(["codex-cli", "--model", "fake-"], {
    cliPath: copiedCli,
    codexPath: copiedCodex,
    cwd: workspace,
    env: { CODEX_HOME: emptyCodexHome },
  });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["fake-default", "fake-fast"]);
});

test("sourcing registers codex-cli aliases without replacing existing shell handlers", () => {
  let result = runBash([
    "PATH=",
    "unset -f codex-cli cdx hiai 2>/dev/null || true",
    `source <(${sourceCommand()})`,
    "type -t codex-cli",
    "type -t cdx",
    "type -t hiai",
    "complete -p codex-cli",
    "complete -p cdx",
    "complete -p hiai",
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^function$/gm)?.length, 3);
  assert.match(result.stdout, /-F _codex_cli_complete codex-cli/);
  assert.match(result.stdout, /-F _codex_cli_complete cdx/);
  assert.match(result.stdout, /-F _codex_cli_complete hiai/);

  result = runBash([
    "codex-cli() { printf 'existing-command\\n'; }",
    "cdx() { printf 'existing-cdx\\n'; }",
    "hiai() { printf 'existing-hiai\\n'; }",
    "_existing_node_completion() { COMPREPLY=(existing-node); }",
    "complete -F _existing_node_completion node",
    `source <(${sourceCommand()})`,
    "codex-cli",
    "cdx",
    "hiai",
    "complete -p node",
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^existing-command$/m);
  assert.match(result.stdout, /^existing-cdx$/m);
  assert.match(result.stdout, /^existing-hiai$/m);
  assert.match(result.stdout, /-F _existing_node_completion node/);
  assert.doesNotMatch(result.stdout, /-F _codex_cli_node_complete node/);
});

test("generated hiai fallback selects broker agentic mode", () => {
  const result = runBash([
    "PATH=",
    "unset -f hiai 2>/dev/null || true",
    `source <(${sourceCommand()})`,
    "hiai --show-config",
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).values.broker, true);
  assert.equal(JSON.parse(result.stdout).values.agenticErrorCode, true);
});

test("option-name completion covers every public flag and both Bash-completion spellings", () => {
  const expected = [
    "--socket", "--direct", "--broker", "--broker-socket", "--prompt", "--image", "--config", "--show-config", "--config-json",
    "--thread-params", "--turn-params", "--thread", "--new", "--state", "--model",
    "--clear-model", "--start-daemon", "--cwd", "--timeout", "--approval", "--approval-log",
    "--experimental-api", "--interactive", "--repl", "--interrupt-pending", "--verbosity", "--progress", "--debug", "--agentic-error-code", "--json",
    "--stdin", "--codex", "--bash_completion", "--bash-completion", "--help", "-h",
  ];
  const result = completion(["codex-cli", "-"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(new Set(result.replies), new Set(expected));
  assert.equal(result.replies.length, expected.length, "completion should not emit duplicate flags");
  assert.ok(!result.replies.includes("--broker-serve"), "internal flags must remain hidden");
  assert.ok(!result.replies.includes("--completion-models"), "completion protocol flags must remain hidden");

  for (const command of ["cdx", "hiai"]) {
    const commandResult = completion([command, "--thr"]);
    assert.equal(commandResult.status, 0, commandResult.stderr);
    assert.deepEqual(commandResult.replies, ["--thread-params", "--thread"]);
  }

  const hiaiAction = completion(["hiai", "st"]);
  assert.equal(hiaiAction.status, 0, hiaiAction.stderr);
  assert.deepEqual(hiaiAction.replies, ["start", "status", "stop"]);

  const alias = completion(["codex-cli", "--bash-"]);
  assert.equal(alias.status, 0, alias.stderr);
  assert.deepEqual(alias.replies, ["--bash-completion"]);

  const prompt = completion(["codex-cli", "ordinary prompt"]);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.deepEqual(prompt.replies, []);
});

test("prompt completion offers every registered action token", () => {
  const cases = [
    { words: ["codex-cli", "<clip"], expected: ["<clipboard>"] },
    { words: ["cdx", "Explain <clip"], expected: ["Explain <clipboard>"] },
    { words: ["hiai", "<clip"], expected: ["<clipboard>"] },
    { words: ["hiai", "<cliboard"], expected: ["<clipboard>"] },
  ];

  for (const { words, expected } of cases) {
    const result = completion(words);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.replies, expected, words.join(" "));
  }
});

test("enumerated values and broker option context complete precisely", () => {
  const cases = [
    { words: ["codex-cli", "--approval", "a"], expected: ["accept", "accept-for-session"] },
    { words: ["codex-cli", "--approval", "d"], expected: ["decline"] },
    { words: ["codex-cli", "--verbosity", "m"], expected: ["medium"] },
    { words: ["codex-cli", "--verbosity", "h"], expected: ["high"] },
    { words: ["codex-cli", "--show-config", ""], expected: ["set", "all"] },
    { words: ["codex-cli", "--show-config", "a"], expected: ["all"] },
    { words: ["codex-cli", "--show-config", "--con"], expected: ["--config", "--config-json"] },
    { words: ["codex-cli", "--broker", "s"], expected: ["start", "status", "stop"] },
    { words: ["codex-cli", "--broker", "t"], expected: ["threads"] },
    { words: ["codex-cli", "--broker", "--thr"], expected: ["--thread-params", "--thread"] },
    { words: ["codex-cli", "--broker", "start", "--cle"], expected: ["--clear-model"] },
  ];

  for (const { words, expected } of cases) {
    const result = completion(words);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.replies, expected, words.join(" "));
  }
});

test("file, directory, @FILE, and executable completion preserve spaces", async (t) => {
  const workspace = await temporaryDirectory(t, "codex completion files ");
  await writeFile(path.join(workspace, "config one.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "config-two.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "image one.png"), "image\n", "utf8");
  await writeFile(path.join(workspace, "params one.json"), "{}\n", "utf8");
  await mkdir(path.join(workspace, "workspace one"));
  const executable = path.join(workspace, "codex-helper");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  for (const flag of ["--socket", "--broker-socket", "--state", "--approval-log", "--config-json"]) {
    const result = completion(["codex-cli", flag, "config"], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(new Set(result.replies), new Set(["config one.json", "config-two.json"]), flag);
  }

  let result = completion(["codex-cli", "--image", "image"], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.replies, ["image one.png"]);

  result = completion(["codex-cli", "--cwd", "workspace"], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.replies, ["workspace one"]);

  for (const flag of ["--thread-params", "--turn-params"]) {
    result = completion(["codex-cli", flag, "@params"], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.replies, ["@params one.json"], flag);
  }

  result = completion(["codex-cli", "--codex", "codex-help"], {
    cwd: workspace,
    env: { PATH: `${workspace}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.replies.includes("codex-helper"));
});

test("model completion prefers and filters Codex's local catalog cache", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex completion cache ");
  await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [
    { slug: "cached-model" },
    { model: "cached-model" },
    { id: "cached-id" },
    { slug: "hidden-model", visibility: "hide" },
    { slug: "unsupported-model", supported_in_api: false },
    { slug: "" },
    null,
  ] }), "utf8");

  let result = invoke(["--completion-cached-models"], { env: { CODEX_HOME: codexHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["cached-model", "cached-id"]);

  result = completion(["codex-cli", "--model", "cached-"], {
    codexPath: path.join(codexHome, "missing-codex"),
    env: { CODEX_HOME: codexHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.replies, ["cached-model", "cached-id"]);

  await writeFile(path.join(codexHome, "models_cache.json"), "not json", "utf8");
  result = invoke(["--completion-cached-models"], { env: { CODEX_HOME: codexHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("dynamic model discovery deduplicates values and falls back to cache on failure", async (t) => {
  await chmod(fakeCodex, 0o755);
  const emptyCodexHome = await temporaryDirectory(t, "codex completion dynamic ");

  let result = invoke(["--completion-models", "--codex", fakeCodex], {
    env: { CODEX_HOME: emptyCodexHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["fake-default", "fake-fast"]);

  const cachedHome = await temporaryDirectory(t, "codex completion fallback ");
  await writeFile(path.join(cachedHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "fallback-model" }] }), "utf8");
  result = invoke(["--completion-models", "--codex", path.join(cachedHome, "missing-codex")], {
    env: { CODEX_HOME: cachedHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "fallback-model\n");

  result = invoke(["--completion-models", "--codex", path.join(emptyCodexHome, "missing-codex")], {
    env: { CODEX_HOME: emptyCodexHome },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-codex|ENOENT|spawn/);
});

test("Bash model cache is reused for 30 seconds and invalidated by age or context", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "codex completion model context ");
  const otherWorkspace = path.join(workspace, "other workspace");
  await mkdir(otherWorkspace);
  const codexHome = await temporaryDirectory(t, "codex completion model empty cache ");
  const trace = path.join(workspace, "model-requests.ndjson");
  const source = sourceCommand();
  const completeModel = (words) => [
    `COMP_WORDS=(${words.map(shellQuote).join(" ")})`,
    `COMP_CWORD=${words.length - 1}`,
    "COMPREPLY=()",
    "_codex_cli_complete",
  ].join("\n");
  const script = [
    `source <(${source})`,
    completeModel(["codex-cli", "--model", "fake-"]),
    completeModel(["codex-cli", "--model", "fake-"]),
    "_CODEX_CLI_MODEL_CACHE_AT=$((SECONDS - 30))",
    completeModel(["codex-cli", "--model", "fake-"]),
    completeModel(["codex-cli", "--cwd", otherWorkspace, "--model", "fake-"]),
    "printf '%s\\0' \"${COMPREPLY[@]}\"",
  ].join("\n");

  const result = runBash(script, {
    cwd: workspace,
    env: { CODEX_HOME: codexHome, FAKE_CODEX_TRACE: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").filter(Boolean), ["fake-default", "fake-fast"]);

  const requests = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter((request) => request.method === "model/list").length, 3);
  assert.equal(requests.filter((request) => request.method === "initialize").length, 3);
});

test("Node invocation delegates only codex-cli command scripts to the completion handler", () => {
  for (const script of [cli, "cdx", "/usr/local/bin/hiai"]) {
    const completed = completion([process.execPath, script, "--ba"], {
      cword: 2,
      handler: "_codex_cli_node_complete",
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(new Set(completed.replies), new Set(["--bash_completion", "--bash-completion"]));
  }

  const result = runBash([
    `source <(${sourceCommand()})`,
    `COMP_WORDS=(${shellQuote(process.execPath)} ${shellQuote("different-script.mjs")} ${shellQuote("--ba")})`,
    "COMP_CWORD=2",
    "COMPREPLY=(sentinel)",
    "_codex_cli_node_complete",
    "status=$?",
    "printf '%s\\n' \"$status\" \"${COMPREPLY[*]}\"",
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1\nsentinel\n");
});

test("CLI entry point runs when its path contains spaces", async (t) => {
  const workspace = await temporaryDirectory(t, "codex cli path with spaces ");
  const copiedCli = path.join(workspace, "codex cli copy.mjs");
  await copyFile(cli, copiedCli);
  await chmod(copiedCli, 0o755);
  await access(copiedCli);
  const result = invoke(["--help"], { cliPath: copiedCli });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: codex-cli/);
});
