/**
 * CPR 视觉指标纯算法库 —— Web 与 Android 共享的 SSOT 逻辑。
 *
 * 输入：MediaPipe Pose 关键点（归一化坐标，x 向右增大、y 向下增大，含 visibility）。
 * 输出：与 cpr_quality PerceptionEvent 契约对齐的指标对象，可直接作为
 *       createPerceptionEvent({ cprQuality }) 的入参，由现有 sessionReducer
 *       (reduceCprQuality) 与 ruleFeedbackEngine (readMetrics) 消费。
 *
 * 边界：仅做运动学近似，不测按压深度（单目无尺度）；置信度低于 minConfidence 时
 *       相关字段输出 null，绝不臆测。频率与中断依赖历史帧，故用有状态的
 *       CprMetricsTracker。
 *
 * update() 顶层输出（snake_case，与 server.js normalizeCprQualityForEvent 契约对齐）：
 *   compressions_started / started、compression_rate / current_rate、average_rate、
 *   quality_score、hand_position（"left" / "right" / "center"）、arm_straight / arm_posture、
 *   interruption_seconds、total_compressions、confidence、vision_ready、pose_coverage、
 *   frame_stability、observed_window_ms。
 */

export const PoseLandmark = Object.freeze({
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
});

const REQUIRED_POSE_LANDMARKS = Object.freeze([
  PoseLandmark.LEFT_SHOULDER,
  PoseLandmark.RIGHT_SHOULDER,
  PoseLandmark.LEFT_ELBOW,
  PoseLandmark.RIGHT_ELBOW,
  PoseLandmark.LEFT_WRIST,
  PoseLandmark.RIGHT_WRIST,
  PoseLandmark.LEFT_HIP,
  PoseLandmark.RIGHT_HIP,
]);

// 内部分类枚举，与 ruleFeedbackEngine handPositionFeedback 的 case 对齐。
// 注意：update() 线缆输出会把 LEFT_OFFSET/RIGHT_OFFSET 映射为 "left"/"right"
// （见 toWireHandPosition），以对齐 cpr_quality 契约与 Android 参考口径。
export const HandPosition = Object.freeze({
  CENTER: "center",
  LEFT_OFFSET: "left_offset",
  RIGHT_OFFSET: "right_offset",
  TOO_HIGH: "too_high",
  TOO_LOW: "too_low",
});

export const DEFAULT_CPR_METRICS_OPTIONS = Object.freeze({
  mirrorX: false,
  // 整体姿态置信度门控（关键关节点 visibility 均值低于此值则相关字段输出 null）。
  // 调用方（web）传入 0.62；默认 0.5。
  minConfidence: 0.5,
  visibilityFloor: 0.5,
  rateWindowMs: 4000,
  minRateCycles: 3,
  // 计算“当前”频率时取最近的若干个周期（其余周期用于窗口平均）。
  recentRateCycles: 4,
  minRateBpm: 50,
  maxRateBpm: 160,
  readinessWindowMs: 1000,
  readinessCoverageFloor: 0.75,
  readinessStabilityFloor: 0.7,
  readinessConfidenceFloor: 0.75,
  frameJitterToleranceRatio: 0.15,
  frameJitterXToleranceRatio: 0.35,
  frameScaleJitterToleranceRatio: 0.25,
  baselineAlpha: 0.05,
  interruptionWindowMs: 1500,
  motionAmplitude: 0.006,
  interruptionTriggerSeconds: 2,
  armStraightDeg: 155,
  // "absolute" uses the rescuer upper-body geometry as a rough chest proxy.
  // "calibrated" treats the first stable press target as the chest-center
  // reference, which is better when the patient/manikin is not detected.
  handPositionReference: "absolute",
  handReferenceWindowMs: 1200,
  handReferenceMinSamples: 6,
  relativeHandXToleranceRatio: 0.55,
  relativeHandYToleranceRatio: 0.65,
  handXToleranceRatio: 0.35,
  handYTopRatio: 0.1,
  handYBottomRatio: 0.6,
  rateLowBpm: 100,
  rateHighBpm: 120,
});

export function createCprMetricsTracker(options = {}) {
  return new CprMetricsTracker(options);
}

