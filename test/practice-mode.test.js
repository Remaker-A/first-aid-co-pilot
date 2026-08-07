import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentStage } from "../src/domain/stages.js";
import { SessionMode, createInitialSessionState } from "../src/domain/types.js";
import { getNextStage, runStateMachine } from "../src/engine/stateMachine.js";
import { validateAction } from "../src/engine/actionValidator.js";
import { createVoiceDemoService } from "../src/voice/service.js";

function cprReadyFacts() {
  return {
    confirmed_facts: {
      responsive: false,
      responsive_source: "test",
      normal_breathing: false,
      breathing_source: "test",
    },
    tool_state: { emergency_call_status: "not_started" },
  };
}

test("practice mode is opt-in: createInitialSessionState defaults to emergency", () => {
  const state = createInitialSessionState();

  assert.equal(state.session_mode, SessionMode.EMERGENCY);
});

test("practice mode S5->S6 auto-advances without emergency_call_status", () => {
  const state = createInitialSessionState({
    sessionMode: SessionMode.PRACTICE,
    currentStage: AgentStage.S5_CALL_EMERGENCY,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  assert.equal(getNextStage(state), AgentStage.S6_CPR_READY);
});

test("emergency mode S5 still waits for emergency_call_status", () => {
  const state = createInitialSessionState({
    currentStage: AgentStage.S5_CALL_EMERGENCY,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  assert.equal(getNextStage(state), AgentStage.S5_CALL_EMERGENCY);
});

test("practice mode entering S5 creates coach guidance without emergency tools or call_brief", () => {
  const state = createInitialSessionState({
    sessionMode: SessionMode.PRACTICE,
    currentStage: AgentStage.S4_SUSPECTED_ARREST,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  const action = runStateMachine(state);
  assert.equal(action.stage, AgentStage.S5_CALL_EMERGENCY);
  assert.equal(action.intent, "practice_emergency_call_simulated");
  assert.equal(action.priority, "normal");
  assert.equal(action.call_brief, undefined);
  assert.deepEqual(action.tool_actions, []);
  assert.match(action.tts.text, /演练模式/);
});

test("practice mode S5 action can advance to S6 without emergency_call tool", () => {
  const state = createInitialSessionState({
    sessionMode: SessionMode.PRACTICE,
    currentStage: AgentStage.S5_CALL_EMERGENCY,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  const action = runStateMachine(state);
  assert.equal(action.stage, AgentStage.S6_CPR_READY);
  assert.equal(action.call_brief, undefined);
  assert.ok(!action.tool_actions.some((tool) => tool.type === "emergency_call"));
});

test("practice mode keeps the CPR start rule unchanged", () => {
  const state = createInitialSessionState({
    sessionMode: SessionMode.PRACTICE,
    currentStage: AgentStage.S2_CHECK_RESPONSE,
    adultLikely: true,
    overrides: { confirmed_facts: { responsive: true } },
  });

  assert.equal(getNextStage(state), AgentStage.MONITOR_RESPONSE);
});

test("practice mode still inherits forbidden speech validation", () => {
  const validation = validateAction(
    {
      intent: "practice_emergency_call_simulated",
      source: "state_machine",
      stage: AgentStage.S5_CALL_EMERGENCY,
      priority: "normal",
      tts: { text: "他已经心脏骤停了。", tone: "calm_firm" },
      ui: { main_text: "演练", secondary_text: "" },
    },
    {
      current_stage: AgentStage.S5_CALL_EMERGENCY,
      session_mode: SessionMode.PRACTICE,
    },
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("forbidden_speech"));
});

test("voice service accepts session_mode=practice and skips emergency_call tools at S5", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaTurnTimeoutMs: 5,
    now: () => new Date().toISOString(),
  });
  const sessionId = "practice_voice_service";

  await service.handleTurn({
    sessionId,
    session_mode: SessionMode.PRACTICE,
    text: "现场安全了",
    patientState: { scene_safe: true, adult_likely: true },
  });
  await service.handleTurn({ sessionId, text: "他没有反应" });
  await service.handleTurn({ sessionId, text: "没有正常呼吸" });
  const callStep = await service.handleTurn({
    sessionId,
    eventSource: "system",
    eventType: "auto_followup",
    metadata: { auto_advance: true },
  });

  assert.equal(callStep.state.session_mode, SessionMode.PRACTICE);
  assert.equal(callStep.state.current_stage, AgentStage.S5_CALL_EMERGENCY);
  assert.equal(callStep.guidance_action.intent, "practice_emergency_call_simulated");
  assert.equal(callStep.guidance_action.call_brief, undefined);
  assert.ok(!callStep.guidance_action.tool_actions.some((tool) => tool.type === "emergency_call"));
});

function neverResolvingRuntime() {
  return {
    async generatePatch() {
      return new Promise(() => {});
    },
  };
}
