import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentStage, AgentStageOrder } from "../src/domain/stages.js";
import { runDemoPipeline, stepAgentTurn } from "../src/agent/runPipeline.js";
import { createInitialSessionState } from "../src/domain/types.js";
import { DemoEventPlayer } from "../src/demo/demoEventPlayer.js";
import {
  createGuidanceDispatcher,
  DELIBERATELY_SILENT_INTENTS,
} from "../src/dispatch/index.js";

const SCRIPT_PATH = resolve("knowledge", "scenario_collapse_vision_v1.json");

// Visual-only sources allowed in this scenario. STT is deliberately excluded so the
// test proves the vision/device perception chain can drive S0->S9 on its own.
const ALLOWED_EVENT_SOURCES = new Set([
  "vision_patient",
  "vision_cpr",
  "vision_rescuer",
  "device",
  "demo_script",
]);

const CORRECTION_INTENTS = [
  "correct_hand_position",
  "correct_compression_rate",
  "correct_arm_posture",
  "correct_compression_interruption",
];

// Milestone intents that must appear in this temporal order across the run.
const ORDERED_KEY_INTENTS = [
  "ask_response_check",
  "ask_breathing_check",
  "start_emergency_call_and_cpr",
  "guide_cpr_position",
  "start_cpr_loop",
  "correct_hand_position",
  "correct_compression_rate",
  "correct_arm_posture",
  "correct_compression_interruption",
  "assist_rescuer_fatigue",
  "assist_aed",
  "generate_handover_report",
  "explain_handover",
];

async function loadScenario() {
  return JSON.parse(await readFile(SCRIPT_PATH, "utf8"));
}

function distinctInOrder(values) {
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  }
  return ordered;
}

// Is `needles` an ordered (not necessarily contiguous) subsequence of `haystack`?
function isSubsequence(needles, haystack) {
  let cursor = 0;
  for (const item of haystack) {
    if (item === needles[cursor]) {
      cursor += 1;
      if (cursor === needles.length) {
        return true;
      }
    }
  }
  return cursor === needles.length;
}

function toolDeliveryOf(result) {
  return result.deliveries.find((delivery) => delivery.channel === "tool");
}

// Drives the scenario one event at a time through the exported stepAgentTurn API
// (rule-only, no Gemma runtime), pairing each emitted action with its source event.
function driveWithStepper(script) {
  const events = new DemoEventPlayer({
    script,
    mode: "demo_replay",
    sessionId: "sess_scenario_step",
  }).events();

  let state = createInitialSessionState({ sessionId: "sess_scenario_step", mode: "demo_replay" });
  const turns = [];
  for (const event of events) {
    const turn = stepAgentTurn(state, event);
    assert.equal(typeof turn.then, "undefined", "stepAgentTurn must stay synchronous without a runtime");
    state = turn.state;
    if (turn.action) {
      turns.push({ event, action: turn.action, source: turn.source });
    }
  }
  return { events, turns, finalState: state };
}

test("scenario reaches S9_HANDOVER and the stage sequence covers S0->S9", async () => {
  const script = await loadScenario();
  const result = runDemoPipeline({ script, sessionId: "sess_scenario" });

  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);

  const stageProgression = distinctInOrder(result.actions.map((action) => action.stage));
  // S0 is the implicit initial stage (no action is emitted while still in S0); the
  // first emitted action already belongs to S1, and the run climbs through S9.
  assert.deepEqual(stageProgression, AgentStageOrder.slice(1));
  assert.equal(AgentStageOrder[0], AgentStage.S0_INIT);
});

test("key intents appear in order and all four vision corrections fire", async () => {
  const script = await loadScenario();
  const result = runDemoPipeline({ script, sessionId: "sess_scenario" });
  const intents = result.actions.map((action) => action.intent);

  assert.ok(
    isSubsequence(ORDERED_KEY_INTENTS, intents),
    `expected milestone intents in order; got ${JSON.stringify(intents)}`
  );

  for (const correction of CORRECTION_INTENTS) {
    assert.ok(intents.includes(correction), `missing correction intent ${correction}`);
  }

  assert.equal(
    result.actions.filter((action) => action.intent === "generate_handover_report").length,
    1
  );
  assert.equal(result.actions.at(-1).intent, "explain_handover");
});

test("corrections are driven by vision cpr_quality, not STT", async () => {
  const script = await loadScenario();
  const { events, turns } = driveWithStepper(script);

  // The whole timeline is vision/device-only: no STT and no spoken intents anywhere.
  for (const event of events) {
    assert.ok(
      ALLOWED_EVENT_SOURCES.has(event.source),
      `unexpected event source ${event.source}`
    );
  }
  assert.ok(!events.some((event) => event.source === "stt"), "scenario must not use STT events");
  assert.ok(
    !events.some((event) => event.user_input && event.user_input.intent),
    "scenario must not rely on spoken intents"
  );

  // Every correction action is emitted by the rule feedback engine in direct
  // response to a vision_cpr event carrying cpr_quality metrics.
  const correctionTurns = turns.filter((turn) => turn.action.intent.startsWith("correct_"));
  assert.equal(correctionTurns.length, CORRECTION_INTENTS.length);
  for (const turn of correctionTurns) {
    assert.equal(turn.action.source, "rule_feedback", `${turn.action.intent} should come from rule_feedback`);
    assert.equal(turn.event.source, "vision_cpr", `${turn.action.intent} should be triggered by vision_cpr`);
    assert.ok(turn.event.cpr_quality, `${turn.action.intent} trigger must carry cpr_quality`);
  }
  assert.deepEqual(
    correctionTurns.map((turn) => turn.action.intent),
    CORRECTION_INTENTS
  );
});

