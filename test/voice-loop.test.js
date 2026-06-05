import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentStage,
  createVoiceDemoService,
  isCriticalFlowAction,
  parseGemmaResponse,
  resolveGuidanceAction,
  transcribeInput,
  validateAction
} from "../src/index.js";

const RESPONSE_FRAME = Object.freeze({
  session_id: "sess_voice_loop",
  current_stage: AgentStage.S2_CHECK_RESPONSE,
  allowed_intents: ["ask_response_check", "parse_response_answer", "patient_unresponsive", "fallback_template"],
  facts: {
    responsive: null,
    normal_breathing: null
  },
  user_input: {
    stt_text: "",
    confidence: 0
  },
  output_schema: "GuidanceActionPatch",
  language: "zh-CN"
});

const VALID_GEMMA_PATCH = Object.freeze({
  intent: "patient_unresponsive",
  tts: {
    text: "收到。他没有反应。现在请看胸口 5 到 10 秒，确认有没有正常呼吸。",
    tone: "calm_firm",
    speed: "normal"
  },
  ui: {
    main_text: "继续检查呼吸",
    secondary_text: "观察胸口 5 到 10 秒"
  },
  visual_overlay: {
    mode: null,
    highlight_target: null,
    correction_arrow: null
  },
  log_suggestion: {
    type: "response_check",
    detail: "rescuer reported no response"
  },
  reason: "rescuer_said_patient_has_no_response",
  confidence: 0.93
});

const VALID_ASK_RESPONSE_PATCH = Object.freeze({
  intent: "ask_response_check",
  tts: {
    text: "现场安全了。请大声叫他，并轻拍双肩。",
    tone: "calm_firm",
    speed: "normal"
  },
  ui: {
    main_text: "检查反应",
    secondary_text: "呼叫并轻拍双肩"
  },
  visual_overlay: {
    mode: null,
    highlight_target: null,
    correction_arrow: null
  },
  log_suggestion: {
    type: "response_check_started",
    detail: "scene_safe_then_check_response"
  },
  reason: "scene_safe_confirmed",
  confidence: 0.9
});

test("voice loop accepts text input and returns transcript, validated Gemma patch, and TTS artifact", async () => {
  const result = await runVoiceLoop({
    inputText: "他没有反应",
    stt: mockStt,
    gemma: async ({ frame }) => {
      assert.equal(frame.user_input.stt_text, "他没有反应");
      return JSON.stringify(VALID_GEMMA_PATCH);
    },
    tts: mockTts
  });

  assert.equal(result.ok, true);
  assert.equal(result.transcript.text, "他没有反应");
  assert.equal(result.transcript.language, "zh-CN");
  assert.equal(result.gemma.patch.intent, "patient_unresponsive");
  assert.equal(result.validation.ok, true);
  assert.equal(result.tts.playable, true);
  assert.match(result.tts.url, /^mock-audio:\/\//);
  assert.equal(result.tts.mimeType, "audio/wav");
});

test("voice loop rejects unsafe Gemma patch and falls back before TTS", async () => {
  const result = await runVoiceLoop({
    inputText: "他没有反应",
    stt: mockStt,
    gemma: async () =>
      JSON.stringify({
        ...VALID_GEMMA_PATCH,
        intent: "patient_unresponsive",
        tts: {
          text: "他已经心脏骤停了。",
          tone: "calm_firm",
          speed: "normal"
        },
        ui: {
          main_text: "错误诊断",
          secondary_text: "不应输出诊断"
        }
      }),
    tts: mockTts
  });

  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.validation.ok, false);
  assert.ok(result.validation.violations.includes("forbidden_speech"));
  assert.equal(result.action.intent, "fallback_template");
  assert.equal(result.tts.playable, true);
});

test("voice loop rejects disallowed Gemma patch fields before ActionValidator", async () => {
  const result = await runVoiceLoop({
    inputText: "他没有反应",
    stt: mockStt,
    gemma: async () =>
      JSON.stringify({
        ...VALID_GEMMA_PATCH,
        next_stage: AgentStage.S3_CHECK_BREATHING,
        tool_actions: [{ type: "emergency_call" }]
      }),
    tts: mockTts
  });

  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.gemma.ok, false);
  assert.ok(result.gemma.violations.includes("disallowed_field:next_stage"));
  assert.ok(result.gemma.violations.includes("disallowed_field:tool_actions"));
  assert.equal(result.action.intent, "fallback_template");
});

