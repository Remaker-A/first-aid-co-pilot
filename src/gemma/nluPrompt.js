import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NLU_OBSERVATION_SCHEMA } from "./decisionFrame.js";

const PROMPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

export const DEFAULT_GEMMA_NLU_SYSTEM_PROMPT_FILE = "gemma_nlu_system_prompt_v1.txt";
export const DEFAULT_GEMMA_NLU_USER_PROMPT_FILE = "gemma_nlu_user_template_v1.txt";

const NLU_FRAME_TOKEN = "<<NLU_FRAME_JSON>>";

export const GEMMA_NLU_SYSTEM_PROMPT = [
  "You are the Gemma NLU observation parser for FirstAid Copilot.",
  "Extract only observation facts from the rescuer transcript.",
  "Do not decide emergency flow, stage transitions, CPR start, diagnosis, or tool calls.",
  "Return exactly one top-level JSON object and no markdown.",
  "The first character must be { and the last character must be }.",
  "Choose intent only from allowed_intents.",
  "Use only allowed_slots. Unknown or low-confidence slots must be null.",
  "Each present slot must be {\"value\": boolean_or_enum, \"confidence\": number_0_to_1}.",
  "Never output stage, next_stage, suspected_cardiac_arrest, diagnosis, decision, tts, ui, guidance, tool_action, or tool_actions.",
  "If the rescuer reports occasional gasping or agonal breathing, it is not normal breathing.",
  "Minimal valid zh-CN example:",
  "{\"intent\":\"agonal_breathing\",\"slots\":{\"normal_breathing\":{\"value\":false,\"confidence\":0.86},\"agonal_breathing\":{\"value\":true,\"confidence\":0.9}},\"overall_confidence\":0.88,\"needs_clarification\":false,\"reason\":\"rescuer_reports_occasional_gasping\"}"
].join("\n");

export const GEMMA_NLU_USER_PROMPT_TEMPLATE = [
  "You will receive one NluFrame.",
  "Return only one top-level JSON object matching the NLU observation schema.",
  "Do not include markdown, explanations, wrappers, stage transitions, tool calls, diagnosis, or guidance text.",
  "",
  "NluFrame:",
  NLU_FRAME_TOKEN
].join("\n");

const promptFileCache = new Map();

export function clearGemmaNluPromptCache() {
  promptFileCache.clear();
}

export function loadGemmaNluSystemPrompt(options = {}) {
  const env = options.env || process.env;
  const filePath = resolvePromptFile(
    options.systemPromptFile ?? env.GEMMA_NLU_SYSTEM_PROMPT_FILE,
    DEFAULT_GEMMA_NLU_SYSTEM_PROMPT_FILE,
    { promptsDir: options.promptsDir, env }
  );
  return readPromptFile(filePath) ?? GEMMA_NLU_SYSTEM_PROMPT;
}

export function loadGemmaNluUserPromptTemplate(options = {}) {
  const env = options.env || process.env;
  const filePath = resolvePromptFile(
    options.userPromptFile ?? env.GEMMA_NLU_USER_PROMPT_FILE,
    DEFAULT_GEMMA_NLU_USER_PROMPT_FILE,
    { promptsDir: options.promptsDir, env }
  );
  return readPromptFile(filePath) ?? GEMMA_NLU_USER_PROMPT_TEMPLATE;
}

export function buildGemmaNluPrompt(frame, options = {}) {
  const pretty = options.pretty ?? true;
  const template = loadGemmaNluUserPromptTemplate(options);
  const normalized = normalizeNluFrameForPrompt(frame);
  return fillNluUserPromptTemplate(template, normalized, { pretty, ...options });
}

export function buildGemmaNluMessages(frame, options = {}) {
  return [
    {
      role: "system",
      content: loadGemmaNluSystemPrompt(options)
    },
    {
      role: "user",
      content: buildGemmaNluPrompt(frame, options)
    }
  ];
}

export function fillNluUserPromptTemplate(template, frameInput, options = {}) {
  const pretty = options.pretty ?? true;
  const frame = normalizeNluFrameForPrompt(frameInput);
  const frameJson = JSON.stringify(frame, null, pretty ? 2 : 0);

  const values = {
    stage: frame.current_stage,
    transcript: frame.transcript,
    allowed_intents_json: JSON.stringify(frame.allowed_intents),
    allowed_slots_json: JSON.stringify(frame.allowed_slots),
    slots_schema_json: JSON.stringify(frame.slots_schema, null, 2),
    confidence_floors_json: JSON.stringify(frame.confidence_floors),
    facts_json: JSON.stringify(frame.facts, null, 2),
    perception_summary_json: JSON.stringify(frame.perception_summary, null, 2),
    escalation_markers_json: JSON.stringify(frame.escalation_markers, null, 2),
    language: frame.language,
    output_schema: frame.output_schema,
    nlu_frame_json: frameJson
  };

  let result = template.split(NLU_FRAME_TOKEN).join(frameJson);
  result = result.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : ""
  );

  return result;
}

export function serializeNluFrame(frame, pretty = true) {
  const normalized = normalizeNluFrameForPrompt(frame);
  return JSON.stringify(normalized, null, pretty ? 2 : 0);
}

export function normalizeNluFrameForPrompt(frame = {}) {
  const slotsSchema = isPlainObject(frame.slots_schema) ? frame.slots_schema : {};
  const allowedSlots = Array.isArray(frame.allowed_slots)
    ? frame.allowed_slots
    : Object.keys(slotsSchema);

  return {
    session_id: frame.session_id || "sess_unknown",
    current_stage: frame.current_stage || "S0_INIT",
    transcript: typeof frame.transcript === "string" ? frame.transcript : "",
    allowed_intents: Array.isArray(frame.allowed_intents) ? frame.allowed_intents : [],
    allowed_slots: allowedSlots,
    slots_schema: slotsSchema,
    confidence_floors: isPlainObject(frame.confidence_floors) ? frame.confidence_floors : {},
    facts: isPlainObject(frame.facts) ? frame.facts : {},
    perception_summary: isPlainObject(frame.perception_summary) ? frame.perception_summary : {},
    escalation_markers: isPlainObject(frame.escalation_markers) ? frame.escalation_markers : {},
    output_schema: frame.output_schema || NLU_OBSERVATION_SCHEMA,
    language: frame.language || "zh-CN"
  };
}

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

  const dir = options.promptsDir || options.env?.GEMMA_NLU_PROMPTS_DIR || options.env?.GEMMA_PROMPTS_DIR || PROMPTS_ROOT;
  return path.resolve(dir, defaultFileName);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
