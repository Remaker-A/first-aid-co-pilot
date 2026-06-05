import {
  getForbiddenIntents,
  getForbiddenPhrases,
  getGemmaAllowedIntents,
  getValidatorRules
} from "../knowledge/knowledgeBase.js";

const PRIORITY_RANK = Object.freeze({
  silent: 0,
  low: 1,
  normal: 2,
  high: 3,
  critical: 4
});

// Tier-1 不可违背硬 Guard 的来源：knowledge/safety_phrases.json 的 validator_rules
// 与 allowed_intents.json 的 forbidden_intents。把"只声明"的规则变成强制校验，每条
// 都有稳定的 reason code（见下方各 guard）。仅在模块加载时读取一次（与
// KNOWLEDGE_FORBIDDEN_PHRASES 一致），单一事实源由 knowledgeBase 维护。
const VALIDATOR_RULES = getValidatorRules();
const KNOWLEDGE_FORBIDDEN_INTENTS = getForbiddenIntents();

// 强制 TTS 字数上限（防 Gemma 长篇）。只统计中文（zh）字符，数字/空格/标点不计入，
// 与 recommended_tts_max_zh_chars 的语义一致。仅约束 source=gemma_agent 的生成话术；
// 状态机/规则反馈/liveDriver 的固定话术是审定过的标准句，豁免长度限制。
const TTS_MAX_ZH_CHARS = ruleNumber(VALIDATOR_RULES.recommended_tts_max_zh_chars, 30);
const CRITICAL_TTS_MAX_ZH_CHARS = ruleNumber(VALIDATOR_RULES.critical_stage_tts_max_zh_chars, 60);
// 急救关键阶段允许更长的安抚/解释（60），其余阶段从严（30）。
const CRITICAL_TTS_STAGES = new Set([
  "S4_SUSPECTED_ARREST",
  "S5_CALL_EMERGENCY",
  "S6_CPR_READY",
  "S7_CPR_LOOP",
  "S8_ASSISTANCE"
]);
const ZH_CHAR_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;

// validator_rules 的布尔开关：默认强制（缺省视为 true），可在知识库显式关闭。
const ENFORCE_GEMMA_NO_TOOLS = VALIDATOR_RULES.must_not_add_tool_actions_from_gemma !== false;
const ENFORCE_NO_STATE_DECISION_CHANGE =
  VALIDATOR_RULES.must_not_change_state_machine_decision !== false;
const GEMMA_SOURCE = "gemma_agent";

function ruleNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const DEFAULT_ALLOWED_TOOL_TYPES_BY_STAGE = Object.freeze({
  S0_INIT: ["check_permissions", "start_recording"],
  S5_CALL_EMERGENCY: [
    "emergency_call",
    "mock_emergency_call",
    "attach_gps",
    "attach_gps_location",
    "start_recording",
    "start_local_recording"
  ],
  S6_CPR_READY: ["start_haptic_metronome"],
  S7_CPR_LOOP: ["start_haptic_metronome", "update_haptic_metronome", "stop_haptic_metronome"],
  MONITOR_RESPONSE: ["emergency_call", "mock_emergency_call", "attach_gps", "attach_gps_location"],
  MONITOR_BREATHING: ["emergency_call", "mock_emergency_call", "attach_gps", "attach_gps_location"],
  S9_HANDOVER: [
    "generate_handover_report",
    "request_share_report",
    "request_share_video",
    "share_report",
    "share_video"
  ]
});

const SHARE_TOOL_TYPES = new Set([
  "share_report",
  "share_video",
  "send_report",
  "send_video",
  "delete_video"
]);

const CONFIRMATION_REQUEST_TOOL_TYPES = new Set([
  "request_share_report",
  "request_share_video"
]);

const FORBIDDEN_SPEECH_PATTERNS = Object.freeze([
  /\u4ed6\u5df2\u7ecf\u5fc3\u810f\u9aa4\u505c/u,
  /\u5df2\u7ecf\u5fc3\u810f\u9aa4\u505c/u,
  /\u8fd9\u662f\u5fc3\u6897/u,
  /\u8fd9\u662f\u8111\u5352\u4e2d/u,
  /\u4e00\u5b9a\u80fd\u6551\u6d3b/u,
  /\u80fd\u6551\u4ed6/u,
  /\u80fd\u6551\u5979/u,
  /\u4e0d\u7528\u62c5\u5fc3.*\u6ca1\u4e8b/u,
  /\u81ea\u5df1\u51b3\u5b9a.*\u6309/u,
  /\u4f1a\u6b7b/u,
  /\b(guarantee|will save|diagnosed|diagnosis|heart attack|stroke)\b/i
]);