test("voice service answers diagnostic turns immediately from the state machine (no Gemma supplement)", async () => {
  // 方案①：S1/S2 等诊断/流程轮不为 Gemma 润色阻塞，直接用确定性状态机话术，
  // 因此 generatePatch 不应被调用。Gemma patch 经 ActionValidator 采用的通用
  // 路径由 gemma-pipeline.test.js 覆盖；CPR-live 轮的 Gemma 由专门用例覆盖。
  let gemmaCalls = 0;
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        gemmaCalls += 1;
        return {
          ok: true,
          patch: VALID_ASK_RESPONSE_PATCH,
          violations: []
        };
      }
    },
    tts: { provider: "mock" },
    now: () => new Date().toISOString()
  });

  const result = await service.handleTurn({
    sessionId: "sess_voice_service",
    text: "现场安全了",
    patientState: { scene_safe: true }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transcript, "现场安全了");
  assert.equal(result.state.current_stage, AgentStage.S2_CHECK_RESPONSE);
  assert.equal(result.guidance_action.intent, "ask_response_check");
  assert.equal(result.guidance_source, "state_machine");
  assert.equal(result.gemma.skipped, true);
  assert.equal(result.gemma.skipReason, "diagnostic_fast_path");
  assert.equal(gemmaCalls, 0);
  assert.match(result.guidance_action.tts.text, /轻拍双肩/);
  assert.equal(result.tts.provider, "mock");
  assert.match(result.tts.audio.data_url, /^data:audio\/wav;base64,/);
  assert.equal(typeof result.timings.total_ms, "number");
});

test("voice service times out slow Gemma on an assistance turn and speaks the state action", async () => {
  // 方案①后诊断轮不调 Gemma；慢 Gemma 的超时回退机制改在仍会咨询 Gemma 润色的
  // 非关键 CPR-live 轮（S8 协助：施救者疲劳）验证。S7 按压轮自带节拍器工具属
  // critical-flow，会直接走状态机而不咨询 Gemma；S8 协助为普通优先级、无工具，才是
  // Gemma 真正参与润色的轮。该轮同时携带文本+疲劳，单轮完成转场并触发 Gemma 超时。
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        return new Promise(() => {});
      }
    },
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
    now: () => new Date().toISOString()
  });
  const sessionId = "sess_voice_service_slow_gemma";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "我有点紧张",
    rescuerState: { fatigue_level: "high" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.gemma.skipped, true);
  assert.equal(result.gemma.skipReason, "gemma_live_timeout");
  assert.equal(result.gemma_live.stale, true);
  assert.equal(result.gemma_live.timeout_ms, 5);
  assert.equal(result.guidance_source, "state_machine");
  assert.equal(result.guidance_action.intent, result.state_action.intent);
  assert.equal(result.tts.text, result.state_action.tts.text);
  assert.ok(result.timings.gemma_ms < 250);
});

test("voice service can carry mock vision facts alongside spoken input", async () => {
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        return { ok: true, patch: VALID_GEMMA_PATCH, violations: [] };
      }
    },
    tts: { provider: "mock" },
    now: () => new Date().toISOString()
  });

  const result = await service.handleTurn({
    sessionId: "sess_voice_service_vision_mock",
    text: "他没有反应",
    eventSource: "vision_patient",
    eventType: "patient_state_update",
    patientState: {
      adult_likely: true,
      responsive: false,
      confidence: 0.91
    },
    metadata: { scene_note: "mock_unresponsive" }
  });

  assert.equal(result.event.source, "vision_patient");
  assert.equal(result.event.event_type, "patient_state_update");
  assert.equal(result.event.user_input.intent, "patient_unresponsive");
  assert.equal(result.state.confirmed_facts.responsive, false);
  assert.equal(result.state.confirmed_facts.responsive_source, "vision_patient");
});

