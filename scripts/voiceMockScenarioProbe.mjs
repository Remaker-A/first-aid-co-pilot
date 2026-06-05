#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../src/config/loadEnv.js";
import { createVoiceDemoService, synthesizeSpeech } from "../src/index.js";
import { TtsAudioCache, DEFAULT_TTS_CACHE_DIR } from "../src/voice/ttsCache.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const artifactsDir = path.join(root, "artifacts");

loadEnv({ cwd: root });

const args = parseArgs(process.argv.slice(2));
const inputMode = args.input || "text";
const sessionId = args.session || `probe_${Date.now().toString(36)}`;
const startedAt = Date.now();
let fakeNowMs = Date.now();

const patientBase = {
  adult_likely: true,
  lying_down: true,
};

const ACCEPTANCE_STEPS = [
  {
    id: "scene_safe",
    label: "Scene is safe, ask response check",
    spokenText: "现场安全了",
    idealAnswer: "请大声叫他，并轻拍双肩。",
    payload: {
      eventSource: "vision_patient",
      eventType: "patient_state_update",
      patientState: {
        ...patientBase,
        responsive: null,
        normal_breathing: null,
        agonal_breathing: null,
        chest_movement: "unknown",
        confidence: 0.86,
      },
      metadata: { scene_safe: true, scene_note: "probe_scene_safe" },
    },
    expect: {
      stage: "S2_CHECK_RESPONSE",
      intent: "ask_response_check",
      eventSource: "vision_patient",
      ttsIncludes: ["轻拍", "双肩"],
      guidanceSourceAny: ["gemma_agent", "state_machine"],
      maxTotalMs: 60000,
    },
  },
  {
    id: "unresponsive",
    label: "Patient unresponsive, ask breathing check",
    spokenText: "他没有反应",
    idealAnswer: "他没有反应。现在看胸口 5 到 10 秒，确认有没有正常呼吸。",
    payload: {
      eventSource: "vision_patient",
      eventType: "patient_state_update",
      patientState: {
        ...patientBase,
        responsive: false,
        normal_breathing: null,
        agonal_breathing: null,
        chest_movement: "unknown",
        confidence: 0.91,
      },
      metadata: { scene_note: "probe_unresponsive" },
    },
    expect: {
      stage: "S3_CHECK_BREATHING",
      intent: "ask_breathing_check",
      eventSource: "vision_patient",
      ttsIncludes: ["胸口", "没有呼吸"],
      guidanceSourceAny: ["state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "no_normal_breathing",
    label: "No normal breathing, suspect arrest",
    spokenText: "没有正常呼吸，偶尔喘一下",
    idealAnswer: "请按疑似心脏骤停处理。现在准备胸外按压。",
    payload: {
      eventSource: "vision_patient",
      eventType: "breathing_update",
      patientState: {
        ...patientBase,
        responsive: false,
        normal_breathing: false,
        agonal_breathing: true,
        chest_movement: "irregular",
        confidence: 0.9,
      },
      metadata: { scene_note: "probe_no_normal_breathing" },
    },
    expect: {
      stage: "S4_SUSPECTED_ARREST",
      intent: "state_suspected_arrest_handling",
      eventSource: "vision_patient",
      ttsIncludes: ["疑似", "胸外按压"],
      guidanceSourceAny: ["state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "call_started",
    label: "Start emergency call and CPR preparation",
    spokenText: "120 已经拨打",
    idealAnswer: "我将为你拨打 120，请保持手机免提。现在准备胸外按压。",
    payload: {
      eventSource: "device",
      eventType: "device_state_update",
      deviceState: {
        emergency_call_started: true,
        emergency_call_status: "started",
        gps_attached: true,
        recording: true,
        network: "offline",
      },
      metadata: { scene_note: "probe_call_started" },
    },
    expect: {
      stage: "S5_CALL_EMERGENCY",
      intent: "start_emergency_call_and_cpr",
      eventSource: "device",
      ttsIncludes: ["120", "免提", "胸外按压"],
      guidanceSourceAny: ["state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "cpr_ready",
    label: "Guide CPR position after emergency call",
    spokenText: "准备好了",
    idealAnswer: "让他平躺在硬地面，双手掌根放在胸口中央。",
    payload: {
      eventSource: "vision_patient",
      eventType: "patient_state_update",
      patientState: {
        ...patientBase,
        responsive: false,
        normal_breathing: false,
        agonal_breathing: true,
        chest_movement: "irregular",
        confidence: 0.89,
      },
      metadata: { scene_note: "probe_cpr_ready" },
    },
    expect: {
      stage: "S6_CPR_READY",
      intent: "guide_cpr_position",
      eventSource: "vision_patient",
      ttsIncludes: ["胸口中央", "胳膊伸直"],
      guidanceSourceAny: ["state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "cpr_start",
    label: "Start CPR loop",
    spokenText: "开始按压",
    idealAnswer: "现在开始按压，跟着节拍，用力快压。",
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: true,
        current_rate: 100,
        average_rate: 100,
        quality_score: 35,
        hand_position: "center",
        arm_posture: "straight",
        interruption_seconds: 0,
        total_compressions: 10,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "start_cpr_loop",
      eventSource: "vision_cpr",
      ttsIncludes: ["开始按压", "节拍"],
      guidanceSourceAny: ["rule_flow_fast_path"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "ask_quality_good",
    label: "Answer live CPR quality question from current vision",
    spokenText: "我按得对吗",
    idealAnswer: "现在按压可以，继续保持这个节奏，目标是 100 到 120 次每分钟。",
    advanceMs: 1500,
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: true,
        current_rate: 108,
        average_rate: 107,
        quality_score: 74,
        hand_position: "center",
        arm_posture: "straight",
        interruption_seconds: 0,
        total_compressions: 26,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "answer_current_cpr_question",
      eventSource: "vision_cpr",
      ttsIncludes: ["继续保持", "100"],
      guidanceSourceAny: ["rule_fast_path"],
      responseType: "question_answer",
      liveDriverSource: "rule_fast_path",
      maxTotalMs: 12000,
    },
  },
  {
    id: "ask_can_stop",
    label: "Answer live stop question immediately",
    spokenText: "我能不能停",
    idealAnswer: "不要停，继续按压。",
    advanceMs: 1500,
    payload: {},
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "answer_current_cpr_question",
      eventSource: "stt",
      ttsIncludes: ["不要停", "继续按压"],
      guidanceSourceAny: ["rule_fast_path"],
      responseType: "question_answer",
      liveDriverSource: "rule_fast_path",
      maxTotalMs: 12000,
    },
  },
  {
    id: "ask_aed_help",
    label: "Answer live AED question immediately",
    spokenText: "除颤仪来了怎么办",
    idealAnswer: "继续按压。让旁边的人打开 AED，跟着它的语音做。",
    advanceMs: 1500,
    payload: {},
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "answer_current_cpr_question",
      eventSource: "stt",
      ttsIncludes: ["继续按压", "AED", "语音"],
      guidanceSourceAny: ["rule_fast_path"],
      responseType: "question_answer",
      liveDriverSource: "rule_fast_path",
      maxTotalMs: 12000,
    },
  },
  {
    // P0-1 regression: a misheard AED question ("除颤仪" -> "出差移") that the regex
    // classifier cannot catch must still resolve to the fixed AED safety answer via
    // the phonetic safety net (intentResolver -> phoneticIntent), not slide into an
    // open-question ack. Exercises both text and tts-stt (round-trip) paths.
    id: "ask_aed_help_phonetic",
    label: "Rescue a misheard AED question via the phonetic safety net",
    spokenText: "出差移来了怎么办",
    idealAnswer: "继续按压。让旁边的人打开 AED，跟着它的语音做。",
    advanceMs: 1500,
    payload: {},
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "answer_current_cpr_question",
      eventSource: "stt",
      ttsIncludes: ["AED", "语音", "继续按压"],
      guidanceSourceAny: ["rule_fast_path"],
      responseType: "question_answer",
      liveDriverSource: "rule_fast_path",
      maxTotalMs: 12000,
    },
  },
  {
    id: "hand_left",
    label: "Correct hand position",
    spokenText: "",
    idealAnswer: "位置向右一点。",
    advanceMs: 10000,
    payload: {
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
        total_compressions: 40,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "correct_hand_position",
      eventSource: "vision_cpr",
      ttsIncludes: ["向右一点"],
      guidanceSourceAny: ["state_machine", "state_machine_critical", "rule_feedback_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "rate_low",
    label: "Correct low compression rate",
    spokenText: "",
    idealAnswer: "再快一点，跟着节拍按。",
    advanceMs: 10000,
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: true,
        current_rate: 82,
        average_rate: 95,
        quality_score: 50,
        hand_position: "center",
        arm_posture: "straight",
        interruption_seconds: 0,
        total_compressions: 70,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "correct_compression_rate",
      eventSource: "vision_cpr",
      ttsIncludes: ["快一点", "节拍"],
      guidanceSourceAny: ["state_machine", "state_machine_critical", "rule_feedback_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "arm_bent",
    label: "Correct arm posture",
    spokenText: "",
    idealAnswer: "手臂伸直，用上半身向下压。",
    advanceMs: 10000,
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: true,
        current_rate: 112,
        average_rate: 102,
        quality_score: 58,
        hand_position: "center",
        arm_posture: "bent",
        interruption_seconds: 0,
        total_compressions: 100,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "correct_arm_posture",
      eventSource: "vision_cpr",
      ttsIncludes: ["手臂伸直", "下压"],
      guidanceSourceAny: ["state_machine", "state_machine_critical", "rule_feedback_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "interrupted",
    label: "Correct CPR interruption",
    spokenText: "",
    idealAnswer: "不要停，继续按压。",
    advanceMs: 10000,
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: false,
        current_rate: 0,
        average_rate: 100,
        quality_score: 55,
        hand_position: "center",
        arm_posture: "straight",
        interruption_seconds: 4,
        total_compressions: 120,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "correct_compression_interruption",
      eventSource: "vision_cpr",
      ttsIncludes: ["不要停", "继续按压"],
      guidanceSourceAny: ["state_machine_critical", "rule_feedback_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "quality_good",
    label: "Continue good CPR rhythm",
    spokenText: "",
    idealAnswer: "继续保持这个节奏。",
    advanceMs: 10000,
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: true,
        current_rate: 110,
        average_rate: 109,
        quality_score: 90,
        hand_position: "center",
        arm_posture: "straight",
        interruption_seconds: 0,
        total_compressions: 240,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "continue_cpr_loop",
      eventSource: "vision_cpr",
      ttsIncludes: ["继续保持", "节奏"],
      guidanceSourceAny: ["state_machine", "state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "fatigue",
    label: "Assist rescuer fatigue",
    spokenText: "",
    idealAnswer: "如果旁边有人，请准备换手。",
    advanceMs: 16000,
    payload: {
      eventSource: "vision_rescuer",
      eventType: "rescuer_state_update",
      rescuerState: {
        emotion: "anxious",
        fatigue_level: "high",
        hesitation_seconds: 0,
        confidence: 0.8,
      },
    },
    expect: {
      stage: "S8_ASSISTANCE",
      intent: "assist_rescuer_fatigue",
      eventSource: "vision_rescuer",
      ttsIncludes: ["准备换手"],
      guidanceSourceAny: ["state_machine"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "aed_arrived",
    label: "Assist AED arrival",
    spokenText: "",
    idealAnswer: "有人取到 AED 时，你继续按压，跟着 AED 语音。",
    advanceMs: 16000,
    payload: {
      eventSource: "vision_patient",
      eventType: "patient_state_update",
      metadata: {
        aed_available: true,
        helper_arrived: true,
        scene_note: "probe_aed_arrived",
      },
    },
    expect: {
      stage: "S8_ASSISTANCE",
      intent: "assist_aed",
      eventSource: "vision_patient",
      ttsIncludes: ["AED", "继续按压"],
      guidanceSourceAny: ["state_machine"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "back_to_cpr",
    label: "Return to CPR loop",
    spokenText: "",
    idealAnswer: "继续保持这个节奏。",
    advanceMs: 10000,
    payload: {
      eventSource: "vision_cpr",
      eventType: "cpr_quality_update",
      cprQuality: {
        compressions_started: true,
        current_rate: 110,
        average_rate: 109,
        quality_score: 90,
        hand_position: "center",
        arm_posture: "straight",
        interruption_seconds: 0,
        total_compressions: 260,
      },
    },
    expect: {
      stage: "S7_CPR_LOOP",
      intent: "continue_cpr_loop",
      eventSource: "vision_cpr",
      ttsIncludes: ["继续保持", "节奏"],
      guidanceSourceAny: ["state_machine", "state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "ems_arrived",
    label: "Generate handover report",
    spokenText: "救护车到了",
    idealAnswer: "急救员到达，我正在生成交接报告。",
    payload: {
      eventSource: "vision_patient",
      eventType: "handover_requested",
      metadata: {
        ems_arrived: true,
        scene_note: "probe_ems_arrived",
      },
    },
    expect: {
      stage: "S9_HANDOVER",
      intent: "generate_handover_report",
      eventSource: "vision_patient",
      ttsIncludes: ["交接报告"],
      guidanceSourceAny: ["state_machine_critical"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
  {
    id: "report_ready",
    label: "Explain report ready",
    spokenText: "",
    idealAnswer: "交接报告已生成，视频记录已本地保存。",
    payload: {
      eventSource: "device",
      eventType: "tool_result",
      metadata: {
        handover_report_generated: true,
        local_video_saved: true,
        scene_note: "probe_report_ready",
      },
      toolResult: {
        type: "generate_handover_report",
        status: "ok",
      },
    },
    expect: {
      stage: "S9_HANDOVER",
      intent: "explain_handover",
      eventSource: "device",
      ttsIncludes: ["报告已生成", "本地保存"],
      guidanceSourceAny: ["state_machine"],
      gemmaSkipped: true,
      maxTotalMs: 12000,
    },
  },
];

await main();

async function main() {
  // Drive output TTS through the shipped WA bundle so standard guidance phrases
  // replay from the pre-rendered cache (~0ms) instead of live synthesis. provider
  // "mock" makes any bundle miss a cheap, deterministic fallback so a tts_cache
  // provider unambiguously means a real bundle hit.
  const ttsCache = new TtsAudioCache({ bundleDir: DEFAULT_TTS_CACHE_DIR });
  await ttsCache.loadBundle();
  const bundleAudioRendered = await readBundleAudioRendered();
  const service = createVoiceDemoService({
    now: () => new Date(fakeNowMs).toISOString(),
    tts: { cache: ttsCache, provider: "mock" },
  });
  const results = [];

  for (const [index, step] of ACCEPTANCE_STEPS.entries()) {
    fakeNowMs += step.advanceMs ?? 10000;
    const input = await buildTurnInput(step, { sessionId, inputMode });
    const started = Date.now();
    const response = await service.handleTurn(input);
    const elapsedMs = Date.now() - started;
    const evaluation = evaluateStep(step, response, elapsedMs);
    results.push({
      index: index + 1,
      id: step.id,
      label: step.label,
      spoken_text: step.spokenText || "",
      ideal_answer: step.idealAnswer,
      expected: step.expect,
      actual: projectResponse(response, elapsedMs),
      checks: evaluation.checks,
      ok: evaluation.ok,
    });
  }

  const summary = summarize(results, inputMode, sessionId, bundleAudioRendered);
  await fs.mkdir(artifactsDir, { recursive: true });
  const outputPath = path.join(
    artifactsDir,
    `voice-mock-scenario-${inputMode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await fs.writeFile(outputPath, JSON.stringify({ summary, results }, null, 2), "utf8");

  printSummary(summary, results, outputPath);
  process.exitCode = summary.ok ? 0 : 1;
}

async function buildTurnInput(step, { sessionId, inputMode }) {
  const base = {
    sessionId,
    ...cloneJson(step.payload),
  };

  if (!step.spokenText) {
    return base;
  }

  if (inputMode === "text") {
    return { ...base, text: step.spokenText };
  }

  if (inputMode !== "tts-stt") {
    throw new Error(`Unsupported --input=${inputMode}. Use text or tts-stt.`);
  }

  const speech = await synthesizeSpeech(step.spokenText, { provider: "sherpa" });
  if (!speech?.ok || !speech.audio?.path) {
    throw new Error(`Could not synthesize input speech for ${step.id}: ${speech?.error?.message || "no wav"}`);
  }
  const audio = await fs.readFile(speech.audio.path);
  return {
    ...base,
    audioBase64: audio.toString("base64"),
    mimeType: "audio/wav",
  };
}

function evaluateStep(step, response, elapsedMs) {
  const checks = [];
  const actual = projectResponse(response, elapsedMs);
  const expect = step.expect;

  addCheck(checks, "stage", actual.stage === expect.stage, expect.stage, actual.stage);
  addCheck(checks, "intent", actual.intent === expect.intent, expect.intent, actual.intent);
  addCheck(checks, "event_source", actual.eventSource === expect.eventSource, expect.eventSource, actual.eventSource);
  addCheck(
    checks,
    "guidance_source",
    expect.guidanceSourceAny.includes(actual.guidanceSource),
    expect.guidanceSourceAny.join(" | "),
    actual.guidanceSource
  );
  for (const keyword of expect.ttsIncludes || []) {
    addCheck(checks, `tts:${keyword}`, actual.ttsText.includes(keyword), keyword, actual.ttsText);
  }
  if (typeof expect.gemmaSkipped === "boolean") {
    addCheck(
      checks,
      "gemma_skipped",
      actual.gemmaSkipped === expect.gemmaSkipped,
      String(expect.gemmaSkipped),
      String(actual.gemmaSkipped)
    );
  }
  if (expect.responseType) {
    addCheck(
      checks,
      "response_type",
      actual.responseType === expect.responseType,
      expect.responseType,
      actual.responseType
    );
  }
  if (expect.liveDriverSource) {
    addCheck(
      checks,
      "live_driver_source",
      actual.liveDriverSource === expect.liveDriverSource,
      expect.liveDriverSource,
      actual.liveDriverSource
    );
  }
  if (expect.maxTotalMs) {
    addCheck(
      checks,
      "latency",
      actual.totalMs <= expect.maxTotalMs,
      `<=${expect.maxTotalMs}ms`,
      `${actual.totalMs}ms`
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function addCheck(checks, name, ok, expected, actual) {
  checks.push({ name, ok, expected, actual });
}

function projectResponse(response, elapsedMs) {
  return {
    ok: response.ok,
    transcript: response.transcript || "",
    sttSource: response.stt?.source || "",
    sttIntent: response.stt?.intent || null,
    stage: response.state?.current_stage || "",
    intent: response.guidance_action?.intent || "",
    eventSource: response.event?.source || "",
    eventType: response.event?.event_type || "",
    guidanceSource: response.guidance_source || "",
    responseType: response.response_type || "",
    liveDriverSource: response.live_driver_source || "",
    gemmaSkipped: response.gemma?.skipped === true,
    gemmaSkipReason: response.gemma?.skipReason || null,
    gemmaFallback: response.gemma?.fallback === true,
    gemmaFallbackReason: response.gemma?.fallbackReason || response.gemma?.reason || null,
    gemmaPatchIntent: response.action_patch?.intent || null,
    ttsProvider: response.tts?.provider || "",
    ttsOk: response.tts?.ok ?? null,
    ttsText: response.guidance_action?.tts?.text || response.state_action?.tts?.text || "",
    timings: response.timings || {},
    totalMs: response.timings?.total_ms ?? elapsedMs,
    elapsedMs,
  };
}

function summarize(results, inputMode, sessionId, bundleAudioRendered = false) {
  const failed = results.filter((result) => !result.ok);
  const totalMs = Date.now() - startedAt;
  const slowest = [...results].sort((left, right) => right.actual.totalMs - left.actual.totalMs)[0] || null;
  const gemmaUsed = results.filter((result) => !result.actual.gemmaSkipped && !result.actual.gemmaFallback);
  const gemmaSkipped = results.filter((result) => result.actual.gemmaSkipped);
  const sttSources = [...new Set(results.map((result) => result.actual.sttSource).filter(Boolean))];
  const ttsProviders = [...new Set(results.map((result) => result.actual.ttsProvider).filter(Boolean))];

  // WA bundle hit rate: how often a standard guidance phrase replayed from the
  // pre-rendered cache. When the shipped bundle has audio, at least one standard
  // phrase must hit; a manifest-only checkout (no WAVs) makes this vacuously true.
  const ttsTurns = results.filter((result) => result.actual.ttsText);
  const bundleHits = ttsTurns.filter((result) => result.actual.ttsProvider === "tts_cache");
  const bundleHitRate = ttsTurns.length > 0 ? bundleHits.length / ttsTurns.length : 0;
  const bundleHitOk = !bundleAudioRendered || bundleHits.length > 0;

  return {
    ok: failed.length === 0 && bundleHitOk,
    input_mode: inputMode,
    session_id: sessionId,
    total_steps: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    runtime_ms: totalMs,
    tts_bundle_audio_rendered: bundleAudioRendered,
    tts_bundle_hits: bundleHits.length,
    tts_bundle_turns: ttsTurns.length,
    tts_bundle_hit_rate: Number(bundleHitRate.toFixed(4)),
    tts_bundle_hit_ok: bundleHitOk,
    tts_bundle_hit_steps: bundleHits.map((result) => result.id),
    slowest_step: slowest ? {
      id: slowest.id,
      total_ms: slowest.actual.totalMs,
      timings: slowest.actual.timings,
    } : null,
    gemma_used_steps: gemmaUsed.map((result) => result.id),
    gemma_skipped_steps: gemmaSkipped.map((result) => ({
      id: result.id,
      reason: result.actual.gemmaSkipReason,
    })),
    stt_sources: sttSources,
    tts_providers: ttsProviders,
  };
}

async function readBundleAudioRendered() {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(DEFAULT_TTS_CACHE_DIR, "manifest.json"), "utf8")
    );
    return manifest.audio_rendered === true;
  } catch {
    return false;
  }
}

function printSummary(summary, results, outputPath) {
  console.log(`Voice mock scenario probe: ${summary.ok ? "PASS" : "FAIL"}`);
  console.log(`input=${summary.input_mode} session=${summary.session_id}`);
  console.log(`steps=${summary.passed}/${summary.total_steps} runtime=${summary.runtime_ms}ms`);
  console.log(`stt=${summary.stt_sources.join(",") || "none"} tts=${summary.tts_providers.join(",") || "none"}`);
  console.log(
    `tts_bundle=${summary.tts_bundle_hits}/${summary.tts_bundle_turns} hits ` +
    `(${Math.round(summary.tts_bundle_hit_rate * 100)}%) audio_rendered=${summary.tts_bundle_audio_rendered} ` +
    `${summary.tts_bundle_hit_ok ? "ok" : "FAIL"}`
  );
  console.log(`gemma_used=${summary.gemma_used_steps.join(",") || "none"}`);
  console.log(`slowest=${summary.slowest_step?.id || "none"} ${summary.slowest_step?.total_ms ?? 0}ms`);
  console.log(`report=${outputPath}`);

  for (const result of results) {
    const marker = result.ok ? "PASS" : "FAIL";
    const actual = result.actual;
    console.log(
      `[${marker}] ${String(result.index).padStart(2, "0")} ${result.id} ` +
      `stage=${actual.stage} intent=${actual.intent} source=${actual.guidanceSource} response=${actual.responseType || "none"} ` +
      `gemma=${actual.gemmaSkipped ? `skip:${actual.gemmaSkipReason}` : actual.gemmaFallback ? `fallback:${actual.gemmaFallbackReason}` : "used"} ` +
      `stt=${actual.sttSource}${actual.sttIntent ? `/${actual.sttIntent}` : ""} ` +
      `total=${actual.totalMs}ms`
    );
    if (!result.ok) {
      for (const check of result.checks.filter((check) => !check.ok)) {
        console.log(`       ${check.name}: expected ${check.expected}; actual ${check.actual}`);
      }
      console.log(`       ideal: ${result.ideal_answer}`);
      console.log(`       tts: ${actual.ttsText}`);
    }
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, value = "true"] = arg.slice(2).split("=");
    parsed[key] = value;
  }
  return parsed;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
