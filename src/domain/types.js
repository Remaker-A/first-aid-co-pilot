import { AgentStage } from "./stages.js";

export { AgentStage } from "./stages.js";

export const Scenario = Object.freeze({
  ADULT_SUSPECTED_CARDIAC_ARREST_CPR: "adult_suspected_cardiac_arrest_cpr",
});

export const Priority = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
});

export const ActionPriority = Priority;

export const ActionSource = Object.freeze({
  STATE_MACHINE: "state_machine",
  RULE_FEEDBACK: "rule_feedback",
  GEMMA_AGENT: "gemma_agent",
  DEMO_SCRIPT: "demo_script",
});

export const EventSource = Object.freeze({
  STT: "stt",
  VISION_PATIENT: "vision_patient",
  VISION_CPR: "vision_cpr",
  VISION_RESCUER: "vision_rescuer",
  DEVICE: "device",
  DEMO_SCRIPT: "demo_script",
});

export const Source = Object.freeze({
  ...ActionSource,
  ...EventSource,
});

export const Mode = Object.freeze({
  REAL_PERCEPTION: "real_perception",
  DEMO_ASSISTED: "demo_assisted",
  DEMO_REPLAY: "demo_replay",
});

export const EventType = Object.freeze({
  SESSION_STARTED: "session_started",
  USER_RESPONSE: "user_response",
  PATIENT_STATE_UPDATE: "patient_state_update",
  BREATHING_UPDATE: "breathing_update",
  CPR_QUALITY_UPDATE: "cpr_quality_update",
  RESCUER_STATE_UPDATE: "rescuer_state_update",
  DEVICE_STATE_UPDATE: "device_state_update",
  TOOL_RESULT: "tool_result",
  HANDOVER_REQUESTED: "handover_requested",
});

export const Event = EventType;

export const InterruptPolicy = Object.freeze({
  INTERRUPT_LOWER_PRIORITY: "interrupt_lower_priority",
  DO_NOT_INTERRUPT: "do_not_interrupt",
  DO_NOT_INTERRUPT_CRITICAL: "do_not_interrupt_critical",
  REPLACE_SAME_INTENT: "replace_same_intent",
});

export const TtsTone = Object.freeze({
  CALM_FIRM: "calm_firm",
  CALM_SOFT: "calm_soft",
  URGENT: "urgent",
});

export const TtsSpeed = Object.freeze({
  SLOW: "slow",
  NORMAL: "normal",
  FAST: "fast",
});

export const EmergencyCallStatus = Object.freeze({
  NOT_STARTED: "not_started",
  PREPARED: "prepared",
  STARTED: "started",
  CONNECTED: "connected",
  FAILED: "failed",
  USER_ALREADY_CALLED: "user_already_called",
});

export const RecordingStatus = Object.freeze({
  NOT_STARTED: "not_started",
  RECORDING: "recording",
  PAUSED: "paused",
  STOPPED: "stopped",
  FAILED: "failed",
});

export const NetworkStatus = Object.freeze({
  OFFLINE: "offline",
  ONLINE: "online",
  UNKNOWN: "unknown",
});

export const ChestMovement = Object.freeze({
  UNKNOWN: "unknown",
  NONE: "none",
  IRREGULAR: "irregular",
  NORMAL: "normal",
});

export const RescuerEmotion = Object.freeze({
  CALM: "calm",
  ANXIOUS: "anxious",
  PANIC: "panic",
  UNKNOWN: "unknown",
});

export const FatigueLevel = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  UNKNOWN: "unknown",
});

export const SESSION_STATE_SCHEMA_VERSION = "session_state.v0.1";
export const PERCEPTION_EVENT_SCHEMA_VERSION = "perception_event.v0.1";
export const GUIDANCE_ACTION_SCHEMA_VERSION = "guidance_action.v0.1";
export const LOG_EVENT_SCHEMA_VERSION = "session_log_event.v0.1";

let idCounter = 0;

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = "id") {
  idCounter += 1;

  const timePart = Date.now().toString(36);
  const counterPart = idCounter.toString(36).padStart(4, "0");
  const randomPart = createRandomPart();

  return `${prefix}_${timePart}_${counterPart}_${randomPart}`;
}

