import assert from "node:assert/strict";
import test from "node:test";

import { stepAgentTurn } from "../src/agent/runPipeline.js";
import { AgentStage } from "../src/domain/stages.js";
import { createInitialSessionState, sessionReducer } from "../src/engine/sessionReducer.js";
import { createLiveSession } from "../src/voice/liveSession.js";

const NOW = "2026-06-05T10:00:00.000Z";

function createSilentTts() {
  return {
    cancel() {},
    async *speak() {},
  };
}

function createGuidanceResult({
  payload,
  stage,
  intent,
  source = "state_machine",
  priority = "normal",
  scope = {},
}) {
  return {
    transcript: payload.text || "",
    stt: { intent: null },
    guidance_action: {
      action_id: `act_${stage}_${intent}`,
      stage,
      intent,
      priority,
      source,
      reason_codes: [],
      tts: { text: "", tone: "calm_firm", speed: "normal", interrupt_policy: "do_not_interrupt_critical" },
      ui: { main_text: "", secondary_text: "", status_tags: [] },
      haptic: { enabled: false },
      tool_actions: [],
      log_event: { type: intent, detail: intent },
    },
    guidance_source: source,
    response_type: "flow_instruction",
    state: {
      session_id: "autonomous_loop",
      current_stage: stage,
      scope: {
        ...scope,
        entry_source: payload.metadata?.entry_source ?? (payload.metadata?.wake_phrase ? "wake_phrase" : scope.entry_source),
        wake_phrase: payload.metadata?.wake_phrase ?? scope.wake_phrase,
      },
      cpr_state: { started: stage === AgentStage.S7_CPR_LOOP, current_rate: 110 },
    },
  };
}

function createProtectiveAdvanceService() {
  const calls = [];
  const scope = {};
  return {
    calls,
    async createGuidance(payload = {}) {
      calls.push(payload);
      if (payload.metadata?.entry_source) {
        scope.entry_source = payload.metadata.entry_source;
      }
      if (payload.metadata?.wake_phrase) {
        scope.wake_phrase = payload.metadata.wake_phrase;
        scope.entry_source ??= "wake_phrase";
      }
      if (payload.patientState?.responsive === false) {
        return createGuidanceResult({
          payload,
          stage: AgentStage.S3_CHECK_BREATHING,
          intent: "ask_breathing_check",
          source: "state_machine_critical",
          priority: "high",
          scope,
        });
      }
      if (payload.patientState?.normal_breathing === false) {
        return createGuidanceResult({
          payload,
          stage: AgentStage.S4_SUSPECTED_ARREST,
          intent: "state_suspected_arrest_handling",
          source: "state_machine_critical",
          priority: "critical",
          scope,
        });
      }
      if (payload.metadata?.auto_advance_from === AgentStage.S4_SUSPECTED_ARREST) {
        return createGuidanceResult({
          payload,
          stage: AgentStage.S5_CALL_EMERGENCY,
          intent: "start_emergency_call_and_cpr",
          source: "state_machine_critical",
          priority: "critical",
          scope,
        });
      }
      if (payload.deviceState?.emergency_call_started === true) {
        return createGuidanceResult({
          payload,
          stage: AgentStage.S6_CPR_READY,
          intent: "mark_cpr_ready",
          source: "state_machine_critical",
          priority: "critical",
          scope,
        });
      }
      return createGuidanceResult({
        payload,
        stage: AgentStage.S2_CHECK_RESPONSE,
        intent: "ask_response_check",
        scope,
      });
    },
  };
}

function createEncouragementService() {
  const calls = [];
  return {
    calls,
    async createGuidance(payload = {}) {
      calls.push(payload);
      return createGuidanceResult({
        payload,
        stage: AgentStage.S7_CPR_LOOP,
        intent: payload.eventType === "encourage_tick" ? "encourage_rescuer" : "noop",
        source: payload.eventType === "encourage_tick" ? "rule_feedback" : "state_machine",
      });
    },
  };
}

