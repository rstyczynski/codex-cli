import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
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
  assert.match(generated.stdout, /_codex_cli_quote_thread_label/);
  assert.match(generated.stdout, /complete .*codex-cli cdx hiai/);
  assert.doesNotMatch(generated.stdout, /codex-cli codex-cli/, "completion target should only be registered once");

  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], {
    input: generated.stdout,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const systemBashSyntax = spawnSync("/bin/bash", ["--noprofile", "--norc", "-n"], {
    input: generated.stdout,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(systemBashSyntax.status, 0, systemBashSyntax.stderr);

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

test("real Bash Readline completes shared-prefix and shell-metacharacter labels without filesystem fallback", (t) => {
  const expectProbe = spawnSync("expect", ["-v"], { encoding: "utf8" });
  if (expectProbe.error?.code === "ENOENT") return t.skip("Expect is not installed");
  const bashPath = "/bin/bash";
  const program = String.raw`
set timeout 10
log_user 0
proc expect_exact {value} {
  expect {
    -exact $value {}
    timeout { puts stderr "missing expected output: $value"; exit 8 }
    eof { puts stderr "shell closed before expected output: $value"; exit 8 }
  }
}
proc expect_prompt {} {
  expect {
    -re {[$#] $} {}
    timeout { puts stderr "missing shell prompt"; exit 8 }
    eof { puts stderr "shell closed before prompt"; exit 8 }
  }
}
spawn -noecho $env(PTY_BASH) --noprofile --norc -i
expect_prompt
send -- {eval "$("$PTY_NODE" "$PTY_CLI" --bash_completion --codex "$PTY_CODEX")"}
send -- "\r"
expect_prompt
send -- {hiai(){ printf '__ARGC__%s\n' "$#"; for arg in "$@"; do printf '__ARG__%s\n' "$arg"; done; }}
send -- "\r"
expect_prompt
send -- {_codex_cli_thread_values(){ _CODEX_CLI_THREAD_CACHE=$'thread-a\tSprint alpha\t1\nthread-b\tSprint beta\t1'; }}
send -- "\r"
expect_prompt
send -- "hiai --thread Spr\t"
after 100
send -- "a\t marker\r"
expect_exact {__ARGC__3}
expect_exact {__ARG__--thread}
expect_exact {__ARG__Sprint alpha}
expect_exact {__ARG__marker}
expect_prompt
send -- {_codex_cli_thread_values(){ _CODEX_CLI_THREAD_CACHE=$'thread-c\tunsafe O\'Brien;$(printf PWN)*\t1'; }}
send -- "\r"
expect_prompt
send -- "hiai --thread Brien\t marker\r"
expect_exact {__ARGC__3}
expect_exact {__ARG__--thread}
expect_exact {__ARG__unsafe O'Brien;$(printf PWN)*}
expect_exact {__ARG__marker}
expect_prompt
send -- {_codex_cli_thread_values(){ _CODEX_CLI_THREAD_CACHE=$'thread-h\tunsafe !!\t1'; }}
send -- "\r"
expect_prompt
send -- {set -H}
send -- "\r"
expect_prompt
send -- "hiai --thread unsafe\t marker\r"
expect_exact {__ARGC__3}
expect_exact {__ARG__--thread}
expect_exact {__ARG__unsafe !!}
expect_exact {__ARG__marker}
expect_prompt
send -- {hiai --thread "unsafe}
send -- "\t marker\r"
expect_exact {__ARGC__3}
expect_exact {__ARG__--thread}
expect_exact {__ARG__thread-h}
expect_exact {__ARG__marker}
expect_prompt
send -- {_codex_cli_thread_values(){ _CODEX_CLI_THREAD_CACHE=; }}
send -- "\r"
expect_prompt
send -- "hiai --thread \t\t"
set timeout 1
expect {
  -exact "README.md" { puts stderr "filesystem fallback appeared in thread completion"; exit 9 }
  timeout {}
}
send -- "\025"
send -- "printf '__NO_FALLBACK__\\n'\r"
set timeout 10
expect_exact {__NO_FALLBACK__}
puts "__EXPECT_OK__"
send -- "exit\r"
`;
  const result = spawnSync("expect", ["-c", program], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      PTY_BASH: bashPath,
      PTY_NODE: process.execPath,
      PTY_CLI: cli,
      PTY_CODEX: fakeCodex,
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /__EXPECT_OK__/);
});

test("slow thread completion shows a delayed spinner and still inserts one label argument", async (t) => {
  const expectProbe = spawnSync("expect", ["-v"], { encoding: "utf8" });
  if (expectProbe.error?.code === "ENOENT") return t.skip("Expect is not installed");
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "codex completion spinner ");
  const socketPath = path.join(workspace, "broker.sock");
  const env = {
    FAKE_CODEX_THREADS_JSON: JSON.stringify([{ id: "thread-spinner", name: "Spinner target", createdAt: 1 }]),
    FAKE_CODEX_THREAD_LIST_DELAY_MS: "700",
  };
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "stop"], { env }));
  const started = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "start"], { env });
  assert.equal(started.status, 0, started.stderr);

  const program = String.raw`
set timeout 10
log_user 0
proc expect_exact {value} {
  expect {
    -exact $value {}
    timeout { puts stderr "missing expected output: $value"; exit 8 }
    eof { puts stderr "shell closed before expected output: $value"; exit 8 }
  }
}
proc expect_prompt {} {
  expect {
    -re {[$#] $} {}
    timeout { puts stderr "missing shell prompt"; exit 8 }
    eof { puts stderr "shell closed before prompt"; exit 8 }
  }
}
spawn -noecho /bin/bash --noprofile --norc -i
expect_before -re {\[[0-9]+\] [0-9]+} { puts stderr "completion created a visible Bash job"; exit 8 }
expect_prompt
send -- "eval \"\$(\"$env(PTY_NODE)\" \"$env(PTY_CLI)\" --bash_completion --codex \"$env(PTY_CODEX)\")\""
send -- "\r"
expect_prompt
send -- {hiai(){ for arg in "$@"; do printf '__ARG__%s\n' "$arg"; done; }}
send -- "\r"
expect_prompt
send -- "hiai --cwd \"$env(PTY_WORKSPACE)\" --broker-socket \"$env(PTY_SOCKET)\" --thread spi\t"
expect {
  -re {Searching Codex threads} {}
  timeout { puts stderr "thread completion never showed its spinner"; exit 8 }
  eof { puts stderr "shell closed before spinner"; exit 8 }
}
send -- " marker\r"
expect_exact {__ARG__--thread}
expect_exact {__ARG__Spinner target}
expect_exact {__ARG__marker}
puts "__EXPECT_OK__"
send -- "exit\r"
`;
  const result = spawnSync("expect", ["-c", program], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      ...env,
      PTY_NODE: process.execPath,
      PTY_CLI: cli,
      PTY_CODEX: fakeCodex,
      PTY_WORKSPACE: workspace,
      PTY_SOCKET: socketPath,
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /__EXPECT_OK__/);
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
    "--thread-params", "--turn-params", "--thread", "--thread-switch", "--thread-set-name", "--new", "--state", "--current-thread", "--model",
    "--clear-model", "--start-daemon", "--cwd", "--timeout", "--approval", "--approval-log",
    "--experimental-api", "--interactive", "--repl", "--interrupt-pending", "--verbosity", "--progress", "--debug", "--diagnostics", "--agentic-error-code", "--json",
    "--stdin", "--codex", "--bash_completion", "--bash-completion", "--help", "-h", "--interim", "--version",
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
    assert.deepEqual(commandResult.replies, ["--thread-params", "--thread", "--thread-switch", "--thread-set-name"]);
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
    { words: ["codex-cli", "<thread_"], expected: ["<thread_id>"] },
    { words: ["cdx", "Explain <clip"], expected: ["Explain <clipboard>"] },
    { words: ["hiai", "<clip"], expected: ["<clipboard>"] },
    { words: ["hiai", "<cliboard"], expected: ["<clipboard>", "<thread_id>"] },
  ];

  for (const { words, expected } of cases) {
    const result = completion(words);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.replies, expected, words.join(" "));
  }
});

