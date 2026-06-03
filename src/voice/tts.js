import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canUseSpeechDaemon, requestTtsDaemon } from "./speechDaemon.js";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(VOICE_DIR, "..", "..");
const RUNTIME_DIR = path.join(VOICE_DIR, ".runtime");
const DEFAULT_TTS_SCRIPT = path.join(REPO_ROOT, "scripts", "speech", "sherpa_tts.py");
const DEFAULT_MODEL_DIR = path.join(REPO_ROOT, "models", "speech", "tts");
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const DEFAULT_TIMEOUT_MS = 15000;

export async function synthesizeSpeech(text, options = {}) {
  const normalizedText = typeof text === "string" ? text : "";
  const provider = normalizeProvider(
    options.provider || process.env.VOICE_TTS_PROVIDER || process.env.SPEECH_MODE || "auto"
  );
  const plan = resolveTtsPlan(options);

  if (shouldAttemptRealTts(provider, plan)) {
    try {
      return await synthesizeWithSherpa(normalizedText, plan);
    } catch (error) {
      return {
        provider: "mock",
        ok: false,
        text: normalizedText,
        error: normalizeError(error),
        audio: createMockAudio(normalizedText),
      };
    }
  }

  return {
    provider: "mock",
    ok: true,
    text: normalizedText,
    audio: createMockAudio(normalizedText),
  };
}

export function createMockAudio(text = "") {
  return {
    kind: "silent_wav",
    mime_type: "audio/wav",
    data_url: createSilentWavDataUrl(0.25),
    text,
  };
}

export function getRuntimeDir() {
  return RUNTIME_DIR;
}

export function resolveTtsPlan(options = {}) {
  const modelDir = firstNonEmpty(options.modelDir, process.env.SPEECH_TTS_MODEL_DIR) || DEFAULT_MODEL_DIR;
  const timeoutMs = positiveNumber(options.timeoutMs, process.env.VOICE_TTS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const sid = numberValue(options.sid, process.env.SPEECH_TTS_SID, 0);
  const speed = positiveNumber(options.speed, process.env.SPEECH_TTS_SPEED, 1);
  const numThreads = positiveNumber(options.numThreads, process.env.SPEECH_TTS_NUM_THREADS, 2);
  const explicitCommand = firstNonEmpty(
    options.sherpaCommand,
    process.env.SHERPA_ONNX_TTS_COMMAND,
    process.env.SPEECH_TTS_COMMAND
  );
  const explicitArgs = firstNonEmpty(options.sherpaArgs, process.env.SHERPA_ONNX_TTS_ARGS);

  if (explicitCommand) {
    const wrapperScript = resolveBundledWrapperScript(explicitArgs, "sherpa_tts.py");
    if (wrapperScript) {
      return {
        mode: "script",
        command: explicitCommand,
        script: wrapperScript,
        modelDir,
        sid,
        speed,
        numThreads,
        timeoutMs,
        explicit: true,
      };
    }

    return {
      mode: "command",
      command: explicitCommand,
      argsTemplate: explicitArgs,
      modelDir,
      timeoutMs,
      explicit: true,
    };
  }

  const python =
    firstNonEmpty(options.python, process.env.SPEECH_TTS_PYTHON, process.env.SPEECH_PYTHON) || DEFAULT_PYTHON;
  const script = firstNonEmpty(options.script, process.env.SPEECH_TTS_SCRIPT) || DEFAULT_TTS_SCRIPT;

  return {
    mode: "script",
    command: python,
    script: path.resolve(script),
    modelDir,
    sid,
    speed,
    numThreads,
    timeoutMs,
    explicit: false,
  };
}

export function buildTtsInvocation(plan, { text, outputPath }) {
  if (plan.mode === "command") {
    return {
      command: plan.command,
      args: buildSherpaArgs(plan.argsTemplate, text, outputPath, plan.modelDir),
    };
  }

  const args = [
    toChildProcessPath(plan.script),
    "--model-dir",
    toChildProcessPath(path.resolve(plan.modelDir)),
    "--output",
    toChildProcessPath(outputPath),
    "--text",
    text,
    "--sid",
    String(plan.sid ?? 0),
    "--speed",
    String(plan.speed ?? 1),
  ];
  if (plan.numThreads) {
    args.push("--num-threads", String(plan.numThreads));
  }
  return { command: plan.command, args };
}

async function synthesizeWithSherpa(text, plan) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  const fileName = `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`;
  const outputPath = path.join(RUNTIME_DIR, fileName);

  if (canUseSpeechDaemon(plan)) {
    try {
      await requestTtsDaemon(plan, { text, outputPath });
      await assertAudioFile(outputPath);
      return createSherpaResult({ text, fileName, outputPath, daemon: true });
    } catch {
      // Fall through to the one-shot CLI path so daemon startup/crash/timeout
      // remains an optimization, not a new hard dependency.
    }
  }

  const { command, args } = buildTtsInvocation(plan, { text, outputPath });
  const result = await runCommand(command, args, plan.timeoutMs);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `sherpa-onnx TTS exited with code ${result.exitCode}`);
  }

  await assertAudioFile(outputPath);

  return createSherpaResult({ text, fileName, outputPath, daemon: false });
}

async function assertAudioFile(outputPath) {
  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error("sherpa-onnx TTS did not produce an audio file.");
  }
}

function createSherpaResult({ text, fileName, outputPath, daemon }) {
  return {
    provider: "sherpa-onnx",
    ok: true,
    text,
    daemon,
    audio: {
      kind: "file",
      mime_type: "audio/wav",
      url: `/api/audio/${encodeURIComponent(fileName)}`,
      path: outputPath,
    },
  };
}

function buildSherpaArgs(template, text, outputPath, modelDir) {
  if (!template) {
    return ["--text", text, "--output", outputPath];
  }

  return splitArgs(template).map((item) =>
    item
      .replaceAll("{text}", text)
      .replaceAll("{out}", outputPath)
      .replaceAll("{output}", outputPath)
      .replaceAll("{output_path}", outputPath)
      .replaceAll("{model_dir}", modelDir)
  );
}

function splitArgs(value) {
  return value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((item) =>
    item.replace(/^["']|["']$/g, "")
  ) || [];
}

function resolveBundledWrapperScript(template, scriptName) {
  const match = splitArgs(template).find((item) =>
    item.replace(/\\/g, "/").toLowerCase().endsWith(`/scripts/speech/${scriptName}`) ||
    item.replace(/\\/g, "/").toLowerCase().endsWith(scriptName)
  );
  return match ? path.resolve(match) : "";
}

function toChildProcessPath(targetPath) {
  if (!targetPath) {
    return targetPath;
  }

  const absolute = path.resolve(targetPath);
  const relative = path.relative(process.cwd(), absolute);
  if (
    relative &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return relative;
  }

  return absolute;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`sherpa-onnx TTS timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function createSilentWavDataUrl(seconds) {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.floor(sampleRate * seconds));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return `data:audio/wav;base64,${buffer.toString("base64")}`;
}

function normalizeProvider(provider) {
  const value = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (value === "sherpa-onnx") {
    return "sherpa";
  }
  return value || "auto";
}

function shouldAttemptRealTts(provider, plan) {
  return provider === "sherpa" || (provider === "auto" && (plan.explicit || canUseSpeechDaemon(plan)));
}

function normalizeError(error) {
  return {
    message: error?.message || "TTS failed.",
    code: error?.code,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function positiveNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return undefined;
}

function numberValue(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return undefined;
}
