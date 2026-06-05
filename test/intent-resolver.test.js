import assert from "node:assert/strict";
import test from "node:test";
import { AgentStage, resolveUserIntent, shouldEscalateToNlu } from "../src/index.js";

test("intent resolver keeps confident regex hits on the fast path", async () => {
  const runtime = {
    parseUserIntent: async () => {
      throw new Error("NLU should not run for a clear regex hit");
    }
  };

  const result = await resolveUserIntent({
    transcript: "没有反应",
    stage: AgentStage.S2_CHECK_RESPONSE,
    runtime,
    options: { env: {} }
  });

  assert.equal(result.intent, "patient_unresponsive");
  assert.equal(result.source, "regex");
  assert.equal(result.escalated, false);
  assert.equal(result.slots.responsive.value, false);
});

test("intent resolver escalates fuzzy diagnostic text to Gemma NLU", async () => {
  let observedFrame = null;
  const runtime = {
    parseUserIntent: async (frame) => {
      observedFrame = frame;
      return {
        ok: true,
        intent: "parse_breathing_answer",
        slots: {
          normal_breathing: { value: false, confidence: 0.92 },
          agonal_breathing: { value: true, confidence: 0.82 }
        },
        confidence: 0.88,
        needsClarification: false
      };
    }
  };

  const result = await resolveUserIntent({
    transcript: "他好像没气了，偶尔喘一下",
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options: { env: { INTENT_NLU: "on" } }
  });

  assert.equal(result.intent, "agonal_breathing");
  assert.equal(result.source, "gemma_nlu");
  assert.equal(result.escalated, true);
  assert.equal(result.slots.normal_breathing.value, false);
  assert.equal(observedFrame.current_stage, AgentStage.S3_CHECK_BREATHING);
  assert.deepEqual(observedFrame.allowed_slots, ["normal_breathing", "agonal_breathing"]);
});

test("intent resolver gates low-confidence CPR trigger slots", async () => {
  const runtime = {
    parseUserIntent: async () => ({
      ok: true,
      intent: "parse_breathing_answer",
      slots: {
        normal_breathing: { value: false, confidence: 0.7 }
      },
      confidence: 0.76,
      needsClarification: false
    })
  };

  const result = await resolveUserIntent({
    transcript: "可能没呼吸",
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options: { env: { INTENT_NLU: "on" } }
  });

  assert.equal(result.source, "gemma_nlu");
  assert.deepEqual(result.slots.normal_breathing, { value: null, confidence: 0.7 });
  assert.equal(result.needsClarification, true);
});

test("intent resolver exposes only live-safe NLU intents in CPR loop", async () => {
  let observedFrame = null;
  const runtime = {
    parseUserIntent: async (frame) => {
      observedFrame = frame;
      return {
        ok: true,
        intent: "paramedics_arrived",
        slots: {},
        confidence: 0.88,
        needsClarification: false
      };
    }
  };

  const result = await resolveUserIntent({
    transcript: "他们已经接手了",
    stage: AgentStage.S7_CPR_LOOP,
    runtime,
    options: { env: { INTENT_NLU: "on" } }
  });

  assert.equal(result.intent, "paramedics_arrived");
  assert.equal(result.source, "gemma_nlu");
  assert.ok(observedFrame.allowed_intents.includes("aed_available"));
  assert.ok(observedFrame.allowed_intents.includes("paramedics_arrived"));
  assert.ok(!observedFrame.allowed_intents.includes("no_normal_breathing"));
  assert.deepEqual(observedFrame.allowed_slots, []);
});

test("intent resolver honors INTENT_NLU off switch", () => {
  const result = shouldEscalateToNlu({
    transcript: "他好像没气了",
    stage: AgentStage.S3_CHECK_BREATHING,
    classification: { intent: null, score: 0, candidates: [] },
    options: {
      env: {
        INTENT_NLU: "off"
      }
    }
  });

  assert.equal(result.escalate, false);
  assert.equal(result.reason, "nlu_disabled");
});
