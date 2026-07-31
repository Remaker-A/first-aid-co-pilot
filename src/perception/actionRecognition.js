import {
  AgentStage,
  EventSource,
  EventType,
  FatigueLevel,
  Mode,
  RescuerEmotion,
  createPerceptionEvent,
  nowIso,
} from "../domain/types.js";

export const ACTION_RECOGNITION_FRAME_SCHEMA_VERSION = "action_recognition_frame.v0.1";
export const ACTION_RECOGNITION_RESULT_SCHEMA_VERSION = "action_recognition_result.v0.1";
export const ACTION_RECOGNIZER_NAME = "cpr_action_heuristic_v0.1";

const DEFAULT_TTL_MS = 1500;
const DEFAULT_ARM_STRAIGHT_DEGREES = 155;
const DEFAULT_INTERRUPTION_MS = 2000;
const RATE_LOW = 100;
const RATE_HIGH = 120;
const RATE_TARGET = 110;

const PoseIndex = Object.freeze({
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
});

const LandmarkAliases = Object.freeze({
  left_shoulder: ["left_shoulder", "leftShoulder", "LEFT_SHOULDER", PoseIndex.LEFT_SHOULDER],
  right_shoulder: ["right_shoulder", "rightShoulder", "RIGHT_SHOULDER", PoseIndex.RIGHT_SHOULDER],
  left_elbow: ["left_elbow", "leftElbow", "LEFT_ELBOW", PoseIndex.LEFT_ELBOW],
  right_elbow: ["right_elbow", "rightElbow", "RIGHT_ELBOW", PoseIndex.RIGHT_ELBOW],
  left_wrist: ["left_wrist", "leftWrist", "LEFT_WRIST", PoseIndex.LEFT_WRIST],
  right_wrist: ["right_wrist", "rightWrist", "RIGHT_WRIST", PoseIndex.RIGHT_WRIST],
  left_hip: ["left_hip", "leftHip", "LEFT_HIP", PoseIndex.LEFT_HIP],
  right_hip: ["right_hip", "rightHip", "RIGHT_HIP", PoseIndex.RIGHT_HIP],
  chest_center: ["chest_center", "chestCenter", "CHEST_CENTER"],
});

