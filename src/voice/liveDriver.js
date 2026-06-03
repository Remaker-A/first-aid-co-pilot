import { createGuidanceAction } from "../domain/actionFactories.js";
import { AgentStage, getStageIndex } from "../domain/stages.js";

export const LiveResponseType = Object.freeze({
  CRITICAL_CORRECTION: "critical_correction",
  QUESTION_ANSWER: "question_answer",
  PROACTIVE_COACHING: "proactive_coaching",
  FLOW_INSTRUCTION: "flow_instruction",
  REASSURANCE: "reassurance",
});

const QUESTION_INTENTS = new Set([
  "ask_cpr_quality",
  "ask_can_stop",
  "ask_aed_help",
  "ask_next_step",
  "ask_emergency_call",
]);

const RATE_LOW = 100;
const RATE_HIGH = 120;
const INTERRUPTION_SECONDS = 2;

export function createLiveAgentInput({
  sessionState = {},
  latestEvent = null,
  latestUserUtterance = {},
  pendingFlowAction = null,
  pendingRuleFeedback = null,
  recentTts,
  allowedIntents,
} = {}) {
  return {
    sessionState,
    latestEvent,
    latestUserUtterance,
    latestVisionState: buildLatestVisionState(sessionState, latestEvent),
    activeMedicalStage: sessionState.current_stage || latestEvent?.stage_hint || null,
    pendingFlowAction,
    pendingRuleFeedback,
    recentTts: recentTts ?? sessionState.dialogue_state?.recent_tts ?? [],
    allowedIntents: allowedIntents ?? sessionState.allowed_intents ?? [],
  };
}

export function createLiveDriverProposal(input = {}) {
  const earlyAed = createEarlyAedProposal(input);
  if (earlyAed) {
    return earlyAed;
  }

  const preCprQuestion = createPreCprQuestionProposal(input);
  if (preCprQuestion) {
    return preCprQuestion;
  }

  if (input.activeMedicalStage !== AgentStage.S7_CPR_LOOP) {
    return null;
  }

  const intent = input.latestUserUtterance?.intent_hint || input.latestUserUtterance?.intent || null;
  if (!QUESTION_INTENTS.has(intent)) {
    return null;
  }

  switch (intent) {
    case "ask_cpr_quality":
      return answerCprQuality(input);
    case "ask_can_stop":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "answer_current_cpr_question",
        ttsText: "不要停，继续按压，直到 AED 提示分析、急救人员接手，或他恢复正常呼吸。",
        priority: "high",
        reasonCodes: ["user_asked_can_stop", "continue_compressions"],
        uiMainText: "不要停",
        uiSecondaryText: "继续胸外按压",
        statusTags: ["不要停", "继续按压"],
      });
    case "ask_aed_help":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "answer_current_cpr_question",
        ttsText: "继续按压。让旁边的人打开 AED，按设备语音提示贴电极；设备提示分析时再暂停。",
        priority: "high",
        reasonCodes: ["user_asked_aed_help"],
        uiMainText: "AED 协助",
        uiSecondaryText: "继续按压，听设备提示",
        statusTags: ["AED", "继续按压"],
      });
    case "ask_next_step":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "answer_current_cpr_question",
        ttsText: "现在继续胸外按压，跟着震动保持 100 到 120 次每分钟；我会继续看位置和节奏。",
        priority: "normal",
        reasonCodes: ["user_asked_next_step", "cpr_loop_active"],
        uiMainText: "继续按压",
        uiSecondaryText: "目标 100-120 次/分钟",
        statusTags: ["持续 CPR", "跟着震动"],
      });
    case "ask_emergency_call":
      return answerEmergencyCallStatus(input);
    default:
      return null;
  }
}

export function liveProposalToGuidanceAction(proposalInput, state = {}, sessionId = null) {
  if (!proposalInput) {
    return null;
  }

  return createGuidanceAction({
    sessionId: sessionId || state.session_id || null,
    stage: state.current_stage || AgentStage.S7_CPR_LOOP,
    intent: proposalInput.intent,
    priority: proposalInput.priority || "normal",
    source: "live_agent",
    reasonCodes: proposalInput.reasonCodes || [],
    ttlMs: 3000,
    throttleKey: proposalInput.throttleKey || `live.${proposalInput.intent}`,
    minIntervalMs: proposalInput.minIntervalMs ?? 0,
    tts: {
      text: proposalInput.ttsText,
      tone: proposalInput.tone || "calm_firm",
      speed: proposalInput.speed || "normal",
      interruptPolicy: proposalInput.interruptPolicy || "do_not_interrupt_critical",
    },
    ui: {
      mainText: proposalInput.uiMainText || "",
      secondaryText: proposalInput.uiSecondaryText || "",
      statusTags: proposalInput.statusTags || [],
      qualityScore: state.cpr_state?.quality_score ?? null,
    },
    haptic: { enabled: true, pattern: "metronome", bpm: 110 },
    visualOverlay: proposalInput.visualOverlay || { mode: "cpr_loop", highlight_target: "chest_center" },
    toolActions: [],
    logEvent: {
      type: proposalInput.responseType || "live_driver",
      detail: proposalInput.reasonCodes?.[0] || proposalInput.intent,
    },
  });
}

