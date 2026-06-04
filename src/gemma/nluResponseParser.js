import {
  getForbiddenIntents,
  getNluAllowedIntents,
  getNluConfidenceFloors,
  getNluSlotSchema
} from "../knowledge/knowledgeBase.js";
import { extractFirstJsonObject } from "./responseParser.js";

const DISALLOWED_OUTPUT_FIELDS = new Set([
  "action",
  "actions",
  "action_id",
  "current_stage",
  "decision",
  "diagnosis",
  "diagnosis_result",
  "diagnostic_result",
  "guidance",
  "haptic",
  "interrupt_policy",
  "log_suggestion",
  "next_stage",
  "priority",
  "source",
  "stage",
  "suspected_cardiac_arrest",
  "throttle_key",
  "tool_action",
  "tool_actions",
  "tts",
  "ui",
  "visual_overlay"
]);

const CORRUPT_TEXT_PATTERN =
  /\uFFFD|锟斤拷|(?:[\u00C2-\u00C3][\u0080-\u00BF]?)|(?:[ÃÂ][\u0080-\u00FF])/u;

export function parseGemmaNluResponse(raw, frameOrOptions = {}, maybeOptions = {}) {
  const { frame, options } = splitFrameAndOptions(frameOrOptions, maybeOptions);
  const violations = [];
  const warnings = [];
  const jsonText = extractFirstJsonObject(coerceModelText(raw));

  if (!jsonText) {
    return parseFailure("json_not_found", ["Model output did not contain a JSON object."]);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return parseFailure("json_parse_failed", [error.message]);
  }

  if (!isPlainObject(parsed)) {
    return parseFailure("json_not_object", ["Model output must be one JSON object."]);
  }

  violations.push(...findDisallowedFields(parsed));
  if (containsCorruptText(parsed)) {
    violations.push("corrupt_text");
  }

  const stage = frame.current_stage || "S0_INIT";
  const allowedIntents = new Set([
    ...(Array.isArray(frame.allowed_intents) ? frame.allowed_intents : []),
    ...getNluAllowedIntents(stage)
  ]);
  const forbiddenIntents = new Set([
    ...getForbiddenIntents(),
    ...(Array.isArray(frame.forbidden_intents) ? frame.forbidden_intents : [])
  ]);
  const slotsSchema = normalizeSlotSchema(frame.slots_schema || frame.allowed_slots || getNluSlotSchema(stage));
  const confidenceFloors = {
    ...getNluConfidenceFloors(),
    ...(isPlainObject(frame.confidence_floors) ? frame.confidence_floors : {})
  };

  const intent = normalizeIntent(parsed.intent);
  if (!intent) {
    violations.push("missing_intent");
  } else if (forbiddenIntents.has(intent)) {
    violations.push(`forbidden_intent:${intent}`);
  } else if (allowedIntents.size > 0 && !allowedIntents.has(intent)) {
    violations.push(`intent_not_allowed:${intent}`);
  }

  if (parsed.slots !== undefined && !isPlainObject(parsed.slots)) {
    violations.push("slots_not_object");
  }

  const normalizedSlots = normalizeSlots(parsed.slots || {}, slotsSchema, confidenceFloors, {
    violations,
    warnings
  });
  const acceptedConfidences = Object.values(normalizedSlots)
    .filter((slot) => isPlainObject(slot))
    .map((slot) => slot.confidence);
  const overallConfidence = normalizeOverallConfidence(parsed.overall_confidence ?? parsed.confidence, acceptedConfidences, {
    violations
  });
  const needsClarification =
    normalizeNeedsClarification(parsed.needs_clarification, { violations }) ||
    acceptedConfidences.length === 0 ||
    overallConfidence < confidenceFloors.overall_floor;

  if (overallConfidence < confidenceFloors.overall_floor) {
    warnings.push(`overall_confidence_below_floor:${overallConfidence}`);
  }

  const result = {
    intent,
    slots: normalizedSlots,
    overall_confidence: overallConfidence,
    confidence: overallConfidence,
    needs_clarification: needsClarification,
    reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "no_reason"
  };

  if (violations.length > 0 && options.strict !== false) {
    return { ok: false, error: "nlu_validation_failed", ...result, result, nlu: result, violations, warnings };
  }

  return { ok: true, source: "gemma_nlu", ...result, result, nlu: result, violations, warnings };
}

export const parseNluResponse = parseGemmaNluResponse;

