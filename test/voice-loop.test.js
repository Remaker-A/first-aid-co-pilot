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

test("voice service sends Gemma patch through ActionValidator before TTS", async () => {
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch(frame) {
        assert.equal(frame.user_input.stt_text, "他没有反应");
        assert.ok(frame.allowed_intents.includes("patient_unresponsive"));
        return {
          ok: true,
          patch: VALID_GEMMA_PATCH,
          violations: []
        };
      }
    },
    tts: { provider: "mock" },
    now: () => new Date().toISOString()
  });

  const result = await service.handleTurn({
    sessionId: "sess_voice_service",
    text: "他没有反应",
    patientState: { scene_safe: true }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transcript, "他没有反应");
  assert.equal(result.gemma_validation.ok, true);
  assert.equal(result.guidance_action.intent, "patient_unresponsive");
  assert.equal(result.tts.provider, "mock");
  assert.match(result.tts.audio.data_url, /^data:audio\/wav;base64,/);
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

  const result = await service.handleTurn({
    sessionId: "sess_voice_service_unsafe",
    text: "他没有反应",
    patientState: { scene_safe: true }
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
  const gemmaAction = { intent: "encourage_rescuer", source: "gemma_agent" };

  const kept = resolveGuidanceAction(criticalState, { ok: true, action: gemmaAction });
  assert.equal(kept.action, criticalState);
  assert.equal(kept.source, "state_machine_critical");

  const normalState = { intent: "ask_response_check", priority: "normal", source: "state_machine" };
  const supplemented = resolveGuidanceAction(normalState, { ok: true, action: gemmaAction });
  assert.equal(supplemented.action, gemmaAction);
  assert.equal(supplemented.source, "gemma_agent");

  const blocked = { intent: "fallback_template", source: "action_validator" };
  const fellBack = resolveGuidanceAction(normalState, { ok: false, action: blocked });
  assert.equal(fellBack.action, blocked);
  assert.equal(fellBack.source, "gemma_fallback");

  const noGemma = resolveGuidanceAction(normalState, null);
  assert.equal(noGemma.action, normalState);
  assert.equal(noGemma.source, "state_machine");
});

test("voice service keeps critical flow state-machine-driven even when Gemma returns a patch", async () => {
  const service = createVoiceDemoService({
    runtime: {
      async generatePatch() {
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
