#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../src/config/loadEnv.js";
import { createLiveSession, createVoiceDemoService } from "../src/index.js";

// Automated Live (WS) reproduction harness for the 1-期 Demo voice mainline.
// It builds a LiveSession in-process (no socket), injects a mock streaming TTS +
// a stub Gemma runtime for determinism, and drives docs/live_speech_test_flow.md
// with control messages, asserting the emitted json/audio events per turn
// (stage / intent / guidance source / TTS substrings / event order, including
// the bounded S4->S5->S6 auto-advance). Style mirrors
// scripts/voiceMockScenarioProbe.mjs.
//
// Contract under test (post-redesign expectations; do NOT depend on a real model):
//   1. Fast judgement funnel: inject session_started -> S1; "现场安全了..." -> S2;
//      "他没有反应" -> S3 (agonal-direct wording, no "正常起伏"); "没有呼吸，偶尔
//      喘一下" -> bounded auto-advance S4 -> S5 -> S6 in a single user turn,
//      stopping at the S6_CPR_READY confirm gate.
//   2. CORE: S6 is the single multimodal confirm gate. Saying "我准备好了" (or
//      准备好了/开始吧/可以开始) is resolved by a deterministic fast path to
//      `continue_cpr` (guidance.source = `rule_flow_fast_path`), flipping the
//      state machine to S7_CPR_LOOP and voicing the single-voice
//      "开始按压/跟着节拍/用力快压" cue (never "震动").
//   3. Single-voice S7 loop: passive Q&A (质量/能不能停/AED) is answered instantly
//      via rule_fast_path without changing stage; AED guidance only points
//      ("打开 AED，跟着它的语音做；先继续按压。"), never narrating pad placement.
//   4. Tolerance: assert "key substring contains + stage equals", never whole
//      sentence equality. Auto-advance synthetic turns may or may not carry
//      thinking/final, so judge by "S4->S5->S6 三段 guidance/state 依序出现、
//      最终停在 S6".

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const artifactsDir = path.join(root, "artifacts");

loadEnv({ cwd: root });

const sessionId = "live_probe_main";

// Mock GPS injected via Live `context` so S5 "向 120 播报" carries coordinates.
const MOCK_LOCATION = {
  address_line: "示例市示例区示范路 1 号",
  landmark: "地铁A口",
  latitude: 31.230416,
  longitude: 121.473701,
  accuracy_m: 18,
};

// Single-segment baseline event order (one user turn -> one guidance segment).
const BASELINE_SEQUENCE = ["thinking", "final", "guidance", "state", "audio_begin", "audio_end"];

