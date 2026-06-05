import { createGuidanceAction } from "../domain/actionFactories.js";
import { AgentStage, getStageIndex } from "../domain/stages.js";

export const LiveResponseType = Object.freeze({
  CRITICAL_CORRECTION: "critical_correction",
  QUESTION_ANSWER: "question_answer",
  PROACTIVE_COACHING: "proactive_coaching",
  FLOW_INSTRUCTION: "flow_instruction",
  REASSURANCE: "reassurance",
  OPEN_QUESTION_ACK: "open_question_ack",
  OPEN_QUESTION_ANSWER: "open_question_answer",
});

const QUESTION_INTENTS = new Set([
  "ask_cpr_quality",
  "ask_can_stop",
  "ask_aed_cpr_alternation",
  "ask_aed_help",
  "ask_next_step",
  "ask_emergency_call",
]);

// WB 开放问答（闭集外提问 → 受控 Gemma 作答）。闭集问题（QUESTION_INTENTS）仍走
// liveDriver 固定答句（快稳）；其余"读起来像提问、且不是流程推进/事实上报"的话被标
// 记为 open_question，交给受控问答 Gemma：先即时 ack 稳场、再异步答。这里只做"粗筛"，
// 真正的安全护栏由受限 allowed_intents + ActionValidator 强制（service.js）。
const OPEN_QUESTION_FLOW_OR_FACT_INTENTS = new Set([
  "continue_cpr",
  "continue_cpr_loop",
  "compressions_reported",
  "step_done",
  "no_normal_breathing",
  "normal_breathing",
  "agonal_breathing",
  "clarify_breathing",
  "patient_unresponsive",
  "patient_responsive",
  "patient_recovered",
  "signs_of_life",
  "scene_safe",
  "scene_unsafe",
  "emergency_called",
  "aed_available",
  "paramedics_arrived",
]);

// Conservative interrogative cue: a trailing question mark / 吗呢 particle, or an
// explicit question word. Kept narrow so plain reports never become open questions.
const OPEN_QUESTION_TEXT_PATTERN =
  /[?？]|(?:吗|呢)[?？。!！\s]*$|怎么|为什么|为啥|为何|多久|多长|多大|多少|几分钟|什么|啥|哪(?:里|儿|个|边)?|如何|怎样|能不能|能否|可不可以|可以吗|要不要|用不用|是不是|有没有|该不该|会不会|需不需要|how\b|why\b|what\b|when\b|where\b|which\b|should\b|can\s+i|do\s+i|need\s+to/i;

// Per-stage controlled-answer intents Gemma may use for an open question. Every
// entry is a subset of that stage's allowed_intents (allowed_intents.json), so the
// answer also passes ActionValidator. Stages without a safe "answer/reassure"
// intent (e.g. the tightly-gated S3/S4 breathing/arrest checks) are intentionally
// omitted, leaving their deterministic flow untouched.
export const OPEN_QUESTION_ANSWER_INTENTS_BY_STAGE = Object.freeze({
  S0_INIT: ["reassure_rescuer"],
  S1_SCENE_SAFE: ["reassure_rescuer"],
  S2_CHECK_RESPONSE: ["reassure_rescuer"],
  S5_CALL_EMERGENCY: ["calm_rescuer"],
  S6_CPR_READY: ["encourage_rescuer", "answer_position_question"],
  S7_CPR_LOOP: ["answer_current_cpr_question", "encourage_rescuer", "calm_rescuer"],
  S8_ASSISTANCE: ["calm_rescuer", "explain_aed_support"],
});

// The immediate stabilizing ack text (shared by the CPR-live stages). Authored as
// a fixed standard line so it is WA-cache eligible — see OPEN_QUESTION_FIXED_PHRASES.
const OPEN_QUESTION_ACK_TEXT = "我在，按住别停，听我说。";

// The CPR-live safety fallback spoken when the async answer times out or is
// blocked (see service.js buildOpenQuestionFallbackAction). Kept here as the
// single source of truth so the spoken text and the pre-rendered cache key never
// drift apart.
export const OPEN_QUESTION_CPR_FALLBACK_PHRASE = "继续按压，不要停，我在。";

// WA-cache source of truth for the WB open-question fixed phrases. The ack lives
// as a `text:` field and the fallback as an inline service.js string, which the
// prerender sweep's ttsText/return regexes both miss, so the WA bundle imports
// this list to pre-synthesize them (scripts/speech/prerenderTtsCache.mjs). That
// keeps the immediate ack ~0ms instead of paying a ~3.5s live synthesis.
export const OPEN_QUESTION_FIXED_PHRASES = Object.freeze([
  OPEN_QUESTION_ACK_TEXT,
  OPEN_QUESTION_CPR_FALLBACK_PHRASE,
]);

