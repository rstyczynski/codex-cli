import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "codex-cli");
const corpusPath = path.join(root, "tests", "parity", "prompts.json");
const fixturePath = path.join(root, "tests", "parity", "fixtures", "workspace");
const resultsRoot = path.join(root, "tests", "results", "parity");
const codex = process.env.CODEX_PARITY_CODEX ?? "codex";
const model = process.env.CODEX_PARITY_MODEL;
const timeoutSeconds = Number(process.env.CODEX_PARITY_TIMEOUT ?? "180");
const commandTimeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 180_000;
const selectedCase = process.env.CODEX_PARITY_CASE;
let runDirectoryPromise;

function parityEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("CDXCLI_")) delete environment[key];
  }
  return environment;
}

function runCommand(command, args, { cwd, timeoutMs = commandTimeoutMs } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env: parityEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, args, stdout, stderr, durationMs: Date.now() - startedAt, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ code: undefined, signal: undefined, error: error.message }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function snapshotWorkspace(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".codex-cli") continue;
    const childRelative = path.join(relative, entry.name);
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(...await snapshotWorkspace(childPath, childRelative));
    } else if (entry.isFile()) {
      const contents = await readFile(childPath);
      snapshot.push({ path: childRelative, sha256: createHash("sha256").update(contents).digest("hex") });
    }
  }
  return snapshot;
}

function classify(result) {
  if (result.timedOut) return "timeout";
  if (result.error) return "spawn-error";
  if (result.code === 0) return "completed";
  return "failed";
}

function countNumberedSentences(text) {
  return text.split(/\r?\n/).filter((line) => /^\s*\d+[.)]\s+\S/.test(line)).length;
}