test("voice service keeps pure mock vision turns state-machine driven when Gemma changes intent", async () => {
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        return { ok: true, patch: VALID_GEMMA_PATCH, violations: [] };
      }
    },
    tts: { provider: "mock" },
    now: () => new Date().toISOString()
  });

  const result = await service.handleTurn({
    sessionId: "sess_voice_service_pure_vision_mock",
    eventSource: "vision_patient",
    eventType: "patient_state_update",
    patientState: {
      adult_likely: true,
      responsive: null,
      normal_breathing: null,
      confidence: 0.86
    },
    metadata: { scene_safe: true }
  });

  assert.equal(result.transcript, "");
  assert.equal(result.state.current_stage, AgentStage.S2_CHECK_RESPONSE);
  assert.equal(result.guidance_source, "state_machine");
  assert.equal(result.guidance_action.intent, "ask_response_check");
  assert.equal(result.gemma.skipped, true);
  assert.equal(result.gemma.skipReason, "no_user_input");
});

test("voice service treats combined safety confirmation and next-step request as a scene-safe flow fact", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingAnyRuntime(),
    tts: { provider: "mock" },
    gemmaTurnTimeoutMs: 5,
    now: () => new Date().toISOString()
  });

  const result = await service.handleTurn({
    sessionId: "sess_scene_safe_next_step",
    text: "我已确认周围安全，并在患者身边，请告诉我接下来怎么做。"
  });

  assert.equal(result.event.user_input.intent, "scene_safe");
  assert.equal(result.state.current_stage, AgentStage.S2_CHECK_RESPONSE);
  assert.equal(result.guidance_action.intent, "ask_response_check");
  assert.equal(result.guidance_source, "state_machine");
  assert.equal(result.response_type, "flow_instruction");
  assert.match(result.guidance_action.tts.text, /轻拍双肩/);
  assert.doesNotMatch(result.guidance_action.tts.text, /还没进入胸外按压/);
});

test("voice service follows the design demo mainline from one-key start through suspected arrest", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingAnyRuntime(),
    tts: { provider: "mock" },
    gemmaTurnTimeoutMs: 5,
    now: () => new Date().toISOString()
  });
  const sessionId = "sess_design_demo_mainline";

  const started = await service.handleTurn({
    sessionId,
    eventSource: "demo_script",
    eventType: "session_started",
    deviceState: {
      camera_available: true,
      mic_available: true,
      gps_available: true,
      recording: true,
      emergency_call_started: false,
      network: "offline"
    },
    metadata: { adult_likely: true, recording: true }
  });
  assert.equal(started.state.current_stage, AgentStage.S1_SCENE_SAFE);
  assert.equal(started.guidance_action.intent, "ensure_scene_safe");
  assert.match(started.guidance_action.tts.text, /开始录制/);
  assert.match(started.guidance_action.tts.text, /确认周围安全/);

  const sceneSafe = await service.handleTurn({ sessionId, text: "周围安全，我在患者身边。" });
  assert.equal(sceneSafe.event.user_input.intent, "scene_safe");
  assert.equal(sceneSafe.state.current_stage, AgentStage.S2_CHECK_RESPONSE);
  assert.equal(sceneSafe.guidance_action.intent, "ask_response_check");

  const unresponsive = await service.handleTurn({ sessionId, text: "他没有反应" });
  assert.equal(unresponsive.state.current_stage, AgentStage.S3_CHECK_BREATHING);
  assert.equal(unresponsive.guidance_action.intent, "ask_breathing_check");

  const abnormalBreathing = await service.handleTurn({
    sessionId,
    text: "好像没有呼吸，偶尔喘一下"
  });
  assert.equal(abnormalBreathing.event.user_input.intent, "agonal_breathing");
  assert.equal(abnormalBreathing.state.current_stage, AgentStage.S4_SUSPECTED_ARREST);
  assert.equal(abnormalBreathing.state.confirmed_facts.normal_breathing, false);
  assert.equal(abnormalBreathing.state.confirmed_facts.agonal_breathing, true);
  assert.equal(abnormalBreathing.guidance_action.intent, "state_suspected_arrest_handling");
  assert.match(abnormalBreathing.guidance_action.tts.text, /疑似心脏骤停/);
});