test("thread completion reads available IDs from an existing broker", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "codex completion threads ");
  const socketPath = path.join(workspace, "broker.sock");
  const missingSocketPath = path.join(workspace, "missing.sock");
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "stop"]));
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", missingSocketPath, "--codex", fakeCodex, "--broker", "stop"]));
  let result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "create thread"]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "create another thread"]);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--thread", "create thread", "select by thread label"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /select by thread label/);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--current-thread"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "thread-2", "one-off --thread must not replace current state");
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--thread-switch", "thread-1", "--thread-set-name", "Sprint 18", "switch current thread"]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--current-thread"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "thread-1");

  let completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "thread-"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["thread-2", "thread-1"], "an ID prefix must remain an ID completion");

  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "thread-"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["thread-2", "thread-1"]);

  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "sprint"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Sprint 18'"]);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread-switch", "sprint"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Sprint 18'"]);
  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--thread-set-name", "sprint"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [], "--thread-set-name must not complete existing thread labels");
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--thread", "Sprint 18", "select named thread"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /select named thread/);

  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", "New sprint", "create named thread"]);
  assert.equal(result.status, 0, result.stderr);

  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "another"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'create another thread'"]);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--thread", "create another thread", "select completed thread"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /select completed thread/);

  const pipedListing = runBash([
    "set -o pipefail",
    `${shellQuote(process.execPath)} ${shellQuote(cli)} --cwd ${shellQuote(workspace)} --broker-socket ${shellQuote(socketPath)} --broker threads | head -n 1 >/dev/null`,
  ].join("\n"));
  assert.equal(pipedListing.status, 0, pipedListing.stderr);
  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "thread-"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["thread-3", "thread-2", "thread-1"], "a disconnected list client must not stop the broker");

  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", "Duplicate label", "duplicate one"]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", "Duplicate label", "duplicate two"]);
  assert.equal(result.status, 0, result.stderr);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "duplicate"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["thread-5", "thread-4"], "duplicate labels must complete to unambiguous IDs");

  const injectionMarker = `/tmp/cdxinj-${process.pid}-${Date.now()}`;
  const unsafeLabel = `unsafe;touch\${IFS}${injectionMarker}`;
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", unsafeLabel, "shell-safe label"]);
  assert.equal(result.status, 0, result.stderr);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "unsafe"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [shellQuote(unsafeLabel)], "one-word shell syntax must still be quoted");
  const evaluated = runBash([
    `source <(${sourceCommand()})`,
    `COMP_WORDS=(${["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "unsafe"].map(shellQuote).join(" ")})`,
    "COMP_CWORD=6",
    "COMPREPLY=()",
    "_codex_cli_complete",
    "eval \"set -- ${COMPREPLY[0]}\"",
    "printf '%s\\0%s\\0' \"$#\" \"$1\"",
  ].join("\n"));
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.deepEqual(evaluated.stdout.split("\0").filter(Boolean), ["1", unsafeLabel]);
  await assert.rejects(access(injectionMarker), { code: "ENOENT" });

  const apostropheLabel = "O'Brien";
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", apostropheLabel, "apostrophe label"]);
  assert.equal(result.status, 0, result.stderr);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "Brien"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [shellQuote(apostropheLabel)]);

  const longLabel = `${"long-".repeat(24)}distinctive-tail`;
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", longLabel, "long label"]);
  assert.equal(result.status, 0, result.stderr);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "distinctive-tail"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [shellQuote(longLabel)], "completion matching must use the full label, not its display truncation");

  const unlabeled = runBash([
    `source <(${sourceCommand()})`,
    `_codex_cli_thread_words ${shellQuote("thread-unlabeled\t\t0")} ''`,
    "printf '%s\\0' \"${COMPREPLY[@]}\"",
  ].join("\n"));
  assert.equal(unlabeled.status, 0, unlabeled.stderr);
  assert.deepEqual(unlabeled.stdout.split("\0").filter(Boolean), ["thread-unlabeled"]);

  const exactId = runBash([
    `source <(${sourceCommand()})`,
    `_codex_cli_thread_words ${shellQuote("thread-1\tFirst\t1\nthread-10\tTenth\t1")} thread-1`,
    "printf '%s\\0' \"${COMPREPLY[@]}\"",
  ].join("\n"));
  assert.equal(exactId.status, 0, exactId.stderr);
  assert.deepEqual(exactId.stdout.split("\0").filter(Boolean), ["thread-1"]);

  const exactLabelBeforeIdPrefix = runBash([
    `eval "$(${sourceCommand()})"`,
    `_codex_cli_thread_words ${shellQuote("019abcde-thread\tDifferent thread\t1\nlabel-thread\t019a\t1")} 019a`,
    "printf '%s\\0' \"${COMPREPLY[@]}\"",
  ].join("\n"));
  assert.equal(exactLabelBeforeIdPrefix.status, 0, exactLabelBeforeIdPrefix.stderr);
  assert.deepEqual(exactLabelBeforeIdPrefix.stdout.split("\0").filter(Boolean), ["'019a'"], "an exact label must retain selector precedence over an ID prefix");

  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--new", "--thread", "thread-"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, []);

  completed = completion(["codex-cli", "--cwd", workspace, "--direct", "--thread", "thread-"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, []);

  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", missingSocketPath, "--thread", "thread-"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, []);
  await assert.rejects(access(missingSocketPath), { code: "ENOENT" }, "completion must not start a missing broker");
  await assert.rejects(access(path.join(workspace, "missing.pid")), { code: "ENOENT" }, "completion must not create broker metadata");
});