test("stepAgentTurn reproduces the runDemoPipeline action stream exactly", async () => {
  const script = await loadScenario();
  const pipeline = runDemoPipeline({ script, sessionId: "sess_scenario_step" });
  const { turns, finalState } = driveWithStepper(script);

  assert.deepEqual(
    turns.map((turn) => turn.action.intent),
    pipeline.actions.map((action) => action.intent)
  );
  assert.deepEqual(
    turns.map((turn) => turn.action.stage),
    pipeline.actions.map((action) => action.stage)
  );
  assert.equal(finalState.current_stage, AgentStage.S9_HANDOVER);
});

test("handover report contains assessment, CPR start, corrections, AED and handover fields", async () => {
  const script = await loadScenario();
  const result = runDemoPipeline({ script, sessionId: "sess_scenario" });
  const { json, text } = result.report;

  assert.equal(json.current_stage, AgentStage.S9_HANDOVER);

  // Assessment derived from the vision facts.
  assert.equal(json.symptoms.responsive, false);
  assert.equal(json.symptoms.normal_breathing, false);
  assert.equal(json.symptoms.suspected_cardiac_arrest, true);
  assert.match(json.symptoms.summary, /无反应/);
  assert.match(json.symptoms.summary, /无正常呼吸/);

  // CPR start time recorded.
  assert.ok(json.cpr_started_at, "expected a CPR start time");

  // All four corrections survive into the report.
  const reportedCorrections = json.cpr.corrections.map((correction) => correction.type);
  for (const correction of CORRECTION_INTENTS) {
    assert.ok(reportedCorrections.includes(correction), `report missing correction ${correction}`);
  }
  assert.ok(json.cpr.interruptions.length >= 1, "expected at least one interruption record");

  // AED status surfaced from the vision AED event.
  assert.equal(json.aed.status, "available");

  // Human-readable text carries the key sections.
  assert.match(text, /交接报告/);
  assert.match(text, /症状/);
  assert.match(text, /CPR 开始/);
  assert.match(text, /纠错事件/);
  assert.match(text, /AED/);
});

test("dispatchAll never swallows a non-silent action; critical 120 call always executes", async () => {
  const script = await loadScenario();
  const result = runDemoPipeline({ script, sessionId: "sess_scenario" });

  const dispatcher = createGuidanceDispatcher();
  const results = dispatcher.dispatchAll(result.actions);

  assert.ok(results.length > 0);
  for (const dispatched of results) {
    const silent =
      DELIBERATELY_SILENT_INTENTS.has(dispatched.intent) || dispatched.priority === "silent";
    assert.ok(
      dispatched.channels.length > 0 || silent,
      `action ${dispatched.intent} should hit >=1 channel or be deliberately silent`
    );
  }

  const hadEmergencyCall = results.some((dispatched) =>
    (toolDeliveryOf(dispatched)?.payload?.tools ?? []).some(
      (tool) => tool.type === "emergency_call" && tool.outcome === "executed"
    )
  );
  assert.ok(hadEmergencyCall, "critical emergency_call must always reach the tool channel");
});

test("unconfirmed share is blocked by the dispatcher (sharing guardrail holds)", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch({
    action_id: "act_share_probe",
    session_id: "sess_scenario",
    timestamp: "2026-06-02T00:00:00.000Z",
    stage: AgentStage.S9_HANDOVER,
    intent: "share_recorded_video",
    priority: "normal",
    source: "state_machine",
    reason_codes: [],
    tts: { text: "是否分享视频？", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
    ui: { main_text: "分享视频？", secondary_text: "需确认", status_tags: [], quality_score: null, primary_button: null },
    haptic: { enabled: false },
    visual_overlay: null,
    tool_actions: [{ type: "share_video", requires_user_confirmation: true }],
  });

  const toolDelivery = toolDeliveryOf(result);
  assert.equal(toolDelivery.status, "blocked");
  const share = toolDelivery.payload.tools.find((tool) => tool.type === "share_video");
  assert.equal(share.outcome, "blocked_requires_confirmation");
  assert.ok(result.warnings.includes("tool_blocked_requires_confirmation:share_video"));
  // The action is not swallowed: ui/tts still deliver.
  assert.ok(result.channels.includes("ui"));
  assert.ok(!result.channels.includes("tool"));
});

test("scenario actions are deterministic across repeated runs", async () => {
  const script = await loadScenario();
  const first = runDemoPipeline({ script, sessionId: "sess_scenario" });
  const second = runDemoPipeline({ script, sessionId: "sess_scenario" });

  const project = (result) =>
    result.actions.map((action) => ({
      intent: action.intent,
      stage: action.stage,
      source: action.source,
      priority: action.priority,
    }));

  assert.deepEqual(project(first), project(second));
  assert.equal(first.state.current_stage, second.state.current_stage);
});