test("voice service uses validator fallback when Gemma text is unsafe", async () => {
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        return {
          ok: true,
          patch: {
            ...VALID_GEMMA_PATCH,
            tts: {
              text: "他已经心脏骤停了。",
              tone: "calm_firm",
              speed: "normal"
            }
          },
          violations: []
        };
      }
    },
    tts: { provider: "mock" },
    now: () => new Date().toISOString()
  });

  const sessionId = "sess_voice_service_unsafe";
  await advanceVoiceSessionToCpr(service, sessionId);

  // 方案①后诊断轮不调 Gemma；越界话术被 ActionValidator 拦截改 fallback 的安全机制
  // 在仍会咨询 Gemma 的非关键 CPR-live 轮（S8 协助）验证。
  const result = await service.handleTurn({
    sessionId,
    text: "好的",
    rescuerState: { fatigue_level: "high" }
  });

  assert.equal(result.gemma_validation.ok, false);
  assert.ok(result.gemma_validation.violations.includes("forbidden_speech"));
  assert.equal(result.guidance_action.intent, "fallback_template");
  assert.notEqual(result.tts.text, "他已经心脏骤停了。");
});

test("isCriticalFlowAction flags critical priority and tool-bearing actions", () => {
  assert.equal(isCriticalFlowAction({ priority: "critical" }), true);
  assert.equal(
    isCriticalFlowAction({ priority: "normal", tool_actions: [{ type: "emergency_call" }] }),
    true
  );
  assert.equal(isCriticalFlowAction({ priority: "normal", tool_actions: [] }), false);
  assert.equal(isCriticalFlowAction({ priority: "high" }), false);
});

test("resolveGuidanceAction keeps critical state actions and lets Gemma supplement otherwise", () => {
  const criticalState = { intent: "start_emergency_call_and_cpr", priority: "critical", source: "state_machine" };
  const gemmaAction = { intent: "ask_response_check", source: "gemma_agent" };

  const kept = resolveGuidanceAction(criticalState, { ok: true, action: gemmaAction });
  assert.equal(kept.action, criticalState);
  assert.equal(kept.source, "state_machine_critical");

  const normalState = { intent: "ask_response_check", priority: "normal", source: "state_machine" };
  const supplemented = resolveGuidanceAction(normalState, { ok: true, action: gemmaAction }, { allowIntentChange: false });
  assert.equal(supplemented.action, gemmaAction);
  assert.equal(supplemented.source, "gemma_agent");

  const changedIntent = { intent: "encourage_rescuer", source: "gemma_agent" };
  const preserved = resolveGuidanceAction(normalState, { ok: true, action: changedIntent }, { allowIntentChange: false });
  assert.equal(preserved.action, normalState);
  assert.equal(preserved.source, "state_machine");

  const blocked = { intent: "fallback_template", source: "action_validator" };
  const fellBack = resolveGuidanceAction(normalState, { ok: false, action: blocked });
  assert.equal(fellBack.action, blocked);
  assert.equal(fellBack.source, "gemma_fallback");

  const noGemma = resolveGuidanceAction(normalState, null);
  assert.equal(noGemma.action, normalState);
  assert.equal(noGemma.source, "state_machine");
});

test("voice service keeps critical flow state-machine-driven even when Gemma returns a patch", async () => {
  let gemmaCalls = 0;
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
        gemmaCalls += 1;
        return { ok: true, patch: VALID_GEMMA_PATCH, violations: [] };
      }
    },
    tts: { provider: "mock" }
  });

  await service.handleTurn({ sessionId: "crit", text: "现场安全了", patientState: { scene_safe: true } });
  await service.handleTurn({ sessionId: "crit", text: "他没有反应" });
  const result = await service.handleTurn({ sessionId: "crit", text: "没有正常呼吸，偶尔喘一下" });

  assert.equal(result.state.current_stage, AgentStage.S4_SUSPECTED_ARREST);
  assert.equal(result.guidance_source, "state_machine_critical");
  assert.equal(result.guidance_action.source, "state_machine");
  assert.equal(result.guidance_action.intent, "state_suspected_arrest_handling");
  assert.notEqual(result.guidance_action.intent, VALID_GEMMA_PATCH.intent);
  assert.equal(result.gemma.skipped, true);
  assert.equal(result.gemma.skipReason, "critical_or_tool_state_action");
  // 方案①后诊断轮（S2）也不再调用 Gemma 润色，整条诊断 + critical 链路一次都不调。
  assert.equal(gemmaCalls, 0);
});