test("implicit thread completion uses the Git-root broker from a repository subdirectory", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "codex completion git root ");
  const nested = path.join(workspace, "nested", "directory");
  const brokerSocket = "broker.sock";
  const isolatedHome = await temporaryDirectory(t, "codex completion git home ");
  await mkdir(nested, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", workspace], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const env = { HOME: isolatedHome };
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", brokerSocket, "--codex", fakeCodex, "--broker", "stop"], { env }));
  let result = invoke(["--cwd", workspace, "--broker-socket", brokerSocket, "--codex", fakeCodex, "--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["--cwd", workspace, "--broker-socket", brokerSocket, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", "Root conversation", "root thread"], { env });
  assert.equal(result.status, 0, result.stderr);

  const completed = completion(["hiai", "--broker-socket", brokerSocket, "--thread", "root"], { cwd: nested, env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Root conversation'"]);
});

test("thread completion forwards explicit configuration and final transport-mode overrides", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "cdx cmp cfg ");
  const socketPath = path.join(workspace, "broker.sock");
  const configPath = path.join(workspace, "completion config.json");
  const brokerDisabledConfigPath = path.join(workspace, "broker disabled completion config.json");
  const directConfigPath = path.join(workspace, "direct completion config.json");
  const socketConfigPath = path.join(workspace, "socket completion config.json");
  await writeFile(configPath, `${JSON.stringify({ cwd: ".", brokerSocket: "broker.sock" })}\n`, "utf8");
  await writeFile(brokerDisabledConfigPath, `${JSON.stringify({ cwd: ".", brokerSocket: "broker.sock", broker: false })}\n`, "utf8");
  await writeFile(directConfigPath, `${JSON.stringify({ cwd: ".", brokerSocket: "broker.sock", direct: true })}\n`, "utf8");
  await writeFile(socketConfigPath, `${JSON.stringify({ cwd: ".", brokerSocket: "broker.sock", socket: "managed.sock" })}\n`, "utf8");
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "stop"]));

  let result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "start"]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", "Configured conversation", "configured thread"]);
  assert.equal(result.status, 0, result.stderr);

  let completed = completion(["codex-cli", "--config", configPath, "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Configured conversation'"]);

  completed = completion(["codex-cli", "--config", brokerDisabledConfigPath, "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [], "codex-cli must honor a configured broker:false value");

  completed = completion(["hiai", "--config", brokerDisabledConfigPath, "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Configured conversation'"], "hiai's implicit command-line --broker must override configured broker:false during completion");

  completed = completion(["codex-cli", "--config", directConfigPath, "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [], "configured direct mode must not query broker threads");

  completed = completion(["codex-cli", "--config", directConfigPath, "--direct", "false", "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Configured conversation'"], "a command-line false value must override configured direct mode");

  completed = completion(["codex-cli", "--config", socketConfigPath, "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [], "configured socket mode must not query broker threads");

  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--new", "false", "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Configured conversation'"], "--new false must leave thread completion enabled");

  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--image", "not-read-during-completion.png", "--prompt", "--socket", "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Configured conversation'"], "unrelated option values must not be mistaken for transport flags or read during completion");

  completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--broker", "false", "--thread", "configured"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [], "an explicitly disabled broker must not be queried");
});

test("broker completion filters and caches the complete thread catalog", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "cdx cmp cat ");
  const socketPath = path.join(workspace, "broker.sock");
  const trace = path.join(workspace, "broker-trace.ndjson");
  const seeds = Array.from({ length: 55 }, (_, index) => ({
    id: `seed-${String(index + 1).padStart(2, "0")}`,
    name: `Catalog label ${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  seeds[0].name = "Global duplicate";
  seeds[52].name = "Unique recent";
  seeds[53].name = "Archive collision";
  seeds[54].name = "Global duplicate";
  seeds[51].name = "Authoritative native name";
  seeds[51].preview = "hidden preview selector";
  seeds[50].name = "Control\u001b[31m label\u007f\u0085safe";
  seeds.push({ id: "retired-collision", name: "Archive collision", archived: true, createdAt: 1000, updatedAt: 1000 });
  seeds.push({ id: "subagent-unique", name: "Unique recent", parentThreadId: "parent-thread", source: { subAgent: { thread_spawn: { parent_thread_id: "parent-thread" } } }, createdAt: 1001, updatedAt: 1001 });
  const env = { FAKE_CODEX_THREADS_JSON: JSON.stringify(seeds), FAKE_CODEX_TRACE: trace };
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "stop"], { env }));

  let result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);
  const completionArgs = ["--cwd", workspace, "--broker-socket", socketPath, "--completion-threads", "--completion-thread-query", "seed-", "--timeout", "10"];
  result = invoke(completionArgs, { env });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").map((line) => line.split("\t"));
  assert.equal(rows.length, 55, "completion must search every active thread matching the typed ID prefix");
  assert.deepEqual(rows.find(([id]) => id === "seed-55"), ["seed-55", "Global duplicate", "0"], "global duplicate labels must remain unambiguous only as IDs");
  assert.deepEqual(rows.find(([id]) => id === "seed-54"), ["seed-54", "Archive collision", "0"], "archived collisions must affect active-label uniqueness");
  assert.deepEqual(rows.find(([id]) => id === "seed-53"), ["seed-53", "Unique recent", "1"]);
  assert.deepEqual(rows.find(([id]) => id === "seed-51"), ["seed-51", "Control [31m label safe", "1"], "completion labels must not emit terminal control characters");
  assert.doesNotMatch(result.stdout, /[\u001b\u007f\u0085]/);
  assert.equal(rows.some(([id]) => id === "seed-01"), true, "old threads must stay available to completion");
  assert.equal(rows.some(([id]) => id === "retired-collision"), false, "the typed ID prefix must still filter the result set");

  result = invoke(completionArgs, { env });
  assert.equal(result.status, 0, result.stderr);
  let requests = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter((request) => request.method === "thread/list").length, 2, "an immediate repeated client must reuse the broker's complete catalog cache");

  let completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "global"], { env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["seed-55", "seed-01"], "a globally duplicated label must complete to unambiguous IDs");
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "archive"], { env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["retired-collision", "seed-54"], "an archived collision must complete to unambiguous IDs");
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "unique recent"], { env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Unique recent'"]);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "hidden preview"], { env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, [], "a native name must hide its obsolete preview from completion");
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "label safe"], { env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Control [31m label safe'"]);

  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "--new", "--thread-set-name", "Fresh completion label", "fresh thread"], { env });
  assert.equal(result.status, 0, result.stderr);
  completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--thread", "fresh completion"], { env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Fresh completion label'"], "thread creation and naming must invalidate the broker catalog immediately");
  requests = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter((request) => request.method === "thread/list").length, 4, "post-mutation completion must refresh the complete catalog");
});

test("thread-family completion searches a thousand-thread catalog with a longer bounded first lookup", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "cdx cmp large ");
  const socketPath = path.join(workspace, "broker.sock");
  const trace = path.join(workspace, "broker-trace.ndjson");
  const seeds = Array.from({ length: 1014 }, (_, index) => ({
    id: `large-${String(index + 1).padStart(4, "0")}`,
    name: index === 1013 ? "Polish completion target" : `Large catalog label ${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  const env = {
    FAKE_CODEX_THREADS_JSON: JSON.stringify(seeds),
    FAKE_CODEX_THREAD_LIST_DELAY_MS: "100",
    FAKE_CODEX_TRACE: trace,
  };
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "stop"], { env }));
  let result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);

  const startedAt = performance.now();
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--completion-threads", "--completion-thread-query", "polish", "--timeout", "10"], { env });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["large-1014\tPolish completion target\t1"]);
  assert.ok(elapsedMs < 5000, `full catalog completion missed its bounded deadline: ${elapsedMs.toFixed(0)}ms`);
  const requests = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter((request) => request.method === "thread/list").length, 12, "completion must scan active and archived pages once, then reuse the broker cache");

  for (const option of ["--thread", "--thread-switch"]) {
    const completed = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, option, "poli"], { env });
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(completed.replies, ["'Polish completion target'"], option);
  }
  const blank = completion(["codex-cli", "--cwd", workspace, "--broker-socket", socketPath, "--thread", ""], { env });
  assert.equal(blank.status, 0, blank.stderr);
  assert.deepEqual(blank.replies, [], "an empty selector must not offer every catalog entry");
});

