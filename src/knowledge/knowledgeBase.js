import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge");

let cache = null;

function loadJson(fileName) {
  try {
    const raw = readFileSync(path.join(KNOWLEDGE_DIR, fileName), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function load() {
  if (cache) {
    return cache;
  }

  const allowed = loadJson("allowed_intents.json") || {};
  const phrases = loadJson("safety_phrases.json") || {};
  const nluSlots = loadJson("nlu_slots.json") || {};

  const specialIntents = uniqueStrings(allowed.special_intents || ["defer_to_rule_feedback", "fallback_template"]);
  const globalIntents = uniqueStrings(allowed.global_intents || []);
  const stageMap = allowed.gemma_intents_by_stage || {};

  const allowedIntentsByStage = {};
  for (const [stage, intents] of Object.entries(stageMap)) {
    allowedIntentsByStage[stage] = uniqueStrings([
      ...(Array.isArray(intents) ? intents : []),
      ...globalIntents,
      ...specialIntents
    ]);
  }

  const safetyPhrasesByStage = buildSafetyPhrasesByStage(phrases.allowed_phrases);
  const forbiddenPhrases = uniqueStrings(
    (Array.isArray(phrases.forbidden_phrases) ? phrases.forbidden_phrases : [])
      .flatMap((entry) => (Array.isArray(entry?.phrases) ? entry.phrases : []))
  );

  const nluConfidenceFloors = normalizeConfidenceFloors(nluSlots.confidence);
  const nluStageConfigs = normalizeNluStageConfigs(nluSlots.stages);
  const nluEscalationMarkers = normalizeMarkerMap(nluSlots.escalation_markers);
  const forbiddenIntents = uniqueStrings([
    ...(allowed.forbidden_intents || []),
    ...(nluSlots.forbidden_intents || [])
  ]);
  const gemmaDecisionScopeByStage = buildGemmaDecisionScope(allowed.gemma_decision_scope);

  cache = {
    knowledgeVersion: allowed.knowledge_version || phrases.knowledge_version || "unknown",
    specialIntents,
    globalIntents,
    allowedIntentsByStage,
    forbiddenIntents,
    gemmaDecisionScopeByStage,
    safetyPhrasesByStage,
    forbiddenPhrases,
    validatorRules: phrases.validator_rules || {},
    nluSlots,
    nluConfidenceFloors,
    nluStageConfigs,
    nluEscalationMarkers
  };

  return cache;
}

// Tier-2 授权信封的单一事实源。每阶段把意图二分为 autonomy / restricted（见
// allowed_intents.json 的 gemma_decision_scope）。仲裁层据此决定是否放开 Gemma 换义。
const AUTONOMY_INTENT_PATTERN =
  /^(reassure_rescuer|encourage_rescuer|calm_rescuer|answer_[a-z0-9_]+_question|explain_[a-z0-9_]+)$/;

function buildGemmaDecisionScope(rawScope) {
  if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    return {};
  }

  const result = {};
  for (const [stage, scope] of Object.entries(rawScope)) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      continue;
    }
    result[stage] = {
      autonomy: uniqueStrings(scope.autonomy),
      restricted: uniqueStrings(scope.restricted)
    };
  }

  return result;
}

function buildSafetyPhrasesByStage(allowedPhrases) {
  const result = {};
  if (!Array.isArray(allowedPhrases)) {
    return result;
  }

  for (const phrase of allowedPhrases) {
    if (!phrase || typeof phrase.text !== "string") {
      continue;
    }
    const stages = Array.isArray(phrase.stages) ? phrase.stages : [];
    for (const stage of stages) {
      if (!result[stage]) {
        result[stage] = [];
      }
      if (!result[stage].includes(phrase.text)) {
        result[stage].push(phrase.text);
      }
    }
  }

  return result;
}

export function getKnowledgeVersion() {
  return load().knowledgeVersion;
}

export function getSpecialIntents() {
  return [...load().specialIntents];
}

export function getGemmaAllowedIntentsByStage() {
  const { allowedIntentsByStage } = load();
  return Object.fromEntries(
    Object.entries(allowedIntentsByStage).map(([stage, intents]) => [stage, [...intents]])
  );
}

export function getGemmaAllowedIntents(stage) {
  const { allowedIntentsByStage, specialIntents } = load();
  const intents = allowedIntentsByStage[stage];
  return intents ? [...intents] : [...specialIntents];
}

