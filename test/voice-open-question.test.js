import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentStage,
  OPEN_QUESTION_FIXED_PHRASES,
  createLiveSession,
  createOpenQuestionAckProposal,
  createVoiceDemoService,
  detectOpenQuestion,
  isOpenQuestionStage,
  looksLikeOpenQuestion,
  openQuestionAnswerIntents,
} from "../src/index.js";
import { DEFAULT_TTS_CACHE_DIR, TtsAudioCache } from "../src/voice/ttsCache.js";
import { buildTtsCacheKey, normalizeForTts } from "../src/voice/ttsText.js";
import { splitTextIntoClauses } from "../src/voice/streamingTts.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// WB 开放问答（闭集外提问 → 受控 Gemma 作答）：liveDriver 标记 open_question，
// service.js planGemmaSupplement 开例外路由给受控问答 Gemma；即时 ack(WA 缓存) + 异步答，
// CPR loop 内不打断纠错、不停节拍器，超时/非法走安全兜底。

// ---------------------------------------------------------------------------
// liveDriver 粗筛（detect/mark）
// ---------------------------------------------------------------------------

test("detectOpenQuestion marks closed-set-external questions, not closed-set or flow/fact reports", () => {
  // Open: reads like a question, no actionable intent.
  assert.equal(detectOpenQuestion({ transcript: "做这个有用吗", intent: null }), true);
  assert.equal(detectOpenQuestion({ transcript: "为什么要一直按", intent: null }), true);
  assert.equal(detectOpenQuestion({ transcript: "还要按多久才行", intent: null }), true);

  // Closed-set questions keep their deterministic fixed answers (not open).
  assert.equal(detectOpenQuestion({ transcript: "我能不能停", intent: "ask_can_stop" }), false);
  assert.equal(detectOpenQuestion({ transcript: "我按得对吗", intent: "ask_cpr_quality" }), false);

  // Flow-progress / fact reports drive the state machine, not Q&A (not open).
  assert.equal(detectOpenQuestion({ transcript: "他没有呼吸吗", intent: "no_normal_breathing" }), false);
  assert.equal(detectOpenQuestion({ transcript: "开始按压", intent: "continue_cpr" }), false);

  // Plain statements are not questions.
  assert.equal(detectOpenQuestion({ transcript: "我有点紧张", intent: null }), false);
  assert.equal(looksLikeOpenQuestion("继续按压"), false);
});

test("open-question stages only expose safe controlled-answer intents", () => {
  assert.equal(isOpenQuestionStage(AgentStage.S7_CPR_LOOP), true);
  assert.equal(isOpenQuestionStage(AgentStage.S8_ASSISTANCE), true);
  // Tightly-gated breathing/arrest checks are intentionally not Q&A stages.
  assert.equal(isOpenQuestionStage(AgentStage.S3_CHECK_BREATHING), false);
  assert.equal(isOpenQuestionStage(AgentStage.S4_SUSPECTED_ARREST), false);

  assert.ok(openQuestionAnswerIntents(AgentStage.S7_CPR_LOOP).includes("answer_current_cpr_question"));
  assert.deepEqual(openQuestionAnswerIntents(AgentStage.S3_CHECK_BREATHING), []);
});

test("the CPR-live ack is a fixed, metronome-safe stabilizer; non-CPR stages have none", () => {
  const ack = createOpenQuestionAckProposal(AgentStage.S7_CPR_LOOP);
  assert.equal(ack.responseType, "open_question_ack");
  assert.equal(ack.intent, "answer_current_cpr_question");
  assert.match(ack.ttsText, /我在/);
  assert.match(ack.ttsText, /按住别停/);
  assert.equal(ack.interruptPolicy, "do_not_interrupt_critical");

  assert.equal(createOpenQuestionAckProposal(AgentStage.S2_CHECK_RESPONSE), null);
});

