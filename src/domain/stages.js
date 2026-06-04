export const AgentStage = Object.freeze({
  S0_INIT: "S0_INIT",
  S1_SCENE_SAFE: "S1_SCENE_SAFE",
  S2_CHECK_RESPONSE: "S2_CHECK_RESPONSE",
  S3_CHECK_BREATHING: "S3_CHECK_BREATHING",
  S4_SUSPECTED_ARREST: "S4_SUSPECTED_ARREST",
  S5_CALL_EMERGENCY: "S5_CALL_EMERGENCY",
  S6_CPR_READY: "S6_CPR_READY",
  S7_CPR_LOOP: "S7_CPR_LOOP",
  S8_ASSISTANCE: "S8_ASSISTANCE",
  S9_HANDOVER: "S9_HANDOVER",
  MONITOR_RESPONSE: "MONITOR_RESPONSE",
  MONITOR_BREATHING: "MONITOR_BREATHING",
});

export const AgentStageOrder = Object.freeze([
  AgentStage.S0_INIT,
  AgentStage.S1_SCENE_SAFE,
  AgentStage.S2_CHECK_RESPONSE,
  AgentStage.S3_CHECK_BREATHING,
  AgentStage.S4_SUSPECTED_ARREST,
  AgentStage.S5_CALL_EMERGENCY,
  AgentStage.S6_CPR_READY,
  AgentStage.S7_CPR_LOOP,
  AgentStage.S8_ASSISTANCE,
  AgentStage.S9_HANDOVER,
]);

export const MonitorStages = Object.freeze([
  AgentStage.MONITOR_RESPONSE,
  AgentStage.MONITOR_BREATHING,
]);

export const CprStages = Object.freeze([
  AgentStage.S4_SUSPECTED_ARREST,
  AgentStage.S5_CALL_EMERGENCY,
  AgentStage.S6_CPR_READY,
  AgentStage.S7_CPR_LOOP,
  AgentStage.S8_ASSISTANCE,
  AgentStage.S9_HANDOVER,
]);

export const StageMetadata = Object.freeze({
  [AgentStage.S0_INIT]: Object.freeze({
    index: 0,
    label: "startup",
    description: "Session startup and demo initialization.",
    terminal: false,
  }),
  [AgentStage.S1_SCENE_SAFE]: Object.freeze({
    index: 1,
    label: "scene_safety",
    description: "Confirm that the rescuer can safely approach.",
    terminal: false,
  }),
  [AgentStage.S2_CHECK_RESPONSE]: Object.freeze({
    index: 2,
    label: "check_response",
    description: "Check whether the adult patient responds.",
    terminal: false,
  }),
  [AgentStage.S3_CHECK_BREATHING]: Object.freeze({
    index: 3,
    label: "check_breathing",
    description: "Check for normal breathing for five to ten seconds.",
    terminal: false,
  }),
  [AgentStage.S4_SUSPECTED_ARREST]: Object.freeze({
    index: 4,
    label: "suspected_arrest",
    description: "Lock the suspected arrest decision from rules.",
    terminal: false,
  }),
  [AgentStage.S5_CALL_EMERGENCY]: Object.freeze({
    index: 5,
    label: "call_emergency",
    description: "Start emergency call, GPS attachment, and local recording.",
    terminal: false,
  }),
  [AgentStage.S6_CPR_READY]: Object.freeze({
    index: 6,
    label: "cpr_ready",
    description: "Prepare position and hand placement for chest compressions.",
    terminal: false,
  }),
  [AgentStage.S7_CPR_LOOP]: Object.freeze({
    index: 7,
    label: "cpr_loop",
    description: "Run compression guidance and quality feedback.",
    terminal: false,
  }),
  [AgentStage.S8_ASSISTANCE]: Object.freeze({
    index: 8,
    label: "assistance",
    description: "Handle AED, fatigue, handoff, or emotional support events.",
    terminal: false,
  }),
  [AgentStage.S9_HANDOVER]: Object.freeze({
    index: 9,
    label: "handover",
    description: "Generate the handover report when help arrives.",
    terminal: true,
  }),
  [AgentStage.MONITOR_RESPONSE]: Object.freeze({
    index: 20,
    label: "monitor_response",
    description: "Observe a responsive patient and call for help.",
    // Not terminal: a deteriorating patient can re-enter the CPR loop (ROSC reversed).
    terminal: false,
  }),
  [AgentStage.MONITOR_BREATHING]: Object.freeze({
    index: 21,
    label: "monitor_breathing",
    description: "Observe breathing (initial gate or post-ROSC) and restart CPR if needed.",
    // Not terminal: post-ROSC monitoring can restart compressions if signs of life stop.
    terminal: false,
  }),
});

