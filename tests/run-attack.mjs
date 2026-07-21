import { spawn } from "node:child_process";

const files = [
  "tests/attack.test.mjs",
  "tests/cli.test.mjs",
  "tests/config.test.mjs",
  "tests/image-attachments.test.mjs",
  "tests/prompt-attachment-actions.test.mjs",
  "tests/broker.test.mjs",
  "tests/socket-cli.test.mjs",
  "tests/websocket.test.mjs",
  "tests/output.test.mjs",
];

const names = [
  "state persistence does not follow a predictable temporary-file symlink",
  "subprocess capture bounds stdout and stderr before they can exhaust memory",
  "CLI rejects invalid options and incompatible modes",
  "CLI reports invalid state and configuration files",
  "Windows directs users away from the unavailable managed Unix socket",
  "Windows broker configuration requires a named pipe",
  "agentic error-code mode maps validated outcomes and preserves system failures",
  "direct mode covers approvals, JSON requests, failures, and timeouts",
  "layered client configuration resolves files, environment, and CLI precedence",
  "configuration errors stop before Codex starts",
  "auto-discovered risky configuration warns only while it wins on a new thread",
  "image validation fails locally and rejects no-turn modes",
  "clipboard image action survives asynchronous app-server loading and is removed at client or broker exit",
  "prompt actions fail closed before broker, app-server, or clipboard access",
  "broker startup removes stale clipboard action files",
  "broker cleans up after app-server crash and can restart",
  "broker automatically recovers an implicit vanished saved thread",
  "broker resumes an explicit not-loaded thread by id",
  "broker waits out a transient interrupted thread read",
  "broker retries a transient empty session metadata read",
  "broker forwards Codex errors and fails on thread systemError",
  "broker start never deletes a non-socket path",
  "broker rejects malformed and incompatible protocol messages",
  "socket mode creates, saves, and resumes a managed app-server thread",
  "socket mode attaches verified local images to the same user turn",
  "socket mode resolves clipboard prompt actions into ordered input items",
  "socket mode surfaces thread system errors even when the turn says completed",
  "socket mode applies the agentic result contract",
  "socket mode rejects approval automation when the app-server forbids it",
  "socket mode resumes an explicit not-loaded thread by id",
  "socket mode reports and interrupts active turns on saved threads",
  "WebSocket client encodes payloads larger than 65535 bytes",
  "WebSocket client handles an event coalesced with the upgrade response",
  "WebSocket client rejects a refused upgrade",
  "WebSocket client rejects a pending request when the peer closes",
  "WebSocket client encodes short and medium payloads",
  "WebSocket client surfaces JSON-RPC response errors",
  "agentic result contract is injected and strictly validated",
  "Codex errors classify retryable failures and veto definitive retries",
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namePattern = `^(?:${names.map(escapeRegex).join("|")})$`;
const child = spawn(process.execPath, ["--test", `--test-name-pattern=${namePattern}`, ...files], { stdio: "inherit" });

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (result.signal) throw new Error(`attack test runner stopped by ${result.signal}`);
process.exitCode = result.code ?? 1;