function evaluate(definition, result, finalMessage, before, after) {
  const text = `${finalMessage}\n${result.stdout}`;
  const matchedPatterns = definition.requiredPatterns.filter((pattern) => new RegExp(pattern, "i").test(text));
  const numberedSentenceCount = countNumberedSentences(finalMessage);
  const lengthPass = (definition.minimumNumberedSentences === undefined || numberedSentenceCount >= definition.minimumNumberedSentences)
    && (definition.maximumNumberedSentences === undefined || numberedSentenceCount <= definition.maximumNumberedSentences);
  return {
    outcome: classify(result),
    matchedPatterns,
    numberedSentenceCount,
    lengthPass,
    semanticPass: matchedPatterns.length === definition.requiredPatterns.length && lengthPass,
    workspaceUnchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}

async function copyFixture(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-cli-parity-"));
  const workspace = path.join(temporaryRoot, "workspace");
  await cp(fixturePath, workspace, { recursive: true });
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return workspace;
}

async function ensureRunDirectory() {
  if (runDirectoryPromise) return runDirectoryPromise;
  runDirectoryPromise = (async () => {
    const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const directory = path.join(resultsRoot, runId);
    await mkdir(directory, { recursive: true });
    const codexVersion = await runCommand(codex, ["--version"], { cwd: root, timeoutMs: 15_000 });
    await writeJson(path.join(directory, "run.json"), {
      runId,
      startedAt: new Date().toISOString(),
      codexCommand: codex,
      codexVersion,
      codexCliPath: cli,
      model: model ?? null,
      sandbox: "read-only",
      commandTimeoutSeconds: commandTimeoutMs / 1000,
      selectedCase: selectedCase ?? null,
    });
    return directory;
  })();
  return runDirectoryPromise;
}

async function runDirect(definition, workspace, caseDirectory) {
  const lastMessagePath = path.join(caseDirectory, "direct-last-message.txt");
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", workspace, "--color", "never", "--output-last-message", lastMessagePath];
  if (model) args.push("--model", model);
  args.push(definition.prompt);
  const result = await runCommand(codex, args, { cwd: workspace });
  return { result, finalMessage: await readIfPresent(lastMessagePath) };
}

async function runCodexCli(t, definition, workspace) {
  const brokerDirectory = await mkdtemp(path.join("/tmp", "cdx-parity-broker-"));
  const brokerSocket = path.join(brokerDirectory, "broker.sock");
  t.after(() => rm(brokerDirectory, { recursive: true, force: true }));
  const start = await runCommand(process.execPath, [cli, "--broker", "start", "--cwd", workspace, "--broker-socket", brokerSocket, "--codex", codex], { cwd: workspace });
  let result = { code: undefined, stdout: "", stderr: "", durationMs: 0, timedOut: false, error: "broker did not start" };
  let stop;
  try {
    if (start.code === 0 && !start.timedOut && !start.error) {
      const args = [cli, "--broker", "--new", "--cwd", workspace, "--broker-socket", brokerSocket, "--thread-params", '{"sandbox":"read-only"}', "--approval", "decline", "--timeout", String(commandTimeoutMs / 1000), "--verbosity", "low"];
      if (model) args.push("--model", model);
      args.push("--prompt", definition.prompt);
      result = await runCommand(process.execPath, args, { cwd: workspace });
    }
  } finally {
    stop = await runCommand(process.execPath, [cli, "--broker", "stop", "--cwd", workspace, "--broker-socket", brokerSocket], { cwd: workspace, timeoutMs: 30_000 });
  }
  return { start, result, stop, finalMessage: result.stdout };
}

async function runCase(t, definition) {
  const runDirectory = await ensureRunDirectory();
  const caseDirectory = path.join(runDirectory, definition.id);
  await mkdir(caseDirectory, { recursive: true });

  const directWorkspace = await copyFixture(t);
  const directBefore = await snapshotWorkspace(directWorkspace);
  const direct = await runDirect(definition, directWorkspace, caseDirectory);
  const directAfter = await snapshotWorkspace(directWorkspace);
  const directEvaluation = evaluate(definition, direct.result, direct.finalMessage, directBefore, directAfter);
  await writeJson(path.join(caseDirectory, "direct.json"), { ...direct, before: directBefore, after: directAfter, evaluation: directEvaluation });

  const cliWorkspace = await copyFixture(t);
  const cliBefore = await snapshotWorkspace(cliWorkspace);
  const candidate = await runCodexCli(t, definition, cliWorkspace);
  const cliAfter = await snapshotWorkspace(cliWorkspace);
  const cliEvaluation = evaluate(definition, candidate.result, candidate.finalMessage, cliBefore, cliAfter);
  await writeJson(path.join(caseDirectory, "codex-cli.json"), { ...candidate, before: cliBefore, after: cliAfter, evaluation: cliEvaluation });

  const comparison = {
    caseId: definition.id,
    requiredPatterns: definition.requiredPatterns,
    direct: directEvaluation,
    codexCli: cliEvaluation,
    outcomeMatches: directEvaluation.outcome === cliEvaluation.outcome,
    pass: directEvaluation.outcome === "completed" && cliEvaluation.outcome === "completed" && directEvaluation.semanticPass && cliEvaluation.semanticPass && directEvaluation.workspaceUnchanged && cliEvaluation.workspaceUnchanged,
  };
  await writeJson(path.join(caseDirectory, "comparison.json"), comparison);
  t.diagnostic(`artifacts: ${caseDirectory}`);
  assert.equal(comparison.pass, true, JSON.stringify(comparison, null, 2));
}

if (process.env.CODEX_PARITY !== "1") {
  test("CDX-10 Codex response comparison", { skip: "set CODEX_PARITY=1 or use npm run test:parity" }, () => {});
} else {
  const definitions = JSON.parse(await readFile(corpusPath, "utf8"));
  const cases = selectedCase ? definitions.filter((definition) => definition.id === selectedCase) : definitions;
  assert.ok(cases.length > 0, `no parity case named ${selectedCase}`);
  for (const definition of cases) {
    test(`CDX-10 ${definition.id}`, { timeout: Math.max(commandTimeoutMs * 3, 360_000) }, async (t) => {
      await runCase(t, definition);
    });
  }
}