export function validateAction(candidate, state = {}, options = {}) {
  const action = normalizeAction(candidate, state, options);
  const violations = [];

  if (containsForbiddenSpeech(action)) {
    violations.push("forbidden_speech");
  }

  // 显式拒绝 forbidden_intents（任何来源）：此前只靠"不在白名单"隐式挡，现在改为显式
  // 拒绝并留下 intent_forbidden:<intent> 审计码，连状态机也不得发出禁忌意图（纵深防御）。
  if (isForbiddenIntent(action.intent)) {
    violations.push(`intent_forbidden:${action.intent}`);
  }

  if (!isIntentAllowed(action, state, options)) {
    violations.push(`intent_not_allowed:${action.intent || ""}`);
  }

  if (isLowerPriorityInterruptingCritical(action, state)) {
    violations.push("low_priority_interrupts_critical");
  }

  // 禁止 Gemma 改写状态机决策：不得触碰 stage/next_stage（CPR 启动仍只由 cprStartRule
  // 决定），并落实 gemma_may_create_tool_actions:false（任何 gemma 来源工具一律剥离）。
  violations.push(...validateGemmaAuthorityGuards(action, candidate, state));

  // 强制 TTS 字数上限（仅 gemma 来源）：超长即判违规并回退，防止 Gemma 长篇阻塞首响。
  if (exceedsTtsCharLimit(action)) {
    violations.push("tts_exceeds_max_chars");
  }

  const toolViolations = validateToolActions(action, state, options);
  violations.push(...toolViolations);

  if (violations.length === 0) {
    return {
      ok: true,
      action,
      violations: []
    };
  }

  const blockedAction = createBlockedAction(action, state, violations);
  return {
    ok: false,
    action: blockedAction,
    rejected_action: action,
    violations
  };
}

export function normalizeAction(candidate = {}, state = {}, options = {}) {
  const stage = candidate.stage || state.current_stage || "S0_INIT";
  const now = options.now || (() => new Date().toISOString());
  const timestamp = candidate.timestamp || now();
  const intent = candidate.intent || candidate.log_event?.type || "fallback_template";
  const toolActions = normalizeToolList(candidate.tool_actions ?? candidate.tool_action);

  return {
    action_id: candidate.action_id || makeActionId(timestamp),
    session_id: candidate.session_id || state.session_id || "sess_unknown",
    timestamp,
    stage,
    intent,
    priority: normalizePriority(candidate.priority),
    source: candidate.source || "validator",
    reason_codes: Array.isArray(candidate.reason_codes) ? candidate.reason_codes : [],
    ttl_ms: typeof candidate.ttl_ms === "number" ? candidate.ttl_ms : 5000,
    throttle_key: candidate.throttle_key || intent,
    min_interval_ms:
      typeof candidate.min_interval_ms === "number" ? candidate.min_interval_ms : 0,
    tts: normalizeTts(candidate.tts),
    ui: normalizeUi(candidate.ui),
    visual_overlay: candidate.visual_overlay || null,
    haptic: candidate.haptic || null,
    tool_action: toolActions.length === 0 ? null : toolActions,
    tool_actions: toolActions,
    log_event: normalizeLogEvent(candidate.log_event, intent),
    // Preserve the optional emergency-call briefing (set on the S5 action) so it
    // survives validation/normalization and reaches the Live/HTTP response.
    ...(candidate.call_brief ? { call_brief: candidate.call_brief } : {})
  };
}

export function isIntentAllowed(action, state = {}, options = {}) {
  const stage = action.stage || state.current_stage || "S0_INIT";
  const allowed =
    options.allowedIntents ||
    state.allowed_intents ||
    getGemmaAllowedIntents(stage) ||
    [];

  if (!action.intent) {
    return false;
  }

  if (allowed.includes(action.intent)) {
    return true;
  }

  if (action.source === "state_machine" || action.source === "rule_feedback") {
    return true;
  }

  if (action.intent.startsWith("correction.") && stage === "S7_CPR_LOOP") {
    return true;
  }

  return action.source === "state_machine" && allowed.length === 0;
}

const KNOWLEDGE_FORBIDDEN_PHRASES = getForbiddenPhrases();

