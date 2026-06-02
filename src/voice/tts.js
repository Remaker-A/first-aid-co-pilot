import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(VOICE_DIR, ".runtime");

export async function synthesizeSpeech(text, options = {}) {
  const normalizedText = typeof text === "string" ? text : "";
  const provider = normalizeProvider(
    options.provider || process.env.VOICE_TTS_PROVIDER || process.env.SPEECH_MODE || "auto"
  );
  const sherpaCommand =
    options.sherpaCommand ||
    process.env.SHERPA_ONNX_TTS_COMMAND ||
    process.env.SPEECH_TTS_COMMAND;

  if ((provider === "sherpa" || provider === "auto") && sherpaCommand) {
    try {
      return await synthesizeWithSherpa(normalizedText, {
        command: sherpaCommand,
        argsTemplate: options.sherpaArgs || process.env.SHERPA_ONNX_TTS_ARGS,
        modelDir: options.modelDir || process.env.SPEECH_TTS_MODEL_DIR || "models/speech/tts",
        timeoutMs: options.timeoutMs || Number(process.env.VOICE_TTS_TIMEOUT_MS) || 15000,
      });
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

async function synthesizeWithSherpa(text, options) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  const fileName = `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`;
  const outputPath = path.join(RUNTIME_DIR, fileName);
  const args = buildSherpaArgs(options.argsTemplate, text, outputPath, options.modelDir);
  const result = await runCommand(options.command, args, options.timeoutMs);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `sherpa-onnx TTS exited with code ${result.exitCode}`);
  }

  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error("sherpa-onnx TTS did not produce an audio file.");
  }

  return {
    provider: "sherpa-onnx",
    ok: true,
    text,
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

function normalizeError(error) {
  return {
    message: error?.message || "TTS failed.",
    code: error?.code,
  };
}
