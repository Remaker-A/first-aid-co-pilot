import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentStage,
  GemmaDecisionScope,
  GUIDANCE_CONFLICT_PRIORITY_ORDER,
  GUIDANCE_SOURCE_PRIORITY,
  GuidanceConflictPriority,
  arbitrateGuidanceAction,
  createVoiceDemoService,
  getGemmaAllowedIntentsByStage,
  getGemmaDecisionScope,
  getGemmaDecisionScopeByStage,
  getGemmaIntentScope,
  getSpecialIntents,
  guidanceSourceRank,
  recordGuidanceArbitration,
  resetGuidanceAuditSink,
  resolveGemmaAuthority,
  resolveGuidanceAction,
  setGuidanceAuditSink
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 1. 知识层：gemma_decision_scope 单一事实源
// ---------------------------------------------------------------------------

test("scope: every stage exposes autonomy/restricted lists", () => {
  const byStage = getGemmaDecisionScopeByStage();
  for (const stage of Object.keys(getGemmaAllowedIntentsByStage())) {
    const scope = byStage[stage];
    assert.ok(scope, `stage ${stage} should have a decision scope`);
    assert.ok(Array.isArray(scope.autonomy), `${stage}.autonomy must be an array`);
    assert.ok(Array.isArray(scope.restricted), `${stage}.restricted must be an array`);
  }
});

test("scope: every (non-special) allowed intent is classified per stage", () => {
  const specials = new Set(getSpecialIntents());
  const allowedByStage = getGemmaAllowedIntentsByStage();

  for (const [stage, intents] of Object.entries(allowedByStage)) {
    const scope = getGemmaDecisionScope(stage);
    const classified = new Set([...scope.autonomy, ...scope.restricted]);
    for (const intent of intents) {
      if (specials.has(intent)) {
        continue;
      }
      assert.ok(
        classified.has(intent),
        `intent ${intent} at ${stage} must be classified as autonomy or restricted`
      );
    }
  }
});

test("scope: expressive intents are autonomy, flow/correction/tool intents are restricted", () => {
  assert.equal(getGemmaIntentScope(AgentStage.S8_ASSISTANCE, "calm_rescuer"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S8_ASSISTANCE, "explain_aed_support"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S8_ASSISTANCE, "assist_rescuer_fatigue"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S8_ASSISTANCE, "assist_aed"), "restricted");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "encourage_rescuer"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "answer_current_cpr_question"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "correction.hand_position"), "restricted");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "continue_cpr"), "restricted");
  assert.equal(getGemmaIntentScope(AgentStage.S2_CHECK_RESPONSE, "ask_response_check"), "restricted");
});

test("scope: unlisted intents fall back to heuristic (expressive -> autonomy, else restricted)", () => {
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "explain_brand_new_thing"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "answer_brand_new_question"), "autonomy");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, "some_unknown_flow_intent"), "restricted");
  assert.equal(getGemmaIntentScope(AgentStage.S7_CPR_LOOP, ""), "restricted");
});

// ---------------------------------------------------------------------------
// 2. 授权信封：resolveGemmaAuthority
// ---------------------------------------------------------------------------

test("authority: autonomy state intent + autonomy gemma intent allows self-selection", () => {
  const authority = resolveGemmaAuthority({
    stage: AgentStage.S8_ASSISTANCE,
    stateIntent: "assist_rescuer_fatigue",
    gemmaIntent: "calm_rescuer"
  });
  assert.equal(authority.stateScope, GemmaDecisionScope.AUTONOMY);
  assert.equal(authority.gemmaScope, GemmaDecisionScope.AUTONOMY);
  assert.equal(authority.allowIntentChange, true);
});

test("authority: restricted state intent forces reword-only (no intent change)", () => {
  const authority = resolveGemmaAuthority({
    stage: AgentStage.S8_ASSISTANCE,
    stateIntent: "assist_aed",
    gemmaIntent: "calm_rescuer"
  });
  assert.equal(authority.stateScope, GemmaDecisionScope.RESTRICTED);
  assert.equal(authority.allowIntentChange, false);
});

test("authority: autonomy state but gemma picks a restricted intent -> discard change", () => {
  const authority = resolveGemmaAuthority({
    stage: AgentStage.S8_ASSISTANCE,
    stateIntent: "assist_rescuer_fatigue",
    gemmaIntent: "continue_cpr"
  });
  assert.equal(authority.stateScope, GemmaDecisionScope.AUTONOMY);
  assert.equal(authority.gemmaScope, GemmaDecisionScope.RESTRICTED);
  assert.equal(authority.allowIntentChange, false);
});

test("authority: same intent is reword, never counted as an intent change", () => {
  const authority = resolveGemmaAuthority({
    stage: AgentStage.S7_CPR_LOOP,
    stateIntent: "encourage_rescuer",
    gemmaIntent: "encourage_rescuer"
  });
  assert.equal(authority.sameIntent, true);
  assert.equal(authority.allowIntentChange, false);
});

