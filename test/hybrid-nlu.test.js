import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentStage,
  createIntentNluFrame,
  createVoiceDemoService,
  parseGemmaNluResponse,
  resolveUserIntent,
  sessionReducer,
  shouldEscalateToNlu,
} from "../src/index.js";

test("NLU parser accepts closed-set slots and clamps confidence", () => {
  const parsed = parseGemmaNluResponse(
    JSON.stringify({
      intent: "no_normal_breathing",
      slots: {
        normal_breathing: { value: false, confidence: 1.4 },
      },
      overall_confidence: 0.91,
      needs_clarification: false,
    }),
    nluFrame(AgentStage.S3_CHECK_BREATHING),
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.intent, "no_normal_breathing");
  assert.deepEqual(parsed.slots.normal_breathing, { value: false, confidence: 1 });
});

test("NLU parser rejects out-of-contract decisions and unknown slots", () => {
  const parsed = parseGemmaNluResponse(
    JSON.stringify({
      intent: "declare_cardiac_arrest",
      next_stage: AgentStage.S4_SUSPECTED_ARREST,
      suspected_cardiac_arrest: true,
      slots: {
        suspected_cardiac_arrest: { value: true, confidence: 0.99 },
      },
      overall_confidence: 0.95,
      needs_clarification: false,
    }),
    nluFrame(AgentStage.S3_CHECK_BREATHING),
  );

  assert.equal(parsed.ok, false);
  assert.ok(parsed.violations.includes("forbidden_intent:declare_cardiac_arrest"));
  assert.ok(parsed.violations.includes("disallowed_field:next_stage"));
  assert.ok(parsed.violations.includes("disallowed_field:suspected_cardiac_arrest"));
  assert.ok(parsed.violations.includes("slot_not_allowed:suspected_cardiac_arrest"));
});

test("NLU parser gates low-confidence CPR-trigger slots to unknown", () => {
  const parsed = parseGemmaNluResponse(
    JSON.stringify({
      intent: "no_normal_breathing",
      slots: {
        normal_breathing: { value: false, confidence: 0.4 },
      },
      overall_confidence: 0.7,
      needs_clarification: true,
    }),
    nluFrame(AgentStage.S3_CHECK_BREATHING),
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.slots.normal_breathing, { value: null, confidence: 0.4 });
  assert.ok(parsed.warnings.includes("slot_below_confidence_floor:normal_breathing"));
});

test("intent resolver keeps clear regex answers on the fast path", async () => {
  let nluCalls = 0;
  const resolved = await resolveUserIntent({
    transcript: "他没有反应",
    stage: AgentStage.S2_CHECK_RESPONSE,
    runtime: {
      async parseUserIntent() {
        nluCalls += 1;
        return { ok: false };
      },
    },
    options: { intentNlu: true },
  });

  assert.equal(nluCalls, 0);
  assert.equal(resolved.intent, "patient_unresponsive");
  assert.equal(resolved.source, "stt");
  assert.equal(resolved.escalated, false);
});

test("intent resolver escalates fuzzy misses to Gemma NLU", async () => {
  const escalation = shouldEscalateToNlu({
    transcript: "他好像没气了",
    stage: AgentStage.S3_CHECK_BREATHING,
    options: { intentNlu: true },
  });
  assert.equal(escalation.escalate, true);

  const resolved = await resolveUserIntent({
    transcript: "他好像没气了",
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime: {
      async parseUserIntent() {
        return {
          ok: true,
          intent: "no_normal_breathing",
          slots: {
            normal_breathing: { value: false, confidence: 0.9 },
          },
          confidence: 0.88,
          needs_clarification: false,
        };
      },
    },
    options: { intentNlu: true },
  });

  assert.equal(resolved.intent, "no_normal_breathing");
  assert.equal(resolved.source, "gemma_nlu");
  assert.equal(resolved.slots.normal_breathing.value, false);
});

test("gemma_nlu facts conflict with vision through the existing reducer path", () => {
  const initial = sessionReducer(null, {
    event_id: "evt_vision",
    session_id: "sess_conflict",
    timestamp: "2026-06-04T12:00:00.000Z",
    source: "vision_patient",
    event_type: "breathing_update",
    patient_state: {
      normal_breathing: true,
      normal_breathing_confidence: 0.86,
    },
  });

  const conflicted = sessionReducer(initial, {
    event_id: "evt_nlu",
    session_id: "sess_conflict",
    timestamp: "2026-06-04T12:00:01.000Z",
    source: "stt",
    event_type: "breathing_update",
    user_input: {
      stt_text: "他好像没气了",
      intent: "clarify_breathing",
      confidence: 0.88,
      source: "gemma_nlu",
    },
    patient_state: {
      normal_breathing: false,
      normal_breathing_confidence: 0.88,
      normal_breathing_source: "gemma_nlu",
    },
  });

  assert.equal(conflicted.confirmed_facts.recheck_required, true);
  assert.equal(conflicted.confirmed_facts.conflicts.length, 1);
  assert.equal(conflicted.confirmed_facts.conflicts[0].existing_source, "vision_patient");
  assert.equal(conflicted.confirmed_facts.conflicts[0].incoming_source, "gemma_nlu");
});

