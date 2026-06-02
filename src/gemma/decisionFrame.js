import {
  getGemmaAllowedIntents,
  getGemmaAllowedIntentsByStage,
  getSafetyPhrases,
  getSpecialIntents
} from "../knowledge/knowledgeBase.js";

export const GUIDANCE_ACTION_PATCH_SCHEMA = "GuidanceActionPatch";

// Single source of truth: both decisionFrame (what Gemma is told it may do) and
// actionValidator (what Gemma is enforced against) derive their allowed intents
// from knowledge/allowed_intents.json via the knowledge base.
export const SPECIAL_GEMMA_INTENTS = Object.freeze(getSpecialIntents());

export const DEFAULT_ALLOWED_INTENTS_BY_STAGE = Object.freeze(getGemmaAllowedIntentsByStage());

const DEFAULT_SAFETY_PHRASES_BY_STAGE = Object.freeze({
  S1_SCENE_SAFE: ["\u5148\u786e\u4fdd\u81ea\u8eab\u5b89\u5168\u3002"],
  S2_CHECK_RESPONSE: ["\u8bf7\u5927\u58f0\u53eb\u4ed6\uff0c\u5e76\u8f7b\u62cd\u53cc\u80a9\u3002"],
  S3_CHECK_BREATHING: [
    "\u8bf7\u770b\u80f8\u53e3 5 \u5230 10 \u79d2\uff0c\u6709\u6ca1\u6709\u6b63\u5e38\u8d77\u4f0f\uff1f",
    "\u5982\u679c\u4e0d\u786e\u5b9a\uff0c\u8bf7\u6309\u6ca1\u6709\u6b63\u5e38\u547c\u5438\u5904\u7406\u3002"
  ],
  S4_SUSPECTED_ARREST: [
    "\u8bf7\u6309\u7591\u4f3c\u5fc3\u810f\u9aa4\u505c\u5904\u7406\u3002"
  ],
  S5_CALL_EMERGENCY: [
    "\u6211\u5c06\u4e3a\u4f60\u62e8\u6253 120\uff0c\u8bf7\u4fdd\u6301\u624b\u673a\u514d\u63d0\u3002"
  ],
  S6_CPR_READY: [
    "\u53cc\u624b\u638c\u6839\u653e\u5728\u80f8\u53e3\u4e2d\u592e\u3002",
    "\u73b0\u5728\u5f00\u59cb\u80f8\u5916\u6309\u538b\u3002"
  ],
  S7_CPR_LOOP: [
    "\u8ddf\u7740\u9707\u52a8\u6309\uff0c\u5feb\u901f\u6709\u529b\u3002",
    "\u7ee7\u7eed\u6309\u538b\uff0c\u4e0d\u8981\u505c\u3002",
    "\u4f60\u505a\u5f97\u5f88\u597d\uff0c\u7ee7\u7eed\u8ddf\u7740\u8282\u594f\u3002"
  ],
  S8_ASSISTANCE: [
    "\u5982\u679c\u65c1\u8fb9\u6709\u4eba\uff0c\u8bf7\u51c6\u5907\u6362\u624b\u3002"
  ],
  S9_HANDOVER: [
    "\u6025\u6551\u5458\u5230\u8fbe\u540e\uff0c\u6211\u4f1a\u663e\u793a\u4ea4\u63a5\u62a5\u544a\u3002"
  ]
});

export function createDecisionFrame({
  state = {},
  event = {},
  allowedIntents,
  safetyPhrases,
  userInput,
  perceptionSummary,
  recentTts,
  language = "zh-CN"
} = {}) {
  const currentStage =
    state.current_stage || event.stage_hint || event.stage || event.current_stage || "S0_INIT";

  return {
    session_id: state.session_id || event.session_id || "sess_unknown",
    current_stage: currentStage,
    allowed_intents: normalizeAllowedIntents(currentStage, allowedIntents || state.allowed_intents),
    facts: buildFacts(state, event),
    user_input: normalizeUserInput(userInput || event.user_input || event),
    perception_summary:
      perceptionSummary || buildPerceptionSummary(event, state),
    recent_tts: normalizeRecentTts(recentTts || state.dialogue_state),
    safety_phrases: normalizeSafetyPhrases(currentStage, safetyPhrases),
    output_schema: GUIDANCE_ACTION_PATCH_SCHEMA,
    language
  };
}

