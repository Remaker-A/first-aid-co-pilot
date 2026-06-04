import assert from "node:assert/strict";
import test from "node:test";
import { stepAgentTurn } from "../src/agent/runPipeline.js";
import { AgentStage } from "../src/domain/stages.js";
import { createInitialSessionState } from "../src/engine/sessionReducer.js";

const NOW = "2026-06-04T13:30:00.000Z";

function createCprLoopState(sessionId = "vision_rule_feedback") {
  return createInitialSessionState({
    session_id: sessionId,
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
      total_compressions: 20,
      current_rate: 110,
      average_rate: 110,
      quality_score: 80,
      last_interruption_seconds: 0,
      last_correction: null,
      hand_position: "center",
      arm_straight: true,
      quality_source: "vision_cpr",
      quality_confidence: 0.9,
    },
  });
}

function createRealVisionEvent(cprQuality, sessionId = "vision_rule_feedback", metadata = {}) {
  return {
    event_id: `${sessionId}_event`,
    session_id: sessionId,
    timestamp: NOW,
    source: "vision_cpr",
    event_type: "cpr_quality_update",
    metadata,
    cpr_quality: {
      compressions_started: true,
      compression_rate: 110,
      interruption_seconds: 0,
      hand_position: "center",
      arm_straight: true,
      quality_score: 80,
      total_compressions: 24,
      confidence: 0.9,
      ...cprQuality,
    },
  };
}

function runRuleFeedbackCase(cprQuality, sessionId) {
  return stepAgentTurn(
    createCprLoopState(sessionId),
    createRealVisionEvent(cprQuality, sessionId),
    { now: () => NOW },
  );
}

test("vision_cpr CPR quality events produce rule feedback from canonical vision fields", () => {
  const cases = [
    {
      name: "hand_position left",
      cprQuality: { hand_position: "left" },
      intent: "correct_hand_position",
      reasonCode: "hand_position_left_offset",
    },
    {
      name: "arm_straight false",
      cprQuality: { arm_straight: false },
      intent: "correct_arm_posture",
      reasonCode: "arm_bent",
    },
    {
      name: "interruption_seconds above threshold",
      cprQuality: { compression_rate: null, current_rate: null, interruption_seconds: 2.2 },
      intent: "correct_compression_interruption",
      reasonCode: "compression_interrupted",
    },
    {
      name: "compression_rate low",
      cprQuality: { compression_rate: 88 },
      intent: "correct_compression_rate",
      reasonCode: "compression_rate_low",
    },
    {
      name: "compression_rate high",
      cprQuality: { compression_rate: 132 },
      intent: "correct_compression_rate",
      reasonCode: "compression_rate_high",
    },
  ];

  for (const { name, cprQuality, intent, reasonCode } of cases) {
    const result = runRuleFeedbackCase(cprQuality, `real_vision_${name.replaceAll(/\W+/g, "_")}`);

    assert.equal(result.state.current_stage, AgentStage.S7_CPR_LOOP, name);
    assert.equal(result.state.cpr_state.quality_source, "vision_cpr", name);
    assert.equal(result.action?.source, "rule_feedback", name);
    assert.equal(result.action?.intent, intent, name);
    assert.ok(result.action?.reason_codes.includes(reasonCode), name);
  }
});

test("recording-only vision_cpr events do not trigger hand-position correction", () => {
  const result = stepAgentTurn(
    createCprLoopState("recording_only_hand_left"),
    createRealVisionEvent(
      {
        hand_position: "left",
        vision_ready: false,
        pose_coverage: 0.42,
        frame_stability: 0.2,
        observed_window_ms: 350,
      },
      "recording_only_hand_left",
      {
        perception_mode: "recording_only",
        camera_facing: "front",
        camera_mount: "handheld",
        mirrored: true,
        vision_ready: false,
        pose_coverage: 0.42,
        frame_stability: 0.2,
        observed_window_ms: 350,
      },
    ),
    { now: () => NOW },
  );

  assert.equal(result.state.current_stage, AgentStage.S7_CPR_LOOP);
  assert.equal(result.state.cpr_state.hand_position, "center");
  assert.notEqual(result.action?.source, "rule_feedback");
  assert.notEqual(result.action?.intent, "correct_hand_position");
  assert.ok(!result.action?.reason_codes?.includes("hand_position_left_offset"));
});

test("fresh vision rate feedback takes priority over stale interruption seconds", () => {
  const result = runRuleFeedbackCase(
    { compression_rate: 86, interruption_seconds: 2.4 },
    "fresh_rate_over_interruption",
  );

  assert.equal(result.action?.intent, "correct_compression_rate");
  assert.ok(result.action?.reason_codes?.includes("compression_rate_low"));
  assert.ok(!result.action?.reason_codes?.includes("compression_interrupted"));
});

test("vision interruption still triggers when no fresh compression rate is available", () => {
  const result = runRuleFeedbackCase(
    { compression_rate: null, current_rate: null, interruption_seconds: 2.4 },
    "interruption_without_fresh_rate",
  );

  assert.equal(result.action?.intent, "correct_compression_interruption");
  assert.ok(result.action?.reason_codes?.includes("compression_interrupted"));
});