export function recognizeCprActionFrame(frame = {}, options = {}) {
  const timestamp = frame.timestamp ?? options.timestamp ?? nowIso();
  const timestampMs = resolveTimestampMs(frame, timestamp);
  const directQuality = frame.cpr_quality ?? frame.cprQuality ?? frame.compression ?? {};
  const landmarks = normalizeLandmarks(frame.pose?.landmarks ?? frame.landmarks ?? frame.keypoints);
  const chestCenter = readPoint(
    frame.chest_center ??
      frame.chestCenter ??
      frame.target?.chest_center ??
      frame.target?.chestCenter ??
      frame.patient?.chest_center ??
      frame.patient?.chestCenter,
  ) ?? estimateChestCenter(landmarks);
  const handCenter = readPoint(
    frame.hand_center ??
      frame.handCenter ??
      frame.pressure_point ??
      frame.pressurePoint ??
      frame.hands?.pressure_point ??
      frame.hands?.pressurePoint,
  ) ?? estimateHandCenter(landmarks, frame.hands);
  const scale = estimateTorsoScale(frame, landmarks, chestCenter);
  const handPosition = resolveHandPosition(directQuality, frame, handCenter, chestCenter, scale, options);
  const arm = resolveArmPosture(directQuality, frame, landmarks, options);
  const compression = estimateCompression(frame, timestampMs, options);
  const rescuerState = recognizeRescuerState(frame);
  const qualityScore = firstNumber(directQuality.quality_score, directQuality.score, frame.quality_score) ?? scoreCprQuality({
    handPosition: handPosition.value,
    armStraight: arm.armStraight,
    compressionRate: compression.rate,
    interruptionSeconds: compression.interruptionSeconds,
    compressionsStarted: compression.compressionsStarted,
  });
  const confidence = combineConfidence([
    readConfidence(frame),
    readConfidence(frame.pose),
    readConfidence(directQuality),
    handPosition.confidence,
    arm.confidence,
    compression.confidence,
  ]);

  const cprQuality = definedValues({
    camera_view: directQuality.camera_view ?? directQuality.cameraView ?? frame.camera_view ?? frame.cameraView ?? frame.camera?.view ?? null,
    compressions_started: compression.compressionsStarted,
    compression_started: compression.compressionsStarted,
    compression_rate_bpm: compression.rate,
    compression_rate: compression.rate,
    current_rate: compression.rate,
    average_rate: compression.averageRate,
    hand_position: handPosition.value,
    hand_offset: handPosition.offset,
    arm_straight: arm.armStraight,
    arm_posture: arm.armStraight == null ? null : arm.armStraight ? "straight" : "bent",
    interruption_ms: compression.interruptionMs,
    interruption_seconds: compression.interruptionSeconds,
    total_compressions: compression.totalCompressions,
    quality_score: qualityScore,
    confidence,
    observed_window_ms: compression.observedWindowMs,
  });

  return {
    schema_version: ACTION_RECOGNITION_RESULT_SCHEMA_VERSION,
    session_id: frame.session_id ?? frame.sessionId ?? options.sessionId ?? options.session_id ?? null,
    timestamp,
    source: EventSource.VISION_CPR,
    event_type: EventType.CPR_QUALITY_UPDATE,
    stage_hint: frame.stage_hint ?? frame.stageHint ?? options.stageHint ?? AgentStage.S7_CPR_LOOP,
    sequence_id: frame.sequence_id ?? frame.sequenceId ?? options.sequenceId ?? null,
    cpr_quality: cprQuality,
    rescuer_state: rescuerState,
    metadata: definedValues({
      recognizer: ACTION_RECOGNIZER_NAME,
      input_schema_version: frame.schema_version ?? ACTION_RECOGNITION_FRAME_SCHEMA_VERSION,
      camera_facing: frame.camera?.facing ?? null,
      chest_center: chestCenter,
      hand_center: handCenter,
      torso_scale: scale,
      arm_angles: arm.angles,
      compression_observation: compression.observation,
    }),
  };
}

export function createCprActionRecognitionEvent(frame = {}, options = {}) {
  const result = recognizeCprActionFrame(frame, options);

  return createPerceptionEvent({
    sessionId: result.session_id,
    timestamp: result.timestamp,
    mode: frame.mode ?? options.mode ?? Mode.REAL_PERCEPTION,
    source: result.source,
    eventType: result.event_type,
    stageHint: result.stage_hint,
    sequenceId: result.sequence_id,
    ttlMs: frame.ttl_ms ?? frame.ttlMs ?? options.ttlMs ?? DEFAULT_TTL_MS,
    cprQuality: result.cpr_quality,
    rescuerState: result.rescuer_state,
    metadata: {
      ...(frame.metadata ?? {}),
      ...result.metadata,
    },
  });
}

export const createActionRecognitionPerceptionEvent = createCprActionRecognitionEvent;

function normalizeLandmarks(input) {
  const raw = new Map();

  if (Array.isArray(input)) {
    input.forEach((point, index) => {
      const normalized = readPoint(point);
      if (!normalized) return;
      raw.set(index, normalized);
      if (point?.name) raw.set(point.name, normalized);
      if (point?.id != null) raw.set(point.id, normalized);
    });
  } else if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      const normalized = readPoint(value);
      if (normalized) raw.set(key, normalized);
    }
  }

  const landmarks = {};
  for (const [canonical, aliases] of Object.entries(LandmarkAliases)) {
    for (const alias of aliases) {
      if (raw.has(alias)) {
        landmarks[canonical] = raw.get(alias);
        break;
      }
      const textAlias = String(alias);
      if (raw.has(textAlias)) {
        landmarks[canonical] = raw.get(textAlias);
        break;
      }
    }
  }

  return landmarks;
}

