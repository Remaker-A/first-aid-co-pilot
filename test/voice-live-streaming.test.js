import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StreamingTtsDaemon,
  createLiveSession,
  createLiveTts,
  createStreamingTts,
  createVoiceServer,
  encodePcm16Wav,
  splitTextIntoClauses,
} from "../src/index.js";

async function writeFakeTtsDaemon(emitEnd) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-streaming-tts-"));
  const fixturePath = path.join(tmpDir, "fake-streaming-tts.cjs");
  const endLine = emitEnd
    ? 'process.stdout.write(JSON.stringify({ type: "audio_end", id: req.id, cancelled: false }) + "\\n");\n'
    : "";
  const fixtureSource =
    'process.stdout.write(JSON.stringify({ type: "ready", sample_rate: 22050 }) + "\\n");\n' +
    'let buffer = "";\n' +
    'process.stdin.setEncoding("utf8");\n' +
    'process.stdin.on("data", (chunk) => {\n' +
    '  buffer += chunk;\n' +
    '  let nl = buffer.indexOf("\\n");\n' +
    '  while (nl >= 0) {\n' +
    '    const line = buffer.slice(0, nl).trim();\n' +
    '    buffer = buffer.slice(nl + 1);\n' +
    '    if (line) {\n' +
    '      const req = JSON.parse(line);\n' +
    '      const data = Buffer.from([1, 0, 2, 0]).toString("base64");\n' +
    '      if (req.type === "speak") {\n' +
    '        process.stdout.write(JSON.stringify({ type: "audio_begin", id: req.id, sample_rate: 22050 }) + "\\n");\n' +
    '        process.stdout.write(JSON.stringify({ type: "audio", id: req.id, sample_rate: 22050, samples: 2, data }) + "\\n");\n' +
    (emitEnd
      ? '        process.stdout.write(JSON.stringify({ type: "audio", id: req.id, sample_rate: 22050, samples: 2, data }) + "\\n");\n'
      : "") +
    '        ' + endLine +
    '      } else if (req.type === "cancel") {\n' +
    '        process.stdout.write(JSON.stringify({ type: "cancelled", id: req.id }) + "\\n");\n' +
    '      }\n' +
    '    }\n' +
    '    nl = buffer.indexOf("\\n");\n' +
    '  }\n' +
    '});\n';
  await fs.writeFile(fixturePath, fixtureSource, "utf8");
  return { tmpDir, fixturePath };
}