// Immediate stabilizing ack played BEFORE the async answer, only in the CPR-live
// stages where latency + the running metronome matter most. The phrase is a fixed
// standard line (WA-cache eligible): it never stops the metronome and never
// interrupts a critical action.
const OPEN_QUESTION_ACK_BY_STAGE = Object.freeze({
  S7_CPR_LOOP: { intent: "answer_current_cpr_question", text: OPEN_QUESTION_ACK_TEXT },
  S8_ASSISTANCE: { intent: "calm_rescuer", text: OPEN_QUESTION_ACK_TEXT },
});

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

  const intent = input.latestUserUtterance?.intent_hint || input.latestUserUtterance?.intent || null;
  const assistanceFact = createAssistanceFactProposal(input, intent);
  if (assistanceFact) {
    return assistanceFact;
  }

  const assistanceQuestion = createAssistanceQuestionProposal(input, intent);
  if (assistanceQuestion) {
    return assistanceQuestion;
  }

  if (input.activeMedicalStage !== AgentStage.S7_CPR_LOOP) {
    return null;
  }

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
        ttsText: "不要停，继续按压；等 AED 或急救人员接手、或他恢复正常呼吸再停。",
        priority: "high",
        reasonCodes: ["user_asked_can_stop", "continue_compressions"],
        uiMainText: "不要停",
        uiSecondaryText: "继续胸外按压",
        statusTags: ["不要停", "继续按压"],
      });
    case "ask_aed_cpr_alternation":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "answer_current_cpr_question",
        ttsText: "继续按压。让旁人贴好 AED 电极并跟着语音做；AED 说正在分析或提示电击时，所有人离开不要碰患者，结束后马上继续按压。",
        priority: "high",
        reasonCodes: ["user_asked_aed_cpr_alternation", "continue_compressions"],
        uiMainText: "AED 配合按压",
        uiSecondaryText: "分析/电击时离开，结束后继续按压",
        statusTags: ["AED", "继续按压"],
        visualOverlay: { mode: "aed_assistance" },
      });
    case "ask_aed_help":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "answer_current_cpr_question",
        ttsText: "打开 AED，跟着它的语音做；先继续按压。分析或电击时所有人离开，结束后马上继续按压。",
        priority: "high",
        reasonCodes: ["user_asked_aed_help"],
        uiMainText: "AED 协助",
        uiSecondaryText: "继续按压，分析/电击时离开",
        statusTags: ["AED", "继续按压"],
        visualOverlay: { mode: "aed_assistance" },
      });
    case "ask_next_step":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "answer_current_cpr_question",
        ttsText: "继续按压，跟着节拍保持节奏；我会继续看位置和节奏。",
        priority: "normal",
        reasonCodes: ["user_asked_next_step", "cpr_loop_active"],
        uiMainText: "继续按压",
        uiSecondaryText: "目标 100-120 次/分钟",
        statusTags: ["持续 CPR", "跟着节拍"],
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
  const hapticEnabled =
    state.current_stage === AgentStage.S7_CPR_LOOP ||
    state.current_stage === AgentStage.S8_ASSISTANCE;

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
    haptic: hapticEnabled
      ? { enabled: true, pattern: "metronome", bpm: 110 }
      : { enabled: false },
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

// Coarse "reads like a question" gate (see OPEN_QUESTION_TEXT_PATTERN).
export function looksLikeOpenQuestion(transcript = "") {
  const text = typeof transcript === "string" ? transcript.trim() : "";
  if (text.length < 2) {
    return false;
  }
  return OPEN_QUESTION_TEXT_PATTERN.test(text);
}

// True when an utterance is an open question: it reads like a question, is NOT a
// closed-set question (those keep their deterministic fixed answer) and is NOT a
// flow-progress / fact report (those drive the state machine, not Q&A).
export function detectOpenQuestion({ transcript = "", intent = null } = {}) {
  if (isLiveQuestionIntent(intent)) {
    return false;
  }
  if (intent && OPEN_QUESTION_FLOW_OR_FACT_INTENTS.has(intent)) {
    return false;
  }
  return looksLikeOpenQuestion(transcript);
}

export function openQuestionAnswerIntents(stage) {
  const intents = OPEN_QUESTION_ANSWER_INTENTS_BY_STAGE[stage];
  return intents ? [...intents] : [];
}

// A stage supports open-question Q&A only if it has a safe controlled-answer
// intent set; otherwise the open-question exception is not opened for it.
export function isOpenQuestionStage(stage) {
  return openQuestionAnswerIntents(stage).length > 0;
}

