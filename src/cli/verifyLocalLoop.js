#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/loadEnv.js";
import {
  createVoiceDemoService,
  findGemmaModelFile,
  resolveGemmaConfig
} from "../index.js";

loadEnv();

const EXPECTED_GEMMA_REPO = "litert-community/gemma-4-E2B-it-litert-lm";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const requireRealGemma = args.has("--require-real-gemma");
const requireRealSpeech = args.has("--require-real-speech");
const skipSmoke = args.has("--skip-smoke");

const checks = [];

await checkGemmaReadiness();
await checkSpeechReadiness();
if (!skipSmoke) {
  await checkVoiceSmoke();
}

const failed = checks.filter((check) => check.status === "fail");
const warnings = checks.filter((check) => check.status === "warn");
const summary = {
  ok: failed.length === 0,
  failed: failed.length,
  warnings: warnings.length,
  checks,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printHumanSummary(summary);
}

process.exitCode = summary.ok ? 0 : 1;

async function checkGemmaReadiness() {
  const config = resolveGemmaConfig();
  addCheck(
    "gemma.repo",
    config.modelRepo === EXPECTED_GEMMA_REPO ? "pass" : "fail",
    `configured repo: ${config.modelRepo}`,
    `expected ${EXPECTED_GEMMA_REPO}`
  );
  addCheck("gemma.backend", "pass", `backend: ${config.backend}`);
  addCheck("gemma.timeout", "pass", `timeout: ${config.timeoutMs}ms`);
  addCheck("gemma.model_dir", await pathExists(config.modelDir) ? "pass" : "warn", config.modelDir);

  let modelFile = null;
  if (config.modelFile) {
    modelFile = (await fileExists(config.modelFile)) ? config.modelFile : null;
  } else {
    try {
      modelFile = await findGemmaModelFile(config.modelDir);
    } catch {
      modelFile = null;
    }
  }

  addCheck(
    "gemma.model_file",
    modelFile ? "pass" : requireRealGemma ? "fail" : "warn",
    modelFile || "No gemma-4-E2B-it*.litertlm file found.",
    "Run npm run setup:gemma, or import a local model with scripts/setupGemma.ps1 -ModelSource <path>."
  );

  const commandProbe = await probeCommand(config.command, ["--help"], 5000);
  addCheck(
    "gemma.litert_cli",
    commandProbe.ok ? "pass" : requireRealGemma ? "fail" : "warn",
    commandProbe.ok ? `${config.command} is callable.` : commandProbe.error,
    "Install litert-lm or set GEMMA_COMMAND/LITERT_LM_COMMAND."
  );
}

async function checkSpeechReadiness() {
  const sttCommand = firstEnv("SHERPA_ONNX_STT_COMMAND", "SPEECH_STT_COMMAND");
  const ttsCommand = firstEnv("SHERPA_ONNX_TTS_COMMAND", "SPEECH_TTS_COMMAND");
  const sttModelDir = process.env.SPEECH_STT_MODEL_DIR || "models/speech/stt";
  const ttsModelDir = process.env.SPEECH_TTS_MODEL_DIR || "models/speech/tts";

  addCheck("speech.stt_provider", "pass", `provider: ${process.env.VOICE_STT_PROVIDER || process.env.SPEECH_MODE || "auto"}`);
  addCheck("speech.tts_provider", "pass", `provider: ${process.env.VOICE_TTS_PROVIDER || process.env.SPEECH_MODE || "auto"}`);
  addCheck("speech.stt_model_dir", await pathExists(sttModelDir) ? "pass" : requireRealSpeech ? "fail" : "warn", path.resolve(sttModelDir));
  addCheck("speech.tts_model_dir", await pathExists(ttsModelDir) ? "pass" : requireRealSpeech ? "fail" : "warn", path.resolve(ttsModelDir));

  const sttProbe = sttCommand
    ? await probeCommand(sttCommand, ["--help"], 5000)
    : { ok: false, error: "SHERPA_ONNX_STT_COMMAND is not set." };
  addCheck(
    "speech.stt_command",
    sttProbe.ok ? "pass" : requireRealSpeech ? "fail" : "warn",
    sttProbe.ok ? `${sttCommand} is callable.` : sttProbe.error,
    "Set SHERPA_ONNX_STT_COMMAND and model-specific SHERPA_ONNX_STT_ARGS."
  );

  const ttsProbe = ttsCommand
    ? await probeCommand(ttsCommand, ["--help"], 5000)
    : { ok: false, error: "SHERPA_ONNX_TTS_COMMAND is not set." };
  addCheck(
    "speech.tts_command",
    ttsProbe.ok ? "pass" : requireRealSpeech ? "fail" : "warn",
    ttsProbe.ok ? `${ttsCommand} is callable.` : ttsProbe.error,
    "Set SHERPA_ONNX_TTS_COMMAND and model-specific SHERPA_ONNX_TTS_ARGS."
  );
}