test("CPR live quality question uses mock vision correction instead of repeating emergency call", async () => {
  const service = createVoiceDemoService({
    runtime: sameIntentRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "live_quality_hand_left";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "我按得对吗",
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      current_rate: 110,
      average_rate: 108,
      quality_score: 42,
      hand_position: "left",
      arm_posture: "straight",
      interruption_seconds: 0,
      total_compressions: 44
    }
  });

  assert.equal(result.state.current_stage, AgentStage.S7_CPR_LOOP);
  assert.equal(result.event.user_input.intent, "ask_cpr_quality");
  assert.equal(result.response_type, "critical_correction");
  assert.equal(result.guidance_source, "rule_feedback_critical");
  assert.match(result.guidance_action.tts.text, /位置向右一点/);
  assert.doesNotMatch(result.guidance_action.tts.text, /拨打 120|免提/);
  assert.equal(result.live_driver_proposal.responseType, "question_answer");
});

test("CPR live stop question is answered by fast path without waiting for Gemma", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "live_stop_question";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "我能不能停"
  });

  assert.equal(result.event.user_input.intent, "ask_can_stop");
  assert.equal(result.response_type, "question_answer");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.equal(result.gemma_live.stale, false);
  assert.equal(result.gemma_live.skipReason, "live_fast_path_selected");
  assert.match(result.guidance_action.tts.text, /不要停/);
  assert.match(result.guidance_action.tts.text, /继续按压/);
});

test("CPR live AED question gives immediate AED support guidance", async () => {
  const service = createVoiceDemoService({
    runtime: sameIntentRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "live_aed_question";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "AED 怎么用"
  });

  assert.equal(result.event.user_input.intent, "ask_aed_help");
  assert.equal(result.response_type, "question_answer");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.match(result.guidance_action.tts.text, /继续按压/);
  assert.match(result.guidance_action.tts.text, /AED/);
  // AED 只引导：跟着它的语音做，不再口述贴电极/设备提示分析时暂停。
  assert.match(result.guidance_action.tts.text, /跟着它的语音/);
});

test("CPR live AED question with AED vision event stays fast-path in assistance stage", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "live_aed_question_with_vision";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "AED 怎么用",
    eventSource: "vision_patient",
    eventType: "patient_state_update",
    metadata: {
      aed_available: true,
      helper_arrived: true,
    }
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.event.user_input.intent, "ask_aed_help");
  assert.equal(result.response_type, "question_answer");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.equal(result.gemma.skipReason, "live_fast_path_selected");
  assert.equal(result.guidance_action.intent, "explain_aed_support");
  assert.match(result.guidance_action.tts.text, /继续按压/);
  assert.match(result.guidance_action.tts.text, /AED/);
  // AED 只引导：跟着它的语音做，不再口述贴电极/设备提示分析时暂停。
  assert.match(result.guidance_action.tts.text, /跟着它的语音/);
});

test("CPR live AED arrival enters assistance and gives immediate AED safety steps", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "live_aed_arrival";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "AED 到了"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.event.user_input.intent, "aed_available");
  assert.equal(result.event.metadata.aed_available, true);
  assert.equal(result.response_type, "flow_instruction");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.equal(result.gemma.skipReason, "live_fast_path_selected");
  assert.equal(result.guidance_action.intent, "assist_aed");
  assert.match(result.guidance_action.tts.text, /继续按压/);
  assert.match(result.guidance_action.tts.text, /分析或电击/);
});

test("CPR live pacemaker wording is soft-mapped to AED arrival", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "live_aed_soft_alias";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    text: "心脏起搏器来了"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.event.user_input.intent, "aed_available");
  assert.equal(result.event.metadata.aed_soft_alias, true);
  assert.equal(result.guidance_action.intent, "assist_aed");
  assert.match(result.guidance_action.tts.text, /如果这是 AED/);
  assert.match(result.guidance_action.tts.text, /自动体外除颤器/);
});

