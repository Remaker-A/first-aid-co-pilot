import { AgentStage } from "../domain/stages.js";
import { createGuidanceAction } from "../domain/actionFactories.js";
import { isActionableCprQualityEvent } from "./cprEventGuards.js";

const TARGET_BPM = 110;
const RATE_LOW = 100;
const RATE_HIGH = 120;
const INTERRUPTION_SECONDS = 2;

export const RuleFeedbackType = Object.freeze({
  INTERRUPTION: "interruption",
  HAND_POSITION: "hand_position",
  RATE_LOW: "rate_low",
  RATE_HIGH: "rate_high",
  ARM_BENT: "arm_bent",
  FATIGUE: "fatigue",
  AED: "aed",
  ENCOURAGEMENT: "encouragement",
});

export function createRuleFeedbackAction(state = {}, event = null) {
  if ((state.current_stage ?? event?.stage_hint) !== AgentStage.S7_CPR_LOOP) {
    return null;
  }

  const feedback = selectRuleFeedback(state, event);
  return feedback ? buildFeedbackAction(state, feedback, event) : null;
}

export function selectRuleFeedback(state = {}, event = null) {
  const metrics = readMetrics(state, event);

  // Interruption is the highest-priority, safety-first correction and is judged
  // first. It fires whenever compressions have been interrupted past the
  // threshold, UNLESS the rescuer is demonstrably still compressing at an
  // actionable (out-of-range) rate — only then are the interruption seconds
  // treated as stale and deferred to the rate correction. A zero rate or
  // compressions_started === false counts as "stopped", never a fresh rate, so
  // a stopped rescuer with an interruption always gets "不要停，继续按压。".
  const hasActionableFreshRate =
    metrics.hasFreshCompressionRate &&
    metrics.compressionRate !== null &&
    (metrics.compressionRate < RATE_LOW || metrics.compressionRate > RATE_HIGH);

  if (metrics.interruptionSeconds >= INTERRUPTION_SECONDS && !hasActionableFreshRate) {
    return {
      type: RuleFeedbackType.INTERRUPTION,
      intent: "correct_compression_interruption",
      priority: "critical",
      reasonCodes: ["compression_interrupted", `interruption_${Math.round(metrics.interruptionSeconds)}s`],
      throttleKey: "correction.interruption",
      minIntervalMs: 5000,
      tts: { text: "不要停，继续按压。", tone: "urgent" },
      ui: {
        mainText: "继续按压",
        secondaryText: "中断时间过长",
        statusTags: ["不要停", "继续按压"],
      },
      visualOverlay: { mode: "continue_compressions" },
      logDetail: "compression_interrupted",
    };
  }

  const handPositionFeedback = getHandPositionFeedback(metrics.handPosition);
  if (handPositionFeedback) {
    return {
      ...handPositionFeedback,
      type: RuleFeedbackType.HAND_POSITION,
      intent: "correct_hand_position",
      priority: "high",
      throttleKey: "correction.hand_position",
      minIntervalMs: 8000,
      logDetail: handPositionFeedback.reasonCodes[0],
    };
  }

  if (metrics.compressionRate !== null && metrics.compressionRate < RATE_LOW) {
    return {
      type: RuleFeedbackType.RATE_LOW,
      intent: "correct_compression_rate",
      priority: "high",
      reasonCodes: ["compression_rate_low", `rate_${Math.round(metrics.compressionRate)}_per_min`],
      throttleKey: "correction.rate_low",
      minIntervalMs: 8000,
      tts: { text: "再快一点，跟着节拍按。", tone: "calm_firm" },
      ui: {
        mainText: "按压偏慢",
        secondaryText: "目标 100-120 次/分钟",
        statusTags: ["偏慢", "跟着节拍"],
      },
      visualOverlay: { mode: "rate_feedback" },
      logDetail: "compression_rate_low",
    };
  }

  if (metrics.compressionRate !== null && metrics.compressionRate > RATE_HIGH) {
    return {
      type: RuleFeedbackType.RATE_HIGH,
      intent: "correct_compression_rate",
      priority: "high",
      reasonCodes: ["compression_rate_high", `rate_${Math.round(metrics.compressionRate)}_per_min`],
      throttleKey: "correction.rate_high",
      minIntervalMs: 8000,
      tts: { text: "稍微慢一点，跟着节拍按。", tone: "calm_firm" },
      ui: {
        mainText: "按压偏快",
        secondaryText: "目标 100-120 次/分钟",
        statusTags: ["偏快", "跟着节拍"],
      },
      visualOverlay: { mode: "rate_feedback" },
      logDetail: "compression_rate_high",
    };
  }

  if (metrics.armBent) {
    return {
      type: RuleFeedbackType.ARM_BENT,
      intent: "correct_arm_posture",
      priority: "high",
      reasonCodes: ["arm_bent"],
      throttleKey: "correction.arm_bent",
      minIntervalMs: 8000,
      tts: { text: "手臂伸直，用上半身向下压。", tone: "calm_firm" },
      ui: {
        mainText: "手臂伸直",
        secondaryText: "用上半身向下压",
        statusTags: ["手臂伸直", "向下压"],
      },
      visualOverlay: { mode: "arm_posture_feedback" },
      logDetail: "arm_bent",
    };
  }

  if (metrics.fatigueLevel === "high" || metrics.fatigueLevel === "exhausted") {
    return {
      type: RuleFeedbackType.FATIGUE,
      intent: "assist_rescuer_fatigue",
      priority: "normal",
      reasonCodes: [`rescuer_fatigue_${metrics.fatigueLevel}`],
      throttleKey: "assistance.fatigue",
      minIntervalMs: 15000,
      tts: { text: "如果旁边有人，请准备换手。", tone: "calm_firm" },
      ui: {
        mainText: "准备换手",
        secondaryText: "尽量保持按压不中断",
        statusTags: ["疲劳提醒", "准备换手"],
      },
      visualOverlay: { mode: "rescuer_assistance" },
      logDetail: "rescuer_fatigue",
    };
  }

  if (metrics.aedAvailable === true || metrics.aedStatus === "available") {
    return {
      type: RuleFeedbackType.AED,
      intent: "assist_aed",
      priority: "normal",
      reasonCodes: ["aed_available"],
      throttleKey: "assistance.aed",
      minIntervalMs: 15000,
      tts: { text: "打开 AED，跟着它的语音做，先继续按压。", tone: "calm_firm" },
      ui: {
        mainText: "AED 到达",
        secondaryText: "继续胸外按压",
        statusTags: ["AED", "继续按压"],
      },
      visualOverlay: { mode: "aed_assistance" },
      logDetail: "aed_available",
    };
  }

  if (event?.metadata?.encourage_tick === true) {
    return {
      type: RuleFeedbackType.ENCOURAGEMENT,
      intent: "encourage_rescuer",
      priority: "normal",
      reasonCodes: ["encourage_tick"],
      throttleKey: "encourage.s7",
      minIntervalMs: 20000,
      tts: { text: "你做得很好，跟着节拍继续。", tone: "calm_soft" },
      ui: {
        mainText: "保持节拍",
        secondaryText: "你做得很好",
        statusTags: ["鼓励", "跟着节拍"],
      },
      visualOverlay: { mode: "rescuer_assistance" },
      haptic: { enabled: false },
      logEventType: "encouragement",
      logDetail: "encourage_tick",
    };
  }

  return null;
}

