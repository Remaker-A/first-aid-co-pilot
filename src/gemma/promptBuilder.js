import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDANCE_ACTION_PATCH_SCHEMA } from "./decisionFrame.js";

// Single source of truth for the Gemma prompts lives in prompts/*.txt. They are
// read at runtime and are authoritative; the inline constants below are only a
// resilient fallback used when the files are missing/unreadable. Both express
// the same GuidanceActionPatch contract that responseParser/actionValidator
// enforce, so "doc prompt" and "code prompt" can no longer drift apart.
const PROMPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
export const DEFAULT_GEMMA_SYSTEM_PROMPT_FILE = "gemma_system_prompt_v1.1.txt";
export const DEFAULT_GEMMA_USER_PROMPT_FILE = "gemma_user_prompt_template_v1.1.txt";

const DECISION_FRAME_TOKEN = "<<DECISION_FRAME_JSON>>";

export const GEMMA_SYSTEM_PROMPT = [
  "You are the Gemma Model Driver for FirstAid Copilot.",
  "You do not decide emergency medical flow. The guideline state machine owns that decision.",
  "Generate only one top-level GuidanceActionPatch JSON object.",
  "Do not wrap the JSON in GuidanceActionPatch, patch, action, markdown fences, or explanatory text.",
  "Do not output markdown, explanations, apologies, tool calls, final GuidanceAction fields, or stage transitions.",
  "Choose intent only from allowed_intents, except defer_to_rule_feedback or fallback_template.",
  "Use only the supplied facts and safety_phrases. Do not add unreviewed medical steps.",
  "Do not diagnose disease, promise outcomes, blame the rescuer, or create fear.",
  "Give at most one primary action. Keep TTS short, calm, and direct.",
  "Patch fields: intent (required), tts{text,tone(calm_firm|calm_soft|urgent),speed(normal|slow)}, ui{main_text,secondary_text}, optional visual_overlay{mode,highlight_target,correction_arrow(left|right|up|down|null)}, optional log_suggestion{type,detail}, reason, confidence(0..1).",
  "Never include action_id, session_id, timestamp, stage, next_stage, priority, source, tool_action, tool_actions, haptic, ttl_ms, throttle_key, min_interval_ms, or interrupt_policy.",
  "If the request is unsafe, unclear, or not allowed, output fallback_template.",
  "If high-frequency CPR feedback should be handled by rules, output defer_to_rule_feedback with empty TTS.",
  "Minimal valid zh-CN example:",
  "{\"intent\":\"guide_cpr_position\",\"tts\":{\"text\":\"双手掌根放在胸口中央。\",\"tone\":\"calm_firm\",\"speed\":\"normal\"},\"ui\":{\"main_text\":\"胸口中央\",\"secondary_text\":\"双手掌根按压\"},\"reason\":\"user_asked_position\",\"confidence\":0.9}"
].join("\n");

export const GEMMA_USER_PROMPT_TEMPLATE = [
  "You will receive one DecisionFrame.",
  "Return only the top-level JSON object matching the GuidanceActionPatch schema.",
  "The first character must be { and the last character must be }.",
  "Do not use wrapper keys such as GuidanceActionPatch, patch, or action.",
  "Do not return final GuidanceAction fields.",
  "Do not return tool calls.",
  "Do not return stage transitions.",
  "",
  "DecisionFrame:",
  DECISION_FRAME_TOKEN
].join("\n");

const promptFileCache = new Map();

function readPromptFile(filePath) {
  if (promptFileCache.has(filePath)) {
    return promptFileCache.get(filePath);
  }

  let content = null;
  try {
    const raw = readFileSync(filePath, "utf8");
    content = raw.replace(/\s+$/u, "");
  } catch {
    content = null;
  }

  promptFileCache.set(filePath, content);
  return content;
}

function resolvePromptFile(explicitFile, defaultFileName, options = {}) {
  if (explicitFile) {
    return path.isAbsolute(explicitFile) ? explicitFile : path.resolve(options.promptsDir || PROMPTS_ROOT, explicitFile);
  }

  const dir = options.promptsDir || options.env?.GEMMA_PROMPTS_DIR || PROMPTS_ROOT;
  return path.resolve(dir, defaultFileName);
}

