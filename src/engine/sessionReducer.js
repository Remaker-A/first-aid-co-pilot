import { AgentStage } from "../domain/stages.js";

const DEFAULT_SCENARIO = "adult_suspected_cardiac_arrest_cpr";
const UNKNOWN_SOURCE = "unknown";
const CONFLICT_CONFIDENCE_FLOOR = 0.6;
const STRONG_CONFIDENCE_FLOOR = 0.75;

const STAGES = Object.freeze({
  S0_INIT: AgentStage?.S0_INIT ?? "S0_INIT",
});

export function createInitialSessionState(overrides = {}) {
  const timestamp = overrides.timestamp ?? new Date().toISOString();

  return mergeObjects(
    {
      session_id: overrides.session_id ?? null,
      mode: overrides.mode ?? "demo_assisted",
      current_stage: STAGES.S0_INIT,
      previous_stage: null,
      started_at: timestamp,
      updated_at: timestamp,
      scope: {
        scenario: DEFAULT_SCENARIO,
        adult_likely: null,
        adult_likely_source: null,
        adult_likely_confidence: null,
        scene_safe: null,
        scene_safe_source: null,
        scene_safe_confidence: null,
      },
      confirmed_facts: {
        responsive: null,
        responsive_source: null,
        responsive_confidence: null,
        normal_breathing: null,
        agonal_breathing: null,
        breathing_source: null,
        breathing_confidence: null,
        normal_breathing_source: null,
        normal_breathing_confidence: null,
        agonal_breathing_source: null,
        agonal_breathing_confidence: null,
        suspected_cardiac_arrest: false,
        recheck_required: false,
        conflicts: [],
        evidence: [],
      },
      tool_state: {
        emergency_call_status: "not_started",
        gps_attached: false,
        gps_available: null,
        recording_status: "not_started",
        handover_generated: false,
        network: null,
      },
      cpr_state: {
        started: false,
        started_at: null,
        total_compressions: 0,
        current_rate: null,
        average_rate: null,
        quality_score: null,
        last_interruption_seconds: 0,
        last_correction: null,
        hand_position: null,
        arm_straight: null,
        quality_source: null,
        quality_confidence: null,
      },
      rescuer_state: {
        emotion: null,
        fatigue_level: null,
        hesitation_seconds: 0,
        confidence: null,
        source: null,
      },
      dialogue_state: {
        pending_question: null,
        last_tts_intent: null,
        last_tts_at: null,
        repeat_count: 0,
        spoken_intents: [],
      },
      action_control: {
        active_priority: "normal",
        cooldowns: {},
      },
      handover_timeline: [],
      demo_state: {
        script_id: null,
        elapsed_ms: 0,
        current_step: null,
      },
      last_event: null,
    },
    overrides,
  );
}

export function sessionReducer(state, event) {
  if (!event || typeof event !== "object") {
    return state ?? createInitialSessionState();
  }

  const receivedAt = new Date().toISOString();
  const timestamp = event.timestamp ?? receivedAt;
  const base = state ?? createInitialSessionState({
    session_id: event.session_id,
    mode: event.mode,
    timestamp,
  });

  if (isExpiredEvent(event, receivedAt)) {
    return {
      ...base,
      last_event: createEventSummary(event, timestamp, "expired"),
    };
  }

  const next = cloneSessionState(base);
  next.session_id = next.session_id ?? event.session_id ?? null;
  next.mode = event.mode ?? next.mode;
  next.started_at = next.started_at ?? timestamp;
  next.updated_at = timestamp;

  reduceUserIntent(next, event, timestamp);
  reduceMetadata(next, event, timestamp);
  reducePatientState(next, event, timestamp);
  reduceDeviceState(next, event, timestamp);
  reduceToolResult(next, event, timestamp);
  reduceCprQuality(next, event, timestamp);
  reduceRescuerState(next, event, timestamp);
  reduceDemoState(next, event);

  next.last_event = createEventSummary(event, timestamp, "accepted");
  appendTimeline(next, event, timestamp);

  return next;
}