test("assistance-stage stop question remains immediate fast path", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "assistance_stop_question";
  await advanceVoiceSessionToCpr(service, sessionId);
  await service.handleTurn({
    sessionId,
    eventSource: "vision_patient",
    eventType: "patient_state_update",
    metadata: {
      aed_available: true,
      helper_arrived: true,
    }
  });

  const result = await service.handleTurn({
    sessionId,
    text: "我能不能停"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.event.user_input.intent, "ask_can_stop");
  assert.equal(result.response_type, "question_answer");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.equal(result.gemma.skipReason, "live_fast_path_selected");
  assert.match(result.guidance_action.tts.text, /不要停/);
  assert.match(result.guidance_action.tts.text, /继续按压/);
});

test("assistance-stage acknowledgement does not trigger rescuer fatigue guidance", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "assistance_ack_continue_cpr";
  await advanceVoiceSessionToCpr(service, sessionId);
  await service.handleTurn({
    sessionId,
    text: "AED 到了"
  });

  const result = await service.handleTurn({
    sessionId,
    text: "好的"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.guidance_action.intent, "continue_cpr");
  assert.doesNotMatch(result.guidance_action.tts.text, /准备换手/);
  assert.doesNotMatch(result.guidance_action.intent, /assist_rescuer_fatigue/);
  assert.match(result.guidance_action.tts.text, /继续按压/);
});

test("stale rescuer fatigue does not contaminate later assistance acknowledgements", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "assistance_stale_fatigue_ack";
  await advanceVoiceSessionToCpr(service, sessionId);
  await service.handleTurn({
    sessionId,
    text: "我有点累",
    rescuerState: { fatigue_level: "high" }
  });

  const result = await service.handleTurn({
    sessionId,
    text: "好的"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.guidance_action.intent, "continue_cpr");
  assert.doesNotMatch(result.guidance_action.tts.text, /准备换手/);
  assert.match(result.guidance_action.tts.text, /继续按压/);
});

test("assistance-stage natural stop variants stay deterministic fast path", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "assistance_natural_stop_question";
  await advanceVoiceSessionToCpr(service, sessionId);
  await service.handleTurn({
    sessionId,
    text: "AED 到了"
  });

  const result = await service.handleTurn({
    sessionId,
    text: "我们就一直按吗"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.event.user_input.intent, "ask_can_stop");
  assert.equal(result.response_type, "question_answer");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.match(result.guidance_action.tts.text, /不要停/);
  assert.match(result.guidance_action.tts.text, /急救人员接手|恢复正常呼吸/);
});

test("assistance-stage AED and compression alternation question has fixed safety answer", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });
  const sessionId = "assistance_aed_cpr_alternation";
  await advanceVoiceSessionToCpr(service, sessionId);
  await service.handleTurn({
    sessionId,
    text: "AED 到了"
  });

  const result = await service.handleTurn({
    sessionId,
    text: "AED 和按压怎么交替"
  });

  assert.equal(result.state.current_stage, AgentStage.S8_ASSISTANCE);
  assert.equal(result.event.user_input.intent, "ask_aed_cpr_alternation");
  assert.equal(result.response_type, "question_answer");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.equal(result.guidance_action.intent, "explain_aed_support");
  assert.match(result.guidance_action.tts.text, /继续按压/);
  assert.match(result.guidance_action.tts.text, /分析或提示电击|所有人离开/);
});