function readPoint(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    return definedValues({
      x: numberOrNull(value[0]),
      y: numberOrNull(value[1]),
      z: numberOrNull(value[2]),
      visibility: numberOrNull(value[3]),
    });
  }
  if (typeof value !== "object") return null;

  const x = firstNumber(value.x, value.normalized_x, value.cx, value.center_x);
  const y = firstNumber(value.y, value.normalized_y, value.cy, value.center_y);
  if (x == null || y == null) return null;

  return definedValues({
    x,
    y,
    z: firstNumber(value.z, value.depth, value.normalized_z),
    visibility: firstNumber(value.visibility, value.score, value.confidence),
  });
}

function estimateChestCenter(landmarks) {
  if (landmarks.chest_center) return landmarks.chest_center;

  const shoulders = midpoint(landmarks.left_shoulder, landmarks.right_shoulder);
  const hips = midpoint(landmarks.left_hip, landmarks.right_hip);
  if (shoulders && hips) {
    return {
      x: shoulders.x,
      y: shoulders.y + (hips.y - shoulders.y) * 0.42,
      visibility: averageNumbers(shoulders.visibility, hips.visibility),
    };
  }
  return shoulders;
}

function estimateHandCenter(landmarks, hands) {
  const fromHands = estimateHandCenterFromDetections(hands);
  if (fromHands) return fromHands;
  return midpoint(landmarks.left_wrist, landmarks.right_wrist) ?? landmarks.left_wrist ?? landmarks.right_wrist ?? null;
}

function estimateHandCenterFromDetections(hands) {
  const list = Array.isArray(hands) ? hands : Array.isArray(hands?.detections) ? hands.detections : null;
  if (!list || list.length === 0) return null;

  const points = list
    .map((item) => readPoint(item.center ?? item.center_point ?? item))
    .filter(Boolean);
  return averagePoint(points);
}

function estimateTorsoScale(frame, landmarks, chestCenter) {
  const explicit = firstNumber(
    frame.torso_width,
    frame.torsoWidth,
    frame.chest_width,
    frame.chestWidth,
    frame.patient?.torso_width,
    frame.patient?.torsoWidth,
  );
  if (explicit != null && explicit > 0) return explicit;

  const shoulderWidth = distance(landmarks.left_shoulder, landmarks.right_shoulder);
  if (shoulderWidth != null && shoulderWidth > 0) return shoulderWidth;

  const chestWidth = firstNumber(chestCenter?.width, chestCenter?.w);
  if (chestWidth != null && chestWidth > 0) return chestWidth;

  return 0.35;
}

function classifyHandPosition(handCenter, chestCenter, scale, options = {}) {
  if (!handCenter || !chestCenter || !scale) {
    return { value: "unknown", offset: null, confidence: 0.25 };
  }

  const xThreshold = options.handXThreshold ?? 0.16;
  const yThreshold = options.handYThreshold ?? 0.18;
  const dx = (handCenter.x - chestCenter.x) / scale;
  const dy = (handCenter.y - chestCenter.y) / scale;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const offset = round(Math.hypot(dx, dy), 3);
  const confidence = combineConfidence([pointConfidence(handCenter), pointConfidence(chestCenter), 0.9]);

  if (absX <= xThreshold && absY <= yThreshold) {
    return { value: "center", offset, confidence };
  }

  if (absX > xThreshold && absY > yThreshold) {
    return { value: "off_center", offset, confidence };
  }

  if (absX > xThreshold) {
    return { value: dx < 0 ? "left_offset" : "right_offset", offset, confidence };
  }

  return { value: dy < 0 ? "too_high" : "too_low", offset, confidence };
}

function resolveHandPosition(directQuality, frame, handCenter, chestCenter, scale, options = {}) {
  const explicit = directQuality.hand_position ?? directQuality.handPosition ?? frame.hand_position ?? frame.handPosition;
  if (typeof explicit === "string" && explicit.length > 0) {
    return {
      value: explicit,
      offset: firstNumber(directQuality.hand_offset, directQuality.handOffset, frame.hand_offset, frame.handOffset),
      confidence: readConfidence(directQuality) ?? readConfidence(frame) ?? 0.9,
    };
  }

  return classifyHandPosition(handCenter, chestCenter, scale, options);
}

