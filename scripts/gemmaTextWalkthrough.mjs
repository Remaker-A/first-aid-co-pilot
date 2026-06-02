// One-shot harness: drive the real Gemma (LiteRT-LM) through the FirstAid
// Copilot CPR main-line using TEXT prompts only (STT/TTS mocked).
//
// Each turn re-spawns litert-lm and cold-loads the ~2.4GB model, so this can
// take several minutes. Full Chinese output is written to a UTF-8 JSON file
// (Windows PowerShell mangles Chinese in the console), and only a compact
// ASCII progress line is printed per turn.
//
// Usage (PowerShell):
//   $env:GEMMA_COMMAND='C:\Users\29989\.local\bin\litert-lm.exe'
//   $env:LITERT_LM_COMMAND='C:\Users\29989\.local\bin\litert-lm.exe'
//   node scripts/gemmaTextWalkthrough.mjs

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVoiceDemoService } from "../src/index.js";
import { loadEnv } from "../src/config/loadEnv.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "_gemma_walkthrough_result.json");

// Fixed timestamp kept slightly in the FUTURE relative to real UTC time so
// perception events never expire mid-run (ttl_ms is 60s internally), while
// staying fully deterministic.
const FIXED_NOW = "2026-06-02T00:00:00.000Z";
const SESSION_ID = "gemma_text_walkthrough_001";

// Main-line walkthrough. The state machine advances ONE stage per event, so we
// feed one turn per transition. The "expected_stage" is the post-transition
// stage the agent (and Gemma) should be operating in for that turn.
const TURNS = [
  {
    label: "scene_safe",
    expected_stage: "S2_CHECK_RESPONSE",
    text: "现场是安全的，我可以靠近他",
    patientState: { adult_likely: true, scene_safe: true, lying_down: true },
  },
  {
    label: "check_response -> unresponsive",
    expected_stage: "S3_CHECK_BREATHING",
    text: "他没有反应，怎么叫都叫不醒",
    patientState: { responsive: false },
  },
  {
    label: "check_breathing -> no normal breathing",
    expected_stage: "S4_SUSPECTED_ARREST",
    text: "他没有正常呼吸，只是偶尔喘一下",
    patientState: { normal_breathing: false, agonal_breathing: true },
  },
  {
    label: "emergency called (120)",
    expected_stage: "S5_CALL_EMERGENCY",
    text: "我已经拨打120了",
    deviceState: { emergency_call_started: true, gps_available: true, recording: true },
  },
  {
    label: "patient positioned",
    expected_stage: "S6_CPR_READY",
    text: "他已经平躺在硬地面上了",
    patientState: { lying_down: true },
  },
  {
    label: "start compressions (quality 32)",
    expected_stage: "S7_CPR_LOOP",
    text: "我开始按压了",
    cprQuality: {
      compressions_started: true,
      current_rate: 96,
      average_rate: 96,
      quality_score: 32,
      hand_position: "unknown",
      total_compressions: 8,
    },
  },
  {
    label: "continue, hand left + rate low (quality 45)",
    expected_stage: "S7_CPR_LOOP",
    text: "我继续按压",
    cprQuality: {
      compressions_started: true,
      current_rate: 92,
      average_rate: 94,
      quality_score: 45,
      hand_position: "left",
      total_compressions: 24,
    },
  },
  {
    label: "rescuer fatigue -> assistance",
    expected_stage: "S8_ASSISTANCE",
    text: "我有点按不动了，手很酸",
    rescuerState: { emotion: "anxious", fatigue_level: "high", confidence: 0.76 },
  },
  {
    label: "AED arrived (still assistance)",
    expected_stage: "S8_ASSISTANCE",
    text: "旁边有人拿来了AED",
    metadata: { aed_available: true, helper_arrived: true },
  },
  {
    label: "back to CPR loop (quality 88)",
    expected_stage: "S7_CPR_LOOP",
    text: "我继续按压",
    cprQuality: {
      compressions_started: true,
      current_rate: 110,
      average_rate: 108,
      quality_score: 88,
      hand_position: "center",
      arm_posture: "straight",
      total_compressions: 200,
    },
  },
  {
    label: "paramedics arrived -> handover",
    expected_stage: "S9_HANDOVER",
    text: "救护车到了，急救员来了",
    metadata: { ems_arrived: true },
  },
];

function pickGemmaText(result) {
  return result?.action_patch?.tts?.text ?? null;
}