export function containsForbiddenSpeech(action) {
  const text = collectActionText(action);
  if (FORBIDDEN_SPEECH_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  return KNOWLEDGE_FORBIDDEN_PHRASES.some((phrase) => phrase.length > 0 && text.includes(phrase));
}

// reason code: intent_forbidden:<intent>
export function isForbiddenIntent(intent) {
  return typeof intent === "string" && KNOWLEDGE_FORBIDDEN_INTENTS.includes(intent);
}

// Tier-1 硬 Guard（仅 source=gemma_agent）：
//  - gemma_cannot_change_stage：候选携带 next_stage，或 stage 与状态机当前阶段不一致。
//  - gemma_tool_action_forbidden:<type>：gemma 来源不得创建任何工具调用（双保险）。
// 校验原始 candidate（normalizeAction 会丢弃 next_stage 等字段，故必须在归一化前取证）。
export function validateGemmaAuthorityGuards(action, candidate = {}, state = {}) {
  const violations = [];
  if (action.source !== GEMMA_SOURCE) {
    return violations;
  }

  if (ENFORCE_NO_STATE_DECISION_CHANGE && gemmaAttemptsStateDecisionChange(candidate, state)) {
    violations.push("gemma_cannot_change_stage");
  }

  if (ENFORCE_GEMMA_NO_TOOLS) {
    const tools = normalizeToolList(action.tool_actions ?? action.tool_action);
    for (const tool of tools) {
      violations.push(`gemma_tool_action_forbidden:${getToolType(tool) || "unknown"}`);
    }
  }

  return violations;
}

function gemmaAttemptsStateDecisionChange(candidate = {}, state = {}) {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  // Any attempt to set the next stage is a decision the state machine owns.
  if (candidate.next_stage != null) {
    return true;
  }

  // Smuggling a divergent stage to slip into another stage's allowed-intent set.
  const currentStage = state.current_stage || null;
  if (currentStage && typeof candidate.stage === "string" && candidate.stage !== currentStage) {
    return true;
  }

  return false;
}

// reason code: tts_exceeds_max_chars （仅 gemma 来源；按中文字符计数）
export function exceedsTtsCharLimit(action) {
  if (action.source !== GEMMA_SOURCE) {
    return false;
  }

  const limit = CRITICAL_TTS_STAGES.has(action.stage) ? CRITICAL_TTS_MAX_ZH_CHARS : TTS_MAX_ZH_CHARS;
  if (!Number.isFinite(limit) || limit <= 0) {
    return false;
  }

  return countZhChars(action.tts?.text) > limit;
}

function countZhChars(text) {
  if (typeof text !== "string") {
    return 0;
  }
  const matches = text.match(ZH_CHAR_PATTERN);
  return matches ? matches.length : 0;
}

export function validateToolActions(action, state = {}, options = {}) {
  const stage = action.stage || state.current_stage || "S0_INIT";
  const allowedTools =
    options.allowedToolTypes ||
    DEFAULT_ALLOWED_TOOL_TYPES_BY_STAGE[stage] ||
    [];
  const tools = normalizeToolList(action.tool_actions ?? action.tool_action);
  const violations = [];

  for (const tool of tools) {
    const type = getToolType(tool);
    if (!type) {
      violations.push("tool_type_missing");
      continue;
    }

    if (!allowedTools.includes(type)) {
      violations.push(`tool_not_allowed:${type}`);
    }

    if (SHARE_TOOL_TYPES.has(type) && !hasUserConfirmation(tool)) {
      violations.push(`tool_requires_user_confirmation:${type}`);
    }

    if (CONFIRMATION_REQUEST_TOOL_TYPES.has(type) && tool.requires_user_confirmation === false) {
      violations.push(`tool_confirmation_flag_missing:${type}`);
    }
  }

  return violations;
}

export function createBlockedAction(originalAction, state = {}, violations = []) {
  const needsShareConfirmation = violations.some((violation) =>
    violation.startsWith("tool_requires_user_confirmation:")
  );
  const lowPriorityBlocked = violations.includes("low_priority_interrupts_critical");
  const timestamp = new Date().toISOString();

  if (needsShareConfirmation) {
    return {
      ...baseBlockedAction(originalAction, state, timestamp, violations),
      intent: "request_share_confirmation",
      priority: "normal",
      tts: {
        text: "\u8bf7\u5148\u786e\u8ba4\u662f\u5426\u5206\u4eab\u62a5\u544a\u6216\u89c6\u9891\u3002",
        tone: "calm_firm",
        speed: "normal",
        interrupt_policy: "queue"
      },
      ui: {
        main_text: "\u9700\u8981\u4f60\u786e\u8ba4",
        secondary_text: "\u786e\u8ba4\u540e\u624d\u80fd\u5206\u4eab\u62a5\u544a\u6216\u89c6\u9891",
        status_tags: []
      }
    };
  }

  if (lowPriorityBlocked) {
    return {
      ...baseBlockedAction(originalAction, state, timestamp, violations),
      intent: "defer_to_critical_action",
      priority: "silent",
      tts: {
        text: "",
        tone: "calm_firm",
        speed: "normal",
        interrupt_policy: "never"
      },
      ui: {
        main_text: "",
        secondary_text: "",
        status_tags: []
      }
    };
  }

  return {
    ...baseBlockedAction(originalAction, state, timestamp, violations),
    intent: "fallback_template",
    priority: "normal",
    tts: {
      text: "\u6211\u4f1a\u7ee7\u7eed\u7ed9\u4f60\u4e00\u6b65\u4e00\u6b65\u63d0\u793a\u3002",
      tone: "calm_firm",
      speed: "normal",
      interrupt_policy: "queue"
    },
    ui: {
      main_text: "\u7ee7\u7eed\u6309\u63d0\u793a\u64cd\u4f5c",
      secondary_text: "\u4fdd\u6301\u51b7\u9759\uff0c\u4e00\u6b65\u4e00\u6b65\u6765",
      status_tags: []
    }
  };
}

function baseBlockedAction(originalAction, state, timestamp, violations) {
  return {
    action_id: makeActionId(timestamp),
    session_id: originalAction.session_id || state.session_id || "sess_unknown",
    timestamp,
    stage: originalAction.stage || state.current_stage || "S0_INIT",
    source: "action_validator",
    reason_codes: ["validator_blocked", ...violations],
    ttl_ms: 3000,
    throttle_key: "validator.blocked",
    min_interval_ms: 0,
    visual_overlay: null,
    haptic: null,
    tool_action: null,
    tool_actions: [],
    log_event: {
      type: "action_blocked",
      detail: violations.join(",")
    }
  };
}

function isLowerPriorityInterruptingCritical(action, state = {}) {
  const activePriority = normalizePriority(state.action_control?.active_priority);
  if (activePriority !== "critical") {
    return false;
  }

  const rank = PRIORITY_RANK[action.priority] ?? PRIORITY_RANK.normal;
  const interruptPolicy = action.tts?.interrupt_policy || action.interrupt_policy || "queue";
  return rank < PRIORITY_RANK.critical && interruptPolicy !== "never";
}

function normalizeTts(tts = {}) {
  return {
    text: typeof tts.text === "string" ? tts.text : "",
    tone: tts.tone || "calm_firm",
    speed: tts.speed || "normal",
    interrupt_policy: tts.interrupt_policy || "queue"
  };
}

function normalizeUi(ui = {}) {
  return {
    main_text: typeof ui.main_text === "string" ? ui.main_text : "",
    secondary_text: typeof ui.secondary_text === "string" ? ui.secondary_text : "",
    status_tags: Array.isArray(ui.status_tags) ? ui.status_tags : [],
    quality_score: ui.quality_score ?? null,
    primary_action: ui.primary_action ?? null
  };
}

function normalizeLogEvent(logEvent, intent) {
  if (logEvent && typeof logEvent === "object") {
    return {
      type: logEvent.type || intent,
      detail: logEvent.detail || intent
    };
  }

  return {
    type: intent,
    detail: intent
  };
}

function normalizePriority(priority) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, priority) ? priority : "normal";
}

function normalizeToolList(toolAction) {
  if (!toolAction) {
    return [];
  }

  return Array.isArray(toolAction) ? toolAction : [toolAction];
}

function getToolType(tool) {
  if (!tool || typeof tool !== "object") {
    return "";
  }

  return tool.type || tool.tool || tool.name || "";
}

function hasUserConfirmation(tool) {
  return (
    tool.requires_user_confirmation === true &&
    (tool.user_confirmed === true ||
      tool.confirmed_by_user === true ||
      tool.confirmation?.confirmed === true)
  );
}

function collectActionText(action) {
  return [
    action.tts?.text,
    action.ui?.main_text,
    action.ui?.secondary_text,
    ...(Array.isArray(action.ui?.status_tags) ? action.ui.status_tags : [])
  ]
    .filter((item) => typeof item === "string")
    .join("\n");
}

function makeActionId(timestamp) {
  const compactTime = String(Date.parse(timestamp) || Date.now()).slice(-8);
  return `act_${compactTime}_${Math.random().toString(36).slice(2, 8)}`;
}