function resolveArmPosture(directQuality, frame, landmarks, options = {}) {
  const explicitStraight = firstDefined(
    directQuality.arm_straight,
    directQuality.arms_straight,
    frame.arm_straight,
    frame.arms_straight,
  );
  if (explicitStraight !== null) {
    return {
      armStraight: Boolean(explicitStraight),
      confidence: readConfidence(directQuality) ?? readConfidence(frame) ?? 0.9,
      angles: null,
    };
  }

  const posture = directQuality.arm_posture ?? directQuality.armPosture ?? frame.arm_posture ?? frame.armPosture;
  if (posture === "bent") {
    return { armStraight: false, confidence: readConfidence(directQuality) ?? readConfidence(frame) ?? 0.85, angles: null };
  }
  if (posture === "straight" || posture === "acceptable") {
    return { armStraight: true, confidence: readConfidence(directQuality) ?? readConfidence(frame) ?? 0.85, angles: null };
  }

  if (directQuality.arm_bent === true || directQuality.elbow_bent === true || frame.arm_bent === true || frame.elbow_bent === true) {
    return { armStraight: false, confidence: readConfidence(directQuality) ?? readConfidence(frame) ?? 0.8, angles: null };
  }

  return estimateArmPostureFromLandmarks(landmarks, options);
}

function estimateArmPostureFromLandmarks(landmarks, options = {}) {
  const threshold = options.armStraightDegrees ?? DEFAULT_ARM_STRAIGHT_DEGREES;
  const left = jointAngleDegrees(landmarks.left_shoulder, landmarks.left_elbow, landmarks.left_wrist);
  const right = jointAngleDegrees(landmarks.right_shoulder, landmarks.right_elbow, landmarks.right_wrist);
  const angles = definedValues({ left, right });
  const available = [left, right].filter((value) => value != null);

  if (available.length === 0) {
    return { armStraight: null, confidence: 0.25, angles };
  }

  const average = available.reduce((sum, value) => sum + value, 0) / available.length;
  return {
    armStraight: average >= threshold,
    confidence: clamp(available.length / 2, 0.45, 0.95),
    angles,
  };
}

