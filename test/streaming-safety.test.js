import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createLiveSession } from "../src/index.js";
import { breathingPolarity } from "../src/voice/liveSession.js";
import { createSttReconnectPolicy } from "../src/voice/sttReconnect.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// A fake streaming-STT session that becomes ready, then can be told to "die"
// via emit("exit"). Mirrors the EventEmitter contract LiveSession relies on.
function makeReadyFakeStt() {
  const stt = new EventEmitter();
  stt.fed = [];
  stt.feed = (buffer) => {
    stt.fed.push(buffer);
    return true;
  };
  stt.end = () => true;
  stt.reset = () => {};
  stt.stop = () => {};
  stt.waitUntilReady = async () => stt;
  return stt;
}

// A fake that never becomes ready and crashes shortly after start, simulating a
// recognizer stuck in a crash loop (exits before ready).
function makeCrashFakeStt() {
  const stt = new EventEmitter();
  stt.feed = () => true;
  stt.end = () => true;
  stt.reset = () => {};
  stt.stop = () => {};
  stt.waitUntilReady = () => new Promise(() => {});
  // Listeners are attached synchronously after the factory returns, so defer
  // the crash to a microtask.
  queueMicrotask(() => stt.emit("exit", { exitCode: 1 }));
  return stt;
}

function silentTts() {
  return {
    cancel() {},
    async *speak() {},
  };
}

function makeLoudPcm(sampleRate, seconds) {
  const sampleCount = Math.floor(sampleRate * seconds);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer.writeInt16LE(i % 2 === 0 ? 24000 : -24000, i * 2);
  }
  return buffer;
}

test("streaming STT auto-reconnects to streaming after a process exit", async () => {
  const created = [];
  const session = createLiveSession({
    sessionId: "sess_reconnect",
    createStreamingStt: () => {
      const stt = makeReadyFakeStt();
      created.push(stt);
      return stt;
    },
    sttMaxRestarts: 2,
    service: {
      async createGuidance() {
        return {};
      },
      reset() {},
    },
    tts: silentTts(),
  });

  const states = [];
  session.on("json", (event) => {
    if (event.type === "state") {
      states.push(event);
    }
  });

  session.handlePcm(Buffer.from([0, 0, 0, 0]));
  await tick();
  assert.equal(created.length, 1);
  assert.equal(session.sttMode, "streaming");

  // The recognizer process dies after having been ready.
  created[0].emit("exit", { exitCode: 137 });
  await tick();

  // A fresh recognizer was spawned and recovered low-latency streaming.
  assert.equal(created.length, 2);
  assert.equal(session.sttMode, "streaming");
  assert.ok(states.some((s) => s.stt_mode === "reconnecting"));
  assert.equal(states.at(-1).stt_mode, "streaming");

  session.close();
});

test("streaming STT degrades to buffered after exceeding the restart budget", async () => {
  const created = [];
  const session = createLiveSession({
    sessionId: "sess_crashloop",
    createStreamingStt: () => {
      const stt = makeCrashFakeStt();
      created.push(stt);
      return stt;
    },
    sttMaxRestarts: 2,
    service: {
      async createGuidance() {
        return {};
      },
      reset() {},
    },
    tts: silentTts(),
  });

  const states = [];
  session.on("json", (event) => {
    if (event.type === "state") {
      states.push(event);
    }
  });

  session.handlePcm(Buffer.from([0, 0, 0, 0]));
  await tick();
  await tick();

  // Initial attempt + exactly 2 restarts, then it gives up.
  assert.equal(created.length, 3);
  assert.equal(session.sttMode, "buffered");
  assert.equal(states.filter((s) => s.stt_mode === "reconnecting").length, 2);
  assert.equal(states.at(-1).stt_mode, "buffered");
  assert.ok(states.at(-1).stt_fallback_reason);

  session.close();
});

