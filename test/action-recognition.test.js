import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentStage,
  EventSource,
  EventType,
  Mode,
  createInitialSessionState,
  createPerceptionEvent,
} from "../src/domain/types.js";
import { createRuleFeedbackAction } from "../src/engine/ruleFeedbackEngine.js";
import { sessionReducer } from "../src/engine/sessionReducer.js";
import {
  createCprActionRecognitionEvent,
  recognizeCprActionFrame,
  stepAgentWithActionRecognition,
} from "../src/perception/index.js";

function createFrame(overrides = {}) {
  return {
    schema_version: "action_recognition_frame.v0.1",
    session_id: "sess_action_recognition",
    timestamp: "2026-06-04T12:00:02.200Z",
    timestamp_ms: 2200,
    sequence_id: 7,
    stage_hint: AgentStage.S7_CPR_LOOP,
    chest_center: { x: 0.5, y: 0.52, visibility: 0.92 },
    hand_center: { x: 0.39, y: 0.53, visibility: 0.88 },
    torso_width: 0.38,
    pose: {
      confidence: 0.86,
      landmarks: {
        left_shoulder: { x: 0.42, y: 0.3, visibility: 0.9 },
        left_elbow: { x: 0.43, y: 0.43, visibility: 0.9 },
        left_wrist: { x: 0.39, y: 0.53, visibility: 0.9 },
        right_shoulder: { x: 0.58, y: 0.3, visibility: 0.9 },
        right_elbow: { x: 0.55, y: 0.43, visibility: 0.9 },
        right_wrist: { x: 0.39, y: 0.53, visibility: 0.9 },
      },
    },
    compression_timestamps_ms: [0, 652, 1304, 1956],
    rescuer: {
      fatigue_score: 0.82,
      hesitation_seconds: 0,
    },
    ...overrides,
  };
}

test("recognizeCprActionFrame converts raw CPR observations into cpr_quality", () => {
  const result = recognizeCprActionFrame(createFrame());

  assert.equal(result.schema_version, "action_recognition_result.v0.1");
  assert.equal(result.source, EventSource.VISION_CPR);
  assert.equal(result.event_type, EventType.CPR_QUALITY_UPDATE);
  assert.equal(result.stage_hint, AgentStage.S7_CPR_LOOP);
  assert.equal(result.cpr_quality.hand_position, "left_offset");
  assert.equal(result.cpr_quality.compression_rate_bpm, 92);
  assert.equal(result.cpr_quality.compression_rate, 92);
  assert.equal(result.cpr_quality.current_rate, 92);
  assert.equal(result.cpr_quality.interruption_ms, 244);
  assert.equal(result.cpr_quality.compressions_started, true);
  assert.equal(result.cpr_quality.arm_straight, false);
  assert.equal(result.cpr_quality.arm_posture, "bent");
  assert.equal(result.rescuer_state.fatigue_level, "high");
  assert.ok(result.cpr_quality.quality_score < 70);
  assert.ok(result.cpr_quality.confidence >= 0.7);
});

test("createCprActionRecognitionEvent emits the standard PerceptionEvent contract", () => {
  const event = createCprActionRecognitionEvent(createFrame(), { mode: Mode.REAL_PERCEPTION });

  assert.equal(event.schema_version, "perception_event.v0.1");
  assert.equal(event.source, EventSource.VISION_CPR);
  assert.equal(event.event_type, EventType.CPR_QUALITY_UPDATE);
  assert.equal(event.stage_hint, AgentStage.S7_CPR_LOOP);
  assert.equal(event.ttl_ms, 1500);
  assert.equal(event.cpr_quality.hand_position, "left_offset");
  assert.equal(event.metadata.recognizer, "cpr_action_heuristic_v0.1");
});

test("stepAgentWithActionRecognition feeds recognized events into rule feedback", () => {
  const state = createInitialSessionState({
    sessionId: "sess_action_recognition_agent",
    mode: Mode.DEMO_ASSISTED,
    currentStage: AgentStage.S7_CPR_LOOP,
    overrides: {
      confirmed_facts: {
        suspected_cardiac_arrest: true,
      },
      cpr_state: {
        started: true,
        started_at: "2026-06-04T12:00:00.000Z",
      },
    },
  });

  const turn = stepAgentWithActionRecognition(
    state,
    createFrame({ session_id: "sess_action_recognition_agent" }),
    { now: () => "2026-06-04T12:00:02.300Z" },
  );

  assert.equal(turn.event.source, EventSource.VISION_CPR);
  assert.equal(turn.state.cpr_state.hand_position, "left_offset");
  assert.equal(turn.action.source, "rule_feedback");
  assert.equal(turn.action.intent, "correct_hand_position");
  assert.deepEqual(turn.action.reason_codes, ["hand_position_left_offset"]);
});