test("the immediate ack (+CPR fallback) ship in the WA prerender bundle so they play from cache", async () => {
  const cache = new TtsAudioCache({ bundleDir: DEFAULT_TTS_CACHE_DIR });
  await cache.loadBundle();

  // The CPR-live ack must be one of the fixed, cache-backed phrases.
  const ack = createOpenQuestionAckProposal(AgentStage.S7_CPR_LOOP);
  assert.ok(OPEN_QUESTION_FIXED_PHRASES.includes(ack.ttsText));

  // Each fixed phrase and every spoken clause must be registered in the shipped
  // manifest; otherwise the "即时 ack" degrades to a ~3.5s live synthesis.
  for (const phrase of OPEN_QUESTION_FIXED_PHRASES) {
    assert.equal(
      cache.has(buildTtsCacheKey(phrase, { tone: "", speed: "" })),
      true,
      `phrase missing from WA bundle: ${phrase}`,
    );
    for (const clause of splitTextIntoClauses(normalizeForTts(phrase), { maxClauseChars: 34 })) {
      assert.equal(
        cache.has(buildTtsCacheKey(clause, { tone: "", speed: "" })),
        true,
        `clause missing from WA bundle: ${clause}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// service.js 路由 + 即时 ack + 异步答
// ---------------------------------------------------------------------------

test("CPR-live open question: immediate ack now, controlled Gemma answer async, metronome kept", async () => {
  const service = createVoiceDemoService({
    runtime: openQuestionRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "open_q_cpr_live";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({ sessionId, text: "做这个真的有用吗" });

  assert.equal(result.state.current_stage, AgentStage.S7_CPR_LOOP);
  assert.equal(result.event.user_input.intent, null);
  assert.equal(result.open_question, true);

  // Synchronous guidance = the immediate ack (WA-cache eligible stabilizer).
  assert.equal(result.guidance_source, "open_question_ack");
  assert.equal(result.response_type, "open_question_ack");
  assert.match(result.guidance_action.tts.text, /我在/);
  assert.match(result.guidance_action.tts.text, /按住别停/);
  assert.equal(result.guidance_action.tts.interrupt_policy, "do_not_interrupt_critical");

  // 不停节拍器：ack keeps the metronome haptic and carries no stop tool.
  assert.equal(result.guidance_action.haptic.pattern, "metronome");
  assert.deepEqual(result.guidance_action.tool_actions, []);

  // Gemma is not run synchronously; the answer is produced asynchronously.
  assert.equal(result.gemma.skipped, true);
  assert.equal(result.gemma.skipReason, "open_question_async");

  // Async controlled Q&A answer (resolved for the single-shot HTTP response).
  assert.equal(result.open_question_answer.ok, true);
  assert.equal(result.open_question_answer.source, "gemma_open_question");
  assert.equal(result.open_question_answer.action.intent, "answer_current_cpr_question");
  assert.match(result.open_question_answer.action.tts.text, /继续按压别停/);
  // The answer also never interrupts a critical correction in the CPR loop.
  assert.equal(result.open_question_answer.action.tts.interrupt_policy, "do_not_interrupt_critical");
});

test("CPR-live open question answer times out to a safety fallback (never blocks the ack)", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 20,
  });
  const sessionId = "open_q_timeout";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({ sessionId, text: "这样按会不会把肋骨弄断呀" });

  assert.equal(result.open_question, true);
  // Ack still played immediately.
  assert.equal(result.guidance_source, "open_question_ack");
  assert.match(result.guidance_action.tts.text, /我在/);
  // Timeout -> deterministic safety fallback, not a model answer.
  assert.equal(result.open_question_answer.ok, false);
  assert.equal(result.open_question_answer.fallback, true);
  assert.equal(result.open_question_answer.source, "open_question_fallback");
  assert.match(result.open_question_answer.action.tts.text, /继续按压/);
});

test("CPR-live open question with a forbidden answer is blocked to a safety fallback", async () => {
  const service = createVoiceDemoService({
    runtime: forbiddenAnswerRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "open_q_forbidden";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({ sessionId, text: "他还能不能救回来呀" });

  assert.equal(result.open_question, true);
  assert.equal(result.open_question_answer.source, "open_question_fallback");
  // The forbidden "一定能救活" promise never reaches the user.
  assert.doesNotMatch(result.open_question_answer.action.tts.text, /一定能救活/);
  assert.match(result.open_question_answer.action.tts.text, /继续按压/);
});

test("a critical CPR correction preempts the open question (corrections are never interrupted)", async () => {
  const service = createVoiceDemoService({
    runtime: openQuestionRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "open_q_vs_correction";
  await advanceVoiceSessionToCpr(service, sessionId);

  // An open-question utterance arrives together with a long compression interruption.
  const result = await service.handleTurn({
    sessionId,
    text: "做这个有用吗",
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      current_rate: 104,
      average_rate: 105,
      quality_score: 35,
      hand_position: "center",
      arm_posture: "straight",
      interruption_seconds: 3,
      total_compressions: 55,
    },
  });

  assert.equal(result.open_question, false, "a critical correction must not be treated as an open question");
  assert.equal(result.response_type, "critical_correction");
  assert.equal(result.guidance_source, "rule_feedback_critical");
  assert.match(result.guidance_action.tts.text, /不要停|继续按压/);
  assert.equal(result.open_question_answer, null);
});

test("closed-set CPR question stays a deterministic fast-path answer (not an open question)", async () => {
  const service = createVoiceDemoService({
    runtime: openQuestionRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "open_q_closed_set_regression";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({ sessionId, text: "我能不能停" });

  assert.equal(result.open_question, false);
  assert.equal(result.event.user_input.intent, "ask_can_stop");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.match(result.guidance_action.tts.text, /不要停/);
  assert.equal(result.open_question_answer, null);
});

// ---------------------------------------------------------------------------
// LiveSession：ack 先播，答案随后播（barge-in/turnSeq 安全）
// ---------------------------------------------------------------------------

test("LiveSession streams the ack first, then the async answer as a follow-up segment", async () => {
  const answer = {
    ok: true,
    action: { action_id: "act_ans", intent: "answer_current_cpr_question", tts: { text: "继续按压别停。" } },
    source: "gemma_open_question",
    responseType: "open_question_answer",
  };
  const session = createLiveSession({
    sessionId: "live_open_q",
    service: openQuestionLiveService({ answerPromise: Promise.resolve(answer) }),
    tts: oneFrameTts(),
    disableStreamingStt: true,
  });
  const json = [];
  const audio = [];
  session.on("json", (event) => json.push(event));
  session.on("audio", (chunk) => audio.push(chunk));

  await session.processTurn({ text: "做这个有用吗" });

  const guidance = json.filter((event) => event.type === "guidance");
  assert.equal(guidance.length, 2, "ack + async answer are two guidance segments");
  assert.equal(guidance[0].source, "open_question_ack");
  assert.match(guidance[0].action.tts.text, /我在/);
  assert.equal(guidance[1].open_question_answer, true);
  assert.equal(guidance[1].source, "gemma_open_question");
  assert.match(guidance[1].action.tts.text, /继续按压别停/);

  // Each spoken segment streams its own audio envelope, ack before answer.
  assert.equal(json.filter((event) => event.type === "audio_begin").length, 2);
  assert.equal(json.filter((event) => event.type === "audio_end").length, 2);
  assert.equal(audio.length, 2);

  session.close();
});

test("a barge-in while the answer is pending suppresses it (ack already played)", async () => {
  let resolveAnswer;
  const answerPromise = new Promise((resolve) => {
    resolveAnswer = resolve;
  });
  const session = createLiveSession({
    sessionId: "live_open_q_barge",
    service: openQuestionLiveService({ answerPromise }),
    tts: oneFrameTts(),
    disableStreamingStt: true,
  });
  const json = [];
  session.on("json", (event) => json.push(event));

  const turn = session.processTurn({ text: "做这个有用吗" });
  await tick(); // ack streamed; the answer promise is still pending

  await session.handleControl({ type: "barge_in" });
  resolveAnswer({
    ok: true,
    action: { action_id: "act_ans", intent: "answer_current_cpr_question", tts: { text: "继续按压别停。" } },
    source: "gemma_open_question",
    responseType: "open_question_answer",
  });
  await turn;

  const answerGuidance = json.filter((event) => event.type === "guidance" && event.open_question_answer === true);
  assert.equal(answerGuidance.length, 0, "barge-in must suppress the still-pending open-question answer");

  session.close();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function openQuestionRuntime(answer = { intent: "answer_current_cpr_question", text: "继续按压别停，按到他能正常呼吸或急救员接手。" }) {
  return {
    async generatePatch() {
      return {
        ok: true,
        patch: {
          intent: answer.intent,
          tts: { text: answer.text, tone: "calm_firm", speed: "normal" },
          ui: { main_text: "继续按压", secondary_text: "别停，等急救员接手" },
          reason: "open_question_answer",
          confidence: 0.82,
        },
        violations: [],
      };
    },
  };
}

function forbiddenAnswerRuntime() {
  return {
    async generatePatch() {
      return {
        ok: true,
        patch: {
          intent: "answer_current_cpr_question",
          tts: { text: "别担心，这样一定能救活。", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "", secondary_text: "" },
          reason: "unsafe_promise",
          confidence: 0.8,
        },
        violations: [],
      };
    },
  };
}

function neverResolvingRuntime() {
  return {
    async generatePatch() {
      return new Promise(() => {});
    },
  };
}

function openQuestionLiveService({ answerPromise, ackText = "我在，按住别停，听我说。" } = {}) {
  return {
    async createGuidance(input = {}) {
      return {
        stt: { transcript: input.text || "", intent: null },
        guidanceAction: {
          action_id: "act_ack",
          intent: "answer_current_cpr_question",
          tts: { text: ackText, tone: "calm_firm", speed: "normal", interrupt_policy: "do_not_interrupt_critical" },
          haptic: { enabled: true, pattern: "metronome", bpm: 110 },
          tool_actions: [],
        },
        guidanceDecision: { source: "open_question_ack", responseType: "open_question_ack" },
        pipeline: { state: { current_stage: AgentStage.S7_CPR_LOOP } },
        openQuestionAnswer: { promise: answerPromise },
      };
    },
    reset() {},
  };
}

function oneFrameTts() {
  return {
    cancel() {},
    async *speak() {
      yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
    },
  };
}

async function advanceVoiceSessionToCpr(service, sessionId) {
  await service.handleTurn({
    sessionId,
    text: "现场安全了",
    patientState: { scene_safe: true, adult_likely: true },
  });
  await service.handleTurn({ sessionId, text: "他没有反应" });
  await service.handleTurn({ sessionId, text: "没有正常呼吸" });
  await service.handleTurn({ sessionId, text: "120 已经拨打" });
  await service.handleTurn({
    sessionId,
    text: "准备好了",
    patientState: {
      adult_likely: true,
      lying_down: true,
      responsive: false,
      normal_breathing: false,
      agonal_breathing: true,
    },
  });
  const cprStart = await service.handleTurn({
    sessionId,
    text: "开始按压",
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      current_rate: 110,
      average_rate: 110,
      quality_score: 72,
      hand_position: "center",
      arm_posture: "straight",
      interruption_seconds: 0,
      total_compressions: 12,
    },
  });
  assert.equal(cprStart.state.current_stage, AgentStage.S7_CPR_LOOP);
}