export const reduceSessionEvent = sessionReducer;
export const reduceSession = sessionReducer;

function cloneSessionState(state) {
  return {
    ...state,
    scope: { ...(state.scope ?? {}) },
    confirmed_facts: {
      ...(state.confirmed_facts ?? {}),
      conflicts: [...(state.confirmed_facts?.conflicts ?? [])],
      evidence: [...(state.confirmed_facts?.evidence ?? [])],
    },
    tool_state: { ...(state.tool_state ?? {}) },
    cpr_state: { ...(state.cpr_state ?? {}) },
    rescuer_state: { ...(state.rescuer_state ?? {}) },
    dialogue_state: {
      ...(state.dialogue_state ?? {}),
      spoken_intents: [...(state.dialogue_state?.spoken_intents ?? [])],
    },
    action_control: {
      ...(state.action_control ?? {}),
      cooldowns: { ...(state.action_control?.cooldowns ?? {}) },
    },
    handover_timeline: [...(state.handover_timeline ?? [])],
    demo_state: { ...(state.demo_state ?? {}) },
  };
}

function reduceUserIntent(next, event, timestamp) {
  const intent = event.user_input?.intent;
  if (!intent) {
    return;
  }

  const source = getEventSource(event);
  const confidence = getUserConfidence(event);

  switch (intent) {
    case "patient_unresponsive":
    case "unresponsive":
      updateConfirmedFact(next, "responsive", false, source, confidence, timestamp, event);
      break;
    case "patient_responsive":
    case "responsive":
      updateConfirmedFact(next, "responsive", true, source, confidence, timestamp, event);
      break;
    case "normal_breathing":
    case "normal_breathing_present":
      updateBreathingFact(next, "normal_breathing", true, source, confidence, timestamp, event);
      break;
    case "no_normal_breathing":
    case "breathing_absent":
      updateBreathingFact(next, "normal_breathing", false, source, confidence, timestamp, event);
      break;
    case "agonal_breathing":
      updateBreathingFact(next, "agonal_breathing", true, source, confidence, timestamp, event);
      updateBreathingFact(next, "normal_breathing", false, source, confidence, timestamp, event);
      break;
    case "scene_safe":
      updateScopeFact(next, "scene_safe", true, source, confidence, timestamp, event);
      break;
    case "scene_unsafe":
      updateScopeFact(next, "scene_safe", false, source, confidence, timestamp, event);
      break;
    case "adult_likely":
      updateScopeFact(next, "adult_likely", true, source, confidence, timestamp, event);
      break;
    case "not_adult":
      updateScopeFact(next, "adult_likely", false, source, confidence, timestamp, event);
      break;
    default:
      break;
  }
}

function reducePatientState(next, event, timestamp) {
  const patient = event.patient_state;
  if (!patient || typeof patient !== "object") {
    return;
  }

  const source = getEventSource(event);

  if (hasOwn(patient, "adult_likely")) {
    updateScopeFact(
      next,
      "adult_likely",
      patient.adult_likely,
      source,
      getPatientConfidence(patient, "adult_likely"),
      timestamp,
      event,
    );
  }

  if (hasOwn(patient, "scene_safe")) {
    updateScopeFact(
      next,
      "scene_safe",
      patient.scene_safe,
      source,
      getPatientConfidence(patient, "scene_safe"),
      timestamp,
      event,
    );
  }

  if (hasOwn(patient, "responsive")) {
    updateConfirmedFact(
      next,
      "responsive",
      patient.responsive,
      source,
      getPatientConfidence(patient, "responsive"),
      timestamp,
      event,
    );
  }

  if (hasOwn(patient, "normal_breathing")) {
    updateBreathingFact(
      next,
      "normal_breathing",
      patient.normal_breathing,
      source,
      getPatientConfidence(patient, "normal_breathing"),
      timestamp,
      event,
    );
  }

  if (hasOwn(patient, "agonal_breathing")) {
    updateBreathingFact(
      next,
      "agonal_breathing",
      patient.agonal_breathing,
      source,
      getPatientConfidence(patient, "agonal_breathing"),
      timestamp,
      event,
    );
  }

  if (hasOwn(patient, "chest_movement")) {
    next.confirmed_facts.chest_movement = patient.chest_movement;
    next.confirmed_facts.chest_movement_source = source;
    next.confirmed_facts.chest_movement_confidence = getPatientConfidence(patient, "chest_movement");
  }
}