export function isLiveQuestionIntent(intent) {
  return QUESTION_INTENTS.has(intent);
}

function answerCprQuality(input) {
  const metrics = input.latestVisionState?.cprQuality || {};

  if ((metrics.interruptionSeconds ?? 0) >= INTERRUPTION_SECONDS) {
    return proposal({
      responseType: LiveResponseType.QUESTION_ANSWER,
      intent: "answer_current_cpr_question",
      ttsText: "现在不要停，马上继续按压。",
      priority: "critical",
      reasonCodes: ["user_asked_cpr_quality", "compression_interrupted"],
      uiMainText: "继续按压",
      uiSecondaryText: "中断时间过长",
      statusTags: ["不要停", "继续按压"],
      interruptPolicy: "interrupt_lower_priority",
      visualOverlay: { mode: "continue_compressions" },
    });
  }

  const handPosition = getHandPositionAnswer(metrics.handPosition);
  if (handPosition) {
    return proposal({
      ...handPosition,
      responseType: LiveResponseType.QUESTION_ANSWER,
      intent: "answer_current_cpr_question",
      priority: "high",
      reasonCodes: ["user_asked_cpr_quality", handPosition.reasonCode],
      statusTags: handPosition.statusTags,
    });
  }

  if (typeof metrics.compressionRate === "number" && metrics.compressionRate < RATE_LOW) {
    return proposal({
      responseType: LiveResponseType.QUESTION_ANSWER,
      intent: "answer_current_cpr_question",
      ttsText: "稍微再快一点，目标是 100 到 120 次每分钟，继续按压。",
      priority: "high",
      reasonCodes: ["user_asked_cpr_quality", "compression_rate_low"],
      uiMainText: "按压偏慢",
      uiSecondaryText: "目标 100-120 次/分钟",
      statusTags: ["偏慢", "继续按压"],
    });
  }

  if (typeof metrics.compressionRate === "number" && metrics.compressionRate > RATE_HIGH) {
    return proposal({
      responseType: LiveResponseType.QUESTION_ANSWER,
      intent: "answer_current_cpr_question",
      ttsText: "稍微慢一点，目标是 100 到 120 次每分钟，继续保持。",
      priority: "high",
      reasonCodes: ["user_asked_cpr_quality", "compression_rate_high"],
      uiMainText: "按压偏快",
      uiSecondaryText: "目标 100-120 次/分钟",
      statusTags: ["偏快", "继续按压"],
    });
  }

  if (metrics.armBent === true) {
    return proposal({
      responseType: LiveResponseType.QUESTION_ANSWER,
      intent: "answer_current_cpr_question",
      ttsText: "手臂伸直，用上半身向下压，继续保持这个节奏。",
      priority: "high",
      reasonCodes: ["user_asked_cpr_quality", "arm_bent"],
      uiMainText: "手臂伸直",
      uiSecondaryText: "用上半身向下压",
      statusTags: ["手臂伸直", "继续按压"],
    });
  }

  return proposal({
    responseType: LiveResponseType.QUESTION_ANSWER,
    intent: "answer_current_cpr_question",
    ttsText: "现在按压可以，继续保持这个节奏，目标是 100 到 120 次每分钟。",
    priority: "normal",
    reasonCodes: ["user_asked_cpr_quality", "cpr_quality_ok"],
    uiMainText: "继续保持",
    uiSecondaryText: "目标 100-120 次/分钟",
    statusTags: ["节奏可以", "继续按压"],
  });
}

function answerEmergencyCallStatus(input) {
  const status = input.sessionState?.tool_state?.emergency_call_status;
  if (status === "started" || status === "connected" || status === "completed") {
    return proposal({
      responseType: LiveResponseType.QUESTION_ANSWER,
      intent: "answer_current_cpr_question",
      ttsText: "120 已经在呼叫中，保持手机免提，你继续胸外按压。",
      priority: "normal",
      reasonCodes: ["user_asked_emergency_call", "emergency_call_started"],
      uiMainText: "120 已呼叫",
      uiSecondaryText: "保持免提，继续按压",
      statusTags: ["120", "继续按压"],
    });
  }

  return proposal({
    responseType: LiveResponseType.QUESTION_ANSWER,
    intent: "answer_current_cpr_question",
    ttsText: "需要立刻拨打 120。拨通后保持免提，同时准备继续胸外按压。",
    priority: "high",
    reasonCodes: ["user_asked_emergency_call", "emergency_call_not_started"],
    uiMainText: "呼叫 120",
    uiSecondaryText: "保持免提并继续准备 CPR",
    statusTags: ["呼叫120", "免提"],
  });
}

