import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getGemmaAllowedIntents, getSafetyPhrases } from "../knowledge/knowledgeBase.js";
import { extractFirstJsonObject } from "./responseParser.js";

// The handover narrative is a dedicated S9 capability: Gemma narrates the
// deterministic handover report (numbers come ONLY from the structured facts).
// It reuses the existing handover_summary_patch intent and is enforced by the
// number guard + ActionValidator in report/handoverNarrative.js.
export const HANDOVER_NARRATIVE_SCHEMA = "HandoverNarrative";
export const HANDOVER_NARRATIVE_INTENT = "handover_summary_patch";
export const HANDOVER_NARRATIVE_STAGE = "S9_HANDOVER";

const PROMPTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts"
);
export const DEFAULT_HANDOVER_NARRATIVE_SYSTEM_PROMPT_FILE =
  "handover_narrative_system_prompt_v1.txt";
export const DEFAULT_HANDOVER_NARRATIVE_USER_PROMPT_FILE =
  "handover_narrative_user_template_v1.txt";

const FACTS_TOKEN = "<<HANDOVER_FACTS_JSON>>";
const SOURCE_TEXT_TOKEN = "<<HANDOVER_SOURCE_TEXT>>";

// Inline fallbacks keep the runtime working even if the prompt files are
// missing/unreadable; the prompt files in prompts/ are authoritative.
export const HANDOVER_NARRATIVE_SYSTEM_PROMPT = [
  "你是 FirstAid Copilot 的交接叙述生成器，在 S9_HANDOVER 阶段把结构化事实转写成中文口头交接叙述。",
  "你只做叙述化，不做医疗判断、不诊断、不预测结果、不发起工具调用、不改变流程。",
  "数字硬性限制：只能复述输入 facts 与 deterministic_report 中已出现的数字，必须完全一致；",
  "禁止新增、推算、估计、四舍五入或修改任何数字；数字保留阿拉伯数字写法，不改成中文数字；未提供则写“未记录”。",
  "不诊断疾病、不承诺结果、不恐吓、不责备、不新增未给出的医疗步骤或信息。",
  "只输出一个顶层 JSON 对象：{\"narrative\":\"中文交接叙述\",\"reason\":\"snake_case\",\"confidence\":0.0}。"
].join("\n");

export const HANDOVER_NARRATIVE_USER_PROMPT_TEMPLATE = [
  "请只依据下面的事实生成交接叙述，叙述中的每个数字都必须能在 facts 或 deterministic_report 中找到且写法一致。",
  "",
  "facts：",
  FACTS_TOKEN,
  "",
  "deterministic_report：",
  SOURCE_TEXT_TOKEN,
  "",
  "请输出唯一的顶层 JSON 对象（HandoverNarrative）。"
].join("\n");

const promptFileCache = new Map();

function readPromptFile(filePath) {
  if (promptFileCache.has(filePath)) {
    return promptFileCache.get(filePath);
  }

  let content = null;
  try {
    content = readFileSync(filePath, "utf8").replace(/\s+$/u, "");
  } catch {
    content = null;
  }

  promptFileCache.set(filePath, content);
  return content;
}

function resolvePromptFile(explicitFile, defaultFileName, options = {}) {
  if (explicitFile) {
    return path.isAbsolute(explicitFile)
      ? explicitFile
      : path.resolve(options.promptsDir || PROMPTS_ROOT, explicitFile);
  }

  const dir = options.promptsDir || options.env?.GEMMA_PROMPTS_DIR || PROMPTS_ROOT;
  return path.resolve(dir, defaultFileName);
}

export function clearHandoverNarrativePromptCache() {
  promptFileCache.clear();
}

export function loadHandoverNarrativeSystemPrompt(options = {}) {
  const env = options.env || process.env;
  const filePath = resolvePromptFile(
    options.systemPromptFile ?? env.HANDOVER_NARRATIVE_SYSTEM_PROMPT_FILE,
    DEFAULT_HANDOVER_NARRATIVE_SYSTEM_PROMPT_FILE,
    { promptsDir: options.promptsDir, env }
  );
  return readPromptFile(filePath) ?? HANDOVER_NARRATIVE_SYSTEM_PROMPT;
}

export function loadHandoverNarrativeUserPromptTemplate(options = {}) {
  const env = options.env || process.env;
  const filePath = resolvePromptFile(
    options.userPromptFile ?? env.HANDOVER_NARRATIVE_USER_PROMPT_FILE,
    DEFAULT_HANDOVER_NARRATIVE_USER_PROMPT_FILE,
    { promptsDir: options.promptsDir, env }
  );
  return readPromptFile(filePath) ?? HANDOVER_NARRATIVE_USER_PROMPT_TEMPLATE;
}

// buildHandoverNarrativeFrame turns the structured handover report JSON into the
// frame the model receives. `facts` is the curated, numeric ground truth; the
// number guard in report/handoverNarrative.js builds its allow-set from exactly
// these facts plus the deterministic report text, so anything Gemma may say is
// derivable from the structured report.
export function buildHandoverNarrativeFrame(reportJson = {}, options = {}) {
  const sourceText = typeof options.sourceText === "string" ? options.sourceText : "";
  return {
    session_id: reportJson.session_id || options.sessionId || "sess_unknown",
    current_stage: HANDOVER_NARRATIVE_STAGE,
    allowed_intents: getGemmaAllowedIntents(HANDOVER_NARRATIVE_STAGE),
    facts: buildNarrativeFacts(reportJson),
    source_text: sourceText,
    safety_phrases: getSafetyPhrases(HANDOVER_NARRATIVE_STAGE),
    output_schema: HANDOVER_NARRATIVE_SCHEMA,
    language: options.language || "zh-CN"
  };
}