function reduceMetadata(next, event, timestamp) {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") {
    return;
  }

  const source = getEventSource(event);

  if (hasOwn(metadata, "scene_safe")) {
    updateScopeFact(next, "scene_safe", metadata.scene_safe, source, 0.9, timestamp, event);
  }

  if (hasOwn(metadata, "adult_likely")) {
    updateScopeFact(next, "adult_likely", metadata.adult_likely, source, 0.9, timestamp, event);
  }

  if (metadata.aed_available === true || metadata.aed_status) {
    next.tool_state.aed_status = metadata.aed_status ?? "available";
  }

  if (metadata.handover_report_generated === true) {
    next.tool_state.handover_generated = true;
  }

  if (metadata.local_video_saved === true) {
    next.tool_state.recording_status = "saved";
  }
}

function reduceDeviceState(next, event) {
  const device = event.device_state;
  if (!device || typeof device !== "object") {
    return;
  }

  if (hasOwn(device, "emergency_call_started")) {
    next.tool_state.emergency_call_status = device.emergency_call_started
      ? "started"
      : next.tool_state.emergency_call_status ?? "not_started";
  }

  if (hasOwn(device, "emergency_call_status")) {
    next.tool_state.emergency_call_status = device.emergency_call_status;
  }

  if (hasOwn(device, "gps_available")) {
    next.tool_state.gps_available = device.gps_available;
  }

  if (hasOwn(device, "gps_attached")) {
    next.tool_state.gps_attached = device.gps_attached;
  }

  if (hasOwn(device, "recording")) {
    next.tool_state.recording_status = device.recording ? "recording" : "not_started";
  }

  if (hasOwn(device, "recording_status")) {
    next.tool_state.recording_status = device.recording_status;
  }

  if (hasOwn(device, "network")) {
    next.tool_state.network = device.network;
  }
}

function reduceToolResult(next, event) {
  const result = event.tool_result;
  if (!result || typeof result !== "object") {
    return;
  }

  const toolType = result.type ?? result.tool_type;
  const status = result.status;

  if (toolType === "emergency_call") {
    next.tool_state.emergency_call_status = status ?? "started";
  }

  if (toolType === "attach_gps_location") {
    next.tool_state.gps_attached = status !== "failed";
  }

  if (toolType === "start_local_recording") {
    next.tool_state.recording_status = status === "failed" ? "failed" : "recording";
  }

  if (toolType === "generate_handover_report") {
    next.tool_state.handover_generated = status !== "failed";
  }
}

