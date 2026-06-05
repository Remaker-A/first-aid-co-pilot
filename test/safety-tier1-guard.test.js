import assert from "node:assert/strict";
import test from "node:test";
import { AgentStage, validateAction } from "../src/index.js";

// WC Tier-1 不可违背硬 Guard：把 knowledge/safety_phrases.json 的 validator_rules
// 与 allowed_intents.json 的 forbidden_intents 从"只声明"变成强制校验。每条规则一个
// 稳定 reason code，下面逐条覆盖。

function gemmaCandidate(overrides = {}) {
  return {
    intent: "reassure_rescuer",
    source: "gemma_agent",
    stage: AgentStage.S2_CHECK_RESPONSE,
    priority: "normal",
    tts: { text: "我在你身边。", tone: "calm_firm" },
    ui: { main_text: "保持冷静", secondary_text: "" },
    ...overrides
  };
}

test("Tier-1 TTS limit: gemma 来源超 30 字中文被拦截并回退 (tts_exceeds_max_chars)", () => {
  const validation = validateAction(
    gemmaCandidate({ tts: { text: "测".repeat(31), tone: "calm_firm" } }),
    { current_stage: AgentStage.S2_CHECK_RESPONSE }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("tts_exceeds_max_chars"));
  assert.equal(validation.action.intent, "fallback_template");
});

test("Tier-1 TTS limit: gemma 来源 30 字以内通过 (zh-only 计数，数字/标点不计)", () => {
  const validation = validateAction(
    gemmaCandidate({
      // 24 个中文字 + 数字/标点不计入，刚好在 30 以内。
      tts: { text: "收到。他没有反应。现在请看胸口 5 到 10 秒，确认有没有正常呼吸。", tone: "calm_firm" },
      intent: "patient_unresponsive"
    }),
    { current_stage: AgentStage.S2_CHECK_RESPONSE }
  );

  assert.equal(validation.ok, true);
  assert.ok(!validation.violations.includes("tts_exceeds_max_chars"));
});

test("Tier-1 TTS limit: 关键阶段放宽到 60 字 (S7 在 60 内通过、超 60 拦截)", () => {
  const ok = validateAction(
    gemmaCandidate({
      stage: AgentStage.S7_CPR_LOOP,
      intent: "encourage_rescuer",
      tts: { text: "测".repeat(60), tone: "calm_firm" }
    }),
    { current_stage: AgentStage.S7_CPR_LOOP }
  );
  assert.equal(ok.ok, true);

  const blocked = validateAction(
    gemmaCandidate({
      stage: AgentStage.S7_CPR_LOOP,
      intent: "encourage_rescuer",
      tts: { text: "测".repeat(61), tone: "calm_firm" }
    }),
    { current_stage: AgentStage.S7_CPR_LOOP }
  );
  assert.equal(blocked.ok, false);
  assert.ok(blocked.violations.includes("tts_exceeds_max_chars"));
});

test("Tier-1 TTS limit: 状态机审定话术不受字数限制约束 (仅约束 gemma 来源)", () => {
  const longCuratedPhrase = "看他的胸口。偶尔大口喘、或者完全不动，都算没有呼吸；看不清就按没有呼吸处理。";
  const validation = validateAction(
    {
      intent: "ask_breathing_check",
      source: "state_machine",
      stage: AgentStage.S3_CHECK_BREATHING,
      priority: "high",
      tts: { text: longCuratedPhrase, tone: "calm_firm" },
      ui: { main_text: "检查呼吸", secondary_text: "" }
    },
    { current_stage: AgentStage.S3_CHECK_BREATHING }
  );

  assert.equal(validation.ok, true);
  assert.ok(!validation.violations.includes("tts_exceeds_max_chars"));
});

test("Tier-1 forbidden_intents: gemma 显式拒绝禁忌意图 (intent_forbidden:<intent>)", () => {
  const validation = validateAction(
    gemmaCandidate({
      stage: AgentStage.S4_SUSPECTED_ARREST,
      intent: "declare_cardiac_arrest",
      tts: { text: "继续按压。", tone: "calm_firm" }
    }),
    { current_stage: AgentStage.S4_SUSPECTED_ARREST }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("intent_forbidden:declare_cardiac_arrest"));
});

test("Tier-1 forbidden_intents: 连状态机来源也被拦截 (纵深防御)", () => {
  const validation = validateAction(
    {
      intent: "diagnose_disease",
      source: "state_machine",
      stage: AgentStage.S2_CHECK_RESPONSE,
      priority: "normal",
      tts: { text: "继续观察。", tone: "calm_firm" },
      ui: { main_text: "观察", secondary_text: "" }
    },
    { current_stage: AgentStage.S2_CHECK_RESPONSE }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("intent_forbidden:diagnose_disease"));
});

test("Tier-1 gemma tool_actions: 任何 gemma 工具一律剥离/拒绝 (gemma_tool_action_forbidden)", () => {
  const validation = validateAction(
    gemmaCandidate({
      stage: AgentStage.S7_CPR_LOOP,
      intent: "encourage_rescuer",
      // start_haptic_metronome 对 S7 阶段本是允许的工具类型，但 gemma 来源仍不得创建。
      tool_actions: [{ type: "start_haptic_metronome", bpm: 110, requires_user_confirmation: false }]
    }),
    { current_stage: AgentStage.S7_CPR_LOOP }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("gemma_tool_action_forbidden:start_haptic_metronome"));
  // 回退动作不携带任何工具调用。
  assert.deepEqual(validation.action.tool_actions, []);
});

test("Tier-1 gemma tool_actions: 状态机来源的同一工具仍然放行 (对照)", () => {
  const validation = validateAction(
    {
      intent: "continue_cpr_loop",
      source: "state_machine",
      stage: AgentStage.S7_CPR_LOOP,
      priority: "normal",
      tts: { text: "继续保持这个节奏。", tone: "calm_firm" },
      tool_actions: [{ type: "start_haptic_metronome", bpm: 110, requires_user_confirmation: false }]
    },
    { current_stage: AgentStage.S7_CPR_LOOP }
  );

  assert.equal(validation.ok, true);
  assert.ok(!validation.violations.some((v) => v.startsWith("gemma_tool_action_forbidden")));
});

test("Tier-1 禁改决策: gemma 携带 next_stage 被拦截 (gemma_cannot_change_stage)", () => {
  const validation = validateAction(
    gemmaCandidate({ next_stage: AgentStage.S3_CHECK_BREATHING }),
    { current_stage: AgentStage.S2_CHECK_RESPONSE }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("gemma_cannot_change_stage"));
});

test("Tier-1 禁改决策: gemma 偷换 stage 跨阶段取意图也被拦截", () => {
  // 试图把 stage 设成 S7 以让 continue_cpr 通过白名单 —— 必须被 stage 偷换 guard 挡下。
  const validation = validateAction(
    gemmaCandidate({ intent: "continue_cpr", stage: AgentStage.S7_CPR_LOOP }),
    { current_stage: AgentStage.S2_CHECK_RESPONSE }
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("gemma_cannot_change_stage"));
});
