import { normalizeAction, validateAction } from "../engine/actionValidator.js";
import { getGemmaAllowedIntents } from "../knowledge/knowledgeBase.js";
import {
  HANDOVER_NARRATIVE_INTENT,
  HANDOVER_NARRATIVE_STAGE,
  buildHandoverNarrativeFrame
} from "../gemma/handoverNarrativePrompt.js";
import { generateHandoverReport } from "./handoverReportGenerator.js";

// WD 第五点：S9 交接 / 复盘 NLG。
//
// Gemma 把 handoverReportGenerator 的结构化结果"叙述化"，但绝不能新增或篡改数字。
// 我们用两道独立的硬约束来保证安全，再失败回退确定性模板：
//   1) 数字白名单护栏：叙述里出现的每个数字都必须能在结构化报告（json 数字字段 +
//      确定性报告全文 + 注入给模型的 facts）里找到，否则判定为编造 -> 回退模板。
//   2) ActionValidator：复用 handover_summary_patch intent，校验禁忌话术 / intent 白名单。
// 任意一道不通过，或模型不可用，都回退到 generateHandoverReport 的确定性 text。
const DECIMAL_NUMBER_PATTERN = /\d+(?:\.\d+)?/g;

// WC 的实时 TTS 字数上限（tts_exceeds_max_chars）约束的是"实时引导轮"，目的是防止
// Gemma 长篇阻塞首响。S9 交接叙述是交接时朗读的多事实报告叙述，本就更长且不在首响
// 关键路径上，故在交接叙述校验中对这一条（且仅这一条）做范围豁免；其余 ActionValidator
// 硬 Guard（禁忌话术、intent 白名单、禁忌意图、禁 Gemma 工具、禁改阶段）全部仍强制。
const REALTIME_ONLY_VIOLATION = "tts_exceeds_max_chars";

// 乱码护栏：只匹配 Unicode 替换符与典型 GBK 乱码标记，正常中文/数字零误伤。交接叙述
// 会朗读给急救员，编码损坏的模型输出应回退确定性模板，而非播报乱码。
const CORRUPT_TEXT_PATTERN = /\uFFFD|锟斤拷/u;

// generateHandoverNarrative orchestrates the S9 narrative. It never throws and
// always resolves to a result whose `narrative` is safe to speak/show: either a
// validated Gemma narrative, or the deterministic template text.
export async function generateHandoverNarrative({
  logInput,
  state = {},
  options = {},
  report,
  runtime,
  sessionId
} = {}) {
  const resolvedReport = report || generateHandoverReport(logInput, state, options);
  const reportJson = resolvedReport.json || {};
  const reportText = resolvedReport.text || "";
  const resolvedSessionId = sessionId || reportJson.session_id || state.session_id || null;

  const frame = buildHandoverNarrativeFrame(reportJson, {
    sourceText: reportText,
    sessionId: resolvedSessionId
  });

  if (!runtime || typeof runtime.generateNarrative !== "function") {
    return templateFallbackResult(resolvedReport, {
      reason: "no_runtime",
      violations: []
    });
  }

  let modelResult = null;
  try {
    modelResult = await runtime.generateNarrative(frame);
  } catch (error) {
    return templateFallbackResult(resolvedReport, {
      reason: error?.message || "narrative_runtime_error",
      violations: []
    });
  }

  const narrative = pickModelNarrative(modelResult);
  if (!modelResult || modelResult.ok === false || modelResult.fallback || !narrative) {
    return templateFallbackResult(resolvedReport, {
      reason: modelResult?.fallbackReason || modelResult?.reason || "gemma_unavailable",
      violations: Array.isArray(modelResult?.violations) ? modelResult.violations : []
    });
  }

  const validation = validateHandoverNarrative(narrative, {
    reportJson,
    reportText,
    facts: frame.facts,
    state,
    sessionId: resolvedSessionId
  });

  if (!validation.ok) {
    return templateFallbackResult(resolvedReport, {
      reason: "narrative_validation_failed",
      violations: validation.violations
    });
  }

  return {
    text: reportText,
    json: reportJson,
    narrative,
    intent: HANDOVER_NARRATIVE_INTENT,
    source: "gemma_agent",
    fallback: false,
    fallbackReason: null,
    violations: [],
    action: validation.action,
    confidence: Number.isFinite(modelResult.confidence) ? modelResult.confidence : null
  };
}