export class CprMetricsTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULT_CPR_METRICS_OPTIONS, ...options };
    this.reset();
  }

  reset() {
    this.baseline = null;
    this.lastDevSign = 0;
    this.cycleTimestamps = [];
    this.motionWindow = [];
    this.readinessWindow = [];
    this.handReferenceWindow = [];
    this.handReference = null;
    this.lastMotionAt = null;
    this.totalCompressions = 0;
    this.started = false;
  }

  update(landmarks, timestampMs) {
    const t = Number.isFinite(timestampMs) ? timestampMs : Date.now();
    const o = this.options;

    const leftShoulder = landmarkPoint(landmarks, PoseLandmark.LEFT_SHOULDER, o.mirrorX);
    const rightShoulder = landmarkPoint(landmarks, PoseLandmark.RIGHT_SHOULDER, o.mirrorX);
    const leftElbow = landmarkPoint(landmarks, PoseLandmark.LEFT_ELBOW, o.mirrorX);
    const rightElbow = landmarkPoint(landmarks, PoseLandmark.RIGHT_ELBOW, o.mirrorX);
    const leftWrist = landmarkPoint(landmarks, PoseLandmark.LEFT_WRIST, o.mirrorX);
    const rightWrist = landmarkPoint(landmarks, PoseLandmark.RIGHT_WRIST, o.mirrorX);
    const leftHip = landmarkPoint(landmarks, PoseLandmark.LEFT_HIP, o.mirrorX);
    const rightHip = landmarkPoint(landmarks, PoseLandmark.RIGHT_HIP, o.mirrorX);
    const requiredPoints = [
      leftShoulder,
      rightShoulder,
      leftElbow,
      rightElbow,
      leftWrist,
      rightWrist,
      leftHip,
      rightHip,
    ];

    const confidence = averageVisibility(requiredPoints);
    const poseCoverage = computePoseCoverage(requiredPoints, o.visibilityFloor);
    const shoulderMid = midpoint(leftShoulder, rightShoulder);
    const hipMid = midpoint(leftHip, rightHip);
    const shoulderWidth = distance(leftShoulder, rightShoulder) || 0.0001;
    const readiness = this.trackReadiness({
      t,
      confidence,
      poseCoverage,
      shoulderMid,
      hipMid,
      shoulderWidth,
    });

    // 置信度低于门控：不更新时序窗口，依赖姿态的字段输出 null（诚实边界）。
    if (confidence < o.minConfidence) {
      return this.emit({
        compressionRate: null,
        averageRate: null,
        handPosition: null,
        armStraight: null,
        qualityScore: null,
        interruptionSeconds: 0,
        confidence,
        readiness,
        timestampMs: t,
      });
    }

    const wristMid = midpoint(leftWrist, rightWrist);

    let compressionRate = null;
    let averageRate = null;
    if (wristMid) {
      this.trackSignal(wristMid.y, t);
      const rates = this.computeRates();
      compressionRate = rates.current;
      averageRate = rates.average;
    }

    const handReference = this.trackHandReference(wristMid, t, shoulderWidth);
    const handPosition = classifyHandPosition({
      wrist: wristMid,
      shoulderMid,
      hipMid,
      shoulderWidth,
      reference: handReference,
      options: o,
    });

    const armStraight = computeArmStraight(
      { leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist },
      o.armStraightDeg
    );

    const interruptionSeconds = this.computeInterruption(t);
    const qualityScore = computeQualityScore({
      compressionRate,
      armStraight,
      handPosition,
      interruptionSeconds,
      options: o,
    });

    return this.emit({
      compressionRate,
      averageRate,
      handPosition,
      armStraight,
      qualityScore,
      interruptionSeconds,
      confidence,
      readiness,
      timestampMs: t,
    });
  }

  trackReadiness({ t, confidence, poseCoverage, shoulderMid, hipMid, shoulderWidth }) {
    const o = this.options;
    const anchor = shoulderMid && hipMid ? midpoint(shoulderMid, hipMid) : null;
    this.readinessWindow.push({ t, anchor, shoulderWidth });

    const minT = t - o.readinessWindowMs;
    while (this.readinessWindow.length && this.readinessWindow[0].t < minT) {
      this.readinessWindow.shift();
    }

    const observedWindowMs = computeObservedWindowMs(this.readinessWindow);
    const frameStability = this.computeFrameStability(observedWindowMs);
    const visionReady =
      poseCoverage >= o.readinessCoverageFloor &&
      frameStability >= o.readinessStabilityFloor &&
      confidence >= o.readinessConfidenceFloor;

    return {
      vision_ready: visionReady,
      pose_coverage: roundMetric(poseCoverage),
      frame_stability: roundMetric(frameStability),
      observed_window_ms: Math.round(observedWindowMs),
    };
  }

  computeFrameStability(observedWindowMs) {
    const o = this.options;
    if (this.readinessWindow.length < 2 || !(o.readinessWindowMs > 0)) {
      return 0;
    }

    const anchors = this.readinessWindow.filter((sample) => sample.anchor && sample.shoulderWidth > 0);
    if (anchors.length < 2) {
      return 0;
    }

    const meanX = anchors.reduce((sum, sample) => sum + sample.anchor.x, 0) / anchors.length;
    const meanShoulderWidth =
      anchors.reduce((sum, sample) => sum + sample.shoulderWidth, 0) / anchors.length;
    if (!(meanShoulderWidth > 0)) {
      return 0;
    }

    let maxAnchorXJitter = 0;
    let maxScaleJitter = 0;
    for (const sample of anchors) {
      maxAnchorXJitter = Math.max(maxAnchorXJitter, Math.abs(sample.anchor.x - meanX));
      maxScaleJitter = Math.max(maxScaleJitter, Math.abs(sample.shoulderWidth - meanShoulderWidth));
    }

    const xJitterRatio = maxAnchorXJitter / meanShoulderWidth;
    const scaleJitterRatio = maxScaleJitter / meanShoulderWidth;
    const xScore = clamp(1 - xJitterRatio / o.frameJitterXToleranceRatio, 0, 1);
    const scaleScore = clamp(1 - scaleJitterRatio / o.frameScaleJitterToleranceRatio, 0, 1);
    const observedScore = clamp(observedWindowMs / o.readinessWindowMs, 0, 1);
    return Math.min(xScore, scaleScore, observedScore);
  }

  trackHandReference(wrist, t, shoulderWidth) {
    const o = this.options;
    if (o.handPositionReference !== "calibrated" || !wrist || !(shoulderWidth > 0)) {
      return null;
    }

    if (this.handReference) {
      return this.handReference;
    }

    this.handReferenceWindow.push({ t, x: wrist.x, y: wrist.y, shoulderWidth });
    const minT = t - o.handReferenceWindowMs;
    while (this.handReferenceWindow.length && this.handReferenceWindow[0].t < minT) {
      this.handReferenceWindow.shift();
    }

    const observedWindowMs = computeObservedWindowMs(this.handReferenceWindow);
    if (
      this.handReferenceWindow.length < o.handReferenceMinSamples ||
      observedWindowMs < o.handReferenceWindowMs * 0.6
    ) {
      return null;
    }

    this.handReference = {
      x: median(this.handReferenceWindow.map((sample) => sample.x)),
      y: median(this.handReferenceWindow.map((sample) => sample.y)),
      shoulderWidth: median(this.handReferenceWindow.map((sample) => sample.shoulderWidth)),
    };
    return this.handReference;
  }

  trackSignal(y, t) {
    const o = this.options;
    // 用慢速 EMA 作为去趋势基线，按压表现为手腕 Y 围绕基线的上下振荡。
    this.baseline = this.baseline === null ? y : this.baseline + o.baselineAlpha * (y - this.baseline);
    const dev = y - this.baseline;
    const sign = dev >= 0 ? 1 : -1;
    // 一次向上过零（谷→升）记为一次按压周期。
    if (this.lastDevSign === -1 && sign === 1) {
      this.cycleTimestamps.push(t);
      this.totalCompressions += 1;
      this.started = true;
      this.lastMotionAt = t;
    }
    this.lastDevSign = sign;

    const rateMinT = t - o.rateWindowMs;
    while (this.cycleTimestamps.length && this.cycleTimestamps[0] < rateMinT) {
      this.cycleTimestamps.shift();
    }

    this.motionWindow.push({ t, y });
    const motionMinT = t - o.interruptionWindowMs;
    while (this.motionWindow.length && this.motionWindow[0].t < motionMinT) {
      this.motionWindow.shift();
    }
    if (this.lastMotionAt === null || amplitude(this.motionWindow) >= o.motionAmplitude) {
      this.lastMotionAt = t;
    }
  }

  computeRates() {
    const o = this.options;
    const cycles = this.cycleTimestamps;
    if (cycles.length < o.minRateCycles) {
      return { current: null, average: null };
    }
    // 用相邻按压周期时间戳的间隔估算频率：bpm = (周期数 / 时间跨度) * 60000。
    const toBpm = (count, span) => {
      if (!(span > 0) || count <= 0) {
        return null;
      }
      const bpm = (count / span) * 60000;
      if (bpm < o.minRateBpm || bpm > o.maxRateBpm) {
        return null;
      }
      return Math.round(bpm * 10) / 10;
    };

    // average_rate：滑动窗口内全部周期的平均频率。
    const average = toBpm(cycles.length - 1, cycles[cycles.length - 1] - cycles[0]);

    // compression_rate / current_rate：最近 recentRateCycles 个周期的“当前”频率，
    // 周期不足时回退到窗口平均。
    const recent = cycles.slice(-Math.max(2, o.recentRateCycles));
    const current = toBpm(recent.length - 1, recent[recent.length - 1] - recent[0]) ?? average;

    return { current, average };
  }

  computeInterruption(t) {
    if (this.lastMotionAt === null) {
      return 0;
    }
    const seconds = (t - this.lastMotionAt) / 1000;
    return seconds > 0 ? Math.round(seconds * 100) / 100 : 0;
  }

  emit({
    compressionRate,
    averageRate,
    handPosition,
    armStraight,
    qualityScore,
    interruptionSeconds = 0,
    confidence,
    readiness,
    timestampMs,
  }) {
    const rate = compressionRate ?? null;
    return {
      compressions_started: this.started,
      started: this.started,
      compression_rate: rate,
      current_rate: rate,
      average_rate: averageRate ?? null,
      interruption_seconds: interruptionSeconds,
      hand_position: toWireHandPosition(handPosition),
      hand_position_basis: handPosition
        ? this.options.handPositionReference === "calibrated" && this.handReference
          ? "calibrated_target"
          : "rescuer_torso_proxy"
        : null,
      arm_straight: armStraight ?? null,
      arm_posture: armStraight === true ? "straight" : armStraight === false ? "bent" : null,
      quality_score: qualityScore ?? null,
      total_compressions: this.totalCompressions,
      confidence: Math.round(confidence * 1000) / 1000,
      vision_ready: readiness?.vision_ready ?? false,
      pose_coverage: readiness?.pose_coverage ?? 0,
      frame_stability: readiness?.frame_stability ?? 0,
      observed_window_ms: readiness?.observed_window_ms ?? 0,
      timestamp_ms: timestampMs,
    };
  }
}