test("early AED mock is acknowledged without skipping the required response check", async () => {
  const service = createVoiceDemoService({
    runtime: sameIntentRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "early_aed_s2";

  await service.handleTurn({
    sessionId,
    text: "现场安全了",
    patientState: { scene_safe: true, adult_likely: true }
  });
  const result = await service.handleTurn({
    sessionId,
    eventSource: "vision_patient",
    eventType: "patient_state_update",
    metadata: {
      aed_available: true,
      helper_arrived: true,
    }
  });

  assert.equal(result.state.current_stage, AgentStage.S2_CHECK_RESPONSE);
  assert.equal(result.guidance_action.intent, "ask_response_check");
  assert.equal(result.response_type, "flow_instruction");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.match(result.guidance_action.tts.text, /AED 已经到了/);
  assert.match(result.guidance_action.tts.text, /轻拍双肩/);
});

test("AED mock on a fresh session is acknowledged while preserving scene safety flow", async () => {
  const service = createVoiceDemoService({
    runtime: sameIntentRuntime(),
    tts: { provider: "mock" },
  });

  const result = await service.handleTurn({
    sessionId: "early_aed_s1",
    eventSource: "vision_patient",
    eventType: "patient_state_update",
    metadata: {
      aed_available: true,
      helper_arrived: true,
    }
  });

  assert.equal(result.state.current_stage, AgentStage.S1_SCENE_SAFE);
  assert.equal(result.guidance_action.intent, "ask_scene_safety");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.match(result.guidance_action.tts.text, /AED 已经到了/);
  assert.match(result.guidance_action.tts.text, /确认周围安全/);
});

test("pre-CPR quality question redirects to current flow without Gemma timeout", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });

  const result = await service.handleTurn({
    sessionId: "pre_cpr_quality_question",
    text: "我按得对吗",
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      current_rate: 110,
      average_rate: 105,
      quality_score: 42,
      hand_position: "left",
      arm_posture: "straight",
      interruption_seconds: 0,
      total_compressions: 40
    }
  });

  assert.equal(result.state.current_stage, AgentStage.S1_SCENE_SAFE);
  assert.equal(result.event.user_input.intent, "ask_cpr_quality");
  assert.equal(result.response_type, "flow_instruction");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.live_driver_source, "rule_fast_path");
  assert.equal(result.gemma.skipped, true);
  assert.equal(result.gemma.skipReason, "live_fast_path_selected");
  assert.equal(result.gemma_live.stale, false);
  assert.match(result.guidance_action.tts.text, /还没进入胸外按压步骤/);
  assert.match(result.guidance_action.tts.text, /确认周围安全/);
});

test("pre-CPR stop question is handled by fast path instead of slow Gemma", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });

  const result = await service.handleTurn({
    sessionId: "pre_cpr_stop_question",
    text: "我能不能停"
  });

  assert.equal(result.state.current_stage, AgentStage.S1_SCENE_SAFE);
  assert.equal(result.event.user_input.intent, "ask_can_stop");
  assert.equal(result.response_type, "flow_instruction");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.gemma.skipReason, "live_fast_path_selected");
  assert.match(result.guidance_action.tts.text, /如果你已经开始按压，不要随意停止/);
  assert.match(result.guidance_action.tts.text, /确认周围安全/);
});

test("pre-CPR AED question is acknowledged and redirected to current flow", async () => {
  const service = createVoiceDemoService({
    runtime: neverResolvingRuntime(),
    tts: { provider: "mock" },
    gemmaLiveTimeoutMs: 5,
  });

  const result = await service.handleTurn({
    sessionId: "pre_cpr_aed_question",
    text: "除颤仪怎么用"
  });

  assert.equal(result.state.current_stage, AgentStage.S1_SCENE_SAFE);
  assert.equal(result.event.user_input.intent, "ask_aed_help");
  assert.equal(result.response_type, "flow_instruction");
  assert.equal(result.guidance_source, "rule_fast_path");
  assert.equal(result.gemma.skipReason, "live_fast_path_selected");
  assert.match(result.guidance_action.tts.text, /AED 可以先放在旁边准备/);
  assert.match(result.guidance_action.tts.text, /确认周围安全/);
});

test("CPR live vision-only interruption correction preempts normal flow guidance", async () => {
  const service = createVoiceDemoService({
    runtime: sameIntentRuntime(),
    tts: { provider: "mock" },
  });
  const sessionId = "live_interruption";
  await advanceVoiceSessionToCpr(service, sessionId);

  const result = await service.handleTurn({
    sessionId,
    eventSource: "vision_cpr",
    eventType: "cpr_quality_update",
    cprQuality: {
      compressions_started: true,
      current_rate: 104,
      average_rate: 105,
      quality_score: 35,
      hand_position: "center",
      arm_posture: "straight",
      interruption_seconds: 3,
      total_compressions: 55
    }
  });

  assert.equal(result.transcript, "");
  assert.equal(result.response_type, "critical_correction");
  assert.equal(result.guidance_source, "rule_feedback_critical");
  assert.match(result.guidance_action.tts.text, /不要停/);
  assert.match(result.guidance_action.tts.text, /继续按压/);
});

