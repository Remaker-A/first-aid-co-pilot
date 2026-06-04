import { AgentStage } from "../domain/stages.js";
import { createNluFrame as createDecisionNluFrame } from "../gemma/decisionFrame.js";
import { nluCacheKey } from "../gemma/nluCache.js";
import { getNluConfidenceFloors, getNluStageConfig } from "../knowledge/knowledgeBase.js";
import { classifyIntent } from "./stt.js";

const DEFAULT_REGEX_CONFIDENCE_FLOOR = 0.85;
const DEFAULT_SLOT_CONFIDENCE_FLOOR = 0.6;
const DEFAULT_CPR_TRIGGER_CONFIDENCE_FLOOR = 0.78;

const UNCERTAINTY_PATTERN =
  /(好像|可能|似乎|大概|也许|不确定|不太确定|不太清楚|不清楚|看不清|看不太清|没看清|看不出|听不清|说不准|说不清|不好说|拿不准|不知道|maybe|not sure|seems|unclear|hard to tell)/i;
const CONTRASTIVE_NEGATION_PATTERN =
  /(没有\s*(但是|但|不过|可是)|不是\s*(但是|但|不过|可是)|no\s+but|not\s+but)/i;
// 是非疑问结构（"有没有呼吸/是不是没气"）含否定子串却并非确定断言，不能被
// classifyIntent 的子串匹配（"有没有呼吸"含"没有呼吸"）武断当成 CPR 触发事实。
const POLAR_QUESTION_PATTERN =
  /(有没有|有无|是不是|是否|有没|还有没有|有还是没有)/;
// 仅 no_normal_breathing 易被"有没有呼吸"等子串/疑问结构误判，须确定才采纳；
// agonal_breathing 依赖"偶尔喘息"等具体观察描述、不会被疑问误匹配，故不纳入降级守卫，
// 以免把"好像没有呼吸、偶尔喘一下"这类典型濒死呼吸误降级、延误 CPR。
const HIGH_RISK_BREATHING_INTENTS = new Set(["no_normal_breathing"]);

const INTENT_ALIASES = Object.freeze({
  normal_breathing_present: "normal_breathing",
  normal_breathing_absent: "no_normal_breathing",
  breathing_absent: "no_normal_breathing",
  unresponsive: "patient_unresponsive",
  responsive: "patient_responsive"
});

// 不确定/疑问语气下的"呼吸缺失"断言不可武断采纳为确定事实（医疗安全护栏）。
function isUncertainBreathingClaim(text, intent) {
  if (!HIGH_RISK_BREATHING_INTENTS.has(normalizeIntent(intent))) {
    return false;
  }
  return (
    UNCERTAINTY_PATTERN.test(text) ||
    POLAR_QUESTION_PATTERN.test(text) ||
    CONTRASTIVE_NEGATION_PATTERN.test(text)
  );
}

