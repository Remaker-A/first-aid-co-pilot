import { DEFAULT_ALLOWED_INTENTS_BY_STAGE } from "./decisionFrame.js";
import { parseGemmaResponse } from "./responseParser.js";

const STAGE_FALLBACKS = Object.freeze({
  S1_SCENE_SAFE: {
    intent: "ask_scene_safety",
    text: "\u5148\u786e\u4fdd\u81ea\u8eab\u5b89\u5168\u3002",
    main: "\u786e\u4fdd\u5b89\u5168",
    secondary: "\u53ef\u4ee5\u63a5\u8fd1\u540e\u518d\u7ee7\u7eed"
  },
  S2_CHECK_RESPONSE: {
    intent: "ask_response_check",
    text: "\u8bf7\u5927\u58f0\u53eb\u4ed6\uff0c\u5e76\u8f7b\u62cd\u53cc\u80a9\u3002",
    main: "\u68c0\u67e5\u53cd\u5e94",
    secondary: "\u5927\u58f0\u547c\u53eb\u5e76\u8f7b\u62cd\u53cc\u80a9"
  },
  S3_CHECK_BREATHING: {
    intent: "ask_breathing_check",
    text: "\u8bf7\u770b\u80f8\u53e3 5 \u5230 10 \u79d2\u3002",
    main: "\u68c0\u67e5\u547c\u5438",
    secondary: "\u89c2\u5bdf\u80f8\u53e3\u662f\u5426\u6b63\u5e38\u8d77\u4f0f"
  },
  S4_SUSPECTED_ARREST: {
    intent: "state_suspected_arrest_handling",
    text: "\u8bf7\u6309\u7591\u4f3c\u5fc3\u810f\u9aa4\u505c\u5904\u7406\u3002",
    main: "\u7591\u4f3c\u5fc3\u810f\u9aa4\u505c",
    secondary: "\u51c6\u5907\u547c\u53eb 120 \u5e76\u5f00\u59cb CPR"
  },
  S5_CALL_EMERGENCY: {
    intent: "explain_call_status",
    text: "\u6211\u5c06\u4e3a\u4f60\u62e8\u6253 120\u3002",
    main: "\u547c\u53eb 120",
    secondary: "\u4fdd\u6301\u624b\u673a\u514d\u63d0"
  },
  S6_CPR_READY: {
    intent: "guide_cpr_position",
    text: "\u53cc\u624b\u638c\u6839\u653e\u5728\u80f8\u53e3\u4e2d\u592e\u3002",
    main: "\u80f8\u53e3\u4e2d\u592e",
    secondary: "\u53cc\u624b\u638c\u6839\u6309\u538b"
  },
  S7_CPR_LOOP: {
    intent: "defer_to_rule_feedback",
    text: "",
    main: "",
    secondary: ""
  },
  S8_ASSISTANCE: {
    intent: "calm_rescuer",
    text: "\u7ee7\u7eed\u6309\u538b\uff0c\u6211\u4f1a\u6301\u7eed\u63d0\u793a\u3002",
    main: "\u7ee7\u7eed\u6309\u538b",
    secondary: "\u6309\u8282\u594f\u4fdd\u6301\u52a8\u4f5c"
  },
  S9_HANDOVER: {
    intent: "explain_handover",
    text: "\u6211\u4f1a\u663e\u793a\u4ea4\u63a5\u62a5\u544a\u3002",
    main: "\u4ea4\u63a5\u62a5\u544a",
    secondary: "\u5411\u6025\u6551\u5458\u5c55\u793a\u5173\u952e\u4fe1\u606f"
  }
});

const POSITION_QUERY = /(\u6309\u54ea|\u54ea\u91cc|\u4f4d\u7f6e|\u80f8\u53e3)/u;
const ANXIETY_QUERY = /(\u5bb3\u6015|\u6015|\u505a\u4e0d\u597d|\u614c)/u;
const BREATHING_UNCERTAIN_QUERY = /(\u547c\u5438|\u5598|\u6ca1\u6c14|\u4e0d\u786e\u5b9a)/u;