function normalizeSlots(slots, slotsSchema, confidenceFloors, report) {
  const normalized = {};
  const allowedSlotNames = new Set(Object.keys(slotsSchema));

  for (const slotName of Object.keys(slots || {})) {
    if (!allowedSlotNames.has(slotName)) {
      report.violations.push(`slot_not_allowed:${slotName}`);
    }
  }

  for (const [slotName, definition] of Object.entries(slotsSchema)) {
    const rawSlot = slots?.[slotName];
    if (rawSlot == null) {
      normalized[slotName] = null;
      continue;
    }
    if (!isPlainObject(rawSlot)) {
      report.violations.push(`invalid_slot_payload:${slotName}`);
      normalized[slotName] = null;
      continue;
    }

    const value = rawSlot.value;
    if (!isValidSlotValue(value, definition)) {
      report.violations.push(`invalid_slot_value:${slotName}`);
      normalized[slotName] = null;
      continue;
    }
    if (typeof rawSlot.confidence !== "number" || !Number.isFinite(rawSlot.confidence)) {
      report.violations.push(`invalid_slot_confidence:${slotName}`);
      normalized[slotName] = null;
      continue;
    }

    const confidence = clamp(rawSlot.confidence, 0, 1);
    const floor = resolveSlotFloor(definition, value, confidenceFloors);
    if (confidence < floor) {
      report.warnings.push(`slot_below_floor:${slotName}:${confidence}`);
      report.warnings.push(`slot_below_confidence_floor:${slotName}`);
      normalized[slotName] = { value: null, confidence };
      continue;
    }

    normalized[slotName] = { value, confidence };
  }

  return normalized;
}

function isValidSlotValue(value, definition) {
  if (definition.type === "enum") {
    return Array.isArray(definition.values) && definition.values.includes(value);
  }
  return typeof value === "boolean";
}

function resolveSlotFloor(definition, value, confidenceFloors) {
  if (
    Object.prototype.hasOwnProperty.call(definition, "cpr_trigger_value") &&
    definition.cpr_trigger_value === value
  ) {
    return confidenceFloors.cpr_trigger_floor;
  }
  if (typeof definition.floor === "string" && Number.isFinite(confidenceFloors[definition.floor])) {
    return confidenceFloors[definition.floor];
  }
  return confidenceFloors.default_floor;
}

function normalizeOverallConfidence(value, acceptedConfidences, report) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(value, 0, 1);
  }
  if (value !== undefined) {
    report.violations.push("invalid_overall_confidence");
  }
  return acceptedConfidences.length > 0 ? Math.max(...acceptedConfidences) : 0;
}

function normalizeNeedsClarification(value, report) {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    report.violations.push("invalid_needs_clarification");
    return true;
  }
  return value;
}

function normalizeIntent(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSlotSchema(slotsSchema) {
  if (Array.isArray(slotsSchema)) {
    return Object.fromEntries(slotsSchema.map((slotName) => [slotName, { type: "boolean" }]));
  }

  if (!isPlainObject(slotsSchema)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(slotsSchema)
      .filter(([, definition]) => isPlainObject(definition) || typeof definition === "string")
      .map(([slotName, definition]) => [
        slotName,
        {
          type: definition.type === "enum" ? "enum" : "boolean",
          values: Array.isArray(definition.values) ? [...definition.values] : [],
          floor: typeof definition.floor === "string" ? definition.floor : undefined,
          cpr_trigger_value: definition.cpr_trigger_value
        }
      ])
  );
}

function splitFrameAndOptions(frameOrOptions = {}, maybeOptions = {}) {
  if (
    frameOrOptions &&
    (Array.isArray(frameOrOptions.allowed_intents) ||
      isPlainObject(frameOrOptions.slots_schema) ||
      isPlainObject(frameOrOptions.allowed_slots))
  ) {
    return { frame: frameOrOptions, options: maybeOptions || {} };
  }
  return { frame: frameOrOptions.frame || {}, options: frameOrOptions || {} };
}

function coerceModelText(raw) {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw.text === "string") return raw.text;
  if (raw && typeof raw.content === "string") return raw.content;
  return "";
}

function findDisallowedFields(value, path = []) {
  if (!value || typeof value !== "object") {
    return [];
  }
  const violations = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (DISALLOWED_OUTPUT_FIELDS.has(key)) {
      violations.push(`disallowed_field:${childPath.join(".")}`);
    }
    if (child && typeof child === "object") {
      violations.push(...findDisallowedFields(child, childPath));
    }
  }
  return violations;
}

function containsCorruptText(value) {
  if (typeof value === "string") return CORRUPT_TEXT_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsCorruptText);
  if (value && typeof value === "object") return Object.values(value).some(containsCorruptText);
  return false;
}

function parseFailure(error, violations) {
  return { ok: false, error, result: null, nlu: null, violations, warnings: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