const STEPS = [
  {
    id: "p1_start",
    label: "握手：start 建会话",
    controls: [{ type: "start", sessionId }],
    expect: { connected: true, noGuidance: true },
  },
  {
    id: "p2_context_gps",
    label: "注入 mock GPS（context 缓存，合并进后续每轮）",
    controls: [{ type: "context", payload: { deviceState: { location: MOCK_LOCATION } } }],
    expect: { noEvents: true },
  },
  {
    id: "s1_session_started",
    label: "段①：一键急救 session_started -> S1 引导靠近患者",
    contract: "四段主线·S1",
    controls: [
      {
        type: "inject",
        eventSource: "demo_script",
        eventType: "session_started",
        deviceState: { recording: true, emergency_call_started: false },
        metadata: { adult_likely: true, recording: true },
      },
    ],
    expect: {
      baseline: true,
      finalStage: "S1_SCENE_SAFE",
      segments: [
        {
          stage: "S1_SCENE_SAFE",
          sourceAny: ["state_machine"],
          ttsIncludes: ["周围安全", "靠近患者"],
        },
      ],
    },
  },
  {
    id: "s2_scene_safe",
    label: "段①：现场安全了 -> S2 呼叫并拍肩",
    contract: "四段主线·S2",
    controls: [{ type: "final", text: "现场安全了，我在患者旁" }],
    expect: {
      baseline: true,
      finalIntent: "scene_safe",
      finalStage: "S2_CHECK_RESPONSE",
      segments: [
        {
          stage: "S2_CHECK_RESPONSE",
          sourceAny: ["state_machine", "gemma_agent"],
          ttsIncludes: ["轻拍", "双肩"],
        },
      ],
    },
  },
  {
    id: "s3_unresponsive",
    label: "段②：他没有反应 -> S3 看胸口",
    contract: "四段主线·S3",
    controls: [{ type: "final", text: "他没有反应" }],
    expect: {
      baseline: true,
      finalIntent: "patient_unresponsive",
      finalStage: "S3_CHECK_BREATHING",
      segments: [
        {
          stage: "S3_CHECK_BREATHING",
          sourceAny: ["state_machine_critical"],
          intent: "ask_breathing_check",
          // Agonal-direct wording: 偶尔大口喘/不动 都算没有呼吸 (no more "正常起伏").
          ttsIncludes: ["胸口", "偶尔大口喘", "没有呼吸"],
        },
      ],
    },
  },
  {
    id: "s4_to_s6_autoadvance",
    label: "段②③：没有呼吸偶尔喘 -> S4 判定骤停，自动连跳 S5 拨120+播报 -> S6 首句口令",
    contract: "四段主线·自动连跳 S4->S5->S6（停在 S6）",
    controls: [{ type: "final", text: "没有呼吸，偶尔喘一下" }],
    expect: {
      finalIntent: "agonal_breathing",
      finalStage: "S6_CPR_READY",
      // Bounded auto-advance: exactly three guidance segments in one user turn.
      segments: [
        {
          stage: "S4_SUSPECTED_ARREST",
          sourceAny: ["state_machine_critical"],
          intent: "state_suspected_arrest_handling",
          ttsIncludes: ["疑似", "胸外按压"],
          audioEnvelope: false,
        },
        {
          stage: "S5_CALL_EMERGENCY",
          sourceAny: ["state_machine_critical"],
          intent: "start_emergency_call_and_cpr",
          ttsIncludes: ["我将为你拨打", "120", "免提"],
          callBriefIncludes: ["坐标", "无反应", "无正常呼吸", "按疑似心脏骤停处理", "请派救护车"],
          hasTool: "emergency_call",
          audioEnvelope: false,
        },
        {
          // S6 is the single confirm gate now (你说我做 coach retired): one
          // positioning line + "说开始/点开始按压".
          stage: "S6_CPR_READY",
          sourceAny: ["state_machine_critical"],
          ttsIncludes: ["胸口中央", "胳膊伸直", "开始"],
          audioEnvelope: true,
        },
      ],
      // The chain must stop at S6 (no further auto-advance into S7).
      maxStage: "S6_CPR_READY",
    },
  },
  {
    id: "s6_ready_fast_path",
    label: '核心回归：S6 说"我准备好了" -> 快路径 continue_cpr 翻转到 S7 起播按压',
    contract: "S6「就绪即开始」快路径（修复前无意图、卡在 S5/S6）",
    core: true,
    controls: [{ type: "final", text: "我准备好了" }],
    expect: {
      baseline: true,
      finalIntent: "continue_cpr",
      finalStage: "S7_CPR_LOOP",
      segments: [
        {
          stage: "S7_CPR_LOOP",
          sourceAny: ["rule_flow_fast_path"],
          intentAny: ["continue_cpr", "start_cpr_loop"],
          // Single-voice startup cue (no "震动").
          ttsIncludes: ["开始按压", "跟着节拍", "用力快压"],
          cprStarted: true,
        },
      ],
      maxStage: "S7_CPR_LOOP",
      // P2-6/P2-7: the metrics event must attribute the readiness start to the
      // deterministic flow fast path (both intent + guidance source) and report the
      // WA-cache TTS hit, not drift to state_machine_critical.
      metrics: {
        guidanceSource: "rule_flow_fast_path",
        intentSource: "rule_flow_fast_path",
        cacheHit: true,
      },
    },
  },
  {
    id: "s7_ask_quality",
    label: "段④被动问答：我按得对吗 -> rule_fast_path 即时作答（stage 不变）",
    contract: "段④被动问答（S7 即时命中 rule_fast_path）",
    bonus: true,
    controls: [{ type: "final", text: "我按得对吗" }],
    expect: {
      baseline: true,
      finalIntent: "ask_cpr_quality",
      finalStage: "S7_CPR_LOOP",
      segments: [
        {
          stage: "S7_CPR_LOOP",
          sourceAny: ["rule_fast_path"],
          responseType: "question_answer",
          intent: "answer_current_cpr_question",
          ttsIncludes: ["按压可以"],
          ttsIncludesAny: ["100 到 120", "100到120"],
        },
      ],
      metrics: { guidanceSource: "rule_fast_path" },
    },
  },
  {
    id: "s7_ask_can_stop",
    label: "段④被动问答：我能不能停 -> rule_fast_path 即时作答（stage 不变）",
    contract: "段④被动问答（S7 即时命中 rule_fast_path）",
    bonus: true,
    controls: [{ type: "final", text: "我能不能停" }],
    expect: {
      baseline: true,
      finalIntent: "ask_can_stop",
      finalStage: "S7_CPR_LOOP",
      segments: [
        {
          stage: "S7_CPR_LOOP",
          sourceAny: ["rule_fast_path"],
          responseType: "question_answer",
          intent: "answer_current_cpr_question",
          ttsIncludes: ["不要停", "继续按压"],
        },
      ],
      metrics: { guidanceSource: "rule_fast_path" },
    },
  },
  {
    id: "s7_open_question_gemma_answer",
    label: "段④开放问答：非模板问题 -> live 先 ack，随后 Gemma answer 追播",
    contract: "段④开放问答（ack_then_async_answer）",
    bonus: true,
    controls: [{ type: "final", text: "为什么他的鞋子湿了" }],
    expect: {
      baseline: true,
      finalIntent: null,
      finalStage: "S7_CPR_LOOP",
      segments: [
        {
          stage: "S7_CPR_LOOP",
          sourceAny: ["open_question_ack"],
          responseType: "open_question_ack",
          intent: "answer_current_cpr_question",
          ttsIncludes: ["按住别停"],
        },
        {
          stage: "S7_CPR_LOOP",
          sourceAny: ["gemma_open_question_text_stream", "gemma_open_question_text"],
          responseType: "open_question_answer",
          intent: "answer_current_cpr_question",
          ttsIncludes: ["继续按压"],
        },
      ],
      metrics: { guidanceSource: "open_question_ack" },
      openQuestionMetrics: {
        ackPending: true,
        answerSourceAny: ["gemma_open_question_text_stream", "gemma_open_question_text"],
        answerFallback: false,
        maxAnswerWaitMs: 60,
      },
    },
  },
  {
    id: "s7_ask_aed",
    label: "段④事实到达：AED 来了怎么办 -> rule_fast_path 进入 AED 协助",
    contract: "段④ AED 到达（S7 即时命中 aed_available -> S8）",
    bonus: true,
    controls: [{ type: "final", text: "AED 来了怎么办" }],
    expect: {
      baseline: true,
      finalIntent: "aed_available",
      finalStage: "S8_ASSISTANCE",
      segments: [
        {
          stage: "S8_ASSISTANCE",
          sourceAny: ["rule_fast_path"],
          responseType: "flow_instruction",
          intent: "assist_aed",
          ttsIncludes: ["继续按压", "语音"],
          ttsIncludesAny: ["打开 AED", "打开AED", "AED"],
        },
      ],
      metrics: { guidanceSource: "rule_fast_path" },
    },
  },
  {
    id: "s8_ems_arrived",
    label: "段④事实到达：120 到了 -> paramedics_arrived 进入 S9 交接并停止节拍",
    contract: "段④ EMS 到达（S8/S7 本地识别 paramedics_arrived，状态机进入 S9）",
    bonus: true,
    controls: [{ type: "final", text: "120 到了" }],
    expect: {
      baseline: true,
      finalIntent: "paramedics_arrived",
      finalStage: "S9_HANDOVER",
      segments: [
        {
          stage: "S9_HANDOVER",
          sourceAny: ["state_machine_critical"],
          responseType: "flow_instruction",
          intent: "generate_handover_report",
          ttsIncludes: ["急救员到达", "交接报告"],
          hasTools: ["stop_haptic_metronome", "generate_handover_report"],
        },
      ],
      metrics: { guidanceSource: "state_machine_critical", intentSource: "regex" },
    },
  },
];