export function getSafetyPhrasesByStage() {
  const { safetyPhrasesByStage } = load();
  return Object.fromEntries(
    Object.entries(safetyPhrasesByStage).map(([stage, items]) => [stage, [...items]])
  );
}

export function getSafetyPhrases(stage) {
  const phrases = load().safetyPhrasesByStage[stage];
  return phrases ? [...phrases] : [];
}

export function getForbiddenIntents() {
  return [...load().forbiddenIntents];
}

export function getGemmaDecisionScopeByStage() {
  const { gemmaDecisionScopeByStage } = load();
  return Object.fromEntries(
    Object.entries(gemmaDecisionScopeByStage).map(([stage, scope]) => [
      stage,
      { autonomy: [...scope.autonomy], restricted: [...scope.restricted] }
    ])
  );
}

export function getGemmaDecisionScope(stage) {
  const scope = load().gemmaDecisionScopeByStage[stage];
  return scope
    ? { autonomy: [...scope.autonomy], restricted: [...scope.restricted] }
    : { autonomy: [], restricted: [] };
}

// "autonomy" -> Gemma 可自选 intent + 自由措辞；"restricted" -> 仅可润色同 intent。
// 未显式分类的意图：表达性意图按启发式归 autonomy，其余一律从严按 restricted。
export function getGemmaIntentScope(stage, intent) {
  if (typeof intent !== "string" || intent.length === 0) {
    return "restricted";
  }

  const scope = load().gemmaDecisionScopeByStage[stage];
  if (scope) {
    if (scope.autonomy.includes(intent)) {
      return "autonomy";
    }
    if (scope.restricted.includes(intent)) {
      return "restricted";
    }
  }

  return AUTONOMY_INTENT_PATTERN.test(intent) ? "autonomy" : "restricted";
}

export function getForbiddenPhrases() {
  return [...load().forbiddenPhrases];
}

export function getValidatorRules() {
  return { ...load().validatorRules };
}

export function getNluSlotsConfig() {
  return cloneJson(load().nluSlots);
}

export function getNluConfidenceFloors() {
  return { ...load().nluConfidenceFloors };
}

export function getNluEscalationMarkers() {
  return cloneJson(load().nluEscalationMarkers);
}

export function getNluStageConfig(stage) {
  const config = load().nluStageConfigs[stage];
  return config ? cloneJson(config) : createEmptyNluStageConfig(stage);
}

export function getNluAllowedIntents(stage) {
  return uniqueStrings(getNluStageConfig(stage).allowed_intents);
}

export function getNluSlotSchema(stage) {
  return cloneJson(getNluStageConfig(stage).slots);
}

export function reloadKnowledgeBase() {
  cache = null;
  return load();
}

function normalizeConfidenceFloors(confidence = {}) {
  return {
    default_floor: numberOrDefault(confidence.default_floor, 0.62),
    cpr_trigger_floor: numberOrDefault(confidence.cpr_trigger_floor, 0.78),
    overall_floor: numberOrDefault(confidence.overall_floor, 0.55)
  };
}

function normalizeNluStageConfigs(stages = {}) {
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(stages).map(([stage, config]) => [
      stage,
      {
        description: typeof config?.description === "string" ? config.description : "",
        enabled: config?.enabled !== false,
        allowed_intents: uniqueStrings(config?.allowed_intents || []),
        slots: normalizeSlotSchema(config?.slots)
      }
    ])
  );
}

function normalizeSlotSchema(slots = {}) {
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(slots)
      .filter(([, definition]) => definition && typeof definition === "object" && !Array.isArray(definition))
      .map(([name, definition]) => [
        name,
        {
          type: definition.type === "enum" ? "enum" : "boolean",
          values: Array.isArray(definition.values) ? [...definition.values] : undefined,
          floor: typeof definition.floor === "string" ? definition.floor : undefined,
          cpr_trigger_value: definition.cpr_trigger_value,
          description: typeof definition.description === "string" ? definition.description : "",
          maps_to: typeof definition.maps_to === "string" ? definition.maps_to : name
        }
      ])
  );
}

function normalizeMarkerMap(markers = {}) {
  if (!markers || typeof markers !== "object" || Array.isArray(markers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(markers).map(([key, values]) => [key, uniqueStrings(values)])
  );
}

function createEmptyNluStageConfig(stage) {
  return {
    description: "",
    enabled: false,
    allowed_intents: [],
    slots: {},
    stage
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.length > 0))];
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
