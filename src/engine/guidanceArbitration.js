import { getGemmaIntentScope } from "../knowledge/knowledgeBase.js";

// WC Tier-2 决策权信封的共享层：被 voice/service.js 与 agent/runPipeline.js 复用，
// 保证两条链路用同一套 scope 仲裁 + 同一套显式冲突优先级 + 同一套审计。

export const GemmaDecisionScope = Object.freeze({
  AUTONOMY: "autonomy",
  RESTRICTED: "restricted"
});

// 显式冲突优先级常量（数值越大越优先）。严格对应 plan 的链路顺序：
// 关键规则纠错 > 状态机 flow/critical/tool > 流程快路径 > Gemma autonomy 自选
//   > Gemma 同 intent 润色 > 确定性兜底。
export const GuidanceConflictPriority = Object.freeze({
  RULE_CRITICAL_CORRECTION: 60,
  STATE_MACHINE_CRITICAL: 50,
  RULE_FLOW_FAST_PATH: 40,
  GEMMA_AUTONOMY: 30,
  GEMMA_REWORD: 20,
  DETERMINISTIC_FALLBACK: 10
});

// 显式优先级的高→低顺序（用于文档与单测断言其单调性）。
export const GUIDANCE_CONFLICT_PRIORITY_ORDER = Object.freeze([
  "RULE_CRITICAL_CORRECTION",
  "STATE_MACHINE_CRITICAL",
  "RULE_FLOW_FAST_PATH",
  "GEMMA_AUTONOMY",
  "GEMMA_REWORD",
  "DETERMINISTIC_FALLBACK"
]);

// 仲裁结果 source -> 冲突优先级 rank。便于审计/对比"谁赢了"。
export const GUIDANCE_SOURCE_PRIORITY = Object.freeze({
  rule_feedback_critical: GuidanceConflictPriority.RULE_CRITICAL_CORRECTION,
  state_machine_critical: GuidanceConflictPriority.STATE_MACHINE_CRITICAL,
  rule_flow_fast_path: GuidanceConflictPriority.RULE_FLOW_FAST_PATH,
  rule_fast_path: GuidanceConflictPriority.RULE_FLOW_FAST_PATH,
  gemma_autonomy: GuidanceConflictPriority.GEMMA_AUTONOMY,
  gemma_agent: GuidanceConflictPriority.GEMMA_REWORD,
  gemma_fallback: GuidanceConflictPriority.DETERMINISTIC_FALLBACK,
  state_machine: GuidanceConflictPriority.DETERMINISTIC_FALLBACK
});

export function guidanceSourceRank(source) {
  return GUIDANCE_SOURCE_PRIORITY[source] ?? GuidanceConflictPriority.DETERMINISTIC_FALLBACK;
}

// Tier-2 授权信封：在状态机选定 intent 之上，决定 Gemma 是否可"换义"。
//  - 状态机给的是 restricted intent  -> 仅可润色（换义被丢弃）。
//  - 状态机给的是 autonomy  intent  -> Gemma 可在同阶段 autonomy 子集内自选其它 intent。
// 关键/工具流由调用方在更上游用 isCriticalFlowAction 拦截，这里只处理非关键轮的换义授权。
export function resolveGemmaAuthority({ stage, stateIntent = null, gemmaIntent = null } = {}) {
  const stateScope = stateIntent ? getGemmaIntentScope(stage, stateIntent) : GemmaDecisionScope.RESTRICTED;
  const gemmaScope = gemmaIntent ? getGemmaIntentScope(stage, gemmaIntent) : GemmaDecisionScope.RESTRICTED;
  const sameIntent = Boolean(stateIntent) && stateIntent === gemmaIntent;
  const allowIntentChange =
    !sameIntent &&
    stateScope === GemmaDecisionScope.AUTONOMY &&
    gemmaScope === GemmaDecisionScope.AUTONOMY;

  return { stage: stage || null, stateScope, gemmaScope, sameIntent, allowIntentChange };
}

// 结构化审计：默认静默（除非显式打开 GUIDANCE_AUDIT_LOG），并把每次仲裁的
// intent + scope + 选定 source + reason code 通过可注入 sink 暴露给测试/上层。
let auditSink = defaultAuditSink;

export function recordGuidanceArbitration(entry = {}) {
  const record = {
    type: "guidance_arbitration",
    chosen_rank: guidanceSourceRank(entry.chosen_source),
    ...entry
  };

  try {
    auditSink(record);
  } catch {
    // 审计绝不能影响指令下发。
  }

  return record;
}

export function setGuidanceAuditSink(sink) {
  auditSink = typeof sink === "function" ? sink : defaultAuditSink;
  return auditSink;
}

export function resetGuidanceAuditSink() {
  auditSink = defaultAuditSink;
  return auditSink;
}

function defaultAuditSink(record) {
  const flag = process.env.GUIDANCE_AUDIT_LOG;
  if (flag === "1" || flag === "true") {
    // eslint-disable-next-line no-console
    console.debug(JSON.stringify(record));
  }
}