function buildFeedbackAction(state, feedback, event) {
  return createGuidanceAction({
    sessionId: state.session_id ?? null,
    timestamp: event?.timestamp ?? state.updated_at,
    stage: AgentStage.S7_CPR_LOOP,
    intent: feedback.intent,
    priority: feedback.priority,
    source: "rule_feedback",
    reasonCodes: feedback.reasonCodes,
    ttlMs: 3000,
    throttleKey: feedback.throttleKey,
    minIntervalMs: feedback.minIntervalMs,
    tts: {
      text: feedback.tts.text,
      tone: feedback.tts.tone,
      speed: "normal",
      interruptPolicy: feedback.priority === "critical"
        ? "interrupt_lower_priority"
        : "do_not_interrupt_critical",
    },
    ui: {
      mainText: feedback.ui.mainText,
      secondaryText: feedback.ui.secondaryText,
      statusTags: feedback.ui.statusTags,
      qualityScore: state.cpr_state?.quality_score ?? null,
    },
    haptic: feedback.haptic ?? { enabled: true, pattern: "metronome", bpm: TARGET_BPM },
    visualOverlay: feedback.visualOverlay,
    toolActions: [],
    logEvent: { type: feedback.logEventType ?? "correction", detail: feedback.logDetail },
  });
}

