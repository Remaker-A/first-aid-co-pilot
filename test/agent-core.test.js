import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentStage,
  cameraFrameSignalToPerceptionEvent,
  createPerceptionEvent,
  decideCprStart,
  getKnowledgeVersion,
  isIntentAllowed,
  normalizeAllowedIntents,
  reduceSessionEvent,
  runDemoPipeline,
  validateAction
} from "../src/index.js";

const ALL_STAGES = [
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
  "MONITOR_RESPONSE",
  "MONITOR_BREATHING"
];

test("knowledge base loads a single intent vocabulary version", () => {
  const version = getKnowledgeVersion();
  assert.equal(typeof version, "string");
  assert.notEqual(version, "unknown");
});

test("decisionFrame allowed intents are all accepted by the action validator", () => {
  for (const stage of ALL_STAGES) {
    for (const intent of normalizeAllowedIntents(stage)) {
      const allowed = isIntentAllowed(
        { stage, intent, source: "gemma_agent" },
        { current_stage: stage }
      );
      assert.equal(allowed, true, `intent ${intent} should be allowed at ${stage}`);
    }
  }
});

test("action validator blocks a knowledge-base forbidden phrase not covered by regex", () => {
  const validation = validateAction(
    {
      stage: AgentStage.S6_CPR_READY,
      intent: "guide_cpr_position",
      source: "gemma_agent",
      tts: { text: "现在我来解释心肺复苏的原理。", tone: "calm_firm" },
      ui: { main_text: "解释", secondary_text: "" }
    },
    { current_stage: AgentStage.S6_CPR_READY }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("forbidden_speech"));
});

test("CPR start rule starts CPR when adult is unresponsive and breathing is not normal", () => {
  const decision = decideCprStart({
    scope: { adult_likely: true },
    confirmed_facts: {
      responsive: false,
      normal_breathing: null,
      agonal_breathing: true
    }
  });

  assert.equal(decision, "START_CPR");
});

test("CPR start rule does not start CPR when normal breathing is confirmed", () => {
  const decision = decideCprStart({
    scope: { adult_likely: true },
    confirmed_facts: {
      responsive: false,
      normal_breathing: true
    }
  });

  assert.equal(decision, "MONITOR_AND_CALL_HELP");
});

test("CPR start rule waits for breathing evidence before starting CPR", () => {
  const decision = decideCprStart({
    scope: { adult_likely: true },
    confirmed_facts: {
      responsive: false,
      normal_breathing: null,
      agonal_breathing: null
    }
  });

  assert.equal(decision, "PREPARE_EMERGENCY_CALL");
});

test("demo replay reaches handover and generates a report", async () => {
  const scriptPath = resolve("knowledge", "demo_script_cpr_main_v1.json");
  const script = JSON.parse(await readFile(scriptPath, "utf8"));
  const result = runDemoPipeline({ script });

  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(
    result.actions.filter((action) => action.intent === "generate_handover_report").length,
    1
  );
  assert.equal(result.actions.at(-1).intent, "explain_handover");
  assert.match(result.report.text, /交接报告/);
});

test("monitor branches can call emergency services without CPR diagnosis", () => {
  for (const stage of [AgentStage.MONITOR_RESPONSE, AgentStage.MONITOR_BREATHING]) {
    const validation = validateAction(
      {
        stage,
        intent: stage === AgentStage.MONITOR_RESPONSE
          ? "monitor_responsive_patient"
          : "monitor_breathing_patient",
        priority: "high",
        source: "state_machine",
        tts: { text: "请呼叫 120 并持续观察。", tone: "calm_firm" },
        tool_actions: [{ type: "emergency_call", requires_user_confirmation: false }]
      },
      { current_stage: stage }
    );

    assert.equal(validation.ok, true, `${stage} should allow emergency_call`);
  }
});