export function createInitialSessionState(options = {}) {
  const timestamp = options.timestamp ?? nowIso();
  const mode = options.mode ?? Mode.DEMO_ASSISTED;
  const sessionId = options.sessionId ?? createId("sess");

  const state = {
    schema_version: SESSION_STATE_SCHEMA_VERSION,
    session_id: sessionId,
    mode,
    current_stage: options.currentStage ?? AgentStage.S0_INIT,
    previous_stage: options.previousStage ?? null,
    started_at: options.startedAt ?? timestamp,
    updated_at: options.updatedAt ?? timestamp,
    scope: {
      scenario: Scenario.ADULT_SUSPECTED_CARDIAC_ARREST_CPR,
      adult_likely: options.adultLikely ?? null,
      scene_safe: options.sceneSafe ?? null,
    },
    confirmed_facts: {
      responsive: null,
      responsive_source: null,
      responsive_confidence: null,
      normal_breathing: null,
      agonal_breathing: null,
      breathing_source: null,
      breathing_confidence: null,
      suspected_cardiac_arrest: false,
    },
    tool_state: {
      emergency_call_status:
        options.emergencyCallStatus ?? EmergencyCallStatus.NOT_STARTED,
      gps_attached: options.gpsAttached ?? false,
      recording_status: options.recordingStatus ?? RecordingStatus.NOT_STARTED,
      handover_generated: false,
    },
    location: options.location ?? null,
    cpr_state: {
      started: false,
      started_at: null,
      total_compressions: 0,
      current_rate: null,
      average_rate: null,
      quality_score: null,
      last_interruption_seconds: 0,
      last_correction: null,
    },
    dialogue_state: {
      pending_question: null,
      last_tts_intent: null,
      last_tts_at: null,
      repeat_count: 0,
      spoken_intents: [],
    },
    action_control: {
      active_priority: Priority.NORMAL,
      cooldowns: {},
    },
    handover_timeline: [],
    demo_state: {
      script_id: options.scriptId ?? null,
      elapsed_ms: options.elapsedMs ?? 0,
      current_step: options.currentStep ?? null,
    },
  };

  if (options.overrides && isPlainObject(options.overrides)) {
    return mergePlain(state, options.overrides);
  }

  return state;
}

export function createPerceptionEvent(input = {}) {
  const timestamp = input.timestamp ?? nowIso();

  return {
    schema_version: PERCEPTION_EVENT_SCHEMA_VERSION,
    event_id: input.eventId ?? createId("evt"),
    session_id: input.sessionId ?? null,
    timestamp,
    mode: input.mode ?? Mode.DEMO_ASSISTED,
    source: input.source ?? EventSource.DEMO_SCRIPT,
    event_type: input.eventType ?? EventType.PATIENT_STATE_UPDATE,
    stage_hint: input.stageHint ?? null,
    sequence_id: input.sequenceId ?? null,
    ttl_ms: input.ttlMs ?? 5000,
    user_input: input.userInput ?? null,
    patient_state: input.patientState ?? null,
    cpr_quality: input.cprQuality ?? null,
    rescuer_state: input.rescuerState ?? null,
    device_state: input.deviceState ?? null,
    metadata: input.metadata ?? {},
  };
}

export function createDecisionFrame(input = {}) {
  return {
    schema_version: "decision_frame.v0.1",
    stage: input.stage ?? AgentStage.S0_INIT,
    allowed_intents: input.allowedIntents ?? [],
    facts: input.facts ?? {},
    safety_phrases: input.safetyPhrases ?? [],
    output_schema: input.outputSchema ?? "GuidanceActionPatch",
    user_input: input.userInput ?? "",
    language: input.language ?? "zh-CN",
  };
}

export function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function createRandomPart() {
  const cryptoObj = globalThis.crypto;

  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID().replaceAll("-", "").slice(0, 12);
  }

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = new Uint8Array(6);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return Math.floor(Math.random() * 0xffffffffffff)
    .toString(16)
    .padStart(12, "0");
}

function mergePlain(base, override) {
  const output = cloneJson(base);

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergePlain(output[key], value);
    } else {
      output[key] = cloneJson(value);
    }
  }

  return output;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