// Stage-aware deterministic flow-progress fast-path: at S6 the "ready/start"
// family ("准备好了/开始吧/可以开始"…) maps straight to continue_cpr so the state
// machine flips S6 -> S7 (start compressions) immediately, with zero model wait.
// Only consulted when the regex finds no intent, so the step_done coach words
// (放好了/做好了/明白了) keep their existing per-step coaching behavior.
const S6_READY_START_PATTERN =
  /(准备\s*(好|就绪|ok|完毕)|准备好(了|啦)?|我?(已经)?准备好|可以开始|开始吧|这就开始|马上开始|开始按|开始\s*cpr|开始心肺复苏|ready|let'?s\s*start|start\s*cpr)/i;

function resolveFlowProgressIntent(text, stage) {
  if (stage === AgentStage.S6_CPR_READY && S6_READY_START_PATTERN.test(text)) {
    return "continue_cpr";
  }
  return null;
}

function resolveNluInferenceMode(options = {}) {
  const mode = options.nluInferenceMode ?? options.nlu_inference_mode;
  return mode === "cache_only" ? "cache_only" : "sync";
}

export async function resolveUserIntent({
  transcript = "",
  stage = AgentStage.S0_INIT,
  runtime = null,
  options = {}
} = {}) {
  const text = normalizeText(transcript);
  const classification = normalizeClassification(options.classification || classifyIntent(text));
  const flowIntent = !classification.intent ? resolveFlowProgressIntent(text, stage) : null;
  // 安全护栏：模糊/疑问语气的"呼吸缺失"（如"我看不太清楚他有没有呼吸"）不得仅凭
  // 正则子串匹配就当成确定 CPR 触发事实；源头降级为 clarify_breathing（与 NLU 开关
  // 无关都安全），NLU 开启时下方仍会升级交给 Gemma 解析。
  const uncertainBreathing = !flowIntent && isUncertainBreathingClaim(text, classification.intent);
  const effectiveIntent = flowIntent || (uncertainBreathing ? "clarify_breathing" : classification.intent);
  const baseConfidence = flowIntent ? 0.9 : classification.score;
  const regexResult = createResolvedIntent({
    intent: effectiveIntent,
    confidence: baseConfidence,
    source: flowIntent ? "rule_flow_fast_path" : (isIntentNluEnabled(options) ? "stt" : "regex"),
    slots: slotsFromIntent(effectiveIntent, baseConfidence),
    needsClarification: uncertainBreathing || !effectiveIntent,
    escalated: false,
    classification
  });

  // Deterministic fast-path resolved it (e.g. S6 "准备好了" -> continue_cpr):
  // never escalate or wait on the model.
  if (flowIntent) {
    return { ...regexResult, escalationReason: "flow_fast_path" };
  }

  const escalation = shouldEscalateToNlu({
    transcript: text,
    stage,
    classification,
    options
  });

  if (!escalation.escalate) {
    return {
      ...regexResult,
      escalationReason: escalation.reason
    };
  }

  // Cache hit: an identical utterance at the same stage already produced a good
  // NLU observation, so skip the (slow, CPU-bound) model entirely. Checked
  // before the runtime/budget gates so a warm answer is returned even if the
  // runtime is momentarily unavailable or the session is over budget.
  const cache = readNluCache(options);
  const cacheKey = cache ? nluCacheKey(text, stage) : null;
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return finalizeCacheHit(cached, escalation.reason);
    }
  }

  // Async deferral (regex_then_async): do not block the turn on the local model.
  // Return the regex result now and mark it so the caller can run the real NLU in
  // the background and populate the shared cache for the next turn to correct.
  if (resolveNluInferenceMode(options) === "cache_only") {
    return {
      ...regexResult,
      escalated: true,
      escalationReason: escalation.reason,
      fallbackReason: "nlu_cache_miss_deferred"
    };
  }

  if (!runtime || typeof runtime.parseUserIntent !== "function") {
    return {
      ...regexResult,
      escalated: true,
      escalationReason: escalation.reason,
      fallbackReason: "nlu_runtime_unavailable"
    };
  }

  // Budget gate: cap how often a session may pay for Gemma per window. Over
  // budget we fall straight back to the regex result instead of queueing more
  // CPU-heavy inferences. Consumed only when we are actually about to call the
  // model (cache hits and disabled NLU never spend budget).
  const budget = readNluBudget(options);
  if (budget && !budget.tryConsume(resolveBudgetKey(options))) {
    return {
      ...regexResult,
      escalated: true,
      escalationReason: escalation.reason,
      fallbackReason: "nlu_budget_exceeded"
    };
  }

  const frame = createIntentNluFrame({
    transcript: text,
    stage,
    classification,
    options
  });

  let nlu;
  try {
    nlu = await runtime.parseUserIntent(frame);
  } catch (error) {
    return {
      ...regexResult,
      escalated: true,
      escalationReason: escalation.reason,
      fallbackReason: "nlu_runtime_failed",
      error: normalizeError(error)
    };
  }

  const normalizedNlu = normalizeNluResult(nlu, frame, options);
  if (!normalizedNlu.ok) {
    // Timeouts and invalid output are intentionally NOT cached: a transient
    // miss must not pin a session to the fallback for the whole TTL.
    return {
      ...regexResult,
      escalated: true,
      escalationReason: escalation.reason,
      fallbackReason: normalizedNlu.reason || "nlu_invalid",
      nlu
    };
  }

  const resolved = {
    ...normalizedNlu,
    escalated: true,
    escalationReason: escalation.reason,
    classification,
    nlu
  };

  if (cache) {
    cache.set(cacheKey, cloneResolution(resolved));
  }

  return resolved;
}

