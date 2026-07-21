import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureProcess, saveThread } from "../bin/codex-cli";

test("state persistence does not follow a predictable temporary-file symlink", async (t) => {
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

test("subprocess capture bounds stdout and stderr before they can exhaust memory", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = await captureProcess(process.execPath, ["-e", `process.${stream}.write("x".repeat(4096))`], { maxOutputBytes: 1024 });
    assert.match(result.error?.message ?? "", /subprocess output exceeds 1024 bytes/);
    assert.ok(result.stdout.length <= 1024);
    assert.ok(result.stderr.length <= 1024);
  }
});