// The immediate stabilizing ack proposal (CPR-live only). Returns null for stages
// without a CPR-live ack, in which case the caller keeps the deterministic guidance
// as the synchronous turn and still streams the async answer afterwards.
export function createOpenQuestionAckProposal(stage) {
  const ack = OPEN_QUESTION_ACK_BY_STAGE[stage];
  if (!ack) {
    return null;
  }

  return proposal({
    responseType: LiveResponseType.OPEN_QUESTION_ACK,
    intent: ack.intent,
    ttsText: ack.text,
    priority: "normal",
    source: "open_question_ack",
    interruptPolicy: "do_not_interrupt_critical",
    reasonCodes: ["open_question_ack", "wa_cache_eligible"],
    uiMainText: "我在",
    uiSecondaryText: "继续按压，听我说",
    statusTags: ["继续按压", "我在"],
    throttleKey: "live.open_question_ack",
  });
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
    ttsText: "按压可以，继续保持 100 到 120 次每分钟。",
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

function createAssistanceQuestionProposal(input, intent) {
  if (input.activeMedicalStage !== AgentStage.S8_ASSISTANCE) {
    return null;
  }

  switch (intent) {
    case "ask_aed_cpr_alternation":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "explain_aed_support",
        ttsText: "继续按压。让旁人贴好 AED 电极并跟着语音做；AED 说正在分析或提示电击时，所有人离开不要碰患者，结束后马上继续按压。",
        priority: "high",
        reasonCodes: ["user_asked_aed_cpr_alternation", "assistance_stage"],
        uiMainText: "AED 配合按压",
        uiSecondaryText: "分析/电击时离开，结束后继续按压",
        statusTags: ["AED", "继续按压"],
        visualOverlay: { mode: "aed_assistance" },
      });
    case "ask_aed_help":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "explain_aed_support",
        ttsText: "打开 AED，跟着它的语音做；先继续按压。分析或电击时所有人离开，结束后马上继续按压。",
        priority: "high",
        reasonCodes: ["user_asked_aed_help", "assistance_stage"],
        uiMainText: "AED 协助",
        uiSecondaryText: "继续按压，分析/电击时离开",
        statusTags: ["AED", "继续按压"],
        visualOverlay: { mode: "aed_assistance" },
      });
    case "ask_can_stop":
      return proposal({
        responseType: LiveResponseType.QUESTION_ANSWER,
        intent: "continue_cpr",
        ttsText: "不要停，继续按压；等 AED 或急救人员接手、或他恢复正常呼吸再停。",
        priority: "high",
        reasonCodes: ["user_asked_can_stop", "assistance_stage"],
        uiMainText: "不要停",
        uiSecondaryText: "继续胸外按压",
        statusTags: ["不要停", "继续按压"],
      });
    default:
      return null;
  }
}

function createAssistanceFactProposal(input, intent) {
  if (input.activeMedicalStage !== AgentStage.S8_ASSISTANCE || intent !== "aed_available") {
    return null;
  }

  const softAlias = input.latestEvent?.metadata?.aed_soft_alias === true;
  const ttsText = softAlias
    ? "如果这是 AED 或自动体外除颤器，打开它，跟着它的语音做；你先继续按压。分析或电击时所有人离开，结束后马上继续按压。"
    : "AED 到了，让旁人打开它并跟着语音做；你先继续按压。分析或电击时所有人离开，结束后马上继续按压。";

  return proposal({
    responseType: LiveResponseType.FLOW_INSTRUCTION,
    intent: "assist_aed",
    ttsText,
    priority: "high",
    reasonCodes: [softAlias ? "aed_soft_alias_available" : "aed_available", "continue_compressions"],
    uiMainText: softAlias ? "疑似 AED 到达" : "AED 到达",
    uiSecondaryText: "打开 AED，分析/电击时所有人离开",
    statusTags: ["AED", "继续按压"],
    visualOverlay: { mode: "aed_assistance" },
  });
}

function preCprQuestionPrefix(intent) {
  switch (intent) {
    case "ask_cpr_quality":
      return "我还不能判断按压质量，因为现在还没进入胸外按压步骤。";
    case "ask_can_stop":
      return "还没进入胸外按压步骤；如果你已经开始按压，不要随意停止。";
    case "ask_aed_help":
    case "ask_aed_cpr_alternation":
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
      return "看他的胸口。只是偶尔大口喘，或者完全不动，都算没有呼吸。";
    case AgentStage.S4_SUSPECTED_ARREST:
      return "请按疑似心脏骤停处理。现在准备胸外按压。";
    case AgentStage.S5_CALL_EMERGENCY:
      return "我将为你拨打 120，请保持手机免提。现在准备胸外按压。";
    case AgentStage.S6_CPR_READY:
      return "让他平躺在硬地面，双手掌根放在胸口中央。手机靠在他胸侧、拍到你的手；放不稳就直接开始按压。";
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