test("thread completion applies one total deadline to broker probing and catalog listing", async (t) => {
  await chmod(fakeCodex, 0o755);
  const workspace = await temporaryDirectory(t, "cdx cmp ttl ");
  const socketPath = path.join(workspace, "broker.sock");
  const env = {
    FAKE_CODEX_THREADS_JSON: JSON.stringify([{ id: "slow-seed", name: "Slow catalog", createdAt: 1 }]),
    FAKE_CODEX_THREAD_LIST_DELAY_MS: "1500",
  };
  t.after(() => invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "stop"], { env }));
  let result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--codex", fakeCodex, "--broker", "start"], { env });
  assert.equal(result.status, 0, result.stderr);

  let startedAt = performance.now();
  result = invoke(["--cwd", workspace, "--broker-socket", socketPath, "--completion-threads", "--completion-thread-query", "catalog", "--timeout", "0.3"], { env });
  let elapsedMs = performance.now() - startedAt;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "a partial catalog must never leak after the deadline");
  assert.ok(elapsedMs < 1000, `completion exceeded its total deadline: ${elapsedMs.toFixed(0)}ms`);

  startedAt = performance.now();
  const completed = completion(["hiai", "--cwd", workspace, "--broker-socket", socketPath, "--timeout", "120", "--thread", "catalog"], { env });
  elapsedMs = performance.now() - startedAt;
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(completed.replies, ["'Slow catalog'"], "a preceding user timeout must not override the ten-second completion deadline");
  assert.ok(elapsedMs < 3000, `completion failed to reuse the longer internal deadline: ${elapsedMs.toFixed(0)}ms`);

  const silentSocketPath = path.join(workspace, "silent.sock");
  const silentServer = net.createServer((socket) => socket.on("data", () => {}));
  await new Promise((resolve, reject) => { silentServer.once("error", reject); silentServer.listen(silentSocketPath, resolve); });
  t.after(() => new Promise((resolve) => silentServer.close(resolve)));
  startedAt = performance.now();
  result = invoke(["--cwd", workspace, "--broker-socket", silentSocketPath, "--completion-threads", "--completion-thread-query", "slow", "--timeout", "0.1"]);
  elapsedMs = performance.now() - startedAt;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(elapsedMs < 450, `silent broker probing ignored the total deadline: ${elapsedMs.toFixed(0)}ms`);
});

