import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonRpcClient } from "../bin/codex-cli";

function encodeServerFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length < 126) return Buffer.concat([Buffer.from([129, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 129;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function readClientFrame(buffer) {
  if (buffer.length < 2) return;
  const lengthCode = buffer[1] & 127;
  const headerLength = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
  if (buffer.length < headerLength + 4) return;
  const payloadLength = lengthCode < 126 ? lengthCode : lengthCode === 126 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
  const frameLength = headerLength + 4 + payloadLength;
  if (buffer.length < frameLength) return;
  const mask = buffer.subarray(headerLength, headerLength + 4);
  const payload = Buffer.from(buffer.subarray(headerLength + 4, frameLength));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { message: JSON.parse(payload.toString("utf8")), rest: buffer.subarray(frameLength) };
}

function upgradeResponse(handshake) {
  const key = handshake.match(/Sec-WebSocket-Key: (.+)\r\n/i)?.[1].trim();
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
}

test("WebSocket client encodes payloads larger than 65535 bytes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli websocket "));
  const socketPath = path.join(workspace, "app.sock");
  const server = net.createServer();
  let receivedTextLength = 0;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  server.on("connection", (socket) => {
    let handshake = "";
    let frames = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (handshake !== undefined) {
        handshake += chunk.toString("binary");
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.write(upgradeResponse(handshake));
        frames = Buffer.from(handshake.slice(end + 4), "binary");
        handshake = undefined;
      } else {
        frames = Buffer.concat([frames, chunk]);
      }

      const frame = readClientFrame(frames);
      if (!frame) return;
      frames = frame.rest;
      receivedTextLength = frame.message.params.text.length;
      socket.write(encodeServerFrame({ jsonrpc: "2.0", id: frame.message.id, result: { ok: true } }));
    });
  });

  const client = new JsonRpcClient(socketPath, () => {}, () => {});
  try {
    const response = await client.request("large/payload", { text: "x".repeat(70000) });
    assert.deepEqual(response, { ok: true });
    assert.equal(receivedTextLength, 70000);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WebSocket client handles an event coalesced with the upgrade response", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli websocket coalesced "));
  const socketPath = path.join(workspace, "app.sock");
  const server = net.createServer();
  const event = { method: "server/ready", params: { ready: true } };

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  server.on("connection", (socket) => {
    let handshake = "";
    socket.once("data", (chunk) => {
      handshake += chunk.toString("binary");
      socket.write(Buffer.concat([Buffer.from(upgradeResponse(handshake), "binary"), encodeServerFrame(event)]));
    });
  });

  let received;
  const client = new JsonRpcClient(socketPath, (message) => { received = message; }, () => {});
  try {
    await client.ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, event);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WebSocket client rejects a refused upgrade", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli websocket rejected "));
  const socketPath = path.join(workspace, "app.sock");
  const server = net.createServer((socket) => socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = new JsonRpcClient(socketPath, () => {}, () => {});
  try {
    await assert.rejects(client.ready, /rejected WebSocket upgrade/);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WebSocket client rejects a pending request when the peer closes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli websocket close "));
  const socketPath = path.join(workspace, "app.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  server.on("connection", (socket) => {
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (!upgraded) {
        upgraded = true;
        socket.write(upgradeResponse(chunk.toString("binary")));
      } else {
        socket.end();
      }
    });
  });

  const client = new JsonRpcClient(socketPath, () => {}, () => {});
  try {
    await assert.rejects(client.request("never/replies", {}), /closed the WebSocket connection/);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function websocketRoundTrip(payloadSize, responseFactory = (id) => ({ jsonrpc: "2.0", id, result: { ok: true } })) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex cli websocket round trip "));
  const socketPath = path.join(workspace, "app.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  server.on("connection", (socket) => {
    let handshake = "";
    let frames = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (handshake !== undefined) {
        handshake += chunk.toString("binary");
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.write(upgradeResponse(handshake));
        frames = Buffer.from(handshake.slice(end + 4), "binary");
        handshake = undefined;
      } else frames = Buffer.concat([frames, chunk]);
      const frame = readClientFrame(frames);
      if (!frame) return;
      frames = frame.rest;
      socket.write(encodeServerFrame(responseFactory(frame.message.id)));
    });
  });
  const client = new JsonRpcClient(socketPath, () => {}, () => {});
  try {
    return await client.request("payload", { text: "x".repeat(payloadSize) });
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("WebSocket client encodes short and medium payloads", async () => {
  assert.deepEqual(await websocketRoundTrip(1), { ok: true });
  assert.deepEqual(await websocketRoundTrip(200), { ok: true });
});

test("WebSocket client surfaces JSON-RPC response errors", async () => {
  await assert.rejects(
    websocketRoundTrip(1, (id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "simulated RPC failure", data: { reason: "bad input" } } })),
    /simulated RPC failure \(JSON-RPC code -32000; data: \{\n  "reason": "bad input"\n\}\)/,
  );
});