test("recognizer estimates compression rate from displacement peaks when timestamps are absent", () => {
  const result = recognizeCprActionFrame(
    createFrame({
      compression_timestamps_ms: undefined,
      timestamp_ms: 2600,
      compression_samples: [
        { timestamp_ms: 0, depth_mm: 0 },
        { timestamp_ms: 180, depth_mm: 24 },
        { timestamp_ms: 330, depth_mm: 4 },
        { timestamp_ms: 650, depth_mm: 0 },
        { timestamp_ms: 820, depth_mm: 25 },
        { timestamp_ms: 980, depth_mm: 3 },
        { timestamp_ms: 1300, depth_mm: 0 },
        { timestamp_ms: 1470, depth_mm: 25 },
        { timestamp_ms: 1630, depth_mm: 4 },
      ],
    }),
  );

  assert.equal(result.cpr_quality.total_compressions, 3);
  assert.ok(result.cpr_quality.compression_rate >= 90);
  assert.ok(result.cpr_quality.compression_rate <= 100);
});

test("recognizer preserves direct normalized cpr_quality when Android already provides it", () => {
  const result = recognizeCprActionFrame({
    session_id: "sess_direct_cpr_quality",
    timestamp: "2026-06-04T12:00:01.000Z",
    timestamp_ms: 1000,
    cpr_quality: {
      camera_view: "side_front",
      compression_started: true,
      compression_rate_bpm: 110,
      interruption_ms: 0,
      hand_position: "center",
      arm_straight: true,
      quality_score: 91,
      confidence: 0.77,
      observed_window_ms: 3000,
    },
  });

  assert.equal(result.cpr_quality.camera_view, "side_front");
  assert.equal(result.cpr_quality.compression_started, true);
  assert.equal(result.cpr_quality.compressions_started, true);
  assert.equal(result.cpr_quality.compression_rate_bpm, 110);
  assert.equal(result.cpr_quality.interruption_ms, 0);
  assert.equal(result.cpr_quality.interruption_seconds, 0);
  assert.equal(result.cpr_quality.hand_position, "center");
  assert.equal(result.cpr_quality.arm_straight, true);
  assert.equal(result.cpr_quality.arm_posture, "straight");
  assert.equal(result.cpr_quality.quality_score, 91);
  assert.equal(result.cpr_quality.observed_window_ms, 3000);
});

test("unknown hand position does not trigger hand-position correction", () => {
  const state = createInitialSessionState({
    sessionId: "sess_unknown_hand_position",
    currentStage: AgentStage.S7_CPR_LOOP,
    overrides: {
      scope: {
        adult_likely: true,
        scene_safe: true,
      },
      confirmed_facts: {
        responsive: false,
        normal_breathing: false,
        suspected_cardiac_arrest: true,
      },
      cpr_state: {
        started: true,
        started_at: "2026-06-04T12:00:00.000Z",
      },
    },
  });

  const turn = stepAgentWithActionRecognition(
    state,
    {
      session_id: "sess_unknown_hand_position",
      timestamp_ms: 2200,
      cpr_quality: {
        compression_started: true,
        compression_rate_bpm: 110,
        interruption_ms: 0,
        arm_straight: true,
        confidence: 0.55,
      },
    },
    { now: () => "2026-06-04T12:00:02.300Z" },
  );

  assert.equal(turn.event.cpr_quality.hand_position, "unknown");
  assert.notEqual(turn.action.intent, "correct_hand_position");
  assert.equal(turn.transition.action.intent, "continue_cpr_loop");
});

test("reducer and rule feedback accept v1.1 CPR quality field names", () => {
  const state = createInitialSessionState({
    sessionId: "sess_cpr_v11",
    currentStage: AgentStage.S7_CPR_LOOP,
    overrides: {
      cpr_state: { started: true },
    },
  });
  const event = createPerceptionEvent({
    sessionId: "sess_cpr_v11",
    source: EventSource.VISION_CPR,
    eventType: EventType.CPR_QUALITY_UPDATE,
    stageHint: AgentStage.S7_CPR_LOOP,
    cprQuality: {
      compression_started: false,
      compression_rate_bpm: 88,
      interruption_ms: 2600,
      hand_position: "center",
      arm_straight: true,
      quality_score: 58,
      confidence: 0.84,
      observed_window_ms: 3000,
    },
  });

  const next = sessionReducer(state, event);
  assert.equal(next.cpr_state.started, false);
  assert.equal(next.cpr_state.current_rate, 88);
  assert.equal(next.cpr_state.last_interruption_seconds, 2.6);

  const action = createRuleFeedbackAction(
    { ...next, current_stage: AgentStage.S7_CPR_LOOP },
    event,
  );
  assert.equal(action.intent, "correct_compression_interruption");
  assert.ok(action.reason_codes.includes("compression_interrupted"));
});
