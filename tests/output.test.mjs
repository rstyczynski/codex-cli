import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProgressSpinner, classifyCodexError, createHumanRenderer, finalAgentMessage, formatThreadItem, parseAgenticResult, parseArgs, promptWithAgenticResultContract, resolveImplicitBrokerWorkspace, showWelcomeBanner } from "../bin/codex-cli";

const root = path.resolve(new URL("..", import.meta.url).pathname);

test("verbosity defaults to low and accepts every documented level", () => {
  assert.equal(parseArgs([]).verbosity, "low");
  for (const verbosity of ["low", "medium", "high"]) {
    assert.equal(parseArgs(["--verbosity", verbosity]).verbosity, verbosity);
  }
  assert.throws(() => parseArgs(["--verbosity", "debug"]), /must be low, medium, or high/);
});

test("progress defaults to enabled", () => {
  assert.equal(parseArgs([]).progress, true);
  assert.equal(parseArgs([]).interim, true);
  assert.equal(parseArgs(["--agentic-error-code"]).agenticErrorCode, true);
});

test("implicit broker workspaces use the Git root or the user home", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex cli broker home "));
  const outsideGit = await mkdtemp(path.join(os.tmpdir(), "codex cli no git "));
  t.after(async () => Promise.all([rm(home, { recursive: true, force: true }), rm(outsideGit, { recursive: true, force: true })]));

  assert.equal(await resolveImplicitBrokerWorkspace(path.join(root, "tests"), home), root);
  assert.equal(await resolveImplicitBrokerWorkspace(outsideGit, home), home);
});

test("agentic result contract is injected and strictly validated", () => {
  const prompt = promptWithAgenticResultContract("Apply the fix and run tests.");
  assert.match(prompt, /^Apply the fix and run tests\./);
  assert.match(prompt, /final assistant message must contain exactly one JSON object/);
  assert.match(prompt, /Never use code 13/);

  assert.deepEqual(
    parseAgenticResult('{"goal_achieved":true,"agentic_exit_code":0,"summary":"done","reason":"tests pass","ignored":"field"}'),
    { goal_achieved: true, agentic_exit_code: 0, summary: "done", reason: "tests pass" },
  );
  assert.deepEqual(
    parseAgenticResult('{"goal_achieved":false,"agentic_exit_code":2,"summary":"blocked","reason":"work remains"}'),
    { goal_achieved: false, agentic_exit_code: 2, summary: "blocked", reason: "work remains" },
  );
  assert.deepEqual(
    parseAgenticResult('{"goal_achieved":true,"agentic_exit_code":2,"summary":"rain expected","reason":"forecast checked"}'),
    { goal_achieved: true, agentic_exit_code: 2, summary: "rain expected", reason: "forecast checked" },
  );
  assert.deepEqual(
    parseAgenticResult('{"goal_achieved":true,"agentic_exit_code":1,"summary":"not Swiss","reason":"the image classification completed"}'),
    { goal_achieved: true, agentic_exit_code: 1, summary: "not Swiss", reason: "the image classification completed" },
  );

  for (const [message, expected] of [
    [undefined, /message is missing/],
    ["not JSON", /not valid JSON/],
    ["[]", /must be a JSON object/],
    ['{"agentic_exit_code":1,"summary":"x"}', /goal_achieved must be a boolean/],
    ['{"goal_achieved":false,"agentic_exit_code":16,"summary":"x"}', /integer from 0 to 15/],
    ['{"goal_achieved":false,"agentic_exit_code":13,"summary":"x"}', /13 is reserved/],
    ['{"goal_achieved":false,"agentic_exit_code":0,"summary":"x"}', /code 0 requires goal_achieved true/],
    ['{"goal_achieved":true,"agentic_exit_code":0}', /summary must be a string/],
    ['{"goal_achieved":true,"agentic_exit_code":0,"summary":"x"}', /reason must be a string/],
    ['{"goal_achieved":true,"agentic_exit_code":0,"summary":"x","reason":3}', /reason must be a string/],
  ]) {
    assert.throws(() => parseAgenticResult(message), (error) => {
      assert.equal(error.exitCode, 72);
      assert.match(error.message, expected);
      return true;
    });
  }

  assert.equal(finalAgentMessage({ items: [
    { type: "agentMessage", text: "progress" },
    { type: "commandExecution" },
    { type: "agentMessage", text: "final" },
  ] }), "final");
  assert.equal(finalAgentMessage({ items: [] }), undefined);
});

