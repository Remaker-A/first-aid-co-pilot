import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MiniWebSocketConnection } from "../src/voice/wsGateway.js";

function makeFakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writableLength = 0;
  socket.writes = [];
  socket.write = (buf) => {
    socket.writes.push(buf);
    return true;
  };
  socket.end = () => {
    socket.destroyed = true;
  };
  return socket;
}

test("audio frames are dropped under socket write backlog and counted", () => {
  const socket = makeFakeSocket();
  const conn = new MiniWebSocketConnection(socket, Buffer.alloc(0), { maxAudioBacklogBytes: 1000 });
  const baseline = socket.writes.length;

  // Healthy socket: audio frame is written normally.
  conn.sendBinary(Buffer.alloc(100));
  assert.equal(socket.writes.length, baseline + 1);
  assert.equal(conn.droppedAudioFrames, 0);

  // Backlogged socket: audio frame is shed (not written) and tallied.
  socket.writableLength = 5000;
  conn.sendBinary(Buffer.alloc(100));
  assert.equal(socket.writes.length, baseline + 1, "audio must not be written under backlog");
  assert.equal(conn.droppedAudioFrames, 1);
  assert.equal(conn.droppedAudioBytes, 100);
});

test("control/JSON frames bypass audio backpressure", () => {
  const socket = makeFakeSocket();
  const conn = new MiniWebSocketConnection(socket, Buffer.alloc(0), { maxAudioBacklogBytes: 1000 });
  socket.writableLength = 999999; // heavily backlogged

  const before = socket.writes.length;
  conn.sendJson({ type: "state", status: "connected" });
  assert.ok(socket.writes.length > before, "JSON control frame must always be sent");
  assert.equal(conn.droppedAudioFrames, 0);
});

test("default backlog threshold applies when unspecified", () => {
  const socket = makeFakeSocket();
  const conn = new MiniWebSocketConnection(socket, Buffer.alloc(0));
  assert.ok(conn.maxAudioBacklogBytes > 0);
  // Just under the 1MB default still writes the audio frame.
  socket.writableLength = 1024 * 1024 - 1;
  conn.sendBinary(Buffer.alloc(10));
  assert.equal(conn.droppedAudioFrames, 0);
  assert.equal(socket.writes.length, 1);
});
