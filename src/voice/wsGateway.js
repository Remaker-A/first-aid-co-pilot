import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { createLiveSession } from "./liveSession.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
// Lossy audio backpressure threshold: if the socket already has more than this
// many bytes queued (slow/stalled client), new PCM audio frames are dropped
// instead of piling up unbounded. Control/JSON frames are never dropped.
const DEFAULT_MAX_AUDIO_BACKLOG_BYTES = 1024 * 1024;

export function attachVoiceWsGateway(server, options = {}) {
  const gateway = createVoiceWsGateway(options);
  server.on("upgrade", (req, socket, head) => {
    gateway.handleUpgrade(req, socket, head);
  });
  return gateway;
}

export function createVoiceWsGateway(options = {}) {
  const sessions = new Set();
  const path = options.path || "/ws/live";
  // Optional shared per-turn metrics aggregator. When provided, every session's
  // `metrics` event is folded in so /api/metrics can expose latency p50/p95,
  // TTS cache hit-rate, intent fallback mix, and safety re-check counts.
  const metricsAggregator = options.metricsAggregator || null;

  return {
    path,
    sessions,
    metricsAggregator,
    handleUpgrade(req, socket, head = Buffer.alloc(0)) {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== path) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }

      const connection = acceptWebSocket(req, socket, head, {
        maxAudioBacklogBytes: options.maxAudioBacklogBytes,
      });
      if (!connection) {
        return;
      }

      const session = createLiveSession({
        // Per-turn latency metrics are on for the live WS path so the client gets a
        // `metrics` event every turn; a caller can still force it off via sessionOptions.
        emitMetrics: true,
        ...(options.sessionOptions || {}),
        autonomousTick: true,
        tick: {
          intervalMs: 4000,
          observationWindowMs: 12000,
          wakeWindowMs: 5000,
          encourage: true,
          encouragementIntervalMs: 25000,
          encourageQuietMs: 12000,
          ...(options.sessionOptions?.tick || {}),
        },
        service: options.service,
        ttsOptions: options.ttsOptions || options.sessionOptions?.ttsOptions,
        sttOptions: options.sttOptions || options.sessionOptions?.sttOptions,
        createStreamingStt: options.createStreamingStt || options.sessionOptions?.createStreamingStt,
        disableStreamingStt: options.disableStreamingStt ?? options.sessionOptions?.disableStreamingStt,
        sessionId: url.searchParams.get("sessionId") || url.searchParams.get("session_id") || undefined,
      });
      sessions.add(session);

      session.on("json", (message) => {
        if (metricsAggregator && message?.type === "metrics") {
          metricsAggregator.record(message);
        }
        connection.sendJson(message);
      });
      session.on("audio", (chunk) => connection.sendBinary(chunk));
      connection.on("text", async (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          connection.sendJson({
            type: "error",
            error: { message: "Expected JSON text frame.", code: "bad_json_frame" },
          });
          return;
        }
        await session.handleControl(message);
      });
      connection.on("binary", (chunk) => session.handlePcm(chunk));
      connection.on("close", () => {
        sessions.delete(session);
        session.close();
      });
      connection.on("error", (error) => {
        session.emitError(error?.message || "WebSocket error.", error?.code || "websocket_error");
      });

      session.start({
        sessionId: url.searchParams.get("sessionId") || url.searchParams.get("session_id") || undefined,
      });
    },
  };
}

export class MiniWebSocketConnection extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), options = {}) {
    super();
    this.socket = socket;
    this.buffer = Buffer.from(head || Buffer.alloc(0));
    this.closed = false;
    this.maxAudioBacklogBytes = numberOrDefault(
      options.maxAudioBacklogBytes,
      DEFAULT_MAX_AUDIO_BACKLOG_BYTES
    );
    this.droppedAudioFrames = 0;
    this.droppedAudioBytes = 0;

    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => this.closeLocal());
    if (this.buffer.length) {
      queueMicrotask(() => this.parseFrames());
    }
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  sendBinary(bytes) {
    // Lossy backpressure for audio only: a slow/stalled client must not let PCM
    // frames pile up unbounded in the socket write buffer. Time-sensitive audio
    // is shed once the socket is backlogged past the threshold; control/JSON
    // frames go through sendText and are never dropped here.
    if (this.closed || this.socket.destroyed) {
      return;
    }
    const backlog = Number(this.socket.writableLength) || 0;
    if (backlog > this.maxAudioBacklogBytes) {
      this.droppedAudioFrames += 1;
      this.droppedAudioBytes += bytes?.length || 0;
      return;
    }
    this.sendFrame(0x2, Buffer.from(bytes));
  }

  close(code = 1000, reason = "") {
    if (this.closed) {
      return;
    }
    const reasonBytes = Buffer.from(String(reason), "utf8");
    const payload = Buffer.alloc(Math.min(123, 2 + reasonBytes.length));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.length - 2);
    this.sendFrame(0x8, payload);
    this.closed = true;
    this.socket.end();
  }

  handleData(chunk) {
    if (this.closed) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  parseFrames() {
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (!fin) {
        this.protocolError("Fragmented WebSocket frames are not supported.");
        return;
      }

      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.protocolError("WebSocket frame is too large.");
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      if (!masked) {
        this.protocolError("Client WebSocket frames must be masked.");
        return;
      }
      if (length > MAX_FRAME_BYTES) {
        this.protocolError("WebSocket frame exceeds maximum size.");
        return;
      }
      if (this.buffer.length < offset + 4 + length) {
        return;
      }

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      unmask(payload, mask);
      this.dispatchFrame(opcode, payload);
    }
  }

  dispatchFrame(opcode, payload) {
    switch (opcode) {
      case 0x1:
        this.emit("text", payload.toString("utf8"));
        break;
      case 0x2:
        this.emit("binary", payload);
        break;
      case 0x8:
        this.closeLocal();
        this.socket.end();
        break;
      case 0x9:
        this.sendFrame(0xA, payload);
        break;
      case 0xA:
        break;
      default:
        this.protocolError(`Unsupported WebSocket opcode: ${opcode}`);
        break;
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) {
      return;
    }

    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    this.socket.write(Buffer.concat([header, payload]));
  }

  protocolError(message) {
    const error = new Error(message);
    error.code = "websocket_protocol_error";
    this.emit("error", error);
    this.close(1002, "protocol error");
  }

  closeLocal() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }
}

function acceptWebSocket(req, socket, head, options = {}) {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || !key.trim()) {
    rejectUpgrade(socket, 400, "Bad Request");
    return null;
  }

  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n")
  );

  return new MiniWebSocketConnection(socket, head, options);
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${message}`,
      "Connection: close",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n")
  );
  socket.destroy();
}

function unmask(payload, mask) {
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] ^= mask[i % 4];
  }
}

function numberOrDefault(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}