test("Codex errors classify retryable failures and veto definitive retries", () => {
  assert.deepEqual(
    classifyCodexError({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } } }, true),
    { classification: "correctable", retrySuppressed: false, willRetry: true },
  );
  assert.deepEqual(
    classifyCodexError({ message: "unexpected status 429 Too Many Requests" }, true),
    { classification: "correctable", retrySuppressed: false, willRetry: true },
  );
  for (const error of [
    { message: "unexpected status 401 Unauthorized" },
    { codexErrorInfo: "unauthorized" },
    { codexErrorInfo: { permissionDenied: {} } },
    { codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 400 } } },
    { codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 501 } } },
  ]) {
    assert.deepEqual(
      classifyCodexError(error, true),
      { classification: "definitive", retrySuppressed: true, willRetry: false },
    );
  }
  assert.deepEqual(
    classifyCodexError({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } } }, false),
    { classification: "definitive", retrySuppressed: false, willRetry: false },
  );
  assert.deepEqual(
    classifyCodexError({ message: "temporary failure" }, "true"),
    { classification: "definitive", retrySuppressed: false, willRetry: false },
  );
});

test("thread-item formatting separates summaries from high-detail payloads", () => {
  const command = {
    id: "command-1",
    type: "commandExecution",
    command: "npm test",
    cwd: "/workspace",
    status: "completed",
    exitCode: 0,
    durationMs: 12,
    aggregatedOutput: "passed\n",
  };
  assert.equal(formatThreadItem(command, "low"), undefined);
  assert.equal(formatThreadItem(command, "medium"), undefined);
  assert.match(formatThreadItem(command, "high"), /cwd: \/workspace/);
  assert.match(formatThreadItem(command, "high"), /output:\n  passed/);

  const reasoning = { id: "reasoning-1", type: "reasoning", summary: ["Summary"], content: ["Detail"] };
  assert.doesNotMatch(formatThreadItem(reasoning, "medium"), /Detail/);
  assert.match(formatThreadItem(reasoning, "high"), /Detail/);
});

test("rich rendering marks item types and separates type changes", () => {
  const diagnostics = [];
  const renderer = createHumanRenderer(
    { json: false, verbosity: "high" },
    undefined,
    { write() {} },
    { write: (chunk) => diagnostics.push(chunk) },
  );

  renderer.item({ id: "command-1", type: "commandExecution", command: "npm test" }, "started");
  renderer.item({ id: "command-1", type: "commandExecution", command: "npm test", exitCode: 0 }, "completed");
  renderer.item({ id: "file-1", type: "fileChange", changes: [{ kind: "update", path: "README.md" }] });

  assert.equal(
    diagnostics.join(""),
    "codex-cli: ⚙️ Command started: npm test\n" +
      "codex-cli: ⚙️ Command completed (exit 0): npm test\n" +
      "\ncodex-cli: 📝 File change completed: update: README.md\n",
  );
});

test("agentic interim updates render only a user-facing summary", () => {
  const diagnostics = [];
  const renderer = createHumanRenderer(
    { json: false, interim: true, agenticErrorCode: true, verbosity: "low" },
    undefined,
    { write() {} },
    { write: (chunk) => diagnostics.push(chunk) },
  );
  const update = JSON.stringify({
    goal_achieved: false,
    agentic_exit_code: 1,
    summary: "Progress checkpoint 1 of 6 completed.",
    reason: "The timed demonstration is still running.",
  });

  renderer.agentDelta("update-1", update.slice(0, 42));
  renderer.agentDelta("update-1", update.slice(42));
  renderer.item({ id: "update-1", type: "agentMessage", text: update }, "completed");

  assert.deepEqual(diagnostics, ["codex-cli: Progress checkpoint 1 of 6 completed.\n"]);
  assert.doesNotMatch(diagnostics.join(""), /goal_achieved|agentic_exit_code|reason/);
});

test("progress spinner advances only when an event advances it and clears cleanly", () => {
  const writes = [];
  const spinner = new ProgressSpinner(true, { write: (chunk) => writes.push(chunk) });
  spinner.start("Waiting for Codex");
  spinner.advance();
  spinner.stop();
  spinner.advance();
  spinner.stop();
  assert.match(writes[0], /Waiting for Codex/);
  assert.equal(writes.length, 5);
  assert.equal(writes.at(-1), "\r\x1b[2K");

  const disabledWrites = [];
  const disabled = new ProgressSpinner(false, { write: (chunk) => disabledWrites.push(chunk) });
  disabled.start();
  disabled.stop();
  assert.deepEqual(disabledWrites, []);
});

test("welcome banner writes only to an interactive terminal and excludes machine-readable modes", () => {
  const writes = [];
  showWelcomeBanner({ json: false, agenticErrorCode: false }, { isTTY: true, write: (chunk) => writes.push(chunk) });
  assert.deepEqual(writes, ["codex-cli v1.0.10 — ready\n"]);

  for (const options of [{ json: true, agenticErrorCode: false }, { json: false, agenticErrorCode: true }]) {
    const suppressed = [];
    showWelcomeBanner(options, { isTTY: true, write: (chunk) => suppressed.push(chunk) });
    assert.deepEqual(suppressed, []);
  }

  const brokerStart = [];
  showWelcomeBanner({ json: true, agenticErrorCode: true }, { isTTY: false, write: (chunk) => brokerStart.push(chunk) }, true);
  assert.deepEqual(brokerStart, ["codex-cli v1.0.10 — ready\n"]);
});
