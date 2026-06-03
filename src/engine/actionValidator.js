import { getForbiddenPhrases, getGemmaAllowedIntents } from "../knowledge/knowledgeBase.js";

const PRIORITY_RANK = Object.freeze({
  silent: 0,
  low: 1,
  normal: 2,
  high: 3,
  critical: 4
});

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

  if (!isIntentAllowed(action, state, options)) {
    violations.push(`intent_not_allowed:${action.intent || ""}`);
  }

  if (isLowerPriorityInterruptingCritical(action, state)) {
    violations.push("low_priority_interrupts_critical");
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
    log_event: normalizeLogEvent(candidate.log_event, intent)
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