await main();

async function main() {
  const { session, jsonEvents, audioEvents } = buildLiveSession();
  const results = [];

  for (const [index, step] of STEPS.entries()) {
    const jsonFrom = jsonEvents.length;
    const audioFrom = audioEvents.length;

    for (const control of step.controls) {
      await session.handleControl(cloneJson(control));
    }

    const turnJson = jsonEvents.slice(jsonFrom);
    const turnAudio = audioEvents.slice(audioFrom);
    const evaluation = evaluateStep(step, turnJson, turnAudio);
    results.push({
      index: index + 1,
      id: step.id,
      label: step.label,
      contract: step.contract || null,
      core: step.core === true,
      bonus: step.bonus === true,
      spoken_text: lastSpoken(step),
      expected: step.expect,
      actual: projectTurn(turnJson, turnAudio),
      checks: evaluation.checks,
      ok: evaluation.ok,
    });
  }

  session.close();

  const summary = summarize(results, sessionId);
  await fs.mkdir(artifactsDir, { recursive: true });
  const outputPath = path.join(
    artifactsDir,
    `live-speech-flow-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await fs.writeFile(outputPath, JSON.stringify({ summary, results }, null, 2), "utf8");

  printSummary(summary, results, outputPath);
  process.exitCode = summary.ok ? 0 : 1;
}

function buildLiveSession() {
  // Stub Gemma runtime: never patches, never spawns Python. Keeps the medical
  // flow fully deterministic (state machine + rule fast path + cpr coach only),
  // so the probe reproduces the exact post-fix behaviour without a real model.
  const runtime = {
    async generatePatch() {
      return { ok: true, skipped: true, skipReason: "stub_runtime", patch: null };
    },
    async parseUserIntent() {
      return { ok: false, reason: "stub_runtime", intent: null, slots: {}, confidence: 0 };
    },
    async generateText(_messages, options = {}) {
      return {
        ok: true,
        text: "继续按压，鞋子湿不影响当前处置。",
        streamed: options.stream === true,
        reason: options.stream ? "stub_text_stream" : "stub_text",
      };
    },
    async prewarm() {
      return { ok: true, warmed: false, reason: "stub_runtime" };
    },
  };

  const service = createVoiceDemoService({
    runtime,
    now: () => new Date().toISOString(),
  });

  // Mock streaming TTS: yields one tiny PCM16 frame per utterance so we can
  // assert the audio_begin -> PCM -> audio_end envelope without real audio. The
  // `provider` field mirrors the real streamer so the metrics event reports a
  // deterministic TTS source (here a WA-cache hit) without touching sherpa.
  const tts = {
    cancel() {},
    async *speak() {
      yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16, provider: "tts_cache" };
    },
  };

  const session = createLiveSession({
    sessionId,
    service,
    tts,
    disableStreamingStt: true,
    // P2-6: assert the per-turn `metrics` event the live WS path emits.
    emitMetrics: true,
  });

  const jsonEvents = [];
  const audioEvents = [];
  session.on("json", (event) => jsonEvents.push(event));
  session.on("audio", (chunk) => audioEvents.push(chunk));

  return { session, jsonEvents, audioEvents };
}

function evaluateStep(step, turnJson, turnAudio) {
  const checks = [];
  const expect = step.expect || {};
  const types = turnJson.map((event) => event.type);

  if (expect.connected) {
    const connected = turnJson.find(
      (event) => event.type === "state" && event.status === "connected"
    );
    addCheck(checks, "connected", Boolean(connected), "state(status=connected)", types.join(","));
  }

  addCheck(checks, "no_error", !types.includes("error"), "no error event", types.join(","));

  if (expect.noEvents) {
    addCheck(checks, "no_events", turnJson.length === 0, "0 events", String(turnJson.length));
  }

  if (expect.noGuidance) {
    addCheck(checks, "no_guidance", !types.includes("guidance"), "no guidance", types.join(","));
  }

  const finalEvent = turnJson.find((event) => event.type === "final");
  if (expect.finalIntent) {
    addCheck(
      checks,
      "final_intent",
      finalEvent?.intent === expect.finalIntent,
      expect.finalIntent,
      finalEvent?.intent ?? "<none>"
    );
  }

  if (expect.baseline) {
    // The user turn (first segment) must emit the full baseline order.
    const head = types.slice(0, BASELINE_SEQUENCE.length);
    addCheck(
      checks,
      "baseline_sequence",
      arrayStartsWith(types, BASELINE_SEQUENCE),
      BASELINE_SEQUENCE.join("->"),
      head.join("->")
    );
  }

  const segments = extractSegments(turnJson);

  if (Array.isArray(expect.segments)) {
    addCheck(
      checks,
      "segment_count",
      segments.length === expect.segments.length,
      String(expect.segments.length),
      String(segments.length)
    );

    for (const [i, want] of expect.segments.entries()) {
      const got = segments[i];
      const tag = `seg${i + 1}`;
      if (!got) {
        addCheck(checks, `${tag}:present`, false, "segment present", "<missing>");
        continue;
      }

      if (want.stage) {
        addCheck(checks, `${tag}:stage`, got.stage === want.stage, want.stage, got.stage ?? "<none>");
      }
      if (Array.isArray(want.sourceAny)) {
        addCheck(
          checks,
          `${tag}:source`,
          want.sourceAny.includes(got.source),
          want.sourceAny.join(" | "),
          got.source ?? "<none>"
        );
      }
      if (want.responseType) {
        addCheck(
          checks,
          `${tag}:response_type`,
          got.responseType === want.responseType,
          want.responseType,
          got.responseType ?? "<none>"
        );
      }
      if (want.intent) {
        addCheck(checks, `${tag}:intent`, got.intent === want.intent, want.intent, got.intent ?? "<none>");
      }
      if (Array.isArray(want.intentAny)) {
        addCheck(
          checks,
          `${tag}:intent`,
          want.intentAny.includes(got.intent),
          want.intentAny.join(" | "),
          got.intent ?? "<none>"
        );
      }
      for (const keyword of want.ttsIncludes || []) {
        addCheck(checks, `${tag}:tts:${keyword}`, got.tts.includes(keyword), keyword, got.tts);
      }
      if (Array.isArray(want.ttsIncludesAny)) {
        const hit = want.ttsIncludesAny.some((keyword) => got.tts.includes(keyword));
        addCheck(checks, `${tag}:tts_any`, hit, want.ttsIncludesAny.join(" | "), got.tts);
      }
      for (const keyword of want.callBriefIncludes || []) {
        const script = got.callBriefScript || "";
        addCheck(checks, `${tag}:brief:${keyword}`, script.includes(keyword), keyword, script || "<no brief>");
      }
      if (want.hasTool) {
        const found = got.toolTypes.includes(want.hasTool);
        addCheck(checks, `${tag}:tool:${want.hasTool}`, found, want.hasTool, got.toolTypes.join(",") || "<none>");
      }
      for (const tool of want.hasTools || []) {
        const found = got.toolTypes.includes(tool);
        addCheck(checks, `${tag}:tool:${tool}`, found, tool, got.toolTypes.join(",") || "<none>");
      }
      if (typeof want.cprStarted === "boolean") {
        const started = got.state?.cpr_state?.started === true;
        addCheck(checks, `${tag}:cpr_started`, started === want.cprStarted, String(want.cprStarted), String(started));
      }
      // Each speaking segment must carry a complete audio envelope. The S4->S5
      // bridge intentionally coalesces three guidance actions into one spoken
      // audio envelope, so earlier synthetic segments opt out.
      const expectAudio = want.audioEnvelope !== false;
      addCheck(
        checks,
        `${tag}:audio_envelope`,
        !expectAudio || (got.hasAudioBegin && got.hasAudioEnd),
        expectAudio ? "audio_begin+audio_end" : "audio optional",
        `${got.hasAudioBegin}/${got.hasAudioEnd}`
      );
    }
  }

  // P2-6: one `metrics` event per guidance segment, each carrying the latency
  // breakdown + TTS cache provider + intent source + gemma skip/stale fields.
  const metricsEvents = turnJson.filter((event) => event.type === "metrics");
  if (Array.isArray(expect.segments)) {
    addCheck(
      checks,
      "metrics_count",
      metricsEvents.length === expect.segments.length,
      String(expect.segments.length),
      String(metricsEvents.length)
    );
    for (const [i, metric] of metricsEvents.entries()) {
      const tag = `metrics${i + 1}`;
      const issues = metricsShapeIssues(metric);
      addCheck(checks, `${tag}:shape`, issues.length === 0, "stt/intent/gemma/tts/total + provider/source/skip", issues.join(",") || "ok");
    }
  }
  if (expect.metrics) {
    const metric = metricsEvents[0] || null;
    if (expect.metrics.guidanceSource) {
      addCheck(
        checks,
        "metrics:guidance_source",
        metric?.guidance_source === expect.metrics.guidanceSource,
        expect.metrics.guidanceSource,
        metric?.guidance_source ?? "<none>"
      );
    }
    if (expect.metrics.intentSource) {
      addCheck(
        checks,
        "metrics:intent_source",
        metric?.intent?.source === expect.metrics.intentSource,
        expect.metrics.intentSource,
        metric?.intent?.source ?? "<none>"
      );
    }
    if (typeof expect.metrics.cacheHit === "boolean") {
      addCheck(
        checks,
        "metrics:tts_cache_hit",
        metric?.tts?.cache_hit === expect.metrics.cacheHit,
        String(expect.metrics.cacheHit),
        String(metric?.tts?.cache_hit)
      );
    }
  }

  if (expect.openQuestionMetrics) {
    const ackMetric = metricsEvents.find((event) => event.open_question?.segment === "ack") || null;
    const answerMetric = metricsEvents.find((event) => event.open_question?.segment === "answer") || null;
    if (typeof expect.openQuestionMetrics.ackPending === "boolean") {
      addCheck(
        checks,
        "open_question:ack_pending",
        ackMetric?.open_question?.pending === expect.openQuestionMetrics.ackPending,
        String(expect.openQuestionMetrics.ackPending),
        String(ackMetric?.open_question?.pending)
      );
    }
    if (Array.isArray(expect.openQuestionMetrics.answerSourceAny)) {
      const source = answerMetric?.guidance_source ?? null;
      addCheck(
        checks,
        "open_question:answer_source",
        expect.openQuestionMetrics.answerSourceAny.includes(source),
        expect.openQuestionMetrics.answerSourceAny.join(" | "),
        source ?? "<none>"
      );
    }
    if (typeof expect.openQuestionMetrics.answerFallback === "boolean") {
      const fallback = answerMetric?.open_question?.fallback === true;
      addCheck(
        checks,
        "open_question:answer_fallback",
        fallback === expect.openQuestionMetrics.answerFallback,
        String(expect.openQuestionMetrics.answerFallback),
        String(fallback)
      );
    }
    if (typeof expect.openQuestionMetrics.maxAnswerWaitMs === "number") {
      const waitMs = answerMetric?.open_question?.wait_ms;
      addCheck(
        checks,
        "open_question:answer_wait",
        typeof waitMs === "number" && waitMs <= expect.openQuestionMetrics.maxAnswerWaitMs,
        `<=${expect.openQuestionMetrics.maxAnswerWaitMs}ms`,
        `${waitMs ?? "null"}ms`
      );
    }
  }

  if (expect.finalStage) {
    const finalStage = lastStage(turnJson);
    addCheck(checks, "final_stage", finalStage === expect.finalStage, expect.finalStage, finalStage ?? "<none>");
  }

  if (expect.maxStage) {
    const order = stageOrder();
    const cap = order.indexOf(expect.maxStage);
    const overshoot = segments
      .map((segment) => segment.stage)
      .filter((stage) => stage && order.indexOf(stage) > cap);
    addCheck(
      checks,
      "max_stage",
      overshoot.length === 0,
      `<= ${expect.maxStage}`,
      overshoot.join(",") || "<none>"
    );
  }

  if (turnAudio.length > 0 || (Array.isArray(expect.segments) && expect.segments.length > 0)) {
    const expectedAudio = Array.isArray(expect.segments)
      ? expect.segments.filter((segment) => segment.audioEnvelope !== false).length
      : 0;
    addCheck(checks, "audio_frames", turnAudio.length >= expectedAudio, `>= ${expectedAudio}`, String(turnAudio.length));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

// Group a turn's json events into guidance segments. Each segment starts at a
// `guidance` event and absorbs the following `state` (stage + full snapshot)
// and audio envelope.
function extractSegments(turnJson) {
  const segments = [];
  let current = null;

  for (const event of turnJson) {
    switch (event.type) {
      case "guidance":
        current = {
          source: event.source ?? null,
          responseType: event.response_type ?? null,
          intent: event.action?.intent ?? null,
          stage: event.action?.stage ?? null,
          tts: event.action?.tts?.text ?? "",
          callBriefScript: event.action?.call_brief?.script ?? toolBriefScript(event.action),
          toolTypes: toolTypesOf(event.action),
          state: null,
          hasAudioBegin: false,
          hasAudioEnd: false,
        };
        segments.push(current);
        break;
      case "state":
        if (current && event.current_stage) {
          current.stage = event.current_stage;
        }
        if (current && event.state) {
          current.state = event.state;
        }
        break;
      case "audio_begin":
        if (current) current.hasAudioBegin = true;
        break;
      case "audio_end":
        if (current) current.hasAudioEnd = true;
        break;
      default:
        break;
    }
  }

  return segments;
}

// A well-formed `metrics` event must carry the full latency breakdown keys
// (present, numeric-or-null), the TTS provenance, the intent source and the gemma
// skip flag. Returns the list of missing/invalid fields ([] when valid).
function metricsShapeIssues(metric) {
  const issues = [];
  const timings = metric?.timings;
  if (!timings || typeof timings !== "object") {
    return ["timings"];
  }
  for (const key of ["stt_ms", "intent_resolution_ms", "gemma_ms", "tts_ms", "total_ms"]) {
    if (!(key in timings)) {
      issues.push(`timings.${key}`);
    }
  }
  if (typeof timings.total_ms !== "number") {
    issues.push("total_ms!number");
  }
  if (!metric?.tts || !("provider" in metric.tts) || !("cache_hit" in metric.tts)) {
    issues.push("tts.provider/cache_hit");
  }
  if (!metric?.intent || !("source" in metric.intent)) {
    issues.push("intent.source");
  }
  if (!metric?.gemma || typeof metric.gemma.skipped !== "boolean") {
    issues.push("gemma.skipped");
  }
  return issues;
}

function toolTypesOf(action) {
  const tools = Array.isArray(action?.tool_actions)
    ? action.tool_actions
    : action?.tool_action
      ? [action.tool_action]
      : [];
  return tools.map((tool) => tool?.type || tool?.tool || tool?.name).filter(Boolean);
}

function toolBriefScript(action) {
  const tools = Array.isArray(action?.tool_actions) ? action.tool_actions : [];
  const call = tools.find((tool) => tool?.type === "emergency_call");
  return call?.briefing?.script ?? "";
}

function lastStage(turnJson) {
  const stages = turnJson
    .filter((event) => event.type === "state" && event.current_stage)
    .map((event) => event.current_stage);
  return stages[stages.length - 1] ?? null;
}

function projectTurn(turnJson, turnAudio) {
  return {
    event_types: turnJson.map((event) => event.type),
    final_intent: turnJson.find((event) => event.type === "final")?.intent ?? null,
    final_stage: lastStage(turnJson),
    segments: extractSegments(turnJson).map((segment) => ({
      stage: segment.stage,
      source: segment.source,
      response_type: segment.responseType,
      intent: segment.intent,
      tts: segment.tts,
      tool_types: segment.toolTypes,
      call_brief_script: segment.callBriefScript || null,
      cpr_started: segment.state?.cpr_state?.started ?? null,
    })),
    metrics: turnJson
      .filter((event) => event.type === "metrics")
      .map((event) => ({
        guidance_source: event.guidance_source ?? null,
        intent_source: event.intent?.source ?? null,
        tts_provider: event.tts?.provider ?? null,
        tts_cache_hit: event.tts?.cache_hit ?? null,
        gemma_skipped: event.gemma?.skipped ?? null,
        total_ms: event.timings?.total_ms ?? null,
      })),
    audio_frames: turnAudio.length,
  };
}

function summarize(results, session) {
  const failed = results.filter((result) => !result.ok);
  const segmentsCovered = results.reduce(
    (sum, result) => sum + (result.actual.segments?.length || 0),
    0
  );
  const metricsEmitted = results.reduce(
    (sum, result) => sum + (result.actual.metrics?.length || 0),
    0
  );
  const stagesCovered = [
    ...new Set(
      results.flatMap((result) => result.actual.segments.map((segment) => segment.stage)).filter(Boolean)
    ),
  ];
  const core = results.find((result) => result.core) || null;

  return {
    ok: failed.length === 0,
    session_id: session,
    total_steps: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    segments_asserted: segmentsCovered,
    metrics_emitted: metricsEmitted,
    stages_covered: stagesCovered,
    core_regression: core ? { id: core.id, ok: core.ok } : null,
    failed_steps: failed.map((result) => result.id),
  };
}

function printSummary(summary, results, outputPath) {
  console.log(`Live speech flow probe: ${summary.ok ? "PASS" : "FAIL"}`);
  console.log(`session=${summary.session_id} steps=${summary.passed}/${summary.total_steps}`);
  console.log(`segments_asserted=${summary.segments_asserted} metrics_emitted=${summary.metrics_emitted} stages=${summary.stages_covered.join(",")}`);
  if (summary.core_regression) {
    console.log(
      `core_regression(S6->S7 rule_flow_fast_path)=${summary.core_regression.ok ? "PASS" : "FAIL"} (${summary.core_regression.id})`
    );
  }
  console.log(`report=${outputPath}`);

  for (const result of results) {
    const marker = result.ok ? "PASS" : "FAIL";
    const tag = result.core ? "CORE " : result.bonus ? "bonus" : "     ";
    const stages = result.actual.segments.map((segment) => segment.stage).join(">") || "-";
    const sources = [...new Set(result.actual.segments.map((segment) => segment.source).filter(Boolean))].join(",") || "-";
    console.log(
      `[${marker}] ${tag} ${String(result.index).padStart(2, "0")} ${result.id} ` +
        `stages=${stages} source=${sources} final_intent=${result.actual.final_intent ?? "none"} ` +
        `events=${result.actual.event_types.length}`
    );
    if (!result.ok) {
      for (const check of result.checks.filter((item) => !item.ok)) {
        console.log(`       ${check.name}: expected ${check.expected}; actual ${check.actual}`);
      }
    }
  }
}

function addCheck(checks, name, ok, expected, actual) {
  checks.push({ name, ok, expected, actual });
}

function arrayStartsWith(arr, prefix) {
  if (arr.length < prefix.length) {
    return false;
  }
  return prefix.every((value, index) => arr[index] === value);
}

function stageOrder() {
  return [
    "S0_INIT",
    "S1_SCENE_SAFE",
    "S2_CHECK_RESPONSE",
    "S3_CHECK_BREATHING",
    "S4_SUSPECTED_ARREST",
    "S5_CALL_EMERGENCY",
    "S6_CPR_READY",
    "S7_CPR_LOOP",
    "S8_ASSISTANCE",
    "S9_HANDOVER",
  ];
}

function lastSpoken(step) {
  const finals = step.controls.filter((control) => control.type === "final");
  return finals.length ? finals[finals.length - 1].text : "";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}
