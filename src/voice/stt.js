import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRuntimeDir } from "./tts.js";

const INTENT_RULES = [
  {
    intent: "scene_safe",
    pattern: /(scene\s+safe|safe now|现场.*安全|安全了|可以靠近)/i,
  },
  {
    intent: "scene_unsafe",
    pattern: /(unsafe|danger|危险|不安全|别靠近)/i,
  },
  {
    intent: "patient_unresponsive",
    pattern: /(unresponsive|no response|not responding|没反应|没有反应|叫不醒|无反应)/i,
  },
  {
    intent: "patient_responsive",
    pattern: /(responsive|responding|有反应|醒了|会回应)/i,
  },
  {
    intent: "no_normal_breathing",
    pattern: /(not breathing|no breathing|abnormal breathing|gasping|没有正常呼吸|没呼吸|无呼吸|喘息|濒死呼吸)/i,
  },
  {
    intent: "normal_breathing",
    pattern: /(normal breathing|breathing normally|正常呼吸|有正常呼吸)/i,
  },
  {
    intent: "emergency_called",
    pattern: /(called|call connected|120.*(已打|打了|接通|已经拨打|已拨打)|急救电话.*(通|打))/i,
  },
  {
    intent: "continue_cpr",
    pattern: /(continue cpr|start cpr|start pressing|keep pressing|开始按|开始 CPR|开始心肺复苏|继续按|继续 CPR|继续心肺复苏)/i,
  },
  {
    intent: "paramedics_arrived",
    pattern: /(paramedics|ems arrived|ambulance arrived|急救员到了|救护车到了|医生到了)/i,
  },
];

export async function transcribeInput(input = {}, options = {}) {
  const text = normalizeText(input.text || input.transcript || input.mockTranscript);
  if (text) {
    return createTranscriptResult({
      transcript: text,
      source: "text_input",
      confidence: inferIntent(text) ? 0.86 : 0.62,
      audio: null,
    });
  }

  const audio = normalizeAudio(input);
  const audioBase64 = normalizeText(input.audioBase64 || input.audio_base64);
  const provider = normalizeProvider(
    options.provider || process.env.VOICE_STT_PROVIDER || process.env.SPEECH_MODE || "auto"
  );
  const sherpaCommand =
    options.sherpaCommand ||
    process.env.SHERPA_ONNX_STT_COMMAND ||
    process.env.SPEECH_STT_COMMAND;

  if (audioBase64 && shouldUseSherpa(provider, sherpaCommand)) {
    try {
      return await transcribeWithSherpa(audioBase64, audio, {
        command: sherpaCommand,
        argsTemplate: options.sherpaArgs || process.env.SHERPA_ONNX_STT_ARGS,
        modelDir: options.modelDir || process.env.SPEECH_STT_MODEL_DIR || "models/speech/stt",
        language: options.language || process.env.SPEECH_LANGUAGE || "zh",
        timeoutMs: options.timeoutMs || Number(process.env.VOICE_STT_TIMEOUT_MS) || 15000,
      });
    } catch (error) {
      return {
        ...createTranscriptResult({
          transcript: mockAudioTranscript(audio),
          source: "mock_audio_stt",
          confidence: 0.45,
          audio,
        }),
        ok: false,
        provider: "mock",
        error: normalizeError(error),
      };
    }
  }

  return mockTranscribeInput(input);
}

export async function mockTranscribeInput(input = {}) {
  const text = normalizeText(input.text || input.transcript || input.mockTranscript);
  const audio = normalizeAudio(input);
  const transcript = text || mockAudioTranscript(audio);

  return createTranscriptResult({
    transcript,
    source: audio ? "mock_audio_stt" : "text_input",
    confidence: transcript ? (inferIntent(transcript) ? 0.86 : 0.62) : 0,
    audio,
  });
}

export function inferIntent(transcript = "") {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(transcript)) {
      return rule.intent;
    }
  }

  return null;
}

