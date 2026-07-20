import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const hiai = path.join(root, "bin/hiai");
const fakeCodex = path.join(root, "tests/fixtures/fake-codex.mjs");

function invokeHiai(workspace, args) {
  const brokerAction = ["start", "status", "stop", "threads"].includes(args[0]) ? args[0] : undefined;
  const remaining = brokerAction ? args.slice(1) : args;
  return spawnSync(hiai, [
    ...(brokerAction ? [brokerAction] : []),
    "--cwd", workspace,
    "--codex", fakeCodex,
    "--broker-socket", path.join(workspace, "broker.sock"),
    ...remaining,
  ], {
    encoding: "utf8",
    timeout: 10000,
  });
}

test("hiai launcher selects broker mode and preserves arguments", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex hiai launcher "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const launcher = path.join(workspace, "hiai");
  const fakeCli = path.join(workspace, "codex-cli");
  await copyFile(path.join(root, "bin/hiai"), launcher);
  await writeFile(fakeCli, [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    "",
  ].join("\n"), "utf8");
  await chmod(launcher, 0o755);
  await chmod(fakeCli, 0o755);

  const result = spawnSync(launcher, ["--new", "sudo whoami", "--timeout", "10", "--approval", "accept"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "--broker", "--new", "sudo whoami", "--timeout", "10", "--approval", "accept",
  ]);

  const action = spawnSync(launcher, ["status", "--cwd", "/workspace"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(action.status, 0, action.stderr);
  assert.deepEqual(JSON.parse(action.stdout), ["--broker", "status", "--cwd", "/workspace"]);
});

test("package installs hiai through its broker launcher", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.bin.hiai, "bin/hiai");
});

test("hiai receives and accepts a broker approval request end to end", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex hiai approval "));
  t.after(() => {
    invokeHiai(workspace, ["stop"]);
    return rm(workspace, { recursive: true, force: true });
  });
  await chmod(fakeCodex, 0o755);

  let result = invokeHiai(workspace, ["start"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /broker started/);

  result = invokeHiai(workspace, [
    "--new", "--approval", "accept-for-session", "approve through hiai",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[acceptForSession\]/);
  assert.match(result.stderr, /approval requested for echo approved; acceptForSession/);
});