export function shouldEscalateToNlu({
  transcript = "",
  stage = AgentStage.S0_INIT,
  classification = classifyIntent(transcript),
  options = {}
} = {}) {
  const normalized = normalizeClassification(classification);

  if (!isIntentNluEnabled(options)) {
    return { escalate: false, reason: "nlu_disabled" };
  }

  if (!isNluEligibleStage(stage)) {
    return { escalate: false, reason: "stage_fast_path" };
  }

  const text = normalizeText(transcript);
  if (!text) {
    return { escalate: false, reason: "empty_transcript" };
  }

  if (isUncertainBreathingClaim(text, normalized.intent)) {
    return { escalate: true, reason: "uncertain_breathing_claim" };
  }

  if (!normalized.intent) {
    return { escalate: true, reason: "regex_miss" };
  }

  if (isAmbiguousClassification(normalized) && !isClearNegatedObservation(text, normalized.intent)) {
    return { escalate: true, reason: "regex_ambiguous" };
  }

  if (normalized.score < resolveRegexConfidenceFloor(options)) {
    return { escalate: true, reason: "regex_low_confidence" };
  }

  if (UNCERTAINTY_PATTERN.test(text) || CONTRASTIVE_NEGATION_PATTERN.test(text)) {
    return { escalate: true, reason: "uncertain_or_contrastive_text" };
  }

  return { escalate: false, reason: "regex_confident" };
}

export function createIntentNluFrame({
  transcript = "",
  stage = AgentStage.S0_INIT,
  classification = null,
  options = {}
} = {}) {
  const normalizedClassification = normalizeClassification(classification || classifyIntent(transcript));

  // Single source of truth: do not pass allowedIntents/slotsSchema so the frame
  // derives them from knowledge/nlu_slots.json via getNluStageConfig. This keeps
  // the prompt, the validator, and slot gating aligned on one config.
  return createDecisionNluFrame({
    state: {
      session_id: options.sessionId || options.session_id || "sess_unknown",
      current_stage: stage,
      confirmed_facts: options.facts || {}
    },
    event: {
      user_input: {
        stt_text: normalizeText(transcript),
        intent_hint: normalizedClassification.intent,
        confidence: normalizedClassification.score
      }
    },
    transcript,
    stage,
    perceptionSummary: options.perceptionSummary || options.perception_summary || {},
    language: options.language || "zh-CN"
  });
}

function normalizeNluResult(nlu, frame, options) {
  if (!nlu?.ok || typeof nlu.intent !== "string") {
    return {
      ok: false,
      reason: nlu?.fallbackReason || nlu?.reason || nlu?.error || "nlu_invalid"
    };
  }

  const floors = resolveNluFloors(options);
  const confidence = clampConfidence(nlu.confidence ?? nlu.overall_confidence);
  const slotSchema = normalizeFrameSlotSchema(frame);
  const slots = gateSlots(nlu.slots, slotSchema, floors);
  const hasKnownSlot = Object.values(slots).some((slot) => slot && slot.value !== null);
  const intent = hasKnownSlot || Object.keys(slotSchema).length === 0
    ? normalizeIntentFromSlots(nlu.intent, slots)
    : clarificationIntentForFrame(frame);
  const needsClarification =
    nlu.needsClarification === true ||
    nlu.needs_clarification === true ||
    confidence < floors.default_floor ||
    (Object.keys(slotSchema).length > 0 && !hasKnownSlot);

  return createResolvedIntent({
    intent,
    confidence,
    source: "gemma_nlu",
    slots,
    needsClarification,
    escalated: true
  });
}

