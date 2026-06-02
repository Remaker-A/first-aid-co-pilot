import { SPECIAL_GEMMA_INTENTS } from "./decisionFrame.js";

const DISALLOWED_TOP_LEVEL_KEYS = Object.freeze([
  "action_id",
  "session_id",
  "timestamp",
  "stage",
  "next_stage",
  "priority",
  "source",
  "tool_action",
  "tool_actions",
  "haptic",
  "ttl_ms",
  "throttle_key",
  "min_interval_ms",
  "interrupt_policy"
]);

const VALID_TONES = new Set(["calm_firm", "calm_soft", "urgent"]);
const VALID_SPEEDS = new Set(["normal", "slow"]);
const VALID_ARROWS = new Set(["left", "right", "up", "down", null]);
const PATCH_WRAPPER_KEYS = Object.freeze(["GuidanceActionPatch", "patch", "action"]);
const CORRUPT_TEXT_PATTERN = /\uFFFD|(?:[\u00C2-\u00C3][\u0080-\u00BF]?)/u;

export function parseGemmaResponse(raw, frameOrOptions = {}, maybeOptions = {}) {
  const { frame, options } = splitFrameAndOptions(frameOrOptions, maybeOptions);
  const allowedIntents = new Set([
    ...(Array.isArray(frame.allowed_intents) ? frame.allowed_intents : []),
    ...SPECIAL_GEMMA_INTENTS
  ]);
  const violations = [];
  const text = coerceModelText(raw);
  const jsonText = extractFirstJsonObject(text);

  if (!jsonText) {
    return parseFailure("json_not_found", ["Model output did not contain a JSON object."]);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return parseFailure("json_parse_failed", [error.message]);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parseFailure("json_not_object", ["Model output must be one JSON object."]);
  }

  violations.push(...findDisallowedTopLevelFields(parsed));

  const patchCandidate = unwrapPatchCandidate(parsed);
  if (!patchCandidate || typeof patchCandidate !== "object" || Array.isArray(patchCandidate)) {
    return parseFailure("json_not_object", ["Model output patch must be one JSON object."]);
  }

  violations.push(...findDisallowedTopLevelFields(patchCandidate));

  const patch = normalizePatch(patchCandidate);

  if (!patch.intent) {
    violations.push("missing_intent");
  } else if (allowedIntents.size > 0 && !allowedIntents.has(patch.intent)) {
    violations.push(`intent_not_allowed:${patch.intent}`);
  }

  if (!VALID_TONES.has(patch.tts.tone)) {
    violations.push(`invalid_tone:${patch.tts.tone}`);
  }

  if (!VALID_SPEEDS.has(patch.tts.speed)) {
    violations.push(`invalid_speed:${patch.tts.speed}`);
  }

  if (!VALID_ARROWS.has(patch.visual_overlay.correction_arrow)) {
    violations.push(`invalid_correction_arrow:${patch.visual_overlay.correction_arrow}`);
  }

  if (typeof patch.confidence !== "number" || Number.isNaN(patch.confidence)) {
    violations.push("invalid_confidence");
  }

  if (containsCorruptText(patch)) {
    violations.push("corrupt_text");
  }

  if (violations.length > 0 && options.strict !== false) {
    return {
      ok: false,
      error: "patch_validation_failed",
      patch,
      violations
    };
  }

  return {
    ok: true,
    patch,
    violations
  };
}

export function extractFirstJsonObject(text) {
  if (typeof text !== "string") {
    return null;
  }

  const stripped = stripCodeFence(text.trim());
  const start = stripped.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function normalizePatch(value = {}) {
  const visualOverlay = value.visual_overlay || {};
  const logSuggestion = value.log_suggestion || {};
  const confidence = Number(value.confidence);
  const intent =
    typeof value.intent === "string"
      ? value.intent
      : typeof value.action === "string"
        ? value.action
        : "";

  return {
    intent,
    tts: {
      text: typeof value.tts?.text === "string" ? value.tts.text : "",
      tone: typeof value.tts?.tone === "string" ? value.tts.tone : "calm_firm",
      speed: typeof value.tts?.speed === "string" ? value.tts.speed : "normal"
    },
    ui: {
      main_text: typeof value.ui?.main_text === "string" ? value.ui.main_text : "",
      secondary_text:
        typeof value.ui?.secondary_text === "string" ? value.ui.secondary_text : ""
    },
    visual_overlay: {
      mode: visualOverlay.mode ?? null,
      highlight_target: visualOverlay.highlight_target ?? null,
      correction_arrow: visualOverlay.correction_arrow ?? null
    },
    log_suggestion: {
      type: typeof logSuggestion.type === "string" ? logSuggestion.type : "",
      detail: typeof logSuggestion.detail === "string" ? logSuggestion.detail : ""
    },
    reason: typeof value.reason === "string" ? value.reason : "no_reason",
    confidence: clamp(Number.isFinite(confidence) ? confidence : 0.5, 0, 1)
  };
}

function splitFrameAndOptions(frameOrOptions, maybeOptions) {
  if (frameOrOptions && Array.isArray(frameOrOptions.allowed_intents)) {
    return {
      frame: frameOrOptions,
      options: maybeOptions || {}
    };
  }

  return {
    frame: frameOrOptions.frame || {},
    options: frameOrOptions || {}
  };
}

function coerceModelText(raw) {
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

function unwrapPatchCandidate(parsed) {
  for (const key of PATCH_WRAPPER_KEYS) {
    const wrapped = parsed[key];
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      return wrapped;
    }
  }

  return parsed;
}

function findDisallowedTopLevelFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return DISALLOWED_TOP_LEVEL_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => `disallowed_field:${key}`);
}

function containsCorruptText(patch) {
  return [
    patch.tts?.text,
    patch.ui?.main_text,
    patch.ui?.secondary_text,
    patch.log_suggestion?.type,
    patch.log_suggestion?.detail,
    patch.reason
  ]
    .filter((item) => typeof item === "string")
    .some((item) => CORRUPT_TEXT_PATTERN.test(item));
}

function stripCodeFence(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseFailure(error, violations) {
  return {
    ok: false,
    error,
    patch: null,
    violations
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