function proposal(input) {
  return {
    responseType: input.responseType,
    intent: input.intent,
    ttsText: input.ttsText,
    priority: input.priority || "normal",
    source: input.source || "rule_fast_path",
    interruptPolicy: input.interruptPolicy || "do_not_interrupt_critical",
    reasonCodes: input.reasonCodes || [],
    uiMainText: input.uiMainText || "",
    uiSecondaryText: input.uiSecondaryText || "",
    statusTags: input.statusTags || [],
    visualOverlay: input.visualOverlay || null,
    tone: input.tone || "calm_firm",
    speed: input.speed || "normal",
    throttleKey: input.throttleKey || null,
    minIntervalMs: input.minIntervalMs ?? 0,
  };
}

function createEarlyAedProposal(input) {
  if (!isAedAvailableEvent(input.latestEvent)) {
    return null;
  }

  if (
    input.activeMedicalStage === AgentStage.S7_CPR_LOOP ||
    input.activeMedicalStage === AgentStage.S8_ASSISTANCE
  ) {
    return null;
  }

  const flowAction = input.pendingFlowAction;
  const flowText = flowAction?.tts?.text || currentStageInstruction(input.activeMedicalStage);
  const text = flowText
    ? `AED 已经到了，可以先放在旁边准备。现在先继续当前步骤：${flowText}`
    : "AED 已经到了，可以先放在旁边准备。现在先继续当前检查步骤。";

  return proposal({
    responseType: LiveResponseType.FLOW_INSTRUCTION,
    intent: currentStageIntent(input.activeMedicalStage),
    ttsText: text,
    priority: flowAction?.priority || "normal",
    reasonCodes: ["aed_arrived_before_cpr_loop", input.activeMedicalStage].filter(Boolean),
    uiMainText: "AED 已到",
    uiSecondaryText: "先完成当前检查步骤",
    statusTags: ["AED", "当前步骤"],
  });
}

function createPreCprQuestionProposal(input) {
  const intent = input.latestUserUtterance?.intent_hint || input.latestUserUtterance?.intent || null;
  const stage = input.activeMedicalStage;
  if (!QUESTION_INTENTS.has(intent) || !isBeforeCprLoop(stage)) {
    return null;
  }

  const flowAction = input.pendingFlowAction;
  const flowText = flowAction?.tts?.text || currentStageInstruction(stage);
  const prefix = preCprQuestionPrefix(intent);
  const ttsText = flowText
    ? `${prefix}现在先继续当前步骤：${flowText}`
    : `${prefix}现在先完成现场安全、反应和呼吸检查。`;

  return proposal({
    responseType: LiveResponseType.FLOW_INSTRUCTION,
    intent: currentStageIntent(stage),
    ttsText,
    priority: flowAction?.priority === "high" ? "high" : "normal",
    reasonCodes: ["live_question_before_cpr_loop", intent, stage].filter(Boolean),
    uiMainText: "先完成当前步骤",
    uiSecondaryText: "进入按压后我会实时看位置和节奏",
    statusTags: ["未到按压", "当前步骤"],
  });
}

function preCprQuestionPrefix(intent) {
  switch (intent) {
    case "ask_cpr_quality":
      return "我还不能判断按压质量，因为现在还没进入胸外按压步骤。";
    case "ask_can_stop":
      return "还没进入胸外按压步骤；如果你已经开始按压，不要随意停止。";
    case "ask_aed_help":
      return "AED 可以先放在旁边准备。还没进入胸外按压步骤。";
    case "ask_emergency_call":
      return "是否需要拨打 120，要先看反应和呼吸检查结果。";
    case "ask_next_step":
    default:
      return "还没进入胸外按压步骤。";
  }
}

function isBeforeCprLoop(stage) {
  if (!stage) {
    return false;
  }

  return getStageIndex(stage) < getStageIndex(AgentStage.S7_CPR_LOOP);
}