export function clearGemmaPromptCache() {
  promptFileCache.clear();
}

export function loadGemmaSystemPrompt(options = {}) {
  const env = options.env || process.env;
  const filePath = resolvePromptFile(
    options.systemPromptFile ?? env.GEMMA_SYSTEM_PROMPT_FILE,
    DEFAULT_GEMMA_SYSTEM_PROMPT_FILE,
    { promptsDir: options.promptsDir, env }
  );
  return readPromptFile(filePath) ?? GEMMA_SYSTEM_PROMPT;
}

export function loadGemmaUserPromptTemplate(options = {}) {
  const env = options.env || process.env;
  const filePath = resolvePromptFile(
    options.userPromptFile ?? env.GEMMA_USER_PROMPT_FILE,
    DEFAULT_GEMMA_USER_PROMPT_FILE,
    { promptsDir: options.promptsDir, env }
  );
  return readPromptFile(filePath) ?? GEMMA_USER_PROMPT_TEMPLATE;
}

export function buildGemmaPrompt(frame, options = {}) {
  const pretty = options.pretty ?? true;
  const template = loadGemmaUserPromptTemplate(options);
  const normalized = normalizeDecisionFrameForPrompt(frame);
  return fillUserPromptTemplate(template, normalized, { pretty, ...options });
}

export function buildGemmaMessages(frame, options = {}) {
  return [
    {
      role: "system",
      content: loadGemmaSystemPrompt(options)
    },
    {
      role: "user",
      content: buildGemmaPrompt(frame, options)
    }
  ];
}

export function fillUserPromptTemplate(template, frameInput, options = {}) {
  const pretty = options.pretty ?? true;
  const frame = normalizeDecisionFrameForPrompt(frameInput);
  const frameJson = JSON.stringify(frame, null, pretty ? 2 : 0);

  const values = {
    stage: frame.current_stage,
    allowed_intents_json: JSON.stringify(frame.allowed_intents),
    facts_json: JSON.stringify(frame.facts, null, 2),
    perception_summary_json: JSON.stringify(frame.perception_summary, null, 2),
    recent_tts_json: JSON.stringify(frame.recent_tts),
    safety_phrases_json: JSON.stringify(frame.safety_phrases, null, 2),
    user_input: frame.user_input?.stt_text || "",
    user_input_json: JSON.stringify(frame.user_input),
    language: frame.language,
    output_schema: frame.output_schema,
    decision_frame_json: frameJson,
    mode: options.mode || "",
    source: frame.perception_summary?.source || ""
  };

  let result = template.split(DECISION_FRAME_TOKEN).join(frameJson);
  result = result.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : ""
  );

  return result;
}

export function serializeDecisionFrame(frame, pretty = true) {
  const normalized = normalizeDecisionFrameForPrompt(frame);
  return JSON.stringify(normalized, null, pretty ? 2 : 0);
}

export function normalizeDecisionFrameForPrompt(frame = {}) {
  return pruneUndefined({
    session_id: frame.session_id || "sess_unknown",
    current_stage: frame.current_stage || "S0_INIT",
    transcript: frame.transcript,
    allowed_intents: Array.isArray(frame.allowed_intents) ? frame.allowed_intents : [],
    allowed_slots: Array.isArray(frame.allowed_slots) ? frame.allowed_slots : undefined,
    slots_schema: frame.slots_schema,
    confidence_floors: frame.confidence_floors,
    facts: frame.facts || {},
    user_input: frame.user_input || { stt_text: "", confidence: 0 },
    perception_summary: frame.perception_summary || {},
    recent_tts: Array.isArray(frame.recent_tts) ? frame.recent_tts : [],
    safety_phrases: Array.isArray(frame.safety_phrases) ? frame.safety_phrases : [],
    escalation_markers: frame.escalation_markers,
    forbidden_intents: frame.forbidden_intents,
    output_schema: frame.output_schema || GUIDANCE_ACTION_PATCH_SCHEMA,
    language: frame.language || "zh-CN"
  });
}

function pruneUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}
