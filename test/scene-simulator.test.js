import assert from "node:assert/strict";
import test from "node:test";

import {
  createSceneSimulator,
  ruleReactionBrain,
  createRuleReactionBrain,
  createLlmSceneBrain,
  llmSceneBrain,
  normalizeAgentSignal,
} from "../src/sim/sceneSimulator.js";
import {
  EventSource,
  EventType,
  PERCEPTION_EVENT_SCHEMA_VERSION,
} from "../src/domain/types.js";

const ISOLATED_SCHEDULE = Object.freeze({
  interruptionAtCprTick: null,
  fatigueAtCprTick: null,
  aedAtCprTick: null,
  emsAtCprTick: 100,
});

// 驱动模拟器（喂 agent 动作，默认 null）直到产出第一条 cpr_quality 事件并返回它。
function driveToFirstCpr(sim, signal = null) {
  for (let guard = 0; guard < 50; guard += 1) {
    const event = sim.nextEvent(signal);
    if (!event) break;
    if (event.event_type === EventType.CPR_QUALITY_UPDATE) return event;
  }
  throw new Error("simulator did not reach a cpr_quality event");
}

// 模拟急救 agent 的纠错优先级（中断 > 手位 > 频率 > 手臂 > 鼓励），用于「持续良好指导」。
function matchingCorrection(quality) {
  if ((quality.interruption_seconds ?? 0) >= 2) {
    return {
      intent: "correct_compression_interruption",
      reason_codes: ["compression_interrupted"],
      priority: "critical",
      haptic: { enabled: true, pattern: "metronome", bpm: 110 },
    };
  }
  const offset = quality.hand_offset ?? (quality.hand_position === "center" ? 0 : 1);
  if (offset > 0) {
    return {
      intent: "correct_hand_position",
      reason_codes: ["hand_position_off_center"],
      priority: "high",
    };
  }
  if (quality.current_rate < 100 || quality.current_rate > 120) {
    return {
      intent: "correct_compression_rate",
      reason_codes: ["compression_rate_low"],
      priority: "high",
    };
  }
  if (quality.arm_posture === "bent") {
    return {
      intent: "correct_arm_posture",
      reason_codes: ["arm_bent"],
      priority: "high",
    };
  }
  return {
    intent: "continue_cpr_loop",
    reason_codes: ["cpr_loop"],
    haptic: { enabled: true, pattern: "metronome", bpm: 110 },
  };
}

function drainEvents(sim, signal = null, guardLimit = 200) {
  const events = [];
  let guard = 0;
  while (!sim.isFinished() && guard < guardLimit) {
    const event = sim.nextEvent(signal);
    if (event) events.push(event);
    guard += 1;
  }
  return events;
}

test("ruleReactionBrain converges hand_position toward center after correct_hand_position", () => {
  const sim = createSceneSimulator({
    brain: ruleReactionBrain,
    seed: 1,
    schedule: ISOLATED_SCHEDULE,
  });

  const baseline = driveToFirstCpr(sim);
  assert.equal(baseline.source, EventSource.VISION_CPR);
  assert.equal(baseline.cpr_quality.hand_offset, 2);
  assert.equal(baseline.cpr_quality.hand_position, "off_center");

  const handCorrection = {
    intent: "correct_hand_position",
    reason_codes: ["hand_position_off_center"],
    priority: "high",
  };

  const after1 = sim.nextEvent(handCorrection);
  assert.ok(
    after1.cpr_quality.hand_offset < baseline.cpr_quality.hand_offset,
    "hand offset should shrink toward center after a hand-position correction"
  );

  const after2 = sim.nextEvent(handCorrection);
  assert.ok(after2.cpr_quality.hand_offset < after1.cpr_quality.hand_offset);
  assert.equal(after2.cpr_quality.hand_offset, 0);
  assert.equal(after2.cpr_quality.hand_position, "center");
});

test("ruleReactionBrain pushes a slow rate into the 100-120 band under rate guidance", () => {
  const sim = createSceneSimulator({
    brain: ruleReactionBrain,
    seed: 11,
    schedule: ISOLATED_SCHEDULE,
  });

  const baseline = driveToFirstCpr(sim);
  assert.ok(baseline.cpr_quality.current_rate < 100, "baseline rate should start slow");

  const rateCorrection = {
    intent: "correct_compression_rate",
    reason_codes: ["compression_rate_low"],
    priority: "high",
  };

  let rate = baseline.cpr_quality.current_rate;
  let event = baseline;
  for (let i = 0; i < 6; i += 1) {
    event = sim.nextEvent(rateCorrection);
    assert.ok(event.cpr_quality.current_rate >= rate, "rate should move monotonically toward target");
    rate = event.cpr_quality.current_rate;
  }

  assert.ok(rate >= 100 && rate <= 120, `rate should land in 100-120 band, got ${rate}`);
});