test("STT adapter falls back to mock audio transcript when sherpa command is unavailable", async () => {
  const result = await transcribeInput(
    {
      audioBase64: Buffer.from("fake wav bytes", "utf8").toString("base64"),
      mimeType: "audio/wav"
    },
    {
      provider: "sherpa",
      sherpaCommand: "definitely-missing-sherpa-stt-command"
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.provider, "mock");
  assert.equal(result.source, "mock_audio_stt");
  assert.match(result.transcript, /mock audio transcript/);
  assert.equal(result.audio.mime_type, "audio/wav");
});

async function runVoiceLoop({ inputText, stt, gemma, tts }) {
  const transcript = await stt(inputText);
  const frame = {
    ...RESPONSE_FRAME,
    user_input: {
      stt_text: transcript.text,
      confidence: transcript.confidence
    }
  };

  const gemmaResult = parseGemmaResponse(await gemma({ frame, transcript }), frame);
  if (!gemmaResult.ok) {
    return withFallback({
      transcript,
      gemma: gemmaResult,
      tts,
      reason: gemmaResult.error,
      violations: gemmaResult.violations
    });
  }

  const candidate = {
    ...gemmaResult.patch,
    stage: frame.current_stage,
    source: "gemma_agent",
    priority: "normal"
  };
  const validation = validateAction(candidate, {
    session_id: frame.session_id,
    current_stage: frame.current_stage,
    allowed_intents: frame.allowed_intents
  });

  if (!validation.ok) {
    const fallbackAudio = await tts(validation.action.tts.text);
    return {
      ok: false,
      fallback: true,
      transcript,
      gemma: gemmaResult,
      validation,
      action: validation.action,
      tts: fallbackAudio
    };
  }

  return {
    ok: true,
    fallback: false,
    transcript,
    gemma: gemmaResult,
    validation,
    action: validation.action,
    tts: await tts(validation.action.tts.text)
  };
}

async function withFallback({ transcript, gemma, tts, reason, violations }) {
  const action = {
    intent: "fallback_template",
    tts: {
      text: "我会继续给你一步一步提示。",
      tone: "calm_firm",
      speed: "normal"
    },
    ui: {
      main_text: "继续按提示操作",
      secondary_text: "保持冷静，一步一步来"
    },
    reason_codes: ["gemma_patch_rejected", ...(violations || [])],
    log_event: {
      type: "voice_loop_fallback",
      detail: reason || "gemma_patch_rejected"
    }
  };

  return {
    ok: false,
    fallback: true,
    transcript,
    gemma,
    validation: null,
    action,
    tts: await tts(action.tts.text)
  };
}

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

function sameIntentRuntime() {
  return {
    async generatePatch(frame) {
      const intent = frame.allowed_intents?.[0] || "fallback_template";
      return {
        ok: true,
        patch: {
          intent,
          tts: {
            text: "请跟着提示继续操作。",
            tone: "calm_firm",
            speed: "normal"
          },
          ui: {
            main_text: "继续操作",
            secondary_text: "按当前提示执行"
          },
          reason: "test_same_intent",
          confidence: 0.8
        },
        violations: []
      };
    }
  };
}

function neverResolvingRuntime() {
  const fallback = sameIntentRuntime();
  return {
    async generatePatch(frame) {
      if (frame.current_stage !== AgentStage.S7_CPR_LOOP) {
        return fallback.generatePatch(frame);
      }
      return new Promise(() => {});
    }
  };
}

function neverResolvingAnyRuntime() {
  return {
    async generatePatch() {
      return new Promise(() => {});
    }
  };
}

async function mockStt(text) {
  return {
    text,
    confidence: 0.96,
    language: "zh-CN",
    source: "mock_stt"
  };
}

async function mockTts(text) {
  const bytes = Buffer.from(`RIFF mock wav ${text}`, "utf8");

  return {
    playable: bytes.length > 12,
    url: `mock-audio://${encodeURIComponent(text.slice(0, 16))}`,
    mimeType: "audio/wav",
    byteLength: bytes.length,
    bytes
  };
}