test("device camera status is tracked without creating recognition facts", () => {
  const state = reduceSessionEvent(undefined, createPerceptionEvent({
    sessionId: "sess_camera_ready",
    source: "device",
    eventType: "device_state_update",
    deviceState: {
      camera_available: true,
      camera_permission: "granted",
      camera_facing: "back",
      camera_preview_active: true,
      camera_stream_status: "previewing",
    },
  }));

  assert.equal(state.tool_state.camera_available, true);
  assert.equal(state.tool_state.camera_permission, "granted");
  assert.equal(state.tool_state.camera_facing, "back");
  assert.equal(state.tool_state.camera_preview_active, true);
  assert.equal(state.tool_state.camera_stream_status, "previewing");
  assert.equal(state.confirmed_facts.responsive, null);
  assert.equal(state.confirmed_facts.normal_breathing, null);
  assert.equal(state.cpr_state.quality_score, null);
});

test("camera frame signal adapter emits device readiness only", () => {
  const event = cameraFrameSignalToPerceptionEvent({
    sessionId: "sess_camera_frame",
    cameraFrameSignal: {
      frameId: "frame_001",
      width: 1280,
      height: 720,
      rotationDegrees: 90,
      brightness: 126.4,
      motionScore: 21,
    },
  });
  const state = reduceSessionEvent(undefined, event);

  assert.equal(event.source, "device");
  assert.equal(event.event_type, "device_state_update");
  assert.equal(event.patient_state, null);
  assert.equal(event.cpr_quality, null);
  assert.equal(event.rescuer_state, null);
  assert.equal(event.metadata.camera_frame_signal.brightness_label, "usable");
  assert.equal(event.metadata.camera_frame_signal.motion_label, "high_motion");
  assert.equal(state.tool_state.camera_stream_status, "analyzing");
  assert.equal(state.confirmed_facts.responsive, null);
  assert.equal(state.cpr_state.quality_score, null);
});

test("responsive handover report does not claim suspected cardiac arrest", () => {
  const result = runDemoPipeline({
    sessionId: "sess_responsive_handover",
    script: [
      {
        at_ms: 0,
        event: {
          source: "demo_script",
          event_type: "session_started",
          patient_state: { adult_likely: true, responsive: null, normal_breathing: null }
        }
      },
      {
        at_ms: 1000,
        event: {
          source: "demo_script",
          event_type: "patient_state_update",
          patient_state: { adult_likely: true },
          metadata: { scene_safe: true }
        }
      },
      {
        at_ms: 2000,
        event: {
          source: "stt",
          event_type: "user_response",
          user_input: {
            stt_text: "他有反应",
            intent: "patient_responsive",
            confidence: 0.9
          },
          patient_state: { adult_likely: true, responsive: true }
        }
      },
      {
        at_ms: 3000,
        event: {
          source: "demo_script",
          event_type: "handover_requested",
          metadata: { ems_arrived: true }
        }
      }
    ]
  });

  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(result.state.confirmed_facts.responsive, true);
  assert.equal(result.state.confirmed_facts.suspected_cardiac_arrest, false);
  assert.equal(result.report.json.symptoms.suspected_cardiac_arrest, false);
  assert.doesNotMatch(result.report.text, /疑似心脏骤停/);
});

test("action validator blocks forbidden diagnostic language", () => {
  const validation = validateAction(
    {
      stage: AgentStage.S4_SUSPECTED_ARREST,
      intent: "state_suspected_arrest_handling",
      priority: "normal",
      source: "gemma_agent",
      tts: { text: "他已经心脏骤停了。", tone: "calm_firm" },
      ui: { main_text: "错误诊断", secondary_text: "" }
    },
    { current_stage: AgentStage.S4_SUSPECTED_ARREST }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("forbidden_speech"));
});

test("action validator requires confirmation before sharing video", () => {
  const validation = validateAction(
    {
      stage: AgentStage.S9_HANDOVER,
      intent: "request_share_video",
      priority: "normal",
      source: "gemma_agent",
      tool_actions: [{ type: "share_video", requires_user_confirmation: true }],
      tts: { text: "请确认是否分享视频。", tone: "calm_firm" }
    },
    { current_stage: AgentStage.S9_HANDOVER }
  );

  assert.equal(validation.ok, false);
  assert.ok(
    validation.violations.includes("tool_requires_user_confirmation:share_video")
  );
});