test("ruleReactionBrain raises quality_score monotonically to a high score under sustained good guidance", () => {
  const sim = createSceneSimulator({
    brain: ruleReactionBrain,
    seed: 2,
    schedule: ISOLATED_SCHEDULE,
  });

  const baseline = driveToFirstCpr(sim);
  const scores = [baseline.cpr_quality.quality_score];
  let last = baseline;

  for (let i = 0; i < 14; i += 1) {
    last = sim.nextEvent(matchingCorrection(last.cpr_quality));
    scores.push(last.cpr_quality.quality_score);
  }

  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      scores[i] >= scores[i - 1],
      `quality_score must be non-decreasing: ${scores[i]} < ${scores[i - 1]} at index ${i}`
    );
  }
  assert.ok(Math.max(...scores) >= 90, `quality_score should reach a high score, peak=${Math.max(...scores)}`);
  assert.ok(scores[scores.length - 1] > scores[0], "quality_score should strictly improve overall");
});

test("interruption injection is cleared after a correct_compression_interruption signal", () => {
  const sim = createSceneSimulator({
    brain: ruleReactionBrain,
    seed: 3,
    schedule: {
      interruptionAtCprTick: 1,
      fatigueAtCprTick: null,
      aedAtCprTick: null,
      emsAtCprTick: 100,
    },
  });

  driveToFirstCpr(sim); // cpr tick 0 (baseline)
  const interrupted = sim.nextEvent({ intent: "continue_cpr_loop" }); // cpr tick 1 -> injected interruption
  assert.equal(interrupted.cpr_quality.interruption_seconds, 3);
  assert.equal(interrupted.cpr_quality.compressions_started, false);

  const resumed = sim.nextEvent({
    intent: "correct_compression_interruption",
    reason_codes: ["compression_interrupted"],
    priority: "critical",
  });
  assert.equal(resumed.cpr_quality.interruption_seconds, 0);
  assert.equal(resumed.cpr_quality.compressions_started, true);
});

test("simulator finishes once EMS arrives and emits a handover_requested milestone", () => {
  const sim = createSceneSimulator({ brain: ruleReactionBrain, seed: 4 });

  const events = drainEvents(sim);
  const last = events[events.length - 1];

  assert.equal(sim.isFinished(), true);
  assert.equal(last.event_type, EventType.HANDOVER_REQUESTED);
  assert.equal(last.source, EventSource.VISION_PATIENT);
  assert.equal(last.metadata.ems_arrived, true);

  // 终止后 nextEvent 返回 null（不再产出事件）。
  assert.equal(sim.nextEvent(null), null);
  assert.equal(sim.snapshot().milestones.emsEmitted, true);
});

test("default narrative emits aed and fatigue milestones before EMS", () => {
  const sim = createSceneSimulator({ brain: ruleReactionBrain, seed: 8 });
  const events = drainEvents(sim);

  assert.ok(
    events.some((event) => event.source === EventSource.VISION_RESCUER && event.rescuer_state?.fatigue_level === "high"),
    "expected a high-fatigue rescuer milestone"
  );
  assert.ok(
    events.some((event) => event.metadata?.aed_available === true),
    "expected an AED-available milestone"
  );
});

test("every produced event is a vision_* PerceptionEvent built via createPerceptionEvent", () => {
  const sim = createSceneSimulator({ brain: ruleReactionBrain, seed: 9 });
  const events = drainEvents(sim);

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.match(event.source, /^vision_/, `source must be a vision_* stream, got ${event.source}`);
    assert.equal(event.schema_version, PERCEPTION_EVENT_SCHEMA_VERSION);
    assert.equal(typeof event.event_id, "string");
    assert.ok(event.metadata && typeof event.metadata === "object");
    assert.equal(event.metadata.simulator, "scene_sim");
  }

  assert.ok(events.some((event) => event.source === EventSource.VISION_CPR && event.cpr_quality));
  assert.ok(events.some((event) => event.source === EventSource.VISION_PATIENT && event.patient_state));
});

test("simulation is deterministic: identical inputs yield identical cpr_quality sequences", () => {
  function run() {
    const sim = createSceneSimulator({ brain: ruleReactionBrain, seed: 7 });
    let last = null;
    const quality = [];
    let guard = 0;
    while (!sim.isFinished() && guard < 200) {
      const event = sim.nextEvent(last ? matchingCorrection(last.cpr_quality) : null);
      if (event?.cpr_quality) {
        quality.push(event.cpr_quality);
        last = event;
      }
      guard += 1;
    }
    return quality;
  }

  assert.deepEqual(run(), run());
});