test("voice service uses NLU observation facts but state machine owns suspected arrest", async () => {
  const service = createVoiceDemoService({
    runtime: nluRuntime({
      "他好像没气了": {
        intent: "no_normal_breathing",
        slots: {
          normal_breathing: { value: false, confidence: 0.9 },
        },
        confidence: 0.88,
      },
    }),
    tts: { provider: "mock" },
    intentNlu: true,
  });
  const sessionId = "sess_nlu_e2e";

  await service.handleTurn({ sessionId, text: "现场安全了" });
  await service.handleTurn({ sessionId, text: "他没有反应" });
  const result = await service.handleTurn({ sessionId, text: "他好像没气了" });

  assert.equal(result.intent_resolution.source, "gemma_nlu");
  assert.equal(result.event.user_input.intent, "no_normal_breathing");
  assert.equal(result.event.patient_state.normal_breathing, false);
  assert.equal(result.event.patient_state.normal_breathing_source, "gemma_nlu");
  assert.equal(result.state.current_stage, AgentStage.S4_SUSPECTED_ARREST);
  assert.equal(result.state.confirmed_facts.suspected_cardiac_arrest, true);
  assert.equal(result.guidance_action.intent, "state_suspected_arrest_handling");
});

test("low-confidence NLU breathing fact stays in stage and asks again", async () => {
  const service = createVoiceDemoService({
    runtime: nluRuntime({
      "他好像没气了": {
        intent: "no_normal_breathing",
        slots: {
          normal_breathing: { value: false, confidence: 0.4 },
        },
        confidence: 0.62,
        needs_clarification: true,
      },
    }),
    tts: { provider: "mock" },
    intentNlu: true,
  });
  const sessionId = "sess_nlu_low_confidence";

  await service.handleTurn({ sessionId, text: "现场安全了" });
  await service.handleTurn({ sessionId, text: "他没有反应" });
  const result = await service.handleTurn({ sessionId, text: "他好像没气了" });

  assert.equal(result.intent_resolution.intent, "clarify_breathing");
  assert.equal(result.event.patient_state.normal_breathing, null);
  assert.equal(result.event.patient_state.normal_breathing_confidence, 0.4);
  assert.equal(result.state.current_stage, AgentStage.S3_CHECK_BREATHING);
  assert.equal(result.state.confirmed_facts.suspected_cardiac_arrest, false);
  assert.equal(result.guidance_action.intent, "ask_breathing_check");
});

test("low-confidence unknown observation does not erase a confirmed breathing fact", () => {
  const confirmed = sessionReducer(null, {
    event_id: "evt_confirm_breathing",
    session_id: "sess_null_guard",
    timestamp: "2026-06-04T12:00:00.000Z",
    source: "vision_patient",
    event_type: "breathing_update",
    patient_state: { normal_breathing: false, normal_breathing_confidence: 0.9 },
  });
  assert.equal(confirmed.confirmed_facts.normal_breathing, false);

  const afterFuzzy = sessionReducer(confirmed, {
    event_id: "evt_fuzzy_unknown",
    session_id: "sess_null_guard",
    timestamp: "2026-06-04T12:00:02.000Z",
    source: "stt",
    event_type: "breathing_update",
    user_input: {
      stt_text: "我也说不好",
      intent: "clarify_breathing",
      confidence: 0.4,
      source: "gemma_nlu",
    },
    patient_state: {
      normal_breathing: null,
      normal_breathing_confidence: 0.4,
      normal_breathing_source: "gemma_nlu",
    },
  });

  assert.equal(afterFuzzy.confirmed_facts.normal_breathing, false);
  assert.equal(afterFuzzy.confirmed_facts.normal_breathing_source, "vision_patient");
});

test("NLU parser rejects corrupt decoded reason text", () => {
  const parsed = parseGemmaNluResponse(
    JSON.stringify({
      intent: "no_normal_breathing",
      slots: { normal_breathing: { value: false, confidence: 0.9 } },
      overall_confidence: 0.9,
      needs_clarification: false,
      reason: "锟斤拷锟斤拷",
    }),
    nluFrame(AgentStage.S3_CHECK_BREATHING),
  );

  assert.equal(parsed.ok, false);
  assert.ok(parsed.violations.includes("corrupt_text"));
});

test("S4 NLU frame exposes breathing slots from the shared knowledge config", () => {
  const frame = createIntentNluFrame({
    transcript: "他还是没有喘气",
    stage: AgentStage.S4_SUSPECTED_ARREST,
    options: {},
  });

  assert.ok(frame.allowed_slots.includes("normal_breathing"));
  assert.ok(frame.allowed_slots.includes("agonal_breathing"));
  assert.ok(frame.allowed_intents.includes("clarify_breathing"));
});

function nluFrame(stage) {
  return {
    current_stage: stage,
    allowed_intents: [
      "normal_breathing",
      "no_normal_breathing",
      "normal_breathing_absent",
      "normal_breathing_present",
      "agonal_breathing",
      "clarify_breathing",
    ],
    allowed_slots: {
      normal_breathing: { type: "boolean", cpr_trigger_value: false },
      agonal_breathing: { type: "boolean", cpr_trigger_value: true },
    },
    slot_confidence: {
      default_floor: 0.6,
      cpr_trigger_floor: 0.78,
    },
  };
}

function nluRuntime(byTranscript) {
  return {
    async parseUserIntent(frame) {
      const result = byTranscript[frame.user_input?.stt_text] || byTranscript[frame.transcript];
      if (!result) {
        return { ok: false, reason: "unexpected_transcript" };
      }
      return {
        ok: true,
        needs_clarification: false,
        ...result,
      };
    },
    async generatePatch(frame) {
      const intent = frame.allowed_intents?.[0] || "fallback_template";
      return {
        ok: true,
        patch: {
          intent,
          tts: {
            text: "请按当前步骤继续。",
            tone: "calm_firm",
            speed: "normal",
          },
          ui: {
            main_text: "继续",
            secondary_text: "按提示操作",
          },
          visual_overlay: {
            mode: null,
            highlight_target: null,
            correction_arrow: null,
          },
          log_suggestion: {
            type: "test",
            detail: "test",
          },
          reason: "test_runtime",
          confidence: 0.8,
        },
        violations: [],
      };
    },
  };
}