test("commit after the restart budget is exhausted uses the buffered audio path", async () => {
  let turnInput = null;
  const session = createLiveSession({
    sessionId: "sess_crashloop_commit",
    createStreamingStt: () => makeCrashFakeStt(),
    sttMaxRestarts: 1,
    service: {
      async createGuidance(input) {
        turnInput = input;
        return {
          stt: { transcript: "buffered transcript", intent: null },
          guidanceAction: { action_id: "act_buf", tts: { text: "确认现场安全。" } },
        };
      },
      reset() {},
    },
    tts: silentTts(),
  });

  session.handlePcm(Buffer.from([5, 0, 6, 0]));
  await tick();
  await tick();
  assert.equal(session.sttMode, "buffered");

  await session.handleControl({ type: "commit" });
  assert.ok(turnInput?.audioBase64, "buffered commit should forward WAV audio after STT gives up");
  assert.equal(turnInput.mimeType, "audio/wav");

  session.close();
});

test("explicit barge_in during playback cancels speech and flushes audio", async () => {
  let cancelReason = null;
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });

  const session = createLiveSession({
    sessionId: "sess_barge",
    disableStreamingStt: true,
    service: {
      async createGuidance() {
        return { guidanceAction: { action_id: "act_b", tts: { text: "继续按压。" } } };
      },
      reset() {},
    },
    tts: {
      cancel(reason) {
        cancelReason = reason;
      },
      async *speak() {
        yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
        await hold; // keep playback "open" until we decide to release it
        yield { chunk: Buffer.from([9, 9]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
      },
    },
  });

  const jsonEvents = [];
  const audioEvents = [];
  session.on("json", (event) => jsonEvents.push(event));
  session.on("audio", (chunk) => audioEvents.push(chunk));

  const turnPromise = session.processTurn({ text: "现在怎么办" });
  await tick();
  assert.equal(session.speaking, true, "session should be mid-playback");

  await session.handleControl({ type: "barge_in" });
  assert.equal(session.speaking, false, "barge_in must stop playback");
  assert.equal(cancelReason, "client_barge_in");
  const cancelEvent = jsonEvents.find((e) => e.type === "audio_cancel");
  assert.ok(cancelEvent, "audio_cancel should be emitted");
  assert.equal(cancelEvent.reason, "client_barge_in");

  releaseHold();
  await turnPromise;
  assert.equal(audioEvents.length, 1, "stale audio chunks after barge_in must be suppressed");
  assert.equal(
    jsonEvents.some((event) => event.type === "audio_end"),
    false,
    "cancelled speech must not emit audio_end"
  );
  session.close();
});