function createCprLoopState(overrides = {}) {
  return createInitialSessionState({
    session_id: "autonomous_rule_feedback",
    timestamp: NOW,
    current_stage: AgentStage.S7_CPR_LOOP,
    scope: {
      scene_safe: true,
      adult_likely: true,
    },
    confirmed_facts: {
      responsive: false,
      normal_breathing: false,
      agonal_breathing: true,
      suspected_cardiac_arrest: true,
      conflicts: [],
      evidence: [],
    },
    tool_state: {
      emergency_call_status: "started",
    },
    cpr_state: {
      started: true,
      started_at: NOW,
      total_compressions: 42,
      current_rate: 110,
      average_rate: 110,
      quality_score: 85,
      last_interruption_seconds: 0,
      hand_position: "center",
      arm_straight: true,
      quality_source: "vision_cpr",
      quality_confidence: 0.9,
    },
    ...overrides,
  });
}

function createEncourageTickEvent(overrides = {}) {
  return {
    event_id: "encourage_tick_event",
    session_id: "autonomous_rule_feedback",
    timestamp: NOW,
    source: "system",
    event_type: "encourage_tick",
    metadata: { encourage_tick: true, autonomous_tick: true },
    ...overrides,
  };
}

function mockDateNow(initialNow) {
  const original = Date.now;
  let current = initialNow;
  Date.now = () => current;
  return {
    set(value) {
      current = value;
    },
    restore() {
      Date.now = original;
    },
  };
}

test("自主 tick：S2/S3 沉默保护推进，并在自动连跳后停在 S6", async () => {
  const clock = mockDateNow(1_000);
  const service = createProtectiveAdvanceService();
  const session = createLiveSession({
    service,
    tts: createSilentTts(),
    disableStreamingStt: true,
    tick: { observationWindowMs: 10, wakeWindowMs: 5 },
  });
  const states = [];
  session.on("json", (event) => {
    if (event.type === "state" && event.current_stage) states.push(event.current_stage);
  });

  try {
    session.currentStage = AgentStage.S2_CHECK_RESPONSE;
    session.stageEnteredAt = 980;
    await session.maybeAutonomousAdvance();

    assert.equal(session.currentStage, AgentStage.S3_CHECK_BREATHING);
    assert.equal(service.calls[0].patientState.responsive, false);
    assert.ok(!states.includes(AgentStage.S7_CPR_LOOP), "S2 timeout must not jump to S7");

    clock.set(2_000);
    session.stageEnteredAt = 1_980;
    await session.maybeAutonomousAdvance();

    assert.deepEqual(
      states.slice(-4),
      [
        AgentStage.S3_CHECK_BREATHING,
        AgentStage.S4_SUSPECTED_ARREST,
        AgentStage.S5_CALL_EMERGENCY,
        AgentStage.S6_CPR_READY,
      ],
    );
    assert.equal(session.currentStage, AgentStage.S6_CPR_READY);
    assert.ok(!states.includes(AgentStage.S7_CPR_LOOP), "protective advance must stop at S6");
  } finally {
    session.close();
    clock.restore();
  }
});

test("metadata 记录唤醒词入口先验到 session scope", () => {
  const state = sessionReducer(createInitialSessionState({ session_id: "wake_prior" }), {
    session_id: "wake_prior",
    event_type: "session_started",
    metadata: { wake_phrase: "急救急救" },
  });

  assert.equal(state.scope.wake_phrase, "急救急救");
  assert.equal(state.scope.entry_source, "wake_phrase");
});