// ---------------------------------------------------------------------------
// 3. 显式冲突优先级常量
// ---------------------------------------------------------------------------

test("priority: documented order is strictly decreasing", () => {
  const ranks = GUIDANCE_CONFLICT_PRIORITY_ORDER.map((name) => GuidanceConflictPriority[name]);
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok(
      ranks[i] < ranks[i - 1],
      `${GUIDANCE_CONFLICT_PRIORITY_ORDER[i]} must rank below ${GUIDANCE_CONFLICT_PRIORITY_ORDER[i - 1]}`
    );
  }
});

test("priority: source ranks follow 关键规则纠错 > 状态机 > 快路径 > autonomy > 润色 > 兜底", () => {
  assert.ok(
    guidanceSourceRank("rule_feedback_critical") >
      guidanceSourceRank("state_machine_critical")
  );
  assert.ok(
    guidanceSourceRank("state_machine_critical") > guidanceSourceRank("rule_flow_fast_path")
  );
  assert.ok(
    guidanceSourceRank("rule_flow_fast_path") > guidanceSourceRank("gemma_autonomy")
  );
  assert.ok(guidanceSourceRank("gemma_autonomy") > guidanceSourceRank("gemma_agent"));
  assert.ok(guidanceSourceRank("gemma_agent") > guidanceSourceRank("state_machine"));
  assert.equal(guidanceSourceRank("gemma_fallback"), GuidanceConflictPriority.DETERMINISTIC_FALLBACK);
  // Unknown sources default to the lowest (deterministic fallback) rank.
  assert.equal(guidanceSourceRank("???"), GuidanceConflictPriority.DETERMINISTIC_FALLBACK);
  assert.equal(GUIDANCE_SOURCE_PRIORITY.gemma_autonomy, GuidanceConflictPriority.GEMMA_AUTONOMY);
});

// ---------------------------------------------------------------------------
// 4. resolveGuidanceAction 给自选与润色打不同 source
// ---------------------------------------------------------------------------

test("resolveGuidanceAction labels a self-selected intent as gemma_autonomy", () => {
  const stateAction = { intent: "assist_rescuer_fatigue", priority: "normal", source: "state_machine" };
  const gemma = { ok: true, action: { intent: "calm_rescuer", source: "gemma_agent" } };

  const changed = resolveGuidanceAction(stateAction, gemma, { allowIntentChange: true });
  assert.equal(changed.source, "gemma_autonomy");
  assert.equal(changed.action.intent, "calm_rescuer");

  const reword = resolveGuidanceAction(
    { intent: "calm_rescuer", priority: "normal", source: "state_machine" },
    { ok: true, action: { intent: "calm_rescuer", source: "gemma_agent" } },
    { allowIntentChange: true }
  );
  assert.equal(reword.source, "gemma_agent");
});

// ---------------------------------------------------------------------------
// 5. arbitrateGuidanceAction 端到端（含 decision_scope）
// ---------------------------------------------------------------------------

function stateAction(intent, overrides = {}) {
  return {
    intent,
    priority: "normal",
    source: "state_machine",
    stage: AgentStage.S8_ASSISTANCE,
    tool_actions: [],
    tts: { text: "如果旁边有人，请准备换手。" },
    ...overrides
  };
}

function gemmaValidation(intent) {
  return {
    ok: true,
    action: {
      intent,
      source: "gemma_agent",
      stage: AgentStage.S8_ASSISTANCE,
      priority: "normal",
      tts: { text: "别紧张，跟着我，继续按。", tone: "calm_firm" }
    }
  };
}

test("arbitrate: autonomy turn lets Gemma self-select within the stage subset", () => {
  const decision = arbitrateGuidanceAction({
    stateAction: stateAction("assist_rescuer_fatigue"),
    gemmaValidation: gemmaValidation("calm_rescuer"),
    liveProposal: null,
    state: { current_stage: AgentStage.S8_ASSISTANCE },
    sessionId: "sess_scope_autonomy"
  });

  assert.equal(decision.source, "gemma_autonomy");
  assert.equal(decision.action.intent, "calm_rescuer");
  assert.equal(decision.decision_scope.state_scope, "autonomy");
  assert.equal(decision.decision_scope.gemma_scope, "autonomy");
  assert.equal(decision.decision_scope.allow_intent_change, true);
  assert.equal(decision.decision_scope.priority_rank, GuidanceConflictPriority.GEMMA_AUTONOMY);
});