export class GemmaFallbackPolicy {
  constructor({ maxConsecutiveFailures = 2 } = {}) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.consecutiveFailures = 0;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
  }

  recordFailure() {
    this.consecutiveFailures += 1;
    return this.consecutiveFailures;
  }

  shouldUsePureStateMachineMode() {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  parseOrFallback(raw, frame, options = {}) {
    const parsed = parseGemmaResponse(raw, frame, options);
    if (parsed.ok) {
      this.recordSuccess();
      return parsed;
    }

    this.recordFailure();
    return {
      ok: true,
      patch: createGemmaFallbackPatch(frame, parsed.error),
      fallback: true,
      violations: parsed.violations
    };
  }
}

export function runLocalGemmaFallback(frame, { rawModelOutput } = {}) {
  if (rawModelOutput !== undefined) {
    const parsed = parseGemmaResponse(rawModelOutput, frame);
    if (parsed.ok) {
      return {
        ok: true,
        patch: parsed.patch,
        source: "parsed_mock_output"
      };
    }
  }

  return {
    ok: true,
    patch: createGemmaFallbackPatch(frame, "local_mock_fallback"),
    source: "local_fallback"
  };
}

export function createGemmaFallbackPatch(frame = {}, reason = "fallback_template") {
  const stage = frame.current_stage || "S0_INIT";
  const text = frame.user_input?.stt_text || "";
  const allowed = new Set(
    Array.isArray(frame.allowed_intents)
      ? frame.allowed_intents
      : DEFAULT_ALLOWED_INTENTS_BY_STAGE[stage] || []
  );
  const template = chooseTemplate(stage, text, allowed);
  const intent = allowed.has(template.intent) ? template.intent : "fallback_template";
  const canSpeak = intent !== "fallback_template" || allowed.has("fallback_template");

  return {
    intent,
    tts: {
      text: canSpeak ? template.text : "",
      tone: template.tone || "calm_firm",
      speed: "normal"
    },
    ui: {
      main_text: canSpeak ? template.main : "",
      secondary_text: canSpeak ? template.secondary : ""
    },
    visual_overlay: template.visual_overlay || {
      mode: null,
      highlight_target: null,
      correction_arrow: null
    },
    log_suggestion: {
      type: "gemma_fallback",
      detail: reason
    },
    reason,
    confidence: 0.6
  };
}

export function isPureStateMachineMode(policy) {
  return Boolean(policy?.shouldUsePureStateMachineMode?.());
}

function chooseTemplate(stage, text, allowed) {
  if (stage === "S6_CPR_READY" && POSITION_QUERY.test(text)) {
    return {
      intent: allowed.has("answer_position_question")
        ? "answer_position_question"
        : "guide_cpr_position",
      text: "\u53cc\u624b\u638c\u6839\u653e\u5728\u80f8\u53e3\u4e2d\u592e\u3002",
      main: "\u80f8\u53e3\u4e2d\u592e",
      secondary: "\u53cc\u624b\u638c\u6839\u6309\u538b",
      visual_overlay: {
        mode: "prepare_cpr_position",
        highlight_target: "chest_center",
        correction_arrow: null
      }
    };
  }

  if ((stage === "S7_CPR_LOOP" || stage === "S8_ASSISTANCE") && ANXIETY_QUERY.test(text)) {
    return {
      intent: allowed.has("calm_rescuer") ? "calm_rescuer" : "encourage_rescuer",
      text: "\u4f60\u505a\u5f97\u5f88\u597d\uff0c\u7ee7\u7eed\u8ddf\u7740\u8282\u594f\u3002",
      main: "\u7ee7\u7eed\u6309\u538b",
      secondary: "\u8ddf\u7740\u9707\u52a8\u8282\u594f",
      tone: "calm_soft"
    };
  }

  if (stage === "S3_CHECK_BREATHING" && BREATHING_UNCERTAIN_QUERY.test(text)) {
    return {
      intent: allowed.has("parse_breathing_answer")
        ? "parse_breathing_answer"
        : "clarify_breathing",
      text: "\u5982\u679c\u4e0d\u786e\u5b9a\uff0c\u8bf7\u6309\u6ca1\u6709\u6b63\u5e38\u547c\u5438\u5904\u7406\u3002",
      main: "\u547c\u5438\u4e0d\u786e\u5b9a",
      secondary: "\u6309\u65e0\u6b63\u5e38\u547c\u5438\u5904\u7406"
    };
  }

  return STAGE_FALLBACKS[stage] || {
    intent: "fallback_template",
    text: "",
    main: "",
    secondary: "",
    tone: "calm_soft"
  };
}