test("唤醒词先验只压短 S2/S3 观察窗，不跳过 S3", async () => {
  const clock = mockDateNow(1_000);

  try {
    const defaultService = createProtectiveAdvanceService();
    const defaultSession = createLiveSession({
      service: defaultService,
      tts: createSilentTts(),
      disableStreamingStt: true,
      tick: { observationWindowMs: 120, wakeWindowMs: 50 },
    });
    defaultSession.currentStage = AgentStage.S2_CHECK_RESPONSE;
    defaultSession.stageEnteredAt = 1_000;
    clock.set(1_060);
    await defaultSession.maybeAutonomousAdvance();
    assert.equal(defaultService.calls.length, 0, "without wake prior, 60ms is below the 120ms window");
    defaultSession.close();

    const wakeService = createProtectiveAdvanceService();
    const wakeSession = createLiveSession({
      service: wakeService,
      tts: createSilentTts(),
      disableStreamingStt: true,
      tick: { observationWindowMs: 120, wakeWindowMs: 50 },
    });
    await wakeSession.processTurn({
      eventSource: "system",
      eventType: "session_started",
      metadata: { wake_phrase: "急救急救" },
    });
    wakeSession.stageEnteredAt = 1_000;
    clock.set(1_060);
    await wakeSession.maybeAutonomousAdvance();

    assert.equal(wakeSession.wakePhrasePrior, true);
    assert.equal(wakeService.calls.at(-1).patientState.responsive, false);
    assert.equal(wakeSession.currentStage, AgentStage.S3_CHECK_BREATHING);
    assert.equal(
      wakeService.calls.at(-1).patientState.normal_breathing,
      undefined,
      "wake prior must not prefill breathing conclusion",
    );
    wakeSession.close();
  } finally {
    clock.restore();
  }
});

test("S7 鼓励 tick 受节流与近期纠错静默门控", async () => {
  const clock = mockDateNow(2_000);
  const service = createEncouragementService();
  const session = createLiveSession({
    service,
    tts: createSilentTts(),
    disableStreamingStt: true,
    tick: { encourage: true, encouragementIntervalMs: 1_000, encourageQuietMs: 500 },
  });

  try {
    session.currentStage = AgentStage.S7_CPR_LOOP;
    session.stageEnteredAt = 1_000;

    await session.maybeAutonomousAdvance();
    assert.equal(service.calls.filter((call) => call.eventType === "encourage_tick").length, 1);

    clock.set(2_500);
    await session.maybeAutonomousAdvance();
    assert.equal(service.calls.filter((call) => call.eventType === "encourage_tick").length, 1);

    clock.set(3_200);
    session.lastCorrectionAt = 3_000;
    await session.maybeAutonomousAdvance();
    assert.equal(service.calls.filter((call) => call.eventType === "encourage_tick").length, 1);

    clock.set(3_600);
    await session.maybeAutonomousAdvance();
    assert.equal(service.calls.filter((call) => call.eventType === "encourage_tick").length, 2);
  } finally {
    session.close();
    clock.restore();
  }
});

test("S7 鼓励规则：质量良好才鼓励，有纠错指标时纠错优先", () => {
  const encourage = stepAgentTurn(
    createCprLoopState(),
    createEncourageTickEvent(),
    { now: () => NOW },
  );

  assert.equal(encourage.state.current_stage, AgentStage.S7_CPR_LOOP);
  assert.equal(encourage.action?.source, "rule_feedback");
  assert.equal(encourage.action?.intent, "encourage_rescuer");
  assert.equal(encourage.action?.priority, "normal");
  assert.equal(encourage.action?.throttle_key, "encourage.s7");
  assert.equal(encourage.action?.min_interval_ms, 20000);
  assert.equal(encourage.action?.tts?.text, "你做得很好，跟着节拍继续。");
  assert.deepEqual(encourage.action?.haptic, { enabled: false });

  const correction = stepAgentTurn(
    createCprLoopState(),
    createEncourageTickEvent({
      source: "vision_cpr",
      event_type: "cpr_quality_update",
      cpr_quality: {
        compressions_started: true,
        compression_rate: 88,
        interruption_seconds: 0,
        hand_position: "center",
        arm_straight: true,
        quality_score: 70,
        confidence: 0.9,
      },
    }),
    { now: () => NOW },
  );

  assert.equal(correction.action?.source, "rule_feedback");
  assert.equal(correction.action?.intent, "correct_compression_rate");
  assert.ok(correction.action?.reason_codes.includes("compression_rate_low"));
  assert.notEqual(correction.action?.intent, "encourage_rescuer");
});