export const StageTransitions = Object.freeze({
  [AgentStage.S0_INIT]: Object.freeze([AgentStage.S1_SCENE_SAFE]),
  [AgentStage.S1_SCENE_SAFE]: Object.freeze([
    AgentStage.S1_SCENE_SAFE,
    AgentStage.S2_CHECK_RESPONSE,
  ]),
  [AgentStage.S2_CHECK_RESPONSE]: Object.freeze([
    AgentStage.S3_CHECK_BREATHING,
    AgentStage.MONITOR_RESPONSE,
  ]),
  [AgentStage.S3_CHECK_BREATHING]: Object.freeze([
    AgentStage.S4_SUSPECTED_ARREST,
    AgentStage.MONITOR_BREATHING,
  ]),
  [AgentStage.S4_SUSPECTED_ARREST]: Object.freeze([AgentStage.S5_CALL_EMERGENCY]),
  [AgentStage.S5_CALL_EMERGENCY]: Object.freeze([AgentStage.S6_CPR_READY]),
  [AgentStage.S6_CPR_READY]: Object.freeze([AgentStage.S7_CPR_LOOP]),
  [AgentStage.S7_CPR_LOOP]: Object.freeze([
    AgentStage.S7_CPR_LOOP,
    AgentStage.S8_ASSISTANCE,
    AgentStage.S9_HANDOVER,
    // ROSC: signs of life returned -> stop compressions, monitor breathing.
    AgentStage.MONITOR_BREATHING,
  ]),
  [AgentStage.S8_ASSISTANCE]: Object.freeze([AgentStage.S7_CPR_LOOP]),
  [AgentStage.S9_HANDOVER]: Object.freeze([]),
  // MONITOR stages are reversible: a recovered patient can deteriorate and the
  // rescuer restarts compressions, so each can re-enter the CPR loop.
  [AgentStage.MONITOR_RESPONSE]: Object.freeze([AgentStage.S7_CPR_LOOP]),
  [AgentStage.MONITOR_BREATHING]: Object.freeze([AgentStage.S7_CPR_LOOP]),
});

export function isAgentStage(stage) {
  return Object.prototype.hasOwnProperty.call(StageMetadata, stage);
}

export function assertAgentStage(stage) {
  if (!isAgentStage(stage)) {
    throw new TypeError(`Unknown AgentStage: ${stage}`);
  }
  return stage;
}

export function getStageMetadata(stage) {
  assertAgentStage(stage);
  return StageMetadata[stage];
}

export function getStageIndex(stage) {
  return getStageMetadata(stage).index;
}

export function isCprStage(stage) {
  return CprStages.includes(stage);
}

export function isMonitorStage(stage) {
  return MonitorStages.includes(stage);
}

export function isTerminalStage(stage) {
  return getStageMetadata(stage).terminal === true;
}

export function canTransition(fromStage, toStage) {
  assertAgentStage(fromStage);
  assertAgentStage(toStage);
  return StageTransitions[fromStage].includes(toStage);
}

export function getAllowedNextStages(stage) {
  assertAgentStage(stage);
  return [...StageTransitions[stage]];
}