// validateHandoverNarrative runs BOTH hard guards: the number allow-set check
// and the ActionValidator (forbidden speech + handover_summary_patch intent).
export function validateHandoverNarrative(
  narrative,
  { reportJson = {}, reportText = "", facts = {}, state = {}, sessionId, now } = {}
) {
  const violations = [];
  const trimmed = typeof narrative === "string" ? narrative.trim() : "";

  if (!trimmed) {
    return { ok: false, violations: ["empty_narrative"], action: null };
  }

  const allowedNumbers = collectAllowedNumberTokens(reportJson, reportText, facts);
  const fabricated = findFabricatedNumbers(trimmed, allowedNumbers);
  if (fabricated.length > 0) {
    violations.push(`fabricated_numbers:${fabricated.join(",")}`);
  }

  if (CORRUPT_TEXT_PATTERN.test(trimmed)) {
    violations.push("corrupt_text");
  }

  const candidate = toHandoverCandidate(trimmed, { reportJson, state, sessionId, now });
  const validatorState = {
    current_stage: HANDOVER_NARRATIVE_STAGE,
    session_id: sessionId || reportJson.session_id || state.session_id || "sess_unknown",
    allowed_intents: getGemmaAllowedIntents(HANDOVER_NARRATIVE_STAGE)
  };
  const actionValidation = validateAction(candidate, validatorState);

  // Enforce every ActionValidator guard EXCEPT the realtime-only length cap.
  const blockingViolations = actionValidation.violations.filter(
    (violation) => violation !== REALTIME_ONLY_VIOLATION
  );
  violations.push(...blockingViolations);

  if (violations.length > 0) {
    return {
      ok: false,
      violations,
      action: actionValidation.ok ? actionValidation.action : null
    };
  }

  // No blocking violations remain. When validateAction failed ONLY due to the
  // intentionally-ignored length cap, its `.action` is a blocked fallback we must
  // not surface, so rebuild the validated handover action from the candidate.
  const action = actionValidation.ok
    ? actionValidation.action
    : normalizeAction(candidate, validatorState);

  return { ok: true, violations: [], action };
}

// collectAllowedNumberTokens builds the set of numeric values Gemma is allowed
// to mention. Sources, by design, are exactly the structured report:
//   - numeric-typed fields anywhere in the report JSON (skip strings so ISO
//     timestamps / ids do not silently widen the allow-set),
//   - every digit run in the deterministic report text (clock times, coords,
//     "85/100", "120 次" ... — this is what is actually rendered),
//   - the curated facts injected into the model prompt (numbers AND the digits
//     inside curated strings like the computed CPR duration), so anything we
//     deliberately hand the model is permitted.
export function collectAllowedNumberTokens(reportJson = {}, reportText = "", facts = {}) {
  const allowed = new Set();
  collectNumbers(reportJson, allowed, { includeStringDigits: false });
  addDigitRuns(reportText, allowed);
  collectNumbers(facts, allowed, { includeStringDigits: true });
  return allowed;
}

// findFabricatedNumbers returns the raw numeric tokens in the narrative that are
// NOT present in the allow-set. Comparison is by numeric value so "06" and "6"
// match, and "110" / "110.0" match.
export function findFabricatedNumbers(narrative = "", allowed = new Set()) {
  const offenders = [];
  const text = String(narrative);
  for (const match of text.matchAll(DECIMAL_NUMBER_PATTERN)) {
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (!allowed.has(value)) {
      offenders.push(match[0]);
    }
  }
  return offenders;
}

function toHandoverCandidate(narrative, { reportJson = {}, state = {}, sessionId, now } = {}) {
  return {
    session_id: sessionId || reportJson.session_id || state.session_id || "sess_unknown",
    stage: HANDOVER_NARRATIVE_STAGE,
    intent: HANDOVER_NARRATIVE_INTENT,
    source: "gemma_agent",
    priority: "normal",
    timestamp: typeof now === "function" ? now() : undefined,
    tts: {
      text: narrative,
      tone: "calm_firm",
      speed: "normal",
      interrupt_policy: "queue"
    },
    ui: {
      main_text: "交接报告",
      secondary_text: "向急救员交接关键信息"
    },
    reason_codes: ["handover_narrative"],
    log_event: {
      type: HANDOVER_NARRATIVE_INTENT,
      detail: "gemma_handover_narrative"
    }
  };
}

function templateFallbackResult(report, { reason, violations }) {
  return {
    text: report.text || "",
    json: report.json || {},
    narrative: report.text || "",
    intent: HANDOVER_NARRATIVE_INTENT,
    source: "template_fallback",
    fallback: true,
    fallbackReason: reason || "template_fallback",
    violations: Array.isArray(violations) ? violations : [],
    action: null,
    confidence: null
  };
}

function pickModelNarrative(modelResult) {
  if (!modelResult || typeof modelResult !== "object") {
    return "";
  }

  const candidate =
    typeof modelResult.narrative === "string"
      ? modelResult.narrative
      : typeof modelResult.text === "string"
        ? modelResult.text
        : "";
  return candidate.trim();
}

function collectNumbers(value, set, { includeStringDigits }) {
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      set.add(value);
    }
    return;
  }

  if (typeof value === "string") {
    if (includeStringDigits) {
      addDigitRuns(value, set);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNumbers(item, set, { includeStringDigits });
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectNumbers(item, set, { includeStringDigits });
    }
  }
}

function addDigitRuns(text, set) {
  if (typeof text !== "string") {
    return;
  }

  for (const match of text.matchAll(DECIMAL_NUMBER_PATTERN)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) {
      set.add(value);
    }
  }
}