export function buildNarrativeFacts(reportJson = {}) {
  const cpr = reportJson.cpr || {};
  const tools = reportJson.tools || {};
  const symptoms = reportJson.symptoms || {};
  const interruptions = Array.isArray(cpr.interruptions) ? cpr.interruptions : [];
  const corrections = Array.isArray(cpr.corrections) ? cpr.corrections : [];
  const interruptionSeconds = interruptions.reduce(
    (sum, item) => sum + (Number.isFinite(item?.seconds) ? item.seconds : 0),
    0
  );
  const duration = computeCprDuration(reportJson);

  return pruneNullish({
    initial_assessment_time: clockOf(reportJson.initial_assessment_time),
    cpr_started_at: clockOf(reportJson.cpr_started_at),
    cpr_duration: duration?.text ?? null,
    cpr_duration_seconds: duration?.total_seconds ?? null,
    symptom_summary: symptoms.summary || null,
    responsive: symptoms.responsive ?? null,
    normal_breathing: symptoms.normal_breathing ?? null,
    agonal_breathing: symptoms.agonal_breathing ?? null,
    suspected_cardiac_arrest: symptoms.suspected_cardiac_arrest ?? null,
    total_compressions: numberOrNull(cpr.total_compressions),
    average_rate: numberOrNull(cpr.average_rate),
    quality_score: numberOrNull(cpr.quality_score),
    interruption_count: interruptions.length,
    interruption_total_seconds: interruptionSeconds > 0 ? interruptionSeconds : null,
    correction_count: corrections.length,
    aed_status: reportJson.aed?.status || null,
    emergency_call_status: tools.emergency_call_status || null,
    // The dispatch number ("120") is part of the structured call brief; expose it
    // only when a call actually happened so the narrative can naturally say
    // "已呼叫 120" without the number guard flagging it as fabricated.
    emergency_call_target: tools.emergency_call_status
      ? reportJson.call_brief?.destination || null
      : null,
    gps_attached: tools.gps_attached ?? null,
    recording_status: tools.recording_status || null,
    video_record: tools.video_record || null,
    location: summarizeLocation(reportJson.location)
  });
}

export function buildHandoverNarrativePrompt(frame = {}, options = {}) {
  const template = loadHandoverNarrativeUserPromptTemplate(options);
  const factsJson = JSON.stringify(frame.facts || {}, null, 2);
  const sourceText = typeof frame.source_text === "string" && frame.source_text.length > 0
    ? frame.source_text
    : "（无确定性报告文本）";

  return template
    .split(FACTS_TOKEN)
    .join(factsJson)
    .split(SOURCE_TEXT_TOKEN)
    .join(sourceText);
}

export function buildHandoverNarrativeMessages(frame = {}, options = {}) {
  return [
    { role: "system", content: loadHandoverNarrativeSystemPrompt(options) },
    { role: "user", content: buildHandoverNarrativePrompt(frame, options) }
  ];
}

// parseHandoverNarrativeResponse pulls the narrative string out of the model
// output. It is permissive about surrounding noise (extracts the first JSON
// object) but requires a non-empty `narrative` field; the number guard and
// ActionValidator downstream are what actually enforce safety.
export function parseHandoverNarrativeResponse(raw) {
  const text = coerceText(raw);
  const jsonText = extractFirstJsonObject(text);

  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const narrative = pickNarrative(parsed);
      if (narrative) {
        return {
          ok: true,
          narrative,
          reason: typeof parsed.reason === "string" ? parsed.reason : "handover_narrative",
          confidence: clamp01(Number(parsed.confidence))
        };
      }
    } catch {
      // fall through to failure
    }
  }

  return { ok: false, error: "narrative_not_found", narrative: "" };
}

function pickNarrative(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  const candidate =
    typeof parsed.narrative === "string"
      ? parsed.narrative
      : typeof parsed.text === "string"
        ? parsed.text
        : "";
  return candidate.trim();
}

function computeCprDuration(reportJson = {}) {
  const start = Date.parse(reportJson.cpr_started_at);
  const end = Date.parse(reportJson.generated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds <= 0) {
    return null;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const text = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  return { total_seconds: totalSeconds, text };
}

function summarizeLocation(location) {
  if (!location || typeof location !== "object") {
    return null;
  }

  const parts = [
    location.address_line,
    location.landmark ? `地标${location.landmark}` : null,
    location.floor ? `楼层${location.floor}` : null
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("，") : null;
}

function clockOf(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }

  return date.toISOString().slice(11, 19);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0.6;
  }
  return Math.min(1, Math.max(0, value));
}

function coerceText(raw) {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw && typeof raw.text === "string") {
    return raw.text;
  }
  if (raw && typeof raw.content === "string") {
    return raw.content;
  }
  return "";
}

function pruneNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
  );
}