test("enumerated values and broker option context complete precisely", () => {
  const cases = [
    { words: ["codex-cli", "--approval", "a"], expected: ["accept", "accept-for-session"] },
    { words: ["codex-cli", "--approval", "d"], expected: ["decline"] },
    { words: ["codex-cli", "--verbosity", "m"], expected: ["medium"] },
    { words: ["codex-cli", "--verbosity", "h"], expected: ["high"] },
    { words: ["codex-cli", "--interim", "f"], expected: ["false"] },
    { words: ["codex-cli", "--interim", "O"], expected: ["on", "off"] },
    { words: ["codex-cli", "--progress", ""], expected: ["true", "on", "1", "yes", "false", "off", "0", "no"] },
    { words: ["codex-cli", "--broker", "f"], expected: ["false"] },
    { words: ["codex-cli", "--show-config", ""], expected: ["set", "all"] },
    { words: ["codex-cli", "--show-config", "a"], expected: ["all"] },
    { words: ["codex-cli", "--show-config", "--con"], expected: ["--config", "--config-json"] },
    { words: ["codex-cli", "--broker", "s"], expected: ["start", "status", "stop"] },
    { words: ["codex-cli", "--broker", "t"], expected: ["threads", "true"] },
    { words: ["codex-cli", "--broker", "--thr"], expected: ["--thread-params", "--thread", "--thread-switch", "--thread-set-name"] },
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