function getHandPositionAnswer(handPosition) {
  switch (handPosition) {
    case "left":
    case "left_offset":
    case "too_left":
      return {
        ttsText: "位置向右一点，继续按压。",
        reasonCode: "hand_position_left_offset",
        uiMainText: "位置偏左",
        uiSecondaryText: "向右调整一点",
        statusTags: ["位置偏左", "向右一点"],
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
        ttsText: "位置向左一点，继续按压。",
        reasonCode: "hand_position_right_offset",
        uiMainText: "位置偏右",
        uiSecondaryText: "向左调整一点",
        statusTags: ["位置偏右", "向左一点"],
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "left",
        },
      };
    case "too_high":
    case "upper_offset":
      return {
        ttsText: "手再往下一点，继续按压。",
        reasonCode: "hand_position_too_high",
        uiMainText: "位置偏高",
        uiSecondaryText: "往下调整一点",
        statusTags: ["位置偏高", "往下一点"],
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "down",
        },
      };
    case "too_low":
    case "lower_offset":
      return {
        ttsText: "手再往上一点，继续按压。",
        reasonCode: "hand_position_too_low",
        uiMainText: "位置偏低",
        uiSecondaryText: "往上调整一点",
        statusTags: ["位置偏低", "往上一点"],
        visualOverlay: {
          mode: "hand_position_feedback",
          highlight_target: "chest_center",
          correction_arrow: "up",
        },
      };
    case "off_center":
    case "wrong_position":
      return {
        ttsText: "双手掌根放回胸口中央，继续按压。",
        reasonCode: "hand_position_off_center",
        uiMainText: "回到胸口中央",
        uiSecondaryText: "双手掌根按压",
        statusTags: ["胸口中央", "继续按压"],
        visualOverlay: { mode: "hand_position_feedback", highlight_target: "chest_center" },
      };
    default:
      return null;
  }
}

function isAedAvailableEvent(event = null) {
  return (
    event?.metadata?.aed_available === true ||
    event?.metadata?.aed_status === "available" ||
    event?.device_state?.aed_available === true ||
    event?.rescuer_state?.aed_available === true ||
    event?.user_input?.intent === "aed_available"
  );
}

function currentStageIntent(stage) {
  switch (stage) {
    case AgentStage.S1_SCENE_SAFE:
      return "ask_scene_safety";
    case AgentStage.S2_CHECK_RESPONSE:
      return "ask_response_check";
    case AgentStage.S3_CHECK_BREATHING:
      return "ask_breathing_check";
    case AgentStage.S4_SUSPECTED_ARREST:
      return "state_suspected_arrest_handling";
    case AgentStage.S5_CALL_EMERGENCY:
      return "start_emergency_call_and_cpr";
    case AgentStage.S6_CPR_READY:
      return "guide_cpr_position";
    default:
      return "fallback_template";
  }
}

function currentStageInstruction(stage) {
  switch (stage) {
    case AgentStage.S1_SCENE_SAFE:
      return "先确认周围安全，再靠近患者。";
    case AgentStage.S2_CHECK_RESPONSE:
      return "请大声叫他，并轻拍双肩。";
    case AgentStage.S3_CHECK_BREATHING:
      return "请看胸口 5 到 10 秒，有没有正常起伏？";
    case AgentStage.S4_SUSPECTED_ARREST:
      return "请按疑似心脏骤停处理。现在准备胸外按压。";
    case AgentStage.S5_CALL_EMERGENCY:
      return "我将为你拨打 120，请保持手机免提。现在准备胸外按压。";
    case AgentStage.S6_CPR_READY:
      return "让他平躺在硬地面，双手掌根放在胸口中央。";
    default:
      return "";
  }
}

function buildLatestVisionState(state = {}, event = null) {
  const cpr = event?.cpr_quality || {};
  const cprState = state.cpr_state || {};
  const rescuer = { ...(state.rescuer_state || {}), ...(event?.rescuer_state || {}) };
  const device = { ...(state.tool_state || {}), ...(event?.device_state || {}) };

  return {
    source: event?.source || null,
    cprQuality: {
      started: firstDefined(cpr.started, cpr.compressions_started, cprState.started),
      handPosition: firstDefined(cpr.hand_position, cpr.hand_position_status, cprState.hand_position),
      compressionRate: firstNumber(
        cpr.compression_rate,
        cpr.compression_rate_bpm,
        cpr.current_rate,
        cpr.rate,
        cprState.current_rate
      ),
      interruptionSeconds: firstNumber(
        cpr.interruption_seconds,
        cpr.last_interruption_seconds,
        cprState.last_interruption_seconds
      ) ?? 0,
      armBent: isArmBent(cpr, cprState),
      qualityScore: firstNumber(cpr.quality_score, cpr.score, cprState.quality_score),
    },
    rescuerState: rescuer,
    deviceState: device,
  };
}

function isArmBent(eventQuality = {}, cprState = {}) {
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
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}