function clarificationIntentForFrame(frame) {
  if (Array.isArray(frame.allowed_intents) && frame.allowed_intents.includes("clarify_breathing")) {
    return "clarify_breathing";
  }
  return null;
}

function gateSlots(slots = {}, slotSchema = {}, floors = resolveNluFloors()) {
  const output = {};
  for (const slot of Object.keys(slotSchema || {})) {
    if (!Object.prototype.hasOwnProperty.call(slots, slot) || slots[slot] === null) {
      continue;
    }

    const candidate = slots[slot];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const confidence = clampConfidence(candidate.confidence);
    const value = candidate.value;
    const floor = confidenceFloorForSlot(slotSchema[slot], value, floors);
    output[slot] = confidence >= floor
      ? { value, confidence }
      : { value: null, confidence };
  }
  return output;
}

// CPR-trigger observations (the schema marks them via cpr_trigger_value) must
// clear a higher floor than ordinary slots before they are trusted.
function confidenceFloorForSlot(definition, value, floors) {
  if (
    definition &&
    typeof definition === "object" &&
    Object.prototype.hasOwnProperty.call(definition, "cpr_trigger_value") &&
    definition.cpr_trigger_value === value
  ) {
    return floors.cpr_trigger_floor;
  }

  if (definition && typeof definition.floor === "string" && Number.isFinite(floors[definition.floor])) {
    return floors[definition.floor];
  }

  return floors.default_floor;
}

function resolveNluFloors(options = {}) {
  const base = getNluConfidenceFloors();
  return {
    ...base,
    default_floor: resolveSlotConfidenceFloor(options, base.default_floor),
    cpr_trigger_floor: resolveCprTriggerConfidenceFloor(options, base.cpr_trigger_floor)
  };
}

function isNluEligibleStage(stage) {
  return getNluStageConfig(stage).enabled === true;
}

function slotsFromIntent(intent, confidence) {
  const score = clampConfidence(confidence);
  switch (normalizeIntent(intent)) {
    case "scene_safe":
      return { scene_safe: { value: true, confidence: score } };
    case "scene_unsafe":
      return { scene_safe: { value: false, confidence: score } };
    case "patient_unresponsive":
      return { responsive: { value: false, confidence: score } };
    case "patient_responsive":
      return { responsive: { value: true, confidence: score } };
    case "normal_breathing":
      return { normal_breathing: { value: true, confidence: score } };
    case "no_normal_breathing":
      return { normal_breathing: { value: false, confidence: score } };
    case "agonal_breathing":
      return {
        agonal_breathing: { value: true, confidence: score },
        normal_breathing: { value: false, confidence: score }
      };
    default:
      return {};
  }
}

function normalizeIntentFromSlots(intent, slots) {
  const normalized = normalizeIntent(intent);
  if (
    (normalized === "parse_response_answer" || normalized === "patient_unresponsive") &&
    slots.responsive?.value === false
  ) {
    return "patient_unresponsive";
  }

  if (
    (normalized === "parse_response_answer" || normalized === "patient_responsive") &&
    slots.responsive?.value === true
  ) {
    return "patient_responsive";
  }

  if (slots.agonal_breathing?.value === true) {
    return "agonal_breathing";
  }

  if (
    (normalized === "parse_breathing_answer" || normalized === "clarify_breathing") &&
    slots.normal_breathing?.value === false
  ) {
    return "no_normal_breathing";
  }

  if (
    (normalized === "parse_breathing_answer" || normalized === "clarify_breathing") &&
    slots.normal_breathing?.value === true
  ) {
    return "normal_breathing";
  }

  return normalized;
}