export function normalizeAllowedIntents(stage, allowedIntents) {
  const fromKnowledge = getGemmaAllowedIntents(stage);
  const source =
    Array.isArray(allowedIntents) && allowedIntents.length > 0
      ? allowedIntents
      : fromKnowledge.length > 0
        ? fromKnowledge
        : ["fallback_template"];

  return uniqueStrings([...source, ...SPECIAL_GEMMA_INTENTS]);
}

export function normalizeSafetyPhrases(stage, safetyPhrases) {
  if (Array.isArray(safetyPhrases) && safetyPhrases.length > 0) {
    return safetyPhrases.filter((item) => typeof item === "string");
  }

  const fromKnowledge = getSafetyPhrases(stage);
  if (fromKnowledge.length > 0) {
    return fromKnowledge;
  }

  return DEFAULT_SAFETY_PHRASES_BY_STAGE[stage] || [];
}

function buildFacts(state, event) {
  const scope = state.scope || {};
  const confirmed = state.confirmed_facts || {};
  const tool = state.tool_state || {};
  const cpr = state.cpr_state || {};
  const device = event.device_state || {};

  return pruneNullish({
    adult_likely: firstDefined(scope.adult_likely, event.patient_state?.adult_likely),
    scene_safe: firstDefined(scope.scene_safe, event.patient_state?.scene_safe),
    responsive: firstDefined(confirmed.responsive, event.patient_state?.responsive),
    normal_breathing: firstDefined(
      confirmed.normal_breathing,
      event.patient_state?.normal_breathing
    ),
    agonal_breathing: firstDefined(
      confirmed.agonal_breathing,
      event.patient_state?.agonal_breathing
    ),
    suspected_cardiac_arrest: confirmed.suspected_cardiac_arrest,
    emergency_call_status: firstDefined(
      tool.emergency_call_status,
      device.emergency_call_status,
      device.emergency_call_started === true ? "started" : undefined
    ),
    gps_attached: firstDefined(tool.gps_attached, device.gps_attached),
    recording_status: firstDefined(
      tool.recording_status,
      device.recording === true ? "recording" : undefined
    ),
    cpr_started: cpr.started,
    total_compressions: cpr.total_compressions,
    current_rate: cpr.current_rate,
    average_rate: cpr.average_rate,
    quality_score: cpr.quality_score,
    last_interruption_seconds: cpr.last_interruption_seconds,
    active_priority: state.action_control?.active_priority
  });
}

function normalizeUserInput(input) {
  const text = firstDefined(input.stt_text, input.user_input?.stt_text, "");

  return pruneNullish({
    stt_text: typeof text === "string" ? text : "",
    intent_hint: firstDefined(input.intent_hint, input.intent, input.user_input?.intent),
    confidence: firstDefined(input.confidence, input.user_input?.confidence, 0)
  });
}

function buildPerceptionSummary(event, state) {
  const cpr = event.cpr_quality || {};
  const patient = event.patient_state || {};
  const rescuer = event.rescuer_state || {};

  return pruneNullish({
    source: event.source || null,
    hand_position: cpr.hand_position || cpr.hand_position_status,
    compression_rate_bpm: firstDefined(cpr.compression_rate, cpr.compression_rate_bpm),
    interruption_ms: firstDefined(
      cpr.interruption_ms,
      typeof cpr.interruption_seconds === "number"
        ? cpr.interruption_seconds * 1000
        : undefined,
      state.cpr_state?.last_interruption_seconds
        ? state.cpr_state.last_interruption_seconds * 1000
        : undefined
    ),
    arm_straight: cpr.arm_straight,
    quality_score: firstDefined(cpr.quality_score, state.cpr_state?.quality_score),
    chest_movement: patient.chest_movement,
    rescuer_emotion: rescuer.emotion,
    fatigue_level: rescuer.fatigue_level
  });
}

function normalizeRecentTts(dialogueState) {
  if (Array.isArray(dialogueState)) {
    return dialogueState.map(normalizeRecentTtsItem).filter(Boolean);
  }

  if (!dialogueState || typeof dialogueState !== "object") {
    return [];
  }

  if (Array.isArray(dialogueState.recent_tts)) {
    return dialogueState.recent_tts.map(normalizeRecentTtsItem).filter(Boolean);
  }

  if (!dialogueState.last_tts_intent && !dialogueState.last_tts_at) {
    return [];
  }

  return [
    pruneNullish({
      intent: dialogueState.last_tts_intent,
      text: dialogueState.last_tts_text || "",
      seconds_ago: null
    })
  ];
}

function normalizeRecentTtsItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return pruneNullish({
    intent: item.intent,
    text: item.text || "",
    seconds_ago: item.seconds_ago
  });
}

function pruneNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
