#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";

const threads = new Map();
const approvals = new Map();
let nextThread = 1;
let nextTurn = 1;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function response(id, result) { send({ jsonrpc: "2.0", id, result }); }

function complete(thread, turn, prompt, decision) {
  if (prompt.includes("agentic missing final")) {
    turn.items = [];
    turn.status = "completed";
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    return;
  }
  let agenticText;
  if (prompt.includes("agentic achieved")) agenticText = JSON.stringify({ goal_achieved: true, agentic_exit_code: 0, summary: "goal complete", reason: "requested work and checks completed" });
  else if (prompt.includes("agentic not achieved")) agenticText = JSON.stringify({ goal_achieved: false, agentic_exit_code: 1, summary: "goal incomplete", reason: "required work remains" });
  else if (prompt.includes("agentic custom success one")) agenticText = JSON.stringify({ goal_achieved: true, agentic_exit_code: 1, summary: "observed failing condition", reason: "the requested check completed and found the caller-defined condition" });
  else if (prompt.includes("agentic custom success two")) agenticText = JSON.stringify({ goal_achieved: true, agentic_exit_code: 2, summary: "caller success outcome two", reason: "the caller-defined condition occurred after completing the task" });
  else if (prompt.includes("agentic custom two")) agenticText = JSON.stringify({ goal_achieved: false, agentic_exit_code: 2, summary: "caller outcome two", reason: "the caller-defined condition occurred" });
  else if (prompt.includes("agentic reserved thirteen")) agenticText = JSON.stringify({ goal_achieved: false, agentic_exit_code: 13, summary: "reserved", reason: "invalid test result" });
  else if (prompt.includes("agentic malformed")) agenticText = "not JSON";
  if (agenticText !== undefined) {
    const item = { id: `item-${turn.id}`, type: "agentMessage", text: agenticText };
    turn.items = [item];
    turn.status = "completed";
    send({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: agenticText } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    return;
  }
  if (prompt.includes("rich items")) {
    const reasoning = { id: `reasoning-${turn.id}`, type: "reasoning", summary: ["Inspecting the workspace"], content: ["Detailed reasoning trace"] };
    const plan = { id: `plan-${turn.id}`, type: "plan", text: "1. Inspect\n2. Verify" };
    const commandStarted = { id: `command-${turn.id}`, type: "commandExecution", command: "npm test", commandActions: [], cwd: thread.cwd, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null };
    const command = { ...commandStarted, status: "completed", aggregatedOutput: "all tests passed\n", exitCode: 0, durationMs: 42 };
    const fileChange = { id: `file-${turn.id}`, type: "fileChange", status: "completed", changes: [{ path: "README.md", kind: "update", diff: "+documented\n" }] };
    const tool = { id: `tool-${turn.id}`, type: "mcpToolCall", server: "docs", tool: "lookup", arguments: { query: "protocol" }, status: "completed", durationMs: 8, result: { content: [{ type: "text", text: "found" }] }, error: null };
    const search = { id: `search-${turn.id}`, type: "webSearch", query: "Codex app-server protocol", action: null };
    const text = `reply ${thread.turns.length}: ${prompt}`;
    const message = { id: `item-${turn.id}`, type: "agentMessage", text };
    turn.items = [reasoning, plan, command, fileChange, tool, search, message];
    turn.status = "completed";
    send({ method: "item/started", params: { threadId: thread.id, turnId: turn.id, item: commandStarted } });
    for (const item of [reasoning, plan, command, fileChange, tool, search]) send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
    send({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: turn.id, itemId: message.id, delta: text } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    return;
  }
  if (prompt.includes("mixed")) {
    const streamed = { id: `streamed-${turn.id}`, type: "agentMessage", text: "progress|" };
    const final = { id: `final-${turn.id}`, type: "agentMessage", text: "final" };
    turn.items = [streamed, final]; turn.status = "completed";
    send({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: turn.id, itemId: `different-${turn.id}`, delta: streamed.text } });
    send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    return;
  }
  const text = `reply ${thread.turns.length}: ${prompt}${decision ? ` [${decision}]` : ""}`;
  const item = { id: `item-${turn.id}`, type: "agentMessage", text };
  turn.items = [item];
  turn.status = "completed";
  send({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: text } });
  send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_CODEX_TRACE) appendFileSync(process.env.FAKE_CODEX_TRACE, `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600 });
  if (Object.hasOwn(message, "id") && !message.method) {
    const pending = approvals.get(message.id);
    if (pending) {
      approvals.delete(message.id);
      const answer = pending.kind === "user-input" ? message.result?.answers?.choice?.answers?.[0] : message.result?.decision;
      setTimeout(() => complete(pending.thread, pending.turn, pending.prompt, answer), 5);
    }
    return;
  }
  const { id, method, params = {} } = message;
  if (method === "initialize") return response(id, { userAgent: "fake-codex" });
  if (method === "model/list") return response(id, {
    data: [
      { id: "fake-default", model: "fake-default", displayName: "Fake default", description: "test model", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
      { id: "fake-fast", model: "fake-fast", displayName: "Fake fast", description: "test model", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [] },
      { id: "fake-default-duplicate", model: "fake-default", displayName: "Fake duplicate", description: "duplicate completion test model", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
    ],
    nextCursor: null,
  });
  if (method === "thread/start") {
    const thread = { id: `thread-${nextThread++}`, cwd: params.cwd, turns: [], status: { type: "idle" } };
    threads.set(thread.id, thread);
    return response(id, { thread });
  }
  if (method === "thread/resume") {
    let thread = threads.get(params.threadId);
    if (!thread && params.threadId?.startsWith("not-loaded-")) {
      thread = { id: params.threadId, cwd: params.cwd, turns: [], status: { type: "idle" } };
      threads.set(thread.id, thread);
    }
    if (!thread) return send({ jsonrpc: "2.0", id, error: { code: -32000, message: `thread not found: ${params.threadId}` } });
    return response(id, { thread });
  }
  if (method === "thread/read") {
    const thread = threads.get(params.threadId);
    if (!thread && params.threadId?.startsWith("not-loaded-")) {
      return response(id, { thread: { id: params.threadId, cwd: params.cwd, turns: [], status: { type: "notLoaded" } } });
    }
    if (!thread) return send({ jsonrpc: "2.0", id, error: { code: -32000, message: `thread not found: ${params.threadId}` } });
    const transientMetadataTurn = thread.turns.find((turn) => turn.transientMetadataReads > 0);
    if (transientMetadataTurn) {
      transientMetadataTurn.transientMetadataReads -= 1;
      return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "thread-store internal error: failed to read session metadata rollout at /tmp/fake-rollout.jsonl is empty" } });
    }
    const transientTurn = thread.turns.find((turn) => turn.transientInterruptedReads > 0);
    if (transientTurn) {
      transientTurn.transientInterruptedReads -= 1;
      return response(id, { thread: { ...thread, turns: thread.turns.map((turn) => turn === transientTurn ? { ...turn, status: "interrupted" } : turn) } });
    }
    return response(id, { thread });
  }
  if (method === "thread/list") {
    const archived = Boolean(params.archived);
    const data = [...threads.values()].filter((thread) => Boolean(thread.archived) === archived);
    return response(id, { data, nextCursor: null, backwardsCursor: null });
  }
  if (method === "turn/start") {
    const thread = threads.get(params.threadId);
    const prompt = params.input?.[0]?.text ?? "";
    if (prompt.includes("missing turn thread") && params.threadId === "thread-1") return send({ jsonrpc: "2.0", id, error: { code: -32000, message: `thread not found: ${params.threadId}` } });
    const turn = { id: `turn-${nextTurn++}`, status: "inProgress", items: prompt.includes("prompt metadata unavailable") ? [] : [{ id: `user-${nextTurn}`, type: "userMessage", content: params.input ?? [] }] };
    thread.turns.push(turn);
    response(id, { turn });
    if (prompt.includes("read image after acknowledgement")) return setTimeout(() => {
      const image = params.input?.find((item) => item.type === "localImage");
      try {
        if (!image) throw new Error("image input was missing");
        if (readFileSync(image.path).length === 0) throw new Error("image input was empty");
      } catch (error) {
        turn.status = "failed";
        turn.error = { message: `could not read image after turn/start acknowledgement: ${error.message}` };
        send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
        return;
      }
      complete(thread, turn, prompt);
    }, 25);
    if (prompt.includes("transient session metadata")) turn.transientMetadataReads = 1;
    if (prompt.includes("misclassified 401")) return setTimeout(() => {
      send({ method: "error", params: {
        threadId: thread.id,
        turnId: turn.id,
        error: {
          message: "unexpected status 401 Unauthorized from /v1/responses",
          additionalDetails: "repeating this request cannot refresh credentials",
          codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } },
        },
        willRetry: true,
      } });
    }, 5);
    if (prompt.includes("unauthenticated")) return setTimeout(() => {
      const error = {
        message: "unexpected status 401 Unauthorized from /v1/responses",
        additionalDetails: "authentication required",
        codexErrorInfo: "unauthorized",
      };
      send({ method: "error", params: { threadId: thread.id, turnId: turn.id, error, willRetry: false } });
      turn.status = "completed";
      turn.items = [];
      thread.status = { type: "systemError" };
      send({ method: "thread/status/changed", params: { threadId: thread.id, status: thread.status } });
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    }, 5);
    if (prompt.includes("retrying error")) {
      send({ method: "error", params: {
        threadId: thread.id,
        turnId: turn.id,
        error: {
          message: "temporary upstream failure",
          additionalDetails: "retrying request",
          codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
        },
        willRetry: true,
      } });
      return setTimeout(() => complete(thread, turn, prompt), 5);
    }
    if (prompt.includes("terminal notification")) return setTimeout(() => {
      send({ method: "error", params: {
        threadId: thread.id,
        turnId: turn.id,
        error: { message: "terminal notification failure", codexErrorInfo: "internalServerError" },
        willRetry: false,
      } });
      turn.status = "completed";
      turn.items = [];
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    }, 5);
    if (prompt.includes("flat terminal error")) return setTimeout(() => {
      send({ method: "error", params: {
        threadId: thread.id,
        turnId: turn.id,
        message: "flat Codex failure",
        additionalDetails: "diagnostic was not nested",
      } });
      turn.status = "completed";
      turn.items = [];
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    }, 5);
    if (prompt.includes("empty terminal error")) return setTimeout(() => {
      send({ method: "error", params: { threadId: thread.id, turnId: turn.id } });
      turn.status = "completed";
      turn.items = [];
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    }, 5);
    if (prompt.includes("crash with approval pending")) {
      const approvalId = `approval-${turn.id}`;
      approvals.set(approvalId, { thread, turn, prompt });
      return setTimeout(() => {
        send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, command: "echo pending", reason: "crash-path test" } });
        setTimeout(() => process.exit(7), 10);
      }, 5);
    }
    if (prompt.includes("crash")) return setTimeout(() => process.exit(7), 5);
    if (prompt.includes("interrupted reason")) return setTimeout(() => {
      turn.status = "interrupted";
      turn.error = { message: "simulated interruption", additionalDetails: "simulated diagnostic detail" };
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    }, 5);
    if (prompt.includes("failed turn")) return setTimeout(() => {
      turn.status = "failed";
      turn.error = { message: "simulated turn failure" };
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn } } });
    }, 5);
    if (prompt.includes("transient interrupted")) {
      turn.transientInterruptedReads = 1;
      return setTimeout(() => complete(thread, turn, prompt), 700);
    }
    if (prompt.includes("unknown request")) {
      const requestId = `unknown-${turn.id}`;
      approvals.set(requestId, { thread, turn, prompt });
      setTimeout(() => send({ id: requestId, method: "item/unknown/requestApproval", params: { threadId: thread.id, turnId: turn.id, command: "unknown" } }), 5);
    } else if (prompt.includes("approve")) {
      const approvalId = `approval-${turn.id}`;
      approvals.set(approvalId, { thread, turn, prompt });
      setTimeout(() => send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, command: "echo approved", reason: "fake test" } }), 5);
    } else if (prompt.includes("question")) {
      const requestId = `input-${turn.id}`;
      approvals.set(requestId, { kind: "user-input", thread, turn, prompt });
      setTimeout(() => send({ id: requestId, method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId: turn.id, itemId: `tool-${turn.id}`, questions: [{ id: "choice", header: "Choice", question: "Pick one", options: [{ label: "Alpha", description: "first" }, { label: "Beta", description: "second" }] }] } }), 5);
    } else setTimeout(() => complete(thread, turn, prompt), prompt.includes("slow") ? 700 : 5);
    return;
  }
  if (method === "turn/interrupt") {
    const turn = threads.get(params.threadId)?.turns.find((candidate) => candidate.id === params.turnId);
    if (turn) turn.status = "failed";
    return response(id, {});
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported fake method: ${method}` } });
});