async function transcribeWithSherpa(audioBase64, audio, options) {
  await fs.mkdir(getRuntimeDir(), { recursive: true });
  const baseName = `stt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const audioPath = path.join(getRuntimeDir(), `${baseName}${audio.extension}`);
  const outputPath = path.join(getRuntimeDir(), `${baseName}.txt`);

  await fs.writeFile(audioPath, Buffer.from(audioBase64, "base64"));

  const args = buildSherpaSttArgs(options.argsTemplate, {
    audioPath,
    outputPath,
    modelDir: options.modelDir,
    language: options.language,
  });
  const result = await runCommand(options.command, args, options.timeoutMs);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `sherpa-onnx STT exited with code ${result.exitCode}`);
  }

  const transcript = await readTranscript(result.stdout, outputPath);
  if (!transcript) {
    throw new Error("sherpa-onnx STT did not produce transcript text.");
  }

  return {
    ...createTranscriptResult({
      transcript,
      source: "sherpa_onnx_stt",
      confidence: 0.72,
      audio,
    }),
    ok: true,
    provider: "sherpa-onnx",
  };
}

function buildSherpaSttArgs(template, { audioPath, outputPath, modelDir, language }) {
  if (!template) {
    return ["--wave-filename", audioPath];
  }

  return splitArgs(template).map((item) =>
    item
      .replaceAll("{audio}", audioPath)
      .replaceAll("{audio_path}", audioPath)
      .replaceAll("{out}", outputPath)
      .replaceAll("{output}", outputPath)
      .replaceAll("{output_path}", outputPath)
      .replaceAll("{model_dir}", modelDir)
      .replaceAll("{language}", language)
  );
}

async function readTranscript(stdout, outputPath) {
  const fromStdout = extractTranscriptText(stdout);
  if (fromStdout) {
    return fromStdout;
  }

  try {
    return normalizeText(await fs.readFile(outputPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function extractTranscriptText(stdout) {
  const text = normalizeText(stdout);
  if (!text) {
    return "";
  }

  try {
    const parsed = JSON.parse(text);
    return normalizeText(parsed.text || parsed.transcript || parsed.result);
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || "";
  }
}

function createTranscriptResult({ transcript, source, confidence, audio }) {
  const intent = inferIntent(transcript);

  return {
    transcript,
    intent,
    confidence,
    source,
    audio,
  };
}

function normalizeProvider(provider) {
  const value = normalizeText(provider).toLowerCase();
  if (value === "sherpa-onnx") {
    return "sherpa";
  }
  return value || "auto";
}

function shouldUseSherpa(provider, command) {
  return Boolean(command) && (provider === "sherpa" || provider === "auto");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAudio(input) {
  const audioBase64 = normalizeText(input.audioBase64 || input.audio_base64);
  if (!audioBase64) {
    return null;
  }

  const mimeType = normalizeText(input.mimeType || input.mime_type) || "application/octet-stream";
  return {
    mime_type: mimeType,
    byte_length: Buffer.byteLength(audioBase64, "base64"),
    extension: extensionForMimeType(mimeType),
  };
}

function extensionForMimeType(mimeType) {
  if (/wav/i.test(mimeType)) {
    return ".wav";
  }
  if (/mpeg|mp3/i.test(mimeType)) {
    return ".mp3";
  }
  if (/ogg/i.test(mimeType)) {
    return ".ogg";
  }
  if (/webm/i.test(mimeType)) {
    return ".webm";
  }
  return ".audio";
}

function mockAudioTranscript(audio) {
  if (!audio) {
    return "";
  }

  return "[mock audio transcript] 请继续急救流程。";
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
      reject(new Error(`sherpa-onnx STT timed out after ${timeoutMs}ms.`));
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

function normalizeError(error) {
  return {
    message: error?.message || "STT failed.",
    code: error?.code,
  };
}
