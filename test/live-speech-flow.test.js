import assert from "node:assert/strict";
import test from "node:test";

import { createLiveSession, createVoiceDemoService } from "../src/index.js";

// End-to-end Live (WS) voice mainline, driven in-process against a LiveSession
// with a mock streaming TTS + a stub Gemma runtime (deterministic: state machine
// + rule fast path + the single S6 confirm gate). Mirrors
// docs/live_speech_test_flow.md and asserts the post-redesign contract:
//   ① startup/guidance (S1) -> ② state feedback (S2, S3 agonal-direct wording),
//   ③ a single "没有呼吸..." user turn bounded-auto-advances S4 -> S5 (拨120 +
//      向120播报) -> S6 and STOPS at S6_CPR_READY (the single multimodal
//      confirm gate), and
//   ④ the CORE regression: at S6 saying "我准备好了" is resolved by the
//      deterministic fast path to `continue_cpr` (guidance.source =
//      `rule_flow_fast_path`), flipping S6 -> S7_CPR_LOOP and voicing the
//      single-voice "开始按压/跟着节拍/用力快压" cue (before the fix this was
//      无意图 and stuck at S5/S6).
//
// Everything is injected (mock TTS, stub runtime, disableStreamingStt + text
// `final` injection), so the suite never touches real sherpa / Gemma / network.
// Assertions use "substring contains + stage equals" tolerance, never whole
// sentence equality.

const MOCK_LOCATION = {
  address_line: "示例市示例区示范路 1 号",
  landmark: "地铁A口",
  latitude: 31.230416,
  longitude: 121.473701,
  accuracy_m: 18,
};

const BASELINE_SEQUENCE = ["thinking", "final", "guidance", "state", "audio_begin", "audio_end"];

// Readiness / "开始吧" phrases that the S6 fast path must map to continue_cpr.
const READINESS_PHRASES = ["我准备好了", "准备好了", "开始吧", "可以开始"];

function buildScenario(sessionId = "live_flow_test") {
  // Stub Gemma runtime: never patches, never resolves an intent, never spawns
  // Python. The mainline must stay fully deterministic on the state machine +
  // rule fast path + the S6 confirm gate.
  const runtime = {
    async generatePatch() {
      return { ok: true, skipped: true, skipReason: "stub_runtime", patch: null };
    },
    async parseUserIntent() {
      return { ok: false, reason: "stub_runtime", intent: null, slots: {}, confidence: 0 };
    },
    async prewarm() {
      return { ok: true, warmed: false, reason: "stub_runtime" };
    },
  };

  const service = createVoiceDemoService({ runtime, now: () => new Date().toISOString() });

  const tts = {
    cancel() {},
    async *speak() {
      yield { chunk: Buffer.from([1, 0]), sampleRate: 16000, channels: 1, bitsPerSample: 16 };
    },
  };

  const session = createLiveSession({ sessionId, service, tts, disableStreamingStt: true });

  const jsonEvents = [];
  const audioEvents = [];
  session.on("json", (event) => jsonEvents.push(event));
  session.on("audio", (chunk) => audioEvents.push(chunk));

  async function control(message) {
    await session.handleControl(message);
  }

  async function drive(message) {
    const jsonFrom = jsonEvents.length;
    const audioFrom = audioEvents.length;
    await session.handleControl(message);
    const json = jsonEvents.slice(jsonFrom);
    return {
      json,
      audio: audioEvents.slice(audioFrom),
      types: json.map((event) => event.type),
      segments: extractSegments(json),
      finalEvent: json.find((event) => event.type === "final") || null,
      finalStage: lastStage(json),
    };
  }

  return { sessionId, session, control, drive };
}

function extractSegments(turnJson) {
  const segments = [];
  let current = null;
  for (const event of turnJson) {
    if (event.type === "guidance") {
      current = {
        source: event.source ?? null,
        responseType: event.response_type ?? null,
        intent: event.action?.intent ?? null,
        stage: event.action?.stage ?? null,
        tts: event.action?.tts?.text ?? "",
        callBriefScript: event.action?.call_brief?.script ?? emergencyBrief(event.action),
        toolTypes: toolTypesOf(event.action),
        state: null,
        hasAudioBegin: false,
        hasAudioEnd: false,
      };
      segments.push(current);
    } else if (event.type === "state" && current) {
      if (event.current_stage) current.stage = event.current_stage;
      if (event.state) current.state = event.state;
    } else if (event.type === "audio_begin" && current) {
      current.hasAudioBegin = true;
    } else if (event.type === "audio_end" && current) {
      current.hasAudioEnd = true;
    }
  }
  return segments;
}

function toolTypesOf(action) {
  const tools = Array.isArray(action?.tool_actions)
    ? action.tool_actions
    : action?.tool_action
      ? [action.tool_action]
      : [];
  return tools.map((tool) => tool?.type || tool?.tool || tool?.name).filter(Boolean);
}