test("new user turn cancels in-flight speech and suppresses stale audio", async () => {
  const cancelReasons = [];
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const session = createLiveSession({
    sessionId: "sess_new_turn_cancel",
    disableStreamingStt: true,
    service: {
      async createGuidance(input) {
        const isSecond = input.text === "second";
        return {
          stt: { transcript: input.text, intent: null },
          guidanceAction: {
            action_id: isSecond ? "act_second" : "act_first",
            tts: { text: isSecond ? "second prompt" : "first prompt" },
          },
        };
      },
      reset() {},
    },
    tts: {
      cancel(reason) {
        cancelReasons.push(reason);
      },
      async *speak(text) {
        if (text === "first prompt") {
          yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
          await holdFirst;
          yield { chunk: Buffer.from([9, 9]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
          return;
        }
        yield { chunk: Buffer.from([2, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
      },
    },
  });

  const sequence = [];
  const secondFinished = new Promise((resolve) => {
    session.on("json", (event) => {
      if (["guidance", "audio_begin", "audio_end"].includes(event.type)) {
        const actionId = event.action_id || event.action?.action_id;
        sequence.push(`${event.type}:${actionId}`);
      }
      if (event.type === "audio_end" && event.action_id === "act_second") {
        resolve();
      }
    });
    session.on("audio", (chunk, metadata) => {
      sequence.push(`audio_chunk:${metadata.action_id}:${[...chunk].join(",")}`);
    });
  });

  const firstTurn = session.processTurn({ text: "first" });
  await tick();
  assert.equal(session.speaking, true, "first prompt should be mid-playback");

  const secondTurn = session.processTurn({ text: "second" });
  await secondFinished;

  assert.ok(cancelReasons.includes("new_turn"));

  releaseFirst();
  await firstTurn;
  await secondTurn;

  assert.ok(sequence.includes("audio_end:act_second"));
  assert.equal(
    sequence.some((event) => event.startsWith("audio_end:act_first")),
    false,
    "superseded first turn must not emit audio_end"
  );
  assert.equal(
    sequence.some((event) => event === "audio_chunk:act_first:9,9"),
    false,
    "late first-turn audio must not be flushed after the new turn"
  );

  session.close();
});

test("energy gate triggers a barge-in when loud speech overlaps playback", async () => {
  let cancelReason = null;
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });

  const session = createLiveSession({
    sessionId: "sess_energy",
    disableStreamingStt: true,
    bargeIn: { energyGate: true, rmsThreshold: 0.1, minSpeechMs: 20 },
    service: {
      async createGuidance() {
        return { guidanceAction: { action_id: "act_e", tts: { text: "继续按压。" } } };
      },
      reset() {},
    },
    tts: {
      cancel(reason) {
        cancelReason = reason;
      },
      async *speak() {
        yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
        await hold;
      },
    },
  });

  const jsonEvents = [];
  session.on("json", (event) => jsonEvents.push(event));

  const turnPromise = session.processTurn({ text: "现在怎么办" });
  await tick();
  assert.equal(session.speaking, true);

  // Quiet echo first: must NOT trigger a barge-in.
  session.handlePcm(Buffer.alloc(640));
  assert.equal(session.speaking, true, "quiet echo should not interrupt playback");

  // Sustained loud speech over the prompt: should interrupt.
  session.handlePcm(makeLoudPcm(16000, 0.1));
  assert.equal(session.speaking, false, "loud overlapping speech should stop playback");
  assert.equal(cancelReason, "energy_barge_in");
  const cancelEvent = jsonEvents.find((e) => e.type === "audio_cancel");
  assert.ok(cancelEvent);
  assert.equal(cancelEvent.reason, "energy_barge_in");

  releaseHold();
  await turnPromise;
  session.close();
});

test("streaming STT final emitted during assistant playback is ignored", async () => {
  const fakeStt = makeReadyFakeStt();
  let serviceCalls = 0;
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const session = createLiveSession({
    sessionId: "sess_drop_speaking_final",
    createStreamingStt: () => fakeStt,
    service: {
      async createGuidance(input) {
        serviceCalls += 1;
        return {
          stt: { transcript: input.text, intent: input.intent },
          guidanceAction: { action_id: "act_speaking", tts: { text: "first prompt" } },
        };
      },
      reset() {},
    },
    tts: {
      cancel() {},
      async *speak() {
        yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
        await hold;
      },
    },
  });
  const ignored = [];
  session.on("json", (event) => {
    if (event.type === "asr_ignored") ignored.push(event);
  });

  session.handlePcm(Buffer.from([0, 1, 0, 1]));
  await tick();
  const firstTurn = session.processTurn({ text: "first" });
  await tick();
  assert.equal(session.speaking, true);

  fakeStt.emit("final", { text: "没有呼吸", intent: "no_normal_breathing" });
  await tick();

  assert.equal(serviceCalls, 1, "echo final during playback must not start another turn");
  assert.equal(ignored.at(-1)?.reason, "assistant_speaking");

  releaseHold();
  await firstTurn;
  session.close();
});

test("streaming STT duplicate final inside the short window is ignored", async () => {
  const fakeStt = makeReadyFakeStt();
  const captured = [];
  const session = createLiveSession({
    sessionId: "sess_drop_duplicate_final",
    createStreamingStt: () => fakeStt,
    service: {
      async createGuidance(input) {
        captured.push(input.text);
        return {
          stt: { transcript: input.text, intent: input.intent },
          guidanceAction: { action_id: `act_${captured.length}`, tts: { text: "ok" } },
        };
      },
      reset() {},
    },
    tts: silentTts(),
  });
  const ignored = [];
  session.on("json", (event) => {
    if (event.type === "asr_ignored") ignored.push(event);
  });

  session.handlePcm(Buffer.from([0, 1, 0, 1]));
  await tick();
  fakeStt.emit("final", { text: "没有呼吸", intent: "no_normal_breathing" });
  await tick();
  fakeStt.emit("final", { text: "没有 呼吸。", intent: "no_normal_breathing" });
  await tick();

  assert.deepEqual(captured, ["没有呼吸"]);
  assert.equal(ignored.at(-1)?.reason, "duplicate_final");

  session.close();
});

test("critical breathing final is re-checked offline and corrected", async () => {
  const reviewCalls = [];
  const fakeStt = makeReadyFakeStt();
  const session = createLiveSession({
    sessionId: "sess_review",
    createStreamingStt: () => fakeStt,
    reviewFinal: async ({ text, audioBase64 }) => {
      reviewCalls.push({ text, hasAudio: Boolean(audioBase64) });
      return { transcript: "没有呼吸" }; // offline engine corrects the mishear
    },
    service: {
      async createGuidance(input) {
        return {
          stt: { transcript: input.text, intent: input.intent },
          guidanceAction: { action_id: "act_review", tts: { text: "开始胸外按压。" } },
        };
      },
      reset() {},
    },
    tts: silentTts(),
  });

  const finals = [];
  session.on("json", (event) => {
    if (event.type === "final") {
      finals.push(event);
    }
  });

  session.handlePcm(Buffer.from([0, 1, 0, 1]));
  await tick();
  assert.equal(session.sttMode, "streaming");

  // Streaming recognizer mishears "没有呼吸" as "有呼吸" (has breathing).
  fakeStt.emit("final", { text: "有呼吸", intent: "normal_breathing" });
  await tick();
  await tick();

  assert.equal(reviewCalls.length, 1, "the offline reviewer must run for breathing finals");
  assert.equal(reviewCalls[0].hasAudio, true, "captured utterance audio is forwarded to the reviewer");
  assert.equal(finals.at(-1).text, "没有呼吸");
  assert.equal(finals.at(-1).intent, "no_normal_breathing");

  session.close();
});

test("non-critical final skips the offline reviewer entirely", async () => {
  let reviewed = 0;
  const fakeStt = makeReadyFakeStt();
  const session = createLiveSession({
    sessionId: "sess_review_skip",
    createStreamingStt: () => fakeStt,
    reviewFinal: async () => {
      reviewed += 1;
      return null;
    },
    service: {
      async createGuidance(input) {
        return {
          stt: { transcript: input.text, intent: input.intent },
          guidanceAction: { action_id: "act_skip", tts: { text: "好的。" } },
        };
      },
      reset() {},
    },
    tts: silentTts(),
  });

  session.handlePcm(Buffer.from([0, 1, 0, 1]));
  await tick();

  fakeStt.emit("final", { text: "现场安全了", intent: "scene_safe" });
  await tick();

  assert.equal(reviewed, 0, "non-breathing finals must not invoke the offline reviewer");

  session.close();
});

test("breathingPolarity classifies CPR-critical readings without misreading negation", () => {
  // "absent" = CPR-indicating; "present" = non-CPR. The negative lookbehind keeps
  // "没有呼吸" from ever resolving to present.
  assert.equal(breathingPolarity("没有呼吸"), "absent");
  assert.equal(breathingPolarity("没有正常呼吸"), "absent");
  assert.equal(breathingPolarity("没呼吸"), "absent");
  assert.equal(breathingPolarity("偶尔喘一下，没气了"), "absent");
  assert.equal(breathingPolarity("濒死喘息"), "absent");
  assert.equal(breathingPolarity("no breathing"), "absent");
  assert.equal(breathingPolarity("有呼吸"), "present");
  assert.equal(breathingPolarity("有正常呼吸"), "present");
  assert.equal(breathingPolarity("呼吸正常"), "present");
  assert.equal(breathingPolarity("breathing normally"), "present");
  assert.equal(breathingPolarity("现场安全了"), null);
  assert.equal(breathingPolarity(""), null);
  assert.equal(breathingPolarity(undefined), null);
});

test("a corrected breathing-polarity flip is surfaced in the per-turn metrics", async () => {
  const fakeStt = makeReadyFakeStt();
  const session = createLiveSession({
    sessionId: "sess_review_metrics",
    emitMetrics: true,
    createStreamingStt: () => fakeStt,
    reviewFinal: async () => ({ transcript: "没有呼吸" }), // offline engine corrects to absent
    service: {
      async createGuidance(input) {
        return {
          stt: { transcript: input.text, intent: input.intent },
          guidanceAction: { action_id: "act_flip", tts: { text: "开始胸外按压。" } },
        };
      },
      reset() {},
    },
    tts: silentTts(),
  });

  const metrics = [];
  session.on("json", (event) => {
    if (event.type === "metrics") {
      metrics.push(event);
    }
  });

  session.handlePcm(Buffer.from([0, 1, 0, 1]));
  await tick();
  // Streaming mishears as "有呼吸" (present); the offline review flips it to absent.
  fakeStt.emit("final", { text: "有呼吸", intent: "normal_breathing" });
  await tick();
  await tick();

  const m = metrics.at(-1);
  assert.ok(m?.review, "metrics must carry the review audit segment when a re-check ran");
  assert.equal(m.review.triggered, true);
  assert.equal(m.review.corrected, true);
  assert.equal(m.review.breathing_polarity_flip, true);
  assert.equal(m.review.polarity_before, "present");
  assert.equal(m.review.polarity_after, "absent");

  session.close();
});

test("a same-polarity correction is not mislabeled as a polarity flip", async () => {
  const fakeStt = makeReadyFakeStt();
  const session = createLiveSession({
    sessionId: "sess_review_same_polarity",
    emitMetrics: true,
    createStreamingStt: () => fakeStt,
    // Offline engine refines the wording but the reading stays "absent".
    reviewFinal: async () => ({ transcript: "没有呼吸" }),
    service: {
      async createGuidance(input) {
        return {
          stt: { transcript: input.text, intent: input.intent },
          guidanceAction: { action_id: "act_same", tts: { text: "开始胸外按压。" } },
        };
      },
      reset() {},
    },
    tts: silentTts(),
  });

  const metrics = [];
  session.on("json", (event) => {
    if (event.type === "metrics") {
      metrics.push(event);
    }
  });

  session.handlePcm(Buffer.from([0, 1, 0, 1]));
  await tick();
  // Streaming heard "呼吸很弱" (already absent); the refinement must not count as a flip.
  fakeStt.emit("final", { text: "呼吸很弱", intent: "no_normal_breathing" });
  await tick();
  await tick();

  const m = metrics.at(-1);
  assert.ok(m?.review);
  assert.equal(m.review.corrected, true);
  assert.equal(m.review.breathing_polarity_flip, false, "same-polarity refinement is not a flip");
  assert.equal(m.review.polarity_before, "absent");
  assert.equal(m.review.polarity_after, "absent");

  session.close();
});

test("stt reconnect policy bounds restarts and resets on recovery", () => {
  const policy = createSttReconnectPolicy({ maxRestarts: 2, baseDelayMs: 100, factor: 2, maxDelayMs: 1000 });
  assert.equal(policy.canRestart(), true);
  assert.deepEqual(policy.registerRestart(), { attempt: 1, delayMs: 100 });
  assert.deepEqual(policy.registerRestart(), { attempt: 2, delayMs: 200 });
  assert.equal(policy.canRestart(), false);

  policy.reset();
  assert.equal(policy.canRestart(), true);
  assert.equal(policy.registerRestart().delayMs, 100);

  const noDelay = createSttReconnectPolicy({ maxRestarts: 3 });
  assert.equal(noDelay.registerRestart().delayMs, 0);
  assert.equal(noDelay.maxRestarts, 3);
});