function readMetrics(state, event) {
  const eventQuality = isActionableCprQualityEvent(event) ? event?.cpr_quality ?? {} : {};
  const cprState = state.cpr_state ?? {};
  const rescuerState = { ...(state.rescuer_state ?? {}), ...(event?.rescuer_state ?? {}) };
  const eventCompressionRate = firstNumber(
    eventQuality.compression_rate,
    eventQuality.compression_rate_bpm,
    eventQuality.current_rate,
    eventQuality.rate
  );

  return {
    handPosition: firstDefined(eventQuality.hand_position, cprState.hand_position),
    compressionRate: firstNumber(
      eventCompressionRate,
      cprState.current_rate
    ),
    hasFreshCompressionRate:
      eventCompressionRate !== null &&
      eventCompressionRate !== 0 &&
      eventQuality.compressions_started !== false,
    interruptionSeconds: firstNumber(
      eventQuality.interruption_seconds,
      eventQuality.last_interruption_seconds,
      cprState.last_interruption_seconds
    ) ?? 0,
    armBent: isArmBent(eventQuality, cprState),
    fatigueLevel: rescuerState.fatigue_level ?? null,
    aedStatus: event?.metadata?.aed_status ?? event?.device_state?.aed_status ?? rescuerState.aed_status ?? null,
    aedAvailable: event?.metadata?.aed_available ?? event?.device_state?.aed_available ?? rescuerState.aed_available ?? null,
  };
}

function getHandPositionFeedback(handPosition) {
  switch (handPosition) {
    case "left":
    case "left_offset":
    case "too_left":
      return {
        reasonCodes: ["hand_position_left_offset"],
        tts: { text: "位置向右一点。", tone: "calm_firm" },
        ui: {
          mainText: "位置偏左",
          secondaryText: "向右调整一点",
          statusTags: ["位置偏左", "向右一点"],
        },
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "right",
        },
      };
    case "right":
    case "right_offset":
    case "too_right":
      return {
        reasonCodes: ["hand_position_right_offset"],
        tts: { text: "位置向左一点。", tone: "calm_firm" },
        ui: {
          mainText: "位置偏右",
          secondaryText: "向左调整一点",
          statusTags: ["位置偏右", "向左一点"],
        },
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "left",
        },
      };
    case "too_high":
    case "upper_offset":
      return {
        reasonCodes: ["hand_position_too_high"],
        tts: { text: "手再往下一点。", tone: "calm_firm" },
        ui: {
          mainText: "位置偏高",
          secondaryText: "往下调整一点",
          statusTags: ["位置偏高", "往下一点"],
        },
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "down",
        },
      };
    case "too_low":
    case "lower_offset":
      return {
        reasonCodes: ["hand_position_too_low"],
        tts: { text: "手再往上一点。", tone: "calm_firm" },
        ui: {
          mainText: "位置偏低",
          secondaryText: "往上调整一点",
          statusTags: ["位置偏低", "往上一点"],
        },
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "up",
        },
      };
    case "off_center":
    case "wrong_position":
      return {
        reasonCodes: ["hand_position_off_center"],
        tts: { text: "双手掌根放回胸口中央。", tone: "calm_firm" },
        ui: {
          mainText: "回到胸口中央",
          secondaryText: "双手掌根按压",
          statusTags: ["胸口中央", "继续按压"],
        },
        visualOverlay: { mode: "hand_position_feedback", highlight_target: "chest_center" },
      };
    default:
      return null;
  }
}

function isArmBent(eventQuality, cprState) {
  return (
    eventQuality.arm_straight === false ||
    eventQuality.arms_straight === false ||
    eventQuality.arm_bent === true ||
    eventQuality.elbow_bent === true ||
    eventQuality.arm_posture === "bent" ||
    cprState.arm_straight === false
  );
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

export default createRuleFeedbackAction;