function emergencyBrief(action) {
  const tools = Array.isArray(action?.tool_actions) ? action.tool_actions : [];
  return tools.find((tool) => tool?.type === "emergency_call")?.briefing?.script ?? "";
}

function lastStage(turnJson) {
  const stages = turnJson
    .filter((event) => event.type === "state" && event.current_stage)
    .map((event) => event.current_stage);
  return stages[stages.length - 1] ?? null;
}

function assertIncludes(text, keywords, label) {
  for (const keyword of keywords) {
    assert.ok(text.includes(keyword), `${label} should include "${keyword}" (got: ${text})`);
  }
}

function assertIncludesAny(text, keywords, label) {
  const hit = keywords.some((keyword) => text.includes(keyword));
  assert.ok(hit, `${label} should include one of ${keywords.join(" | ")} (got: ${text})`);
}

// Drive P1/P2 + segments ①-③ so we stop at the first S6_CPR_READY confirm-gate
// prompt. Returns the auto-advance turn (the single "没有呼吸..." user turn) for reuse.
async function driveToCprReady(scenario) {
  await scenario.control({ type: "start", sessionId: scenario.sessionId });
  await scenario.control({
    type: "context",
    payload: { deviceState: { location: MOCK_LOCATION } },
  });
  await scenario.drive({
    type: "inject",
    eventSource: "demo_script",
    eventType: "session_started",
    deviceState: { recording: true, emergency_call_started: false },
    metadata: { adult_likely: true, recording: true },
  });
  await scenario.drive({ type: "final", text: "现场安全了，我在患者旁" });
  await scenario.drive({ type: "final", text: "他没有反应" });
  return scenario.drive({ type: "final", text: "没有呼吸，偶尔喘一下" });
}

test("段①②③ 四段主线贯通：session_started -> S1 -> S2 -> S3 -> 自动连跳停在 S6", async () => {
  const scenario = buildScenario();

  // P1 handshake.
  await scenario.control({ type: "start", sessionId: scenario.sessionId });

  // P2 mock GPS via context (cached, merged into every later turn).
  await scenario.control({
    type: "context",
    payload: { deviceState: { location: MOCK_LOCATION } },
  });

  // 段① step 1: session_started -> S1.
  const s1 = await scenario.drive({
    type: "inject",
    eventSource: "demo_script",
    eventType: "session_started",
    deviceState: { recording: true, emergency_call_started: false },
    metadata: { adult_likely: true, recording: true },
  });
  assert.deepEqual(s1.types, BASELINE_SEQUENCE);
  assert.equal(s1.finalStage, "S1_SCENE_SAFE");
  assert.equal(s1.segments[0].stage, "S1_SCENE_SAFE");
  assert.equal(s1.segments[0].source, "state_machine");
  assertIncludes(s1.segments[0].tts, ["周围安全", "靠近患者"], "S1 TTS");

  // 段① step 2: scene_safe -> S2.
  const s2 = await scenario.drive({ type: "final", text: "现场安全了，我在患者旁" });
  assert.deepEqual(s2.types, BASELINE_SEQUENCE);
  assert.equal(s2.finalEvent.intent, "scene_safe");
  assert.equal(s2.finalStage, "S2_CHECK_RESPONSE");
  assert.ok(["state_machine", "gemma_agent"].includes(s2.segments[0].source));
  assertIncludes(s2.segments[0].tts, ["轻拍", "双肩"], "S2 TTS");

  // 段② step 3: unresponsive -> S3 (critical).
  const s3 = await scenario.drive({ type: "final", text: "他没有反应" });
  assert.deepEqual(s3.types, BASELINE_SEQUENCE);
  assert.equal(s3.finalEvent.intent, "patient_unresponsive");
  assert.equal(s3.finalStage, "S3_CHECK_BREATHING");
  assert.equal(s3.segments[0].source, "state_machine_critical");
  assert.equal(s3.segments[0].intent, "ask_breathing_check");
  // S3 reframes agonal breathing directly (偶尔大口喘/不动 都算没有呼吸); no more "正常起伏".
  assertIncludes(s3.segments[0].tts, ["胸口", "偶尔大口喘", "没有呼吸"], "S3 TTS");

  // 段②③ step 4: agonal breathing -> S4, then bounded auto-advance S5 + S6.
  const auto = await scenario.drive({ type: "final", text: "没有呼吸，偶尔喘一下" });
  assert.equal(auto.finalEvent.intent, "agonal_breathing");
  assert.equal(auto.finalStage, "S6_CPR_READY");
  assert.deepEqual(
    auto.segments.map((segment) => segment.stage),
    ["S4_SUSPECTED_ARREST", "S5_CALL_EMERGENCY", "S6_CPR_READY"],
    "single user turn must chain S4 -> S5 -> S6 and stop at S6"
  );
  for (const segment of auto.segments) {
    assert.equal(segment.source, "state_machine_critical");
    assert.ok(segment.hasAudioBegin && segment.hasAudioEnd, "each auto segment streams audio");
  }

  const [s4, s5, s6] = auto.segments;
  assert.equal(s4.intent, "state_suspected_arrest_handling");
  assertIncludes(s4.tts, ["疑似", "胸外按压"], "S4 TTS");

  assert.equal(s5.intent, "start_emergency_call_and_cpr");
  assertIncludes(s5.tts, ["我将为你拨打", "120", "免提"], "S5 TTS");
  assertIncludes(
    s5.callBriefScript,
    ["这里是", "坐标", "无反应", "无正常呼吸", "按疑似心脏骤停处理", "请派救护车"],
    "S5 call brief"
  );
  assert.ok(s5.toolTypes.includes("emergency_call"), "S5 carries the emergency_call tool");

  // S6 is the single confirm gate: one positioning line + "说开始/点开始按压".
  assertIncludes(s6.tts, ["胸口中央", "胳膊伸直", "开始按压"], "S6 entry TTS");

  scenario.session.close();
});