async function checkVoiceSmoke() {
  const service = createVoiceDemoService({
    stt: {
      provider: requireRealSpeech ? "sherpa" : "mock",
    },
    tts: {
      provider: requireRealSpeech ? "sherpa" : "mock",
    },
    now: () => new Date().toISOString(),
  });

  let result;
  try {
    result = await service.handleTurn({
      sessionId: "verify_local_loop",
      text: "他没有反应",
      patientState: { scene_safe: true },
    });
  } catch (error) {
    addCheck("voice.smoke", "fail", error.message || "voice smoke failed");
    return;
  }

  addCheck("voice.transcript", result.transcript === "他没有反应" ? "pass" : "fail", result.transcript || "<empty>");
  addCheck("voice.stage", result.state?.current_stage === "S2_CHECK_RESPONSE" ? "pass" : "warn", result.state?.current_stage || "<none>");
  addCheck(
    "voice.gemma",
    result.gemma?.fallback && requireRealGemma ? "fail" : "pass",
    result.gemma?.fallback ? `fallback: ${result.gemma.fallbackReason || result.gemma.reason}` : "Gemma patch parsed.",
    "Real Gemma verification requires a local model file and callable litert-lm."
  );
  addCheck(
    "voice.validator",
    result.gemma_validation?.ok ? "pass" : "fail",
    result.guidance_action?.intent || "<no guidance_action>"
  );
  addCheck(
    "voice.tts",
    result.tts?.audio?.data_url || result.tts?.audio?.url ? "pass" : "fail",
    `provider: ${result.tts?.provider || "unknown"}`
  );
}

function addCheck(name, status, detail, remediation = "") {
  checks.push({
    name,
    status,
    detail,
    remediation,
  });
}

async function pathExists(targetPath) {
  try {
    await fs.access(path.resolve(targetPath));
    return true;
  } catch {
    return false;
  }
}

async function fileExists(targetPath) {
  try {
    const stat = await fs.stat(path.resolve(targetPath));
    return stat.isFile();
  } catch {
    return false;
  }
}

function firstEnv(...names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name];
    }
  }
  return "";
}

function probeCommand(command, commandArgs, timeoutMs) {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ ok: false, error: "command is not configured." });
      return;
    }

    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: `${command} timed out.` });
    }, timeoutMs);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message || String(error) });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: exitCode === 0,
        error: exitCode === 0 ? "" : stderr.trim() || `${command} exited with code ${exitCode}.`,
      });
    });
  });
}

function printHumanSummary(summary) {
  for (const check of summary.checks) {
    const label = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${label}] ${check.name}: ${check.detail}`);
    if (check.status !== "pass" && check.remediation) {
      console.log(`       ${check.remediation}`);
    }
  }

  console.log("");
  console.log(
    summary.ok
      ? `Local loop readiness passed with ${summary.warnings} warning(s).`
      : `Local loop readiness failed: ${summary.failed} failure(s), ${summary.warnings} warning(s).`
  );
}
