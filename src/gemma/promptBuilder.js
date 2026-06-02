import { GUIDANCE_ACTION_PATCH_SCHEMA } from "./decisionFrame.js";

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
  "<<DECISION_FRAME_JSON>>"
].join("\n");

export function buildGemmaPrompt(frame, { pretty = true } = {}) {
  const frameJson = serializeDecisionFrame(frame, pretty);
  return GEMMA_USER_PROMPT_TEMPLATE.replace("<<DECISION_FRAME_JSON>>", frameJson);
}

export function buildGemmaMessages(frame, options = {}) {
  return [
    {
      role: "system",
      content: GEMMA_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: buildGemmaPrompt(frame, options)
    }
  ];
}

export function serializeDecisionFrame(frame, pretty = true) {
  const normalized = normalizeDecisionFrameForPrompt(frame);
  return JSON.stringify(normalized, null, pretty ? 2 : 0);
}

export function normalizeDecisionFrameForPrompt(frame = {}) {
  return {
    session_id: frame.session_id || "sess_unknown",
    current_stage: frame.current_stage || "S0_INIT",
    allowed_intents: Array.isArray(frame.allowed_intents) ? frame.allowed_intents : [],
    facts: frame.facts || {},
    user_input: frame.user_input || { stt_text: "", confidence: 0 },
    perception_summary: frame.perception_summary || {},
    recent_tts: Array.isArray(frame.recent_tts) ? frame.recent_tts : [],
    safety_phrases: Array.isArray(frame.safety_phrases) ? frame.safety_phrases : [],
    output_schema: frame.output_schema || GUIDANCE_ACTION_PATCH_SCHEMA,
    language: frame.language || "zh-CN"
  };
}
