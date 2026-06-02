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

  cache = {
    knowledgeVersion: allowed.knowledge_version || phrases.knowledge_version || "unknown",
    specialIntents,
    globalIntents,
    allowedIntentsByStage,
    forbiddenIntents: uniqueStrings(allowed.forbidden_intents || []),
    safetyPhrasesByStage,
    forbiddenPhrases,
    validatorRules: phrases.validator_rules || {}
  };

  return cache;
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

export function getForbiddenPhrases() {
  return [...load().forbiddenPhrases];
}

export function getValidatorRules() {
  return { ...load().validatorRules };
}

export function reloadKnowledgeBase() {
  cache = null;
  return load();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.length > 0))];
}