function estimateCompression(frame, timestampMs, options = {}) {
  const direct = frame.cpr_quality ?? frame.cprQuality ?? frame.compression ?? {};
  const directRate = firstNumber(
    direct.compression_rate,
    direct.current_rate,
    direct.compression_rate_bpm,
    direct.rate,
    frame.compression_rate,
    frame.compression_rate_bpm,
    frame.current_rate,
  );
  const directStarted = firstDefined(
    direct.compressions_started,
    direct.compression_started,
    direct.started,
    frame.compressions_started,
    frame.compression_started,
  );
  const directInterruption = firstNumber(
    direct.interruption_seconds,
    direct.last_interruption_seconds,
    frame.interruption_seconds,
  );
  const directInterruptionMs = firstNumber(
    direct.interruption_ms,
    direct.last_interruption_ms,
    frame.interruption_ms,
  );
  const directTotal = firstNumber(
    direct.total_compressions,
    direct.compression_count,
    frame.total_compressions,
    frame.compression_count,
  );
  const timestamps = normalizeCompressionTimestamps(
    frame.compression_timestamps_ms ??
      frame.compressionTimestampsMs ??
      frame.compression_timestamps ??
      frame.compressionTimestamps ??
      direct.compression_timestamps_ms,
  );
  const samplePeaks = timestamps.length >= 2
    ? []
    : detectCompressionPeaks(frame.compression_samples ?? frame.compressionSamples ?? frame.samples, options);
  const compressionTimes = timestamps.length >= 2 ? timestamps : samplePeaks;
  const sampleWindowMs = observedSampleWindowMs(frame.compression_samples ?? frame.compressionSamples ?? frame.samples);
  const rateFromTimes = compressionTimes.length >= 2 ? rateFromTimestamps(compressionTimes) : null;
  const lastCompressionMs = compressionTimes.length > 0 ? compressionTimes[compressionTimes.length - 1] : null;
  const inferredInterruptionMs =
    lastCompressionMs != null && timestampMs != null && timestampMs >= lastCompressionMs
      ? timestampMs - lastCompressionMs
      : null;
  const interruptionSeconds = directInterruption ?? (
    directInterruptionMs != null ? round(directInterruptionMs / 1000, 2) :
    inferredInterruptionMs != null
      ? round(inferredInterruptionMs / 1000, 2)
      : null
  );
  const interruptionMs = directInterruptionMs ?? (
    directInterruption != null ? Math.round(directInterruption * 1000) : inferredInterruptionMs
  );
  const observedWindowMs = firstNumber(
    direct.observed_window_ms,
    direct.observedWindowMs,
    frame.observed_window_ms,
    frame.observedWindowMs,
  ) ?? (
    compressionTimes.length >= 2
      ? compressionTimes[compressionTimes.length - 1] - compressionTimes[0]
      : sampleWindowMs
  );
  const rate = directRate ?? rateFromTimes;
  const started = directStarted ?? (
    rate != null && (interruptionSeconds == null || interruptionSeconds < (options.interruptionMs ?? DEFAULT_INTERRUPTION_MS) / 1000)
  );

  return {
    rate: rate == null ? null : Math.round(rate),
    averageRate: rate == null ? null : Math.round(rate),
    compressionsStarted: started == null ? null : Boolean(started),
    interruptionMs,
    interruptionSeconds: interruptionSeconds ?? (started === true ? 0 : null),
    totalCompressions: directTotal ?? (compressionTimes.length > 0 ? compressionTimes.length : null),
    observedWindowMs,
    confidence: compressionConfidence({ directRate, compressionTimes, samples: frame.compression_samples ?? frame.compressionSamples ?? frame.samples }),
    observation: definedValues({
      source: directRate != null ? "direct_rate" : compressionTimes.length >= 2 ? "time_series" : "unknown",
      compression_count: compressionTimes.length,
      last_compression_ms: lastCompressionMs,
      observed_window_ms: observedWindowMs,
    }),
  };
}

function normalizeCompressionTimestamps(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return firstNumber(value?.timestamp_ms, value?.timestampMs, value?.t_ms, value?.time_ms);
    })
    .filter((value) => value != null)
    .sort((a, b) => a - b);
}

function detectCompressionPeaks(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 3) return [];

  const normalized = samples
    .map((sample, index) => ({
      time: firstNumber(sample.timestamp_ms, sample.timestampMs, sample.t_ms, sample.time_ms, sample.t) ?? index * 33,
      value: readCompressionSampleValue(sample),
    }))
    .filter((sample) => sample.value != null)
    .sort((a, b) => a.time - b.time);

  if (normalized.length < 3) return [];

  const values = normalized.map((sample) => sample.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const threshold = options.peakThreshold ?? mean + Math.sqrt(variance) * 0.25;
  const minGap = options.minCompressionGapMs ?? 250;
  const peaks = [];

  for (let index = 1; index < normalized.length - 1; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    const next = normalized[index + 1];
    const enoughGap = peaks.length === 0 || current.time - peaks[peaks.length - 1] >= minGap;
    if (
      current.value >= threshold &&
      current.value >= previous.value &&
      current.value > next.value &&
      enoughGap
    ) {
      peaks.push(current.time);
    }
  }

  return peaks;
}

function observedSampleWindowMs(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const times = samples
    .map((sample, index) => firstNumber(sample.timestamp_ms, sample.timestampMs, sample.t_ms, sample.time_ms, sample.t) ?? index * 33)
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  return times[times.length - 1] - times[0];
}

function readCompressionSampleValue(sample = {}) {
  return firstNumber(
    sample.depth_mm,
    sample.compression_depth_mm,
    sample.depth,
    sample.compression_depth,
    sample.hand_y,
    sample.wrist_y,
    sample.y,
  );
}