function reduceCprQuality(next, event, timestamp) {
  const quality = event.cpr_quality;
  if (!quality || typeof quality !== "object") {
    return;
  }

  const source = getEventSource(event);
  const confidence = numberOrNull(quality.confidence);

  if (hasOwn(quality, "started")) {
    next.cpr_state.started = quality.started === true;
  } else if (hasOwn(quality, "compressions_started")) {
    next.cpr_state.started = quality.compressions_started === true;
  } else if (next.cpr_state.started !== true && event.event_type === "cpr_quality_update") {
    next.cpr_state.started = true;
  }

  if (next.cpr_state.started && !next.cpr_state.started_at) {
    next.cpr_state.started_at = timestamp;
  }

  const total = firstNumber(
    quality.total_compressions,
    quality.compression_count,
    quality.compressions,
  );
  if (total !== null) {
    next.cpr_state.total_compressions = total;
  } else if (isFiniteNumber(quality.compressions_delta)) {
    next.cpr_state.total_compressions =
      (next.cpr_state.total_compressions ?? 0) + quality.compressions_delta;
  }

  const rate = firstNumber(quality.compression_rate, quality.rate, quality.current_rate);
  if (rate !== null) {
    next.cpr_state.current_rate = rate;
  }

  const averageRate = firstNumber(quality.average_rate, quality.avg_rate);
  if (averageRate !== null) {
    next.cpr_state.average_rate = averageRate;
  }

  const score = firstNumber(quality.quality_score, quality.score);
  if (score !== null) {
    next.cpr_state.quality_score = score;
  }

  const interruptionSeconds = firstNumber(
    quality.interruption_seconds,
    quality.last_interruption_seconds,
  );
  if (interruptionSeconds !== null) {
    next.cpr_state.last_interruption_seconds = interruptionSeconds;
  }

  if (hasOwn(quality, "hand_position")) {
    next.cpr_state.hand_position = quality.hand_position;
  }

  if (hasOwn(quality, "arm_straight")) {
    next.cpr_state.arm_straight = quality.arm_straight;
  }

  if (hasOwn(quality, "arms_straight")) {
    next.cpr_state.arm_straight = quality.arms_straight;
  }

  if (quality.arm_posture === "bent") {
    next.cpr_state.arm_straight = false;
  } else if (quality.arm_posture === "straight" || quality.arm_posture === "acceptable") {
    next.cpr_state.arm_straight = true;
  }

  next.cpr_state.quality_source = source;
  next.cpr_state.quality_confidence = confidence;
}

function reduceRescuerState(next, event) {
  const rescuer = event.rescuer_state;
  if (!rescuer || typeof rescuer !== "object") {
    return;
  }

  next.rescuer_state = {
    ...next.rescuer_state,
    ...definedValues({
      emotion: rescuer.emotion,
      fatigue_level: rescuer.fatigue_level,
      hesitation_seconds: rescuer.hesitation_seconds,
      confidence: rescuer.confidence,
      source: getEventSource(event),
      aed_status: rescuer.aed_status,
      aed_available: rescuer.aed_available,
    }),
  };
}

function reduceDemoState(next, event) {
  if (!event.demo_state || typeof event.demo_state !== "object") {
    return;
  }

  next.demo_state = {
    ...next.demo_state,
    ...definedValues(event.demo_state),
  };
}

function updateScopeFact(next, field, value, source, confidence, timestamp, event) {
  if (!isKnown(value)) {
    return;
  }

  const conflict = maybeRecordConflict(
    next,
    `scope.${field}`,
    next.scope[field],
    value,
    next.scope[`${field}_source`],
    source,
    next.scope[`${field}_confidence`],
    confidence,
    timestamp,
    event,
  );

  if (!conflict.shouldKeepExisting) {
    next.scope[field] = value;
    next.scope[`${field}_source`] = source;
    next.scope[`${field}_confidence`] = confidence;
  }
}

function updateConfirmedFact(next, field, value, source, confidence, timestamp, event) {
  if (!isKnown(value)) {
    return;
  }

  const sourceKey = `${field}_source`;
  const confidenceKey = `${field}_confidence`;
  const conflict = maybeRecordConflict(
    next,
    field,
    next.confirmed_facts[field],
    value,
    next.confirmed_facts[sourceKey],
    source,
    next.confirmed_facts[confidenceKey],
    confidence,
    timestamp,
    event,
  );

  if (!conflict.shouldKeepExisting) {
    next.confirmed_facts[field] = value;
    next.confirmed_facts[sourceKey] = source;
    next.confirmed_facts[confidenceKey] = confidence;
  }

  appendEvidence(next, field, value, source, confidence, timestamp, event);
}