async function main() {
  const service = createVoiceDemoService({
    stt: { provider: "mock" },
    tts: { provider: "mock" },
    now: () => FIXED_NOW,
  });

  const turns = [];
  const startedAt = new Date().toISOString();
  console.log(`[walkthrough] start ${startedAt} session=${SESSION_ID} turns=${TURNS.length}`);
  console.log(`[walkthrough] gemma_command=${process.env.GEMMA_COMMAND || process.env.LITERT_LM_COMMAND || "<default litert-lm>"}`);

  for (let index = 0; index < TURNS.length; index += 1) {
    const turn = TURNS[index];
    const turnNumber = index + 1;
    const input = {
      sessionId: SESSION_ID,
      text: turn.text,
    };
    if (turn.patientState) input.patientState = turn.patientState;
    if (turn.cprQuality) input.cprQuality = turn.cprQuality;
    if (turn.deviceState) input.deviceState = turn.deviceState;
    if (turn.rescuerState) input.rescuerState = turn.rescuerState;
    if (turn.metadata) input.metadata = turn.metadata;

    const t0 = Date.now();
    let result;
    let error = null;
    try {
      result = await service.handleTurn(input);
    } catch (err) {
      error = { message: err?.message || String(err), stack: err?.stack || null };
    }
    const elapsedMs = Date.now() - t0;

    const record = {
      turn: turnNumber,
      label: turn.label,
      input_text: turn.text,
      input_state: {
        patientState: turn.patientState || null,
        cprQuality: turn.cprQuality || null,
        deviceState: turn.deviceState || null,
        rescuerState: turn.rescuerState || null,
        metadata: turn.metadata || null,
      },
      expected_stage: turn.expected_stage,
      elapsed_ms: elapsedMs,
      error,
    };

    if (result) {
      record.inferred_intent = result.stt?.intent ?? null;
      record.stt_confidence = result.stt?.confidence ?? null;
      record.current_stage = result.state?.current_stage ?? null;
      record.allowed_intents = result.decision_frame?.allowed_intents ?? null;
      record.gemma = {
        fallback: result.gemma?.fallback ?? null,
        fallbackReason: result.gemma?.fallbackReason ?? null,
        error: result.gemma?.error ?? null,
        violations: result.gemma?.violations ?? null,
        patch_intent: result.action_patch?.intent ?? null,
        patch_tts_text: pickGemmaText(result),
        patch_ui_main: result.action_patch?.ui?.main_text ?? null,
        patch_reason: result.action_patch?.reason ?? null,
        patch_confidence: result.action_patch?.confidence ?? null,
      };
      record.gemma_validation = {
        ok: result.gemma_validation?.ok ?? null,
        violations: result.gemma_validation?.violations ?? [],
      };
      record.state_action = {
        intent: result.state_action?.intent ?? null,
        tts_text: result.state_action?.tts?.text ?? null,
        priority: result.state_action?.priority ?? null,
      };
      record.guidance_action = {
        intent: result.guidance_action?.intent ?? null,
        source: result.guidance_action?.source ?? null,
        priority: result.guidance_action?.priority ?? null,
        tts_text: result.guidance_action?.tts?.text ?? null,
        ui_main: result.guidance_action?.ui?.main_text ?? null,
      };
    }

    turns.push(record);

    const fb = record.gemma ? record.gemma.fallback : "ERR";
    const valid = record.gemma_validation ? record.gemma_validation.ok : "ERR";
    console.log(
      `Turn ${String(turnNumber).padStart(2, " ")}/${TURNS.length} | ` +
        `intent=${record.inferred_intent ?? "null"} | ` +
        `stage=${record.current_stage ?? "ERR"} | ` +
        `gemma_fallback=${fb} | ` +
        `patch_intent=${record.gemma ? record.gemma.patch_intent : "ERR"} | ` +
        `valid=${valid} | ` +
        `guidance=${record.guidance_action ? record.guidance_action.intent : "ERR"} | ` +
        `${elapsedMs}ms`
    );
  }

  const finishedAt = new Date().toISOString();
  // The runtime only sets `fallback: true` on fallbacks; a successful real
  // parse leaves it undefined. So "real Gemma" = has a patch and did not fall back.
  const realCount = turns.filter((t) => t.gemma && t.gemma.fallback !== true && !t.error).length;
  const fallbackCount = turns.filter((t) => t.gemma && t.gemma.fallback === true).length;
  const summary = {
    session_id: SESSION_ID,
    fixed_now: FIXED_NOW,
    started_at: startedAt,
    finished_at: finishedAt,
    gemma_command: process.env.GEMMA_COMMAND || process.env.LITERT_LM_COMMAND || null,
    total_turns: turns.length,
    real_gemma_turns: realCount,
    fallback_turns: fallbackCount,
    total_elapsed_ms: turns.reduce((acc, t) => acc + (t.elapsed_ms || 0), 0),
  };

  const payload = { summary, turns };
  writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log("");
  console.log(`[walkthrough] done. real_gemma=${realCount} fallback=${fallbackCount} total=${turns.length}`);
  console.log(`[walkthrough] result JSON: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("[walkthrough] fatal error:", err?.message || err);
  process.exitCode = 1;
});
