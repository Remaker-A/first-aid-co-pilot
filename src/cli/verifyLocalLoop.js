#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/loadEnv.js";
import {
  createVoiceDemoService,
  evaluateGemmaModelCheck,
  findGemmaModelFile,
  GEMMA_PLACEHOLDER_MIN_BYTES,
  resolveGemmaConfig,
  synthesizeSpeech
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

  const modelInspection = await inspectGemmaModelFile(config);
  const modelCheck = evaluateGemmaModelCheck(modelInspection, { requireRealGemma });
  addCheck("gemma.model_file", modelCheck.status, modelCheck.detail, modelCheck.remediation);

  const commandProbe = await probeCommand(config.command, [...config.commandPrefixArgs, "--help"], 5000);
  const commandDetail = commandProbe.ok
    ? `${config.command} is callable.`
    : await describeGemmaCommandFailure(config.command, commandProbe.error);
  addCheck(
    "gemma.litert_cli",
    commandProbe.ok ? "pass" : requireRealGemma ? "fail" : "warn",
    commandDetail,
    describeGemmaRunnerRemediation(commandProbe.error)
  );
}

async function inspectGemmaModelFile(config) {
  const inspection = {
    found: false,
    file: null,
    bytes: 0,
    placeholder: false,
    modelDir: config.modelDir,
    modelRepo: config.modelRepo,
  };

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

  if (!modelFile) {
    return inspection;
  }

  const stat = await fs.stat(path.resolve(modelFile));
  return {
    ...inspection,
    found: true,
    file: path.resolve(modelFile),
    bytes: stat.size,
    placeholder: stat.size > 0 && stat.size < GEMMA_PLACEHOLDER_MIN_BYTES,
  };
}

function describeGemmaRunnerRemediation(error = "") {
  const base = "Install a working litert-lm runner, or set GEMMA_COMMAND/LITERT_LM_COMMAND to a callable executable.";
  if (/uv trampoline failed to canonicalize script path/i.test(error)) {
    return [
      `${base} The current litert-lm command is a broken uv trampoline shim.`,
      "Reinstall litert-lm in an environment with PyPI access, or point GEMMA_COMMAND at a known-good local runner."
    ].join(" ");
  }

  return base;
}

async function describeGemmaCommandFailure(command, error = "") {
  if (!/uv trampoline failed to canonicalize script path/i.test(error)) {
    return error;
  }

  const trampoline = await inspectUvTrampoline(command);
  if (!trampoline?.pythonPath) {
    return error;
  }

  const targetProbe = await probeCommand(trampoline.pythonPath, ["--version"], 2000);
  const targetDetail = targetProbe.ok
    ? "embedded Python target is callable"
    : `embedded Python target is not callable: ${targetProbe.error}`;
  return `${error}; embedded Python target: ${trampoline.pythonPath}; ${targetDetail}`;
}

async function inspectUvTrampoline(command) {
  const commandPath = await resolveCommandPath(command);
  if (!commandPath) {
    return null;
  }

  let binaryText = "";
  try {
    binaryText = (await fs.readFile(commandPath)).toString("latin1");
  } catch {
    return null;
  }

  const pythonPath = binaryText.match(/[A-Z]:\\Users\\[^"\0\r\n]+?\\uv\\tools\\litert-lm\\Scripts\\python\.exe/i)?.[0] || null;
  return {
    commandPath,
    pythonPath,
  };
}

async function resolveCommandPath(command) {
  if (!command) {
    return null;
  }

  if (path.isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return (await fileExists(command)) ? path.resolve(command) : null;
  }

  const pathDirs = splitPathEnv(process.env.Path || process.env.PATH || "");
  const extensions = process.platform === "win32"
    ? splitPathEnv(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    : [""];
  const names = process.platform === "win32" && !path.extname(command)
    ? extensions.map((extension) => `${command}${extension.toLowerCase()}`)
    : [command];

  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function splitPathEnv(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
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
    result = await service.handleTurn(await createVoiceSmokeInput());
  } catch (error) {
    addCheck("voice.smoke", "fail", error.message || "voice smoke failed");
    return;
  }

  const transcriptDetail = `${result.transcript || "<empty>"} (source: ${result.stt?.source || "unknown"}, intent: ${result.stt?.intent || "none"})`;
  const transcriptOk = requireRealSpeech
    ? Boolean(result.transcript) &&
      result.stt?.source === "sherpa_onnx_stt"
    : result.transcript === "他没有反应";
  addCheck("voice.transcript", transcriptOk ? "pass" : "fail", transcriptDetail);
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

async function createVoiceSmokeInput() {
  const baseInput = {
    sessionId: "verify_local_loop",
    patientState: { scene_safe: true },
  };

  if (!requireRealSpeech) {
    return {
      ...baseInput,
      text: "他没有反应",
    };
  }

  const tts = await synthesizeSpeech("他没有反应", { provider: "sherpa" });
  if (!tts?.ok || !tts.audio?.path) {
    addCheck(
      "speech.tts_real_smoke",
      "fail",
      tts?.error?.message || "real TTS did not produce a WAV file."
    );
    return {
      ...baseInput,
      text: "他没有反应",
    };
  }

  const ttsAudio = await fs.readFile(tts.audio.path);
  addCheck("speech.tts_real_smoke", "pass", `${tts.audio.path} (${ttsAudio.length} bytes)`);

  const sttFixture = await findSttFixtureAudio();
  if (!sttFixture) {
    addCheck(
      "speech.stt_real_fixture",
      "fail",
      "No fixed STT fixture wav found under models/speech/stt/test_wavs."
    );
    return {
      ...baseInput,
      audioBase64: ttsAudio.toString("base64"),
      mimeType: "audio/wav",
    };
  }

  const sttAudio = await fs.readFile(sttFixture);
  addCheck("speech.stt_real_fixture", "pass", `${sttFixture} (${sttAudio.length} bytes)`);
  return {
    ...baseInput,
    audioBase64: sttAudio.toString("base64"),
    mimeType: "audio/wav",
    patientState: { scene_safe: true, responsive: false },
  };
}

async function findSttFixtureAudio() {
  const candidates = [
    path.resolve("models", "speech", "stt", "test_wavs", "zh.wav"),
    path.resolve("models", "speech", "stt", "test_wavs", "yue.wav"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
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

    let child;
    try {
      child = spawn(command, commandArgs, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: error.message || String(error) });
      return;
    }
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