function updateBreathingFact(next, field, value, source, confidence, timestamp, event) {
  if (!isKnown(value)) {
    next.confirmed_facts[field] = value;
    next.confirmed_facts[`${field}_source`] = source;
    next.confirmed_facts[`${field}_confidence`] = confidence;
    if (next.confirmed_facts.breathing_source == null) {
      next.confirmed_facts.breathing_source = source;
      next.confirmed_facts.breathing_confidence = confidence;
    }
    appendEvidence(next, field, value, source, confidence, timestamp, event);
    return;
  }

  const conflict = maybeRecordConflict(
    next,
    field,
    next.confirmed_facts[field],
    value,
    next.confirmed_facts[`${field}_source`],
    source,
    next.confirmed_facts[`${field}_confidence`],
    confidence,
    timestamp,
    event,
  );

  if (!conflict.shouldKeepExisting) {
    next.confirmed_facts[field] = value;
    next.confirmed_facts[`${field}_source`] = source;
    next.confirmed_facts[`${field}_confidence`] = confidence;
    next.confirmed_facts.breathing_source = source;
    next.confirmed_facts.breathing_confidence = confidence;
  }

  appendEvidence(next, field, value, source, confidence, timestamp, event);
}

function maybeRecordConflict(
  next,
  field,
  currentValue,
  incomingValue,
  currentSource,
  incomingSource,
  currentConfidence,
  incomingConfidence,
  timestamp,
  event,
) {
  if (
    typeof currentValue !== "boolean" ||
    typeof incomingValue !== "boolean" ||
    currentValue === incomingValue
  ) {
    return { shouldKeepExisting: false };
  }

  if (currentSource === incomingSource) {
    return { shouldKeepExisting: false };
  }

  const currentScore = normalizeConfidence(currentConfidence);
  const incomingScore = normalizeConfidence(incomingConfidence);
  if (incomingScore >= CONFLICT_CONFIDENCE_FLOOR || currentScore >= CONFLICT_CONFIDENCE_FLOOR) {
    next.confirmed_facts.recheck_required = true;
    next.confirmed_facts.conflicts.push({
      field,
      existing_value: currentValue,
      incoming_value: incomingValue,
      existing_source: currentSource ?? UNKNOWN_SOURCE,
      incoming_source: incomingSource ?? UNKNOWN_SOURCE,
      existing_confidence: currentConfidence ?? null,
      incoming_confidence: incomingConfidence ?? null,
      event_id: event.event_id ?? null,
      timestamp,
      resolved: false,
    });
  }

  if (currentScore >= STRONG_CONFIDENCE_FLOOR && incomingScore < currentScore) {
    return { shouldKeepExisting: true };
  }

  return { shouldKeepExisting: false };
}

function appendEvidence(next, field, value, source, confidence, timestamp, event) {
  next.confirmed_facts.evidence.push({
    field,
    value,
    source,
    confidence: confidence ?? null,
    event_id: event.event_id ?? null,
    timestamp,
  });
}

function appendTimeline(next, event, timestamp) {
  if (!event.event_type) {
    return;
  }

  next.handover_timeline.push({
    time: timestamp,
    type: event.event_type,
    detail: event.user_input?.intent ?? event.source ?? UNKNOWN_SOURCE,
    event_id: event.event_id ?? null,
  });
}

function createEventSummary(event, timestamp, status) {
  return {
    event_id: event.event_id ?? null,
    event_type: event.event_type ?? null,
    source: event.source ?? null,
    stage_hint: event.stage_hint ?? null,
    sequence_id: event.sequence_id ?? null,
    timestamp,
    status,
  };
}

function isExpiredEvent(event, nowTimestamp) {
  if (!isFiniteNumber(event.ttl_ms) || !event.timestamp) {
    return false;
  }

  const createdAt = Date.parse(event.timestamp);
  const now = Date.parse(nowTimestamp);
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) {
    return false;
  }

  return now - createdAt > event.ttl_ms;
}

function getEventSource(event) {
  return event.source ?? UNKNOWN_SOURCE;
}

function getUserConfidence(event) {
  return numberOrNull(event.user_input?.confidence);
}

function getPatientConfidence(patient, field) {
  return numberOrNull(patient[`${field}_confidence`] ?? patient.confidence);
}

function normalizeConfidence(confidence) {
  return numberOrNull(confidence) ?? 0;
}

function firstNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) {
      return value;
    }
  }
  return null;
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isKnown(value) {
  return value !== undefined;
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function definedValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function mergeObjects(base, overrides) {
  const result = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeObjects(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default sessionReducer;
