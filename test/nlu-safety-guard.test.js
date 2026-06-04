import assert from "node:assert/strict";
import test from "node:test";
import { AgentStage, resolveUserIntent, shouldEscalateToNlu } from "../src/index.js";

const S3 = AgentStage.S3_CHECK_BREATHING;

test("uncertain polar-question breathing is NOT taken as confident no_normal_breathing (NLU off)", async () => {
  const resolved = await resolveUserIntent({
    transcript: "我看不太清楚他有没有呼吸",
    stage: S3,
    options: {},
  });
  assert.equal(resolved.intent, "clarify_breathing");
  assert.equal(resolved.source, "regex");
  assert.equal(resolved.needsClarification, true);
  assert.equal(resolved.slots.normal_breathing, undefined);
});

test("a hedged breathing-absent claim is downgraded to clarify (NLU off)", async () => {
  const resolved = await resolveUserIntent({
    transcript: "他好像没有呼吸吧",
    stage: S3,
    options: {},
  });
  assert.equal(resolved.intent, "clarify_breathing");
  assert.notEqual(resolved.slots.normal_breathing?.value, false);
});

test("a clear breathing-absent statement is still taken as no_normal_breathing", async () => {
  const resolved = await resolveUserIntent({
    transcript: "他没有呼吸",
    stage: S3,
    options: {},
  });
  assert.equal(resolved.intent, "no_normal_breathing");
  assert.equal(resolved.slots.normal_breathing.value, false);
});

test("the unresponsive intent is unaffected by the breathing guard", async () => {
  const resolved = await resolveUserIntent({
    transcript: "他没有反应",
    stage: AgentStage.S2_CHECK_RESPONSE,
    options: {},
  });
  assert.equal(resolved.intent, "patient_unresponsive");
});

test("shouldEscalateToNlu flags uncertain breathing for NLU when enabled", () => {
  const escalation = shouldEscalateToNlu({
    transcript: "我看不太清楚他有没有呼吸",
    stage: S3,
    options: { intentNlu: true },
  });
  assert.equal(escalation.escalate, true);
  assert.equal(escalation.reason, "uncertain_breathing_claim");
});

test("uncertain breathing escalates to Gemma NLU when enabled", async () => {
  const resolved = await resolveUserIntent({
    transcript: "我看不太清楚他有没有呼吸",
    stage: S3,
    runtime: {
      async parseUserIntent() {
        return {
          ok: true,
          intent: "clarify_breathing",
          slots: {
            normal_breathing: { value: null, confidence: 0.5 },
            agonal_breathing: { value: null, confidence: 0.5 },
          },
          overall_confidence: 0.55,
          needs_clarification: true,
        };
      },
    },
    options: { intentNlu: true },
  });
  assert.equal(resolved.source, "gemma_nlu");
  assert.equal(resolved.intent, "clarify_breathing");
});