test("自动连跳有界且停在 S6：恰好三段 guidance/state/audio、不越界进 S7", async () => {
  const scenario = buildScenario();
  const auto = await driveToCprReady(scenario);

  const stages = auto.segments.map((segment) => segment.stage);
  assert.deepEqual(stages, ["S4_SUSPECTED_ARREST", "S5_CALL_EMERGENCY", "S6_CPR_READY"]);
  assert.ok(!stages.includes("S7_CPR_LOOP"), "auto-advance must stop at S6, not enter S7");

  // Three guidance + three audio envelopes within a single shared turn_seq.
  const turnSeqs = new Set(
    auto.json.filter((event) => typeof event.turn_seq === "number").map((event) => event.turn_seq)
  );
  assert.equal(turnSeqs.size, 1, "auto-advance segments share the user turn's turn_seq");
  assert.equal(auto.json.filter((event) => event.type === "guidance").length, 3);
  assert.equal(auto.json.filter((event) => event.type === "audio_begin").length, 3);
  assert.equal(auto.json.filter((event) => event.type === "audio_end").length, 3);
  assert.equal(auto.audio.length, 3, "one PCM frame per spoken segment");

  // S5 carries the 120 briefing with the injected GPS coordinates + symptoms.
  const s5 = auto.segments[1];
  assertIncludes(
    s5.callBriefScript,
    ["坐标", "31.230416", "121.473701", "无反应", "无正常呼吸", "请派救护车"],
    "S5 briefing"
  );

  scenario.session.close();
});

test("S6 录制态视觉 CPR 质量不会推进到 S7 或启动节拍", async () => {
  const scenario = buildScenario("live_flow_recording_only_vision");
  await driveToCprReady(scenario);

  const recordingOnly = await scenario.drive({
    type: "inject",
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      compression_rate: 110,
      interruption_seconds: 0,
      hand_position: "left",
      arm_straight: false,
      quality_score: 40,
      confidence: 0.8,
      vision_ready: false,
      pose_coverage: 0.4,
      frame_stability: 0.2,
      observed_window_ms: 300,
    },
    metadata: {
      perception_mode: "recording_only",
      camera_facing: "front",
      camera_mount: "handheld",
      mirrored: true,
      vision_ready: false,
      pose_coverage: 0.4,
      frame_stability: 0.2,
      observed_window_ms: 300,
    },
  });

  assert.equal(recordingOnly.finalStage, "S6_CPR_READY");
  assert.ok(
    !recordingOnly.segments.some((segment) => segment.stage === "S7_CPR_LOOP"),
    "recording-only vision should not enter CPR loop"
  );
  assert.ok(
    !recordingOnly.segments.some((segment) => segment.toolTypes.includes("start_haptic_metronome")),
    "recording-only vision should not start the haptic metronome"
  );
  const lastState = recordingOnly.json.findLast((event) => event.type === "state")?.state;
  assert.notEqual(lastState?.cpr_state?.started, true);

  scenario.session.close();
});