function rateFromTimestamps(timestamps) {
  const intervals = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const interval = timestamps[index] - timestamps[index - 1];
    if (interval > 0) intervals.push(interval);
  }
  if (intervals.length === 0) return null;
  const recent = intervals.slice(-8);
  const averageInterval = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  return 60000 / averageInterval;
}

function recognizeRescuerState(frame = {}) {
  const rescuer = frame.rescuer_state ?? frame.rescuerState ?? frame.rescuer ?? null;
  if (!rescuer || typeof rescuer !== "object") return null;

  const fatigueScore = firstNumber(rescuer.fatigue_score, rescuer.fatigueScore, rescuer.fatigue);
  const panicScore = firstNumber(rescuer.panic_score, rescuer.panicScore, rescuer.anxiety_score);
  const explicitFatigue = rescuer.fatigue_level ?? rescuer.fatigueLevel;

  return definedValues({
    emotion: rescuer.emotion ?? emotionFromPanicScore(panicScore),
    fatigue_level: explicitFatigue ?? fatigueLevelFromScore(fatigueScore),
    hesitation_seconds: firstNumber(rescuer.hesitation_seconds, rescuer.hesitationSeconds),
    confidence: firstNumber(rescuer.confidence, rescuer.score, fatigueScore, panicScore),
  });
}

function scoreCprQuality({ handPosition, armStraight, compressionRate, interruptionSeconds, compressionsStarted }) {
  let score = 100;

  if (handPosition && handPosition !== "center") score -= handPosition === "off_center" ? 25 : 18;
  if (armStraight === false) score -= 18;
  if (compressionRate == null) {
    score -= 12;
  } else if (compressionRate < RATE_LOW || compressionRate > RATE_HIGH) {
    score -= Math.min(25, Math.abs(compressionRate - RATE_TARGET) * 1.2);
  }
  if (compressionsStarted === false || (interruptionSeconds ?? 0) >= 2) score -= 28;

  return Math.round(clamp(score, 0, 100));
}

function compressionConfidence({ directRate, compressionTimes, samples }) {
  if (directRate != null) return 0.9;
  if (compressionTimes.length >= 4) return 0.82;
  if (compressionTimes.length >= 2) return 0.68;
  if (Array.isArray(samples) && samples.length >= 8) return 0.55;
  return 0.35;
}

function resolveTimestampMs(frame, timestamp) {
  const explicit = firstNumber(frame.timestamp_ms, frame.timestampMs, frame.time_ms);
  if (explicit != null) return explicit;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function jointAngleDegrees(a, b, c) {
  if (!a || !b || !c) return null;
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const magA = Math.hypot(ab.x, ab.y);
  const magC = Math.hypot(cb.x, cb.y);
  if (magA === 0 || magC === 0) return null;
  const cosine = clamp((ab.x * cb.x + ab.y * cb.y) / (magA * magC), -1, 1);
  return round((Math.acos(cosine) * 180) / Math.PI, 1);
}

function midpoint(a, b) {
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: averageNumbers(pointConfidence(a), pointConfidence(b)),
  };
}

function averagePoint(points) {
  if (!points || points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    visibility: averageNumbers(...points.map(pointConfidence)),
  };
}

function distance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointConfidence(point) {
  return numberOrNull(point?.visibility) ?? 0.8;
}

function readConfidence(value) {
  return numberOrNull(value?.confidence ?? value?.score);
}

function combineConfidence(values) {
  const filtered = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (filtered.length === 0) return null;
  const average = filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
  return round(clamp(average, 0, 1), 2);
}

function fatigueLevelFromScore(score) {
  if (score == null) return null;
  if (score >= 0.75) return FatigueLevel.HIGH;
  if (score >= 0.4) return FatigueLevel.MEDIUM;
  return FatigueLevel.LOW;
}

function emotionFromPanicScore(score) {
  if (score == null) return null;
  if (score >= 0.75) return RescuerEmotion.PANIC;
  if (score >= 0.4) return RescuerEmotion.ANXIOUS;
  return RescuerEmotion.CALM;
}

function averageNumbers(...values) {
  const filtered = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function definedValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null),
  );
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