test("arbitrate: restricted state intent keeps the state machine action (reword only)", () => {
  const decision = arbitrateGuidanceAction({
    stateAction: stateAction("assist_aed"),
    gemmaValidation: gemmaValidation("calm_rescuer"),
    liveProposal: null,
    state: { current_stage: AgentStage.S8_ASSISTANCE },
    sessionId: "sess_scope_restricted"
  });

  assert.equal(decision.source, "state_machine");
  assert.equal(decision.action.intent, "assist_aed");
  assert.equal(decision.decision_scope.allow_intent_change, false);
});

test("arbitrate: explicit allowIntentChange=false is a hard ceiling over scope", () => {
  const decision = arbitrateGuidanceAction({
    stateAction: stateAction("assist_rescuer_fatigue"),
    gemmaValidation: gemmaValidation("calm_rescuer"),
    liveProposal: null,
    state: { current_stage: AgentStage.S8_ASSISTANCE },
    sessionId: "sess_scope_ceiling",
    allowIntentChange: false
  });

  assert.equal(decision.source, "state_machine");
  assert.equal(decision.decision_scope.allow_intent_change, false);
});

// ---------------------------------------------------------------------------
// 6. 审计日志
// ---------------------------------------------------------------------------

test("audit: arbitration emits a structured record (intent + scope + chosen source)", () => {
  const records = [];
  setGuidanceAuditSink((record) => records.push(record));
  try {
    arbitrateGuidanceAction({
      stateAction: stateAction("assist_rescuer_fatigue"),
      gemmaValidation: gemmaValidation("calm_rescuer"),
      liveProposal: null,
      state: { current_stage: AgentStage.S8_ASSISTANCE },
      sessionId: "sess_audit"
    });
  } finally {
    resetGuidanceAuditSink();
  }

  assert.equal(records.length, 1);
  const [entry] = records;
  assert.equal(entry.type, "guidance_arbitration");
  assert.equal(entry.state_intent, "assist_rescuer_fatigue");
  assert.equal(entry.gemma_intent, "calm_rescuer");
  assert.equal(entry.state_scope, "autonomy");
  assert.equal(entry.gemma_scope, "autonomy");
  assert.equal(entry.chosen_source, "gemma_autonomy");
  assert.equal(entry.chosen_rank, GuidanceConflictPriority.GEMMA_AUTONOMY);
});

test("audit: recordGuidanceArbitration returns the record and tolerates a broken sink", () => {
  setGuidanceAuditSink(() => {
    throw new Error("sink boom");
  });
  try {
    const record = recordGuidanceArbitration({ chosen_source: "gemma_autonomy", state_intent: "x" });
    assert.equal(record.type, "guidance_arbitration");
    assert.equal(record.chosen_rank, GuidanceConflictPriority.GEMMA_AUTONOMY);
  } finally {
    resetGuidanceAuditSink();
  }
});

// ---------------------------------------------------------------------------
// 7. 端到端：语音服务在 S8 非关键轮放开 Gemma 自选
// ---------------------------------------------------------------------------

test("voice service lets Gemma self-select an autonomy intent on a non-critical assistance turn", async () => {
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        return {
          ok: true,
          patch: {
            intent: "calm_rescuer",
            tts: { text: "别紧张，跟着我，继续按。", tone: "calm_firm", speed: "normal" },
            ui: { main_text: "保持冷静", secondary_text: "跟着节拍继续按" },
            reason: "reassure_fatigued_rescuer",
            confidence: 0.88
          },
          violations: []
        };
      }
    },
    tts: { provider: "mock" },
    now: () => new Date().toISOString()
  });

  const sessionId = "sess_autonomy_e2e";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "我有点紧张",
    rescuerState: { fatigue_level: "high" }
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.guidance_source, "gemma_autonomy");
  assert.equal(result.guidance_action.intent, "calm_rescuer");
  assert.equal(result.decision_scope.state_scope, "autonomy");
  assert.equal(result.decision_scope.gemma_scope, "autonomy");
  assert.equal(result.decision_scope.allow_intent_change, true);
});

async function advanceVoiceSessionToCpr(service, sessionId) {
  await service.handleTurn({
    sessionId,
    text: "现场安全了",
    patientState: { scene_safe: true, adult_likely: true }
  });
  await service.handleTurn({ sessionId, text: "他没有反应" });
  await service.handleTurn({ sessionId, text: "没有正常呼吸" });
  await service.handleTurn({ sessionId, text: "120 已经拨打" });
  await service.handleTurn({
    sessionId,
    text: "准备好了",
    patientState: {
      adult_likely: true,
      lying_down: true,
      responsive: false,
      normal_breathing: false,
      agonal_breathing: true
    }
  });
  const cprStart = await service.handleTurn({
    sessionId,
    text: "开始按压",
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      current_rate: 110,
      average_rate: 110,
      quality_score: 72,
      hand_position: "center",
      arm_posture: "straight",
      interruption_seconds: 0,
      total_compressions: 12
    }
  });
  assert.equal(cprStart.state.current_stage, AgentStage.S7_CPR_LOOP);
}