test('核心回归：S6 说"我准备好了" -> 快路径 continue_cpr 翻转到 S7（rule_flow_fast_path）', async () => {
  const scenario = buildScenario();
  await driveToCprReady(scenario);

  const ready = await scenario.drive({ type: "final", text: "我准备好了" });

  // Single user turn (no auto-advance off S7): full baseline envelope.
  assert.deepEqual(ready.types, BASELINE_SEQUENCE);
  assert.equal(ready.segments.length, 1, "readiness is one guidance segment, not an auto-advance chain");

  // The fix: the state machine flips S6 -> S7 (before the fix it stuck at S5/S6).
  assert.equal(ready.finalStage, "S7_CPR_LOOP", "readiness must flip the stage to S7_CPR_LOOP");

  const seg = ready.segments[0];
  assert.equal(seg.stage, "S7_CPR_LOOP");
  // The deterministic readiness fast path marks its source explicitly.
  assert.equal(seg.source, "rule_flow_fast_path", "S6 readiness must be the deterministic flow fast path");
  // User intent is resolved to continue_cpr (was 无意图 before the fix).
  assert.equal(ready.finalEvent.intent, "continue_cpr", "readiness resolves to continue_cpr");
  assert.ok(
    ["continue_cpr", "start_cpr_loop"].includes(seg.intent),
    `guidance action intent should start the loop (got: ${seg.intent})`
  );
  // Voices the single-voice "开始按压 / 跟着节拍 / 用力快压" compression cue (no "震动").
  assertIncludes(seg.tts, ["开始按压", "跟着节拍", "用力快压"], "S7 startup TTS");
  // Compressions are marked as started so the haptic metronome can run.
  assert.equal(seg.state?.cpr_state?.started, true, "cpr_state.started must be true after readiness");

  scenario.session.close();
});

for (const phrase of READINESS_PHRASES) {
  test(`核心回归（就绪话术变体）："${phrase}" 在 S6 触发 S6->S7 快路径`, async () => {
    const scenario = buildScenario(`live_flow_ready_${phrase}`);
    await driveToCprReady(scenario);

    const ready = await scenario.drive({ type: "final", text: phrase });
    assert.equal(ready.finalStage, "S7_CPR_LOOP", `"${phrase}" must flip S6 -> S7`);
    assert.equal(ready.segments.length, 1);
    assert.equal(ready.segments[0].source, "rule_flow_fast_path");
    assertIncludes(ready.segments[0].tts, ["开始按压", "跟着节拍", "用力快压"], `"${phrase}" startup TTS`);

    scenario.session.close();
  });
}

test("段④被动问答：进入 S7 后随时插话经 rule_fast_path 即时作答、stage 不变", async () => {
  const scenario = buildScenario();
  await driveToCprReady(scenario);

  // Enter S7 via the readiness fast path.
  const enter = await scenario.drive({ type: "final", text: "我准备好了" });
  assert.equal(enter.finalStage, "S7_CPR_LOOP");

  const ask = await scenario.drive({ type: "final", text: "我能不能停" });
  assert.deepEqual(ask.types, BASELINE_SEQUENCE);
  assert.equal(ask.finalStage, "S7_CPR_LOOP", "passive question must not change the stage");
  assert.equal(ask.segments.length, 1, "no auto-advance on a passive question");
  assert.equal(ask.finalEvent.intent, "ask_can_stop");
  assert.equal(ask.segments[0].source, "rule_fast_path");
  assert.equal(ask.segments[0].responseType, "question_answer");
  assert.equal(ask.segments[0].intent, "answer_current_cpr_question");
  assertIncludes(ask.segments[0].tts, ["不要停", "继续按压"], "ask_can_stop answer");

  scenario.session.close();
});

test("ROSC 再入：S7 收到生命迹象 -> MONITOR_BREATHING（停按压/复原卧位）；再没反应 -> 重启回 S7", async () => {
  const scenario = buildScenario("live_flow_rosc_reentry");
  await driveToCprReady(scenario);

  // Enter S7 via the readiness fast path.
  const enter = await scenario.drive({ type: "final", text: "我准备好了" });
  assert.equal(enter.finalStage, "S7_CPR_LOOP");
  assert.equal(enter.segments[0].state?.cpr_state?.started, true);

  // ROSC: signs of life return during compressions -> stop and monitor breathing.
  const rosc = await scenario.drive({ type: "final", text: "他又喘气了" });
  assert.equal(rosc.finalEvent.intent, "signs_of_life", "signs-of-life utterance resolves to signs_of_life");
  assert.equal(rosc.finalStage, "MONITOR_BREATHING", "signs of life must move S7 -> MONITOR_BREATHING");
  assert.equal(rosc.segments.length, 1, "ROSC monitor is one segment (MONITOR is not an auto-advance stage)");
  // ROSC wording: stop compressions, recovery position, restart if they deteriorate.
  assertIncludes(rosc.segments[0].tts, ["停止按压", "复原姿势", "重新开始按压"], "ROSC monitor TTS");

  // Deteriorates again -> low-threshold restart back into the CPR loop with the startup cue.
  const restart = await scenario.drive({ type: "final", text: "他又没反应了" });
  assert.equal(restart.finalStage, "S7_CPR_LOOP", "MONITOR_BREATHING -> S7 restart on deterioration");
  assertIncludes(restart.segments[0].tts, ["开始按压", "跟着节拍", "用力快压"], "S7 restart TTS");

  scenario.session.close();
});