test("normalizeAgentSignal accepts GuidanceAction, DispatchResult, arrays, and null", () => {
  assert.deepEqual(normalizeAgentSignal(null).intent, null);

  const action = {
    intent: "correct_hand_position",
    reason_codes: ["hand_position_left_offset"],
    haptic: { enabled: true, bpm: 110 },
    visual_overlay: { mode: "hand_position_feedback" },
    priority: "high",
  };
  const fromAction = normalizeAgentSignal(action);
  assert.equal(fromAction.intent, "correct_hand_position");
  assert.deepEqual(fromAction.reasonCodes, ["hand_position_left_offset"]);
  assert.equal(fromAction.haptic.enabled, true);

  // DispatchResult 形态：haptic 从 deliveries 推导。
  const dispatchResult = {
    intent: "continue_cpr_loop",
    priority: "normal",
    deliveries: [
      { channel: "ui", status: "delivered" },
      { channel: "haptic", status: "delivered" },
    ],
  };
  const fromDispatch = normalizeAgentSignal(dispatchResult);
  assert.equal(fromDispatch.intent, "continue_cpr_loop");
  assert.equal(fromDispatch.haptic.enabled, true);

  // 数组：优先采纳最近的纠错动作。
  const fromArray = normalizeAgentSignal([
    { intent: "encourage_rescuer" },
    { intent: "correct_arm_posture", reason_codes: ["arm_bent"] },
  ]);
  assert.equal(fromArray.intent, "correct_arm_posture");
});

test("llmSceneBrain delegates deterministic CPR physiology to the rule brain", () => {
  const signals = [
    { intent: "correct_hand_position", reason_codes: ["hand_position_off_center"] },
    { intent: "correct_hand_position", reason_codes: ["hand_position_left_offset"] },
    { intent: "correct_compression_rate", reason_codes: ["compression_rate_low"] },
    { intent: "correct_arm_posture", reason_codes: ["arm_bent"] },
    { intent: "continue_cpr_loop", haptic: { enabled: true, bpm: 110 } },
  ];

  function runWith(brain) {
    const sim = createSceneSimulator({ brain, seed: 5, schedule: ISOLATED_SCHEDULE });
    driveToFirstCpr(sim);
    return signals.map((signal) => sim.nextEvent(signal).cpr_quality);
  }

  const ruleSeq = runWith(ruleReactionBrain);
  const llmSeq = runWith(createLlmSceneBrain({ fallbackBrain: ruleReactionBrain }));
  assert.deepEqual(llmSeq, ruleSeq);
});

test("llmSceneBrain uses an injected generateText for bystander narration", async () => {
  const prompts = [];
  const brain = createLlmSceneBrain({
    generateText: (prompt) => {
      prompts.push(prompt);
      return "我在拼命按压，快撑不住了！";
    },
  });
  const sim = createSceneSimulator({ brain, seed: 6, schedule: ISOLATED_SCHEDULE });

  let event = null;
  for (let guard = 0; guard < 20; guard += 1) {
    event = await sim.nextEventAsync(null);
    if (event?.event_type === EventType.CPR_QUALITY_UPDATE) break;
  }

  assert.equal(event.event_type, EventType.CPR_QUALITY_UPDATE);
  assert.equal(event.metadata.bystander, "我在拼命按压，快撑不住了！");
  assert.ok(prompts.length > 0, "injected generator should have been called");
});

test("llmSceneBrain falls back to deterministic narration when no model is injected", async () => {
  const brain = llmSceneBrain(); // 无注入：narrate 回退到确定性模板
  assert.equal(typeof brain.react, "function");

  const sim = createSceneSimulator({ brain, seed: 10 });
  const event = await sim.nextEventAsync(null);

  assert.ok(event);
  assert.equal(typeof event.metadata.bystander, "string");
  assert.ok(event.metadata.bystander.length > 0);
});

test("createRuleReactionBrain honors custom tuning", () => {
  const brain = createRuleReactionBrain({ name: "fast_rule", rateStep: 30 });
  assert.equal(brain.name, "fast_rule");

  const sim = createSceneSimulator({ brain, seed: 12, schedule: ISOLATED_SCHEDULE });
  const baseline = driveToFirstCpr(sim);
  const next = sim.nextEvent({ intent: "correct_compression_rate", reason_codes: ["compression_rate_low"] });
  assert.ok(next.cpr_quality.current_rate - baseline.cpr_quality.current_rate >= 20);
});