function isIntentNluEnabled(options = {}) {
  const env = options.env || process.env;
  const raw = options.intentNlu ?? options.intent_nlu ?? env.INTENT_NLU;
  if (raw === undefined || raw === null || raw === "") {
    return false;
  }

  if (typeof raw === "boolean") {
    return raw;
  }

  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

function isAmbiguousClassification(classification) {
  const candidates = Array.isArray(classification.candidates) ? classification.candidates : [];
  if (candidates.length < 2) {
    return false;
  }

  const [best, next] = candidates;
  return best.intent !== next.intent && Math.abs(best.score - next.score) <= 0.05;
}

function isClearNegatedObservation(text, intent) {
  if (intent === "patient_unresponsive") {
    return /(没有反应|没反应|无反应|叫不醒|no response|not responding|unresponsive)/i.test(text);
  }
  if (intent === "no_normal_breathing") {
    return /(没有正常呼吸|没有呼吸|没呼吸|无呼吸|not breathing|no breathing)/i.test(text);
  }
  return false;
}

function normalizeFrameSlotSchema(frame = {}) {
  if (frame.slots_schema && typeof frame.slots_schema === "object" && !Array.isArray(frame.slots_schema)) {
    return frame.slots_schema;
  }

  if (Array.isArray(frame.allowed_slots)) {
    return Object.fromEntries(frame.allowed_slots.map((slot) => [slot, { type: "boolean" }]));
  }

  if (frame.allowed_slots && typeof frame.allowed_slots === "object") {
    return frame.allowed_slots;
  }

  return {};
}

function createResolvedIntent({
  intent,
  confidence,
  source,
  slots,
  needsClarification,
  escalated,
  classification = null
}) {
  return {
    ok: true,
    intent: normalizeIntent(intent),
    slots: slots || {},
    confidence: clampConfidence(confidence),
    source,
    needsClarification: Boolean(needsClarification),
    needs_clarification: Boolean(needsClarification),
    escalated: Boolean(escalated),
    classification
  };
}

function normalizeClassification(classification) {
  return {
    intent: normalizeIntent(classification?.intent),
    score: clampConfidence(classification?.score),
    candidates: Array.isArray(classification?.candidates)
      ? classification.candidates.map((candidate) => ({
        ...candidate,
        intent: normalizeIntent(candidate.intent),
        score: clampConfidence(candidate.score)
      }))
      : []
  };
}

function normalizeIntent(intent) {
  if (typeof intent !== "string" || !intent) {
    return null;
  }
  return INTENT_ALIASES[intent] || intent;
}

function resolveRegexConfidenceFloor(options = {}) {
  return positiveNumber(
    options.regexConfidenceFloor,
    options.regex_confidence_floor,
    DEFAULT_REGEX_CONFIDENCE_FLOOR
  );
}

function resolveSlotConfidenceFloor(options = {}, knowledgeDefault = DEFAULT_SLOT_CONFIDENCE_FLOOR) {
  return positiveNumber(
    options.defaultFloor,
    options.default_floor,
    options.slotConfidenceFloor,
    options.slot_confidence_floor,
    knowledgeDefault,
    DEFAULT_SLOT_CONFIDENCE_FLOOR
  );
}

function resolveCprTriggerConfidenceFloor(options = {}, knowledgeDefault = DEFAULT_CPR_TRIGGER_CONFIDENCE_FLOOR) {
  return positiveNumber(
    options.cprTriggerFloor,
    options.cpr_trigger_floor,
    knowledgeDefault,
    DEFAULT_CPR_TRIGGER_CONFIDENCE_FLOOR
  );
}

function positiveNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return Math.min(1, num);
    }
  }
  return 0;
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(1, Math.max(0, num));
}

function readNluCache(options = {}) {
  const cache = options.nluCache ?? options.nlu_cache;
  if (cache && typeof cache.get === "function" && typeof cache.set === "function") {
    return cache;
  }
  return null;
}

function readNluBudget(options = {}) {
  const budget = options.nluBudget ?? options.nlu_budget;
  if (budget && typeof budget.tryConsume === "function") {
    return budget;
  }
  return null;
}

function resolveBudgetKey(options = {}) {
  return options.sessionId || options.session_id || "__session__";
}

function finalizeCacheHit(cached, escalationReason) {
  return {
    ...cloneResolution(cached),
    escalationReason,
    cacheHit: true
  };
}

function cloneResolution(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON clone for any non-cloneable field.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeError(error) {
  return {
    message: error?.message || "NLU runtime failed.",
    code: error?.code
  };
}