/**
 * 把内部 HandPosition 枚举映射为 cpr_quality 线缆取值：
 * 横向偏移 → "left" / "right"，其余（center / too_high / too_low）原样透传，
 * 无法判定 → null。ruleFeedbackEngine 同时接受 "left" 与 "left_offset"。
 */
export function toWireHandPosition(handPosition) {
  switch (handPosition) {
    case HandPosition.LEFT_OFFSET:
      return "left";
    case HandPosition.RIGHT_OFFSET:
      return "right";
    case null:
    case undefined:
      return null;
    default:
      return handPosition;
  }
}

export function landmarkPoint(landmarks, index, mirrorX = false) {
  if (!landmarks) {
    return null;
  }
  const p = landmarks[index];
  if (!p) {
    return null;
  }
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const rawVis = p.visibility ?? p.presence ?? 1;
  const visibility = Number.isFinite(Number(rawVis)) ? Number(rawVis) : 1;
  return { x: mirrorX ? 1 - x : x, y, visibility };
}

export function midpoint(a, b) {
  if (!a || !b) {
    return a || b || null;
  }
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

export function distance(a, b) {
  if (!a || !b) {
    return 0;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function averageVisibility(points) {
  const visibilities = points.filter(Boolean).map((p) => p.visibility ?? 1);
  if (!visibilities.length) {
    return 0;
  }
  return visibilities.reduce((sum, v) => sum + v, 0) / visibilities.length;
}

export function computePoseCoverage(points, visibilityFloor = DEFAULT_CPR_METRICS_OPTIONS.visibilityFloor) {
  if (!points?.length) {
    return 0;
  }
  const covered = points.filter((p) => p && (p.visibility ?? 1) >= visibilityFloor).length;
  return covered / REQUIRED_POSE_LANDMARKS.length;
}

/** 三点夹角（顶点为 b），返回 0–180 度；输入不足时返回 null。 */
export function computeAngle(a, b, c) {
  if (!a || !b || !c) {
    return null;
  }
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const magBA = Math.hypot(bax, bay);
  const magBC = Math.hypot(bcx, bcy);
  if (magBA === 0 || magBC === 0) {
    return null;
  }
  let cos = (bax * bcx + bay * bcy) / (magBA * magBC);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function isArmStraight(shoulder, elbow, wrist, thresholdDeg = 155) {
  const angle = computeAngle(shoulder, elbow, wrist);
  if (angle === null) {
    return null;
  }
  return angle >= thresholdDeg;
}

function computeArmStraight(joints, thresholdDeg) {
  const left = isArmStraight(joints.leftShoulder, joints.leftElbow, joints.leftWrist, thresholdDeg);
  const right = isArmStraight(joints.rightShoulder, joints.rightElbow, joints.rightWrist, thresholdDeg);
  if (left === null && right === null) {
    return null;
  }
  // 任一手臂弯曲即判定弯曲，倾向于提示纠正（更安全）。
  if (left === false || right === false) {
    return false;
  }
  return true;
}

export function classifyHandPosition({
  wrist,
  shoulderMid,
  hipMid,
  shoulderWidth,
  reference = null,
  options = DEFAULT_CPR_METRICS_OPTIONS,
}) {
  if (!wrist || !shoulderMid || !hipMid) {
    return null;
  }
  if (options.handPositionReference === "calibrated") {
    return classifyCalibratedHandPosition({
      wrist,
      reference,
      shoulderWidth,
      options,
    });
  }
  const torsoLen = hipMid.y - shoulderMid.y;
  if (!(torsoLen > 0)) {
    return null;
  }
  // 先判垂直（胸口应在上半躯干），再判水平偏移。
  const top = shoulderMid.y + options.handYTopRatio * torsoLen;
  const bottom = shoulderMid.y + options.handYBottomRatio * torsoLen;
  if (wrist.y < top) {
    return HandPosition.TOO_HIGH;
  }
  if (wrist.y > bottom) {
    return HandPosition.TOO_LOW;
  }
  const centerX = (shoulderMid.x + hipMid.x) / 2;
  const xTol = options.handXToleranceRatio * (shoulderWidth || 0);
  const xOffset = wrist.x - centerX;
  if (xOffset < -xTol) {
    return HandPosition.LEFT_OFFSET;
  }
  if (xOffset > xTol) {
    return HandPosition.RIGHT_OFFSET;
  }
  return HandPosition.CENTER;
}

function classifyCalibratedHandPosition({ wrist, reference, shoulderWidth, options }) {
  if (!wrist) {
    return null;
  }
  if (!reference) {
    return HandPosition.CENTER;
  }
  const scale = reference.shoulderWidth || shoulderWidth || 0;
  if (!(scale > 0)) {
    return HandPosition.CENTER;
  }
  const xTol = options.relativeHandXToleranceRatio * scale;
  const yTol = options.relativeHandYToleranceRatio * scale;
  const xOffset = wrist.x - reference.x;
  const yOffset = wrist.y - reference.y;
  if (xOffset < -xTol) {
    return HandPosition.LEFT_OFFSET;
  }
  if (xOffset > xTol) {
    return HandPosition.RIGHT_OFFSET;
  }
  if (yOffset < -yTol) {
    return HandPosition.TOO_HIGH;
  }
  if (yOffset > yTol) {
    return HandPosition.TOO_LOW;
  }
  return HandPosition.CENTER;
}

export function computeQualityScore({
  compressionRate,
  armStraight,
  handPosition,
  interruptionSeconds,
  options = DEFAULT_CPR_METRICS_OPTIONS,
}) {
  if (compressionRate === null || compressionRate === undefined) {
    return null;
  }
  let score = 0;
  if (compressionRate >= options.rateLowBpm && compressionRate <= options.rateHighBpm) {
    score += 40;
  } else {
    const target = (options.rateLowBpm + options.rateHighBpm) / 2;
    score += Math.max(0, 40 - Math.abs(compressionRate - target));
  }
  if (armStraight === true) {
    score += 20;
  }
  if (handPosition === HandPosition.CENTER) {
    score += 20;
  }
  if ((interruptionSeconds ?? 0) < options.interruptionTriggerSeconds) {
    score += 20;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function amplitude(window) {
  if (window.length < 2) {
    return 0;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const sample of window) {
    if (sample.y < min) {
      min = sample.y;
    }
    if (sample.y > max) {
      max = sample.y;
    }
  }
  return max - min;
}

function computeObservedWindowMs(window) {
  if (window.length < 2) {
    return 0;
  }
  return Math.max(0, window[window.length - 1].t - window[0].t);
}

function median(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundMetric(value) {
  return Math.round(value * 1000) / 1000;
}