function createFakeStt() {
  const stt = new EventEmitter();
  stt.fed = [];
  stt.ended = 0;
  stt.feed = (buffer) => {
    stt.fed.push(buffer);
    return true;
  };
  stt.end = () => {
    stt.ended += 1;
    return true;
  };
  stt.reset = () => {};
  stt.stop = () => {};
  stt.waitUntilReady = async () => stt;
  return stt;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("streaming TTS splits clauses and yields PCM chunks", async () => {
  const spoken = [];
  const tts = createStreamingTts({
    chunkBytes: 4,
    synthesize: async (text) => {
      spoken.push(text);
      return {
        provider: "fake",
        audio: {
          data_url: `data:audio/wav;base64,${encodePcm16Wav(Buffer.from([1, 2, 3, 4, 5, 6])).toString("base64")}`,
        },
      };
    },
  });

  const chunks = [];
  for await (const item of tts.speak("继续按压。AED 来了怎么办？")) {
    chunks.push(item);
  }

  assert.deepEqual(spoken, ["继续按压。", "AED 来了怎么办？"]);
  assert.equal(chunks.length, 4);
  assert.deepEqual([...chunks[0].chunk], [1, 2, 3, 4]);
  assert.equal(chunks[0].sampleRate, 16000);
  assert.equal(chunks[0].bitsPerSample, 16);
});

test("streaming TTS cancellation stops the active iterator", async () => {
  const tts = createStreamingTts({
    chunkBytes: 2,
    synthesize: async () => ({
      provider: "fake",
      audio: {
        data_url: `data:audio/wav;base64,${encodePcm16Wav(Buffer.from([1, 2, 3, 4])).toString("base64")}`,
      },
    }),
  });

  const iterator = tts.speak("第一句。第二句。");
  assert.equal((await iterator.next()).done, false);
  tts.cancel("test_cancel");
  await assert.rejects(() => iterator.next(), /test_cancel/);
});

test("splitTextIntoClauses breaks long text without dropping content", () => {
  const text = "现在继续胸外按压，跟着节拍保持 100 到 120 次每分钟；我会继续看位置和节奏。";
  const clauses = splitTextIntoClauses(text, { maxClauseChars: 18 });
  assert.ok(clauses.length > 2);
  assert.equal(clauses.join(""), text.replace(/\s+/g, " "));
});

test("live session emits final, guidance, state, and streaming audio", async () => {
  const session = createLiveSession({
    sessionId: "sess_live_test",
    service: {
      async handleTurn(input) {
        assert.equal(input.sessionId, "sess_live_test");
        assert.equal(input.text, "现场安全了");
        return {
          ok: true,
          transcript: input.text,
          stt: { intent: "scene_safe" },
          state: { current_stage: "S2_CHECK_RESPONSE" },
          guidance_source: "state_machine",
          response_type: "flow_instruction",
          guidance_action: {
            action_id: "act_live_test",
            tts: { text: "请大声叫他，并轻拍双肩。" },
          },
        };
      },
      reset() {
        return { ok: true };
      },
    },
    tts: {
      cancel() {},
      async *speak(text) {
        assert.match(text, /轻拍双肩/);
        yield {
          chunk: Buffer.from([7, 8]),
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
        };
      },
    },
  });
  const jsonEvents = [];
  const audioEvents = [];
  session.on("json", (event) => jsonEvents.push(event));
  session.on("audio", (chunk) => audioEvents.push(chunk));

  await session.handleControl({ type: "final", text: "现场安全了" });

  assert.deepEqual(
    jsonEvents.map((event) => event.type),
    ["thinking", "final", "guidance", "state", "audio_begin", "audio_end"]
  );
  assert.equal(jsonEvents.find((event) => event.type === "final").intent, "scene_safe");
  assert.equal(jsonEvents.find((event) => event.type === "guidance").action.action_id, "act_live_test");
  assert.equal(audioEvents.length, 1);
  assert.deepEqual([...audioEvents[0]], [7, 8]);
});

test("live session accepts Android turn control frames", async () => {
  let capturedInput = null;
  const session = createLiveSession({
    sessionId: "sess_android_turn",
    service: {
      async createGuidance(input) {
        capturedInput = input;
        return {
          stt: { transcript: input.text, intent: "scene_safe" },
          pipeline: { state: { current_stage: "S2_CHECK_RESPONSE" } },
          guidanceDecision: { source: "state_machine", responseType: "flow_instruction" },
          guidanceAction: {
            action_id: "act_android_turn",
            tts: { text: "请检查反应。" },
          },
        };
      },
      reset() {},
    },
    tts: {
      cancel() {},
      async *speak() {},
    },
  });
  const jsonEvents = [];
  session.on("json", (event) => jsonEvents.push(event));

  await session.handleControl({
    type: "turn",
    payload: {
      text: "现场安全了",
      eventSource: "demo_script",
      eventType: "session_started",
    },
  });

  assert.equal(capturedInput.sessionId, "sess_android_turn");
  assert.equal(capturedInput.text, "现场安全了");
  assert.equal(capturedInput.eventSource, "demo_script");
  assert.equal(jsonEvents.find((event) => event.type === "guidance")?.action.action_id, "act_android_turn");
  assert.equal(jsonEvents.some((event) => event.error?.code === "bad_control_type"), false);

  session.close();
});

test("live session emits audio_unavailable when TTS produces no chunks", async () => {
  const session = createLiveSession({
    sessionId: "sess_empty_tts",
    service: {
      async createGuidance() {
        return {
          stt: { transcript: "continue", intent: "continue_cpr" },
          guidanceAction: {
            action_id: "act_empty_tts",
            tts: { text: "continue compressions" },
          },
        };
      },
      reset() {},
    },
    tts: {
      cancel() {},
      async *speak() {},
    },
  });
  const jsonEvents = [];
  session.on("json", (event) => jsonEvents.push(event));

  await session.handleControl({ type: "commit_text", text: "continue" });

  const unavailable = jsonEvents.find((event) => event.type === "audio_unavailable");
  assert.equal(unavailable?.action_id, "act_empty_tts");
  assert.equal(unavailable?.reason, "tts_stream_empty");
  assert.equal(jsonEvents.some((event) => event.type === "audio_begin"), false);

  session.close();
});

test("live session feeds PCM to streaming STT and commits partial/final turns", async () => {
  const fakeStt = createFakeStt();
  let captured = null;
  const session = createLiveSession({
    sessionId: "sess_stream",
    createStreamingStt: () => fakeStt,
    service: {
      async createGuidance(input) {
        captured = input;
        return {
          stt: { transcript: input.text, intent: "scene_safe" },
          pipeline: { state: { current_stage: "S2_CHECK_RESPONSE" } },
          guidanceDecision: { source: "rule_fast_path", responseType: "flow_instruction" },
          guidanceAction: { action_id: "act_stream", tts: { text: "请检查反应。" } },
        };
      },
      reset() {},
    },
    tts: {
      cancel() {},
      async *speak() {
        yield { chunk: Buffer.from([1, 2]), sampleRate: 22050, channels: 1, bitsPerSample: 16 };
      },
    },
  });

  const jsonEvents = [];
  session.on("json", (event) => jsonEvents.push(event));

  await session.handleControl({ type: "context", payload: { eventSource: "vision_patient" } });

  session.handlePcm(Buffer.from([0, 0, 0, 0]));
  await tick();
  session.handlePcm(Buffer.from([1, 1, 1, 1]));
  assert.equal(fakeStt.fed.length, 1);
  assert.equal(session.sttMode, "streaming");

  fakeStt.emit("partial", { text: "请检查" });
  assert.equal(jsonEvents.find((event) => event.type === "partial")?.text, "请检查");

  fakeStt.emit("final", { text: "现场安全了", intent: "scene_safe" });
  await tick();

  const types = jsonEvents.map((event) => event.type);
  assert.ok(types.includes("final"));
  assert.ok(types.includes("guidance"));
  assert.ok(types.includes("audio_begin"));
  assert.equal(captured.eventSource, "vision_patient");
  assert.equal(captured.text, "现场安全了");
  assert.equal(jsonEvents.find((event) => event.type === "guidance").source, "rule_fast_path");
  assert.equal(jsonEvents.find((event) => event.type === "audio_begin").sample_rate, 22050);

  session.close();
});

test("live session orders partial, final, guidance, and audio frames", async () => {
  const fakeStt = createFakeStt();
  const sequence = [];
  const session = createLiveSession({
    sessionId: "sess_live_order",
    createStreamingStt: () => fakeStt,
    service: {
      async createGuidance(input) {
        assert.equal(input.sessionId, "sess_live_order");
        assert.equal(input.text, "scene is safe");
        return {
          stt: { transcript: input.text, intent: "scene_safe" },
          guidanceDecision: { source: "rule_fast_path", responseType: "flow_instruction" },
          guidanceAction: {
            action_id: "act_live_order",
            tts: { text: "check response" },
          },
        };
      },
      reset() {},
    },
    tts: {
      cancel() {},
      async *speak(text) {
        assert.equal(text, "check response");
        yield {
          chunk: Buffer.from([3, 4]),
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
        };
      },
    },
  });

  const done = new Promise((resolve) => {
    session.on("json", (event) => {
      if (["partial", "final", "guidance", "audio_begin", "audio_end"].includes(event.type)) {
        sequence.push(event.type);
      }
      if (event.type === "audio_end") {
        resolve();
      }
    });
    session.on("audio", (chunk, metadata) => {
      sequence.push("audio_chunk");
      assert.deepEqual([...chunk], [3, 4]);
      assert.equal(metadata.action_id, "act_live_order");
      assert.equal(metadata.sample_rate, 16000);
    });
  });

  session.handlePcm(Buffer.from([0, 0, 0, 0]));
  await tick();
  fakeStt.emit("partial", { text: "scene" });
  fakeStt.emit("final", { text: "scene is safe", intent: "scene_safe" });

  await done;

  assert.deepEqual(sequence, [
    "partial",
    "final",
    "guidance",
    "audio_begin",
    "audio_chunk",
    "audio_end",
  ]);

  session.close();
});

test("live session commits buffered audio when streaming STT is unavailable", async () => {
  let turnInput = null;
  const session = createLiveSession({
    sessionId: "sess_buffered",
    disableStreamingStt: true,
    service: {
      async createGuidance(input) {
        turnInput = input;
        return {
          stt: { transcript: "buffered transcript", intent: null },
          pipeline: { state: { current_stage: "S1_SCENE_SAFETY" } },
          guidanceDecision: { source: "state_machine", responseType: "flow_instruction" },
          guidanceAction: { action_id: "act_buf", tts: { text: "确认现场安全。" } },
        };
      },
      reset() {},
    },
    tts: {
      cancel() {},
      async *speak() {
        yield { chunk: Buffer.from([9, 9]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
      },
    },
  });

  const jsonEvents = [];
  session.on("json", (event) => jsonEvents.push(event));

  session.handlePcm(Buffer.from([5, 0, 6, 0]));
  assert.equal(session.sttMode, "buffered");

  await session.handleControl({ type: "commit" });

  assert.ok(turnInput.audioBase64, "buffered commit should forward WAV audio");
  assert.equal(turnInput.mimeType, "audio/wav");
  assert.ok(jsonEvents.some((event) => event.type === "guidance"));
});

test("createLiveTts returns the in-process streamer unless the daemon is opted in", () => {
  const inProcess = createLiveTts({ useDaemon: false });
  assert.equal(inProcess.constructor.name, "StreamingTts");
  const daemon = createLiveTts({ useDaemon: true, modelDir: os.tmpdir() });
  assert.equal(daemon.constructor.name, "StreamingTtsDaemon");
  daemon.stop();
});

test("streaming TTS daemon yields PCM chunks from the sherpa stream", async () => {
  const { tmpDir, fixturePath } = await writeFakeTtsDaemon(true);
  const tts = new StreamingTtsDaemon({
    python: process.execPath,
    script: fixturePath,
    modelDir: tmpDir,
    readyTimeoutMs: 2000,
  });

  try {
    const chunks = [];
    for await (const item of tts.speak("继续按压。")) {
      chunks.push(item);
    }
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].sampleRate, 22050);
    assert.equal(chunks[0].bitsPerSample, 16);
    assert.deepEqual([...chunks[0].chunk], [1, 0, 2, 0]);
  } finally {
    tts.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("streaming TTS daemon cancellation ends the active iterator", async () => {
  const { tmpDir, fixturePath } = await writeFakeTtsDaemon(false);
  const tts = new StreamingTtsDaemon({
    python: process.execPath,
    script: fixturePath,
    modelDir: tmpDir,
    readyTimeoutMs: 2000,
  });

  try {
    const iterator = tts.speak("第一句。第二句。");
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.deepEqual([...first.value.chunk], [1, 0, 2, 0]);
    tts.cancel("barge_in");
    const next = await iterator.next();
    assert.equal(next.done, true);
  } finally {
    tts.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("voice server mounts the live WebSocket upgrade gateway", () => {
  const server = createVoiceServer({
    service: {
      async handleTurn() {
        return { ok: true };
      },
      reset() {
        return { ok: true };
      },
    },
  });
  assert.equal(server.listenerCount("upgrade"), 1);
  server.close();
});
