import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeDir } from "./tts.js";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(VOICE_DIR, "..", "..");

// Canonical offline STT pipeline: a Python wrapper around sherpa-onnx SenseVoice.
// All of these are injectable through options or environment variables so the
// adapter never hardcodes a single machine layout.
const DEFAULT_STT_SCRIPT = path.join(REPO_ROOT, "scripts", "speech", "sherpa_stt.py");
const DEFAULT_MODEL_DIR = path.join(REPO_ROOT, "models", "speech", "stt");
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const DEFAULT_TIMEOUT_MS = 20000;

// Recommended public model so the fallback hint can tell the user exactly what
// to download and where to put it (mirrors scripts/setupSpeech.ps1).
const RECOMMENDED_STT_MODEL = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
const RECOMMENDED_STT_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2";

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
    intent: "ask_cpr_quality",
    pattern: /(按得对|按的对|这样.*(可以|对吗|行吗)|我.*按.*(对吗|可以吗|行吗)|我爱你的对吗|位置.*对吗|节奏.*对吗|质量.*怎么样)/i,
  },
  {
    intent: "ask_can_stop",
    pattern: /(能不能停|能不能听|可以停|能停|要不要停|是不是.*停|还要按多久|按到什么时候)/i,
  },
  {
    intent: "ask_aed_help",
    pattern: /(aed|a e d|除颤仪|自动体外除颤|电击|[说需]?[除出]?颤[仪姨]|出差[一姨仪疑]).*?(来了|到了|怎么办|怎么用|要怎么做)|(?:来了|到了).*?(aed|除颤仪|[说需]?[除出]?颤[仪姨]|出差[一姨仪疑])/i,
  },
  {
    intent: "ask_next_step",
    pattern: /(下一步|接下来|现在怎么办|现在做什么|然后呢|下一步做什么|我该怎么办)/i,
  },
  {
    intent: "ask_emergency_call",
    pattern: /(要不要.*120|需不需要.*120|现在.*打120|120.*要不要|120.*需不需要|急救电话.*要不要|急救电话.*打吗)/i,
  },
  {
    intent: "emergency_called",
    pattern: /(called|call connected|120.*(已打|打了|拨打|已拨|接通)|(?:已|已经)?(?:拨打|拨通|打了?|呼叫)120|急救电话.*(通|打))/i,
  },
  {
    intent: "continue_cpr",
    pattern: /(continue cpr|start cpr|start pressing|keep pressing|开始按|开始 CPR|开始心肺复苏|继续按|继续 CPR|继续心肺复苏)/i,
  },
  {
    intent: "paramedics_arrived",
    pattern: /(paramedics|ems arrived|ambulance arrived|急救员.*(到|来)|急救人员.*(到|来|大佬)|救[护货]车.*(到|来)|医生.*(到|来)|医护.*(到|来|赶到)|救援.*(到|来))/i,
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

  if (audio && audioBase64 && shouldAttemptRealStt(provider)) {
    const plan = resolveSttPlan(options);

    // Script mode owns the model directory, so we can fail fast with a precise
    // "what is missing / what to download / where to put it" hint instead of
    // spawning Python only to watch it crash on a missing model.
    if (plan.mode === "script") {
      const model = await inspectSttModel(plan.modelDir);
      if (!model.ready) {
        return mockAudioFallback(audio, {
          error: { message: `STT model missing under ${model.dir}.`, code: "stt_model_missing" },
          hint: buildModelMissingHint(model.dir, model.missing),
        });
      }
    }

    try {
      return await transcribeWithSherpa(audioBase64, audio, plan);
    } catch (error) {
      if (shouldRetryWithAutoLanguage(plan, error)) {
        try {
          return {
            ...(await transcribeWithSherpa(audioBase64, audio, {
              ...plan,
              language: "auto",
            })),
            language_retry: "auto",
          };
        } catch (retryError) {
          return mockAudioFallback(audio, {
            error: normalizeError(retryError),
            hint: buildRuntimeHint({ ...plan, language: "auto" }, retryError),
          });
        }
      }

      return mockAudioFallback(audio, {
        error: normalizeError(error),
        hint: buildRuntimeHint(plan, error),
      });
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

// Resolve how to invoke the real STT engine. An explicit command (set by an
// advanced user) always wins for backward compatibility; otherwise we default
// to the bundled Python sherpa-onnx wrapper.
export function resolveSttPlan(options = {}) {
  const modelDir = firstNonEmpty(options.modelDir, process.env.SPEECH_STT_MODEL_DIR) || DEFAULT_MODEL_DIR;
  const language = firstNonEmpty(options.language, process.env.SPEECH_LANGUAGE) || "auto";
  const timeoutMs = positiveNumber(options.timeoutMs, process.env.VOICE_STT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const explicitCommand = firstNonEmpty(
    options.sherpaCommand,
    process.env.SHERPA_ONNX_STT_COMMAND,
    process.env.SPEECH_STT_COMMAND
  );
  if (explicitCommand) {
    return {
      mode: "command",
      command: explicitCommand,
      argsTemplate: firstNonEmpty(options.sherpaArgs, process.env.SHERPA_ONNX_STT_ARGS),
      modelDir,
      language,
      timeoutMs,
    };
  }

  const python =
    firstNonEmpty(options.python, process.env.SPEECH_STT_PYTHON, process.env.SPEECH_PYTHON) || DEFAULT_PYTHON;
  const script = firstNonEmpty(options.script, process.env.SPEECH_STT_SCRIPT) || DEFAULT_STT_SCRIPT;
  const numThreads = positiveNumber(options.numThreads, process.env.SPEECH_STT_NUM_THREADS, 2);

  return {
    mode: "script",
    command: python,
    script: path.resolve(script),
    modelDir,
    language,
    numThreads,
    timeoutMs,
  };
}

// Build the exact argv used to spawn the STT engine. Exported so tests can
// assert that the real command path is constructed correctly without a model.
export function buildSttInvocation(plan, { audioPath, outputPath }) {
  if (plan.mode === "command") {
    return {
      command: plan.command,
      args: buildCommandArgs(plan.argsTemplate, {
        audioPath,
        outputPath,
        modelDir: plan.modelDir,
        language: plan.language,
      }),
    };
  }

  const args = [
    toChildProcessPath(plan.script),
    "--model-dir",
    toChildProcessPath(path.resolve(plan.modelDir)),
    "--audio",
    toChildProcessPath(audioPath),
    "--language",
    plan.language,
  ];
  if (plan.numThreads) {
    args.push("--num-threads", String(plan.numThreads));
  }

  return { command: plan.command, args };
}

async function transcribeWithSherpa(audioBase64, audio, plan) {
  await fs.mkdir(getRuntimeDir(), { recursive: true });
  const baseName = `stt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const audioPath = path.join(getRuntimeDir(), `${baseName}${audio.extension}`);
  const outputPath = path.join(getRuntimeDir(), `${baseName}.txt`);

  await fs.writeFile(audioPath, Buffer.from(audioBase64, "base64"));

  try {
    const { command, args } = buildSttInvocation(plan, { audioPath, outputPath });
    const result = await runCommand(command, args, plan.timeoutMs);

    if (result.exitCode !== 0) {
      throw new Error(
        normalizeText(result.stderr) || `sherpa-onnx STT exited with code ${result.exitCode}`
      );
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
  } finally {
    await cleanupTempFiles([audioPath, outputPath]);
  }
}

function buildCommandArgs(template, { audioPath, outputPath, modelDir, language }) {
  if (!template) {
    return ["--wave-filename", toChildProcessPath(audioPath)];
  }

  return splitArgs(template).map((item) =>
    item
      .replaceAll("{audio}", toChildProcessPath(audioPath))
      .replaceAll("{audio_path}", toChildProcessPath(audioPath))
      .replaceAll("{out}", toChildProcessPath(outputPath))
      .replaceAll("{output}", toChildProcessPath(outputPath))
      .replaceAll("{output_path}", toChildProcessPath(outputPath))
      .replaceAll("{model_dir}", toChildProcessPath(path.resolve(modelDir)))
      .replaceAll("{language}", language)
  );
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
    if (parsed && typeof parsed === "object") {
      if (parsed.error && !normalizeText(parsed.text || parsed.transcript || parsed.result)) {
        throw new Error(`sherpa-onnx STT reported error: ${parsed.error}`);
      }
      return normalizeText(parsed.text || parsed.transcript || parsed.result);
    }
    return "";
  } catch (error) {
    if (error instanceof Error && /reported error/.test(error.message)) {
      throw error;
    }
    return (
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) || ""
    );
  }
}

// Inspect a model directory the same way scripts/speech/sherpa_stt.py does:
// it needs an .onnx acoustic model plus a tokens.txt symbol table.
async function inspectSttModel(modelDir) {
  const dir = path.resolve(modelDir);
  const files = await listFilesRecursive(dir);
  const model = pickByPatterns(files, [/\.int8\.onnx$/i, /[\\/]model\.onnx$/i, /\.onnx$/i]);
  const tokens = files.find((file) => /[\\/]tokens\.txt$/i.test(file)) || null;

  const missing = [];
  if (!model) {
    missing.push("model.int8.onnx（SenseVoice 声学模型，约 228MB）");
  }
  if (!tokens) {
    missing.push("tokens.txt（标记符号表，约 308KB）");
  }

  return { dir, ready: Boolean(model && tokens), model, tokens, missing };
}

async function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return out;
    }
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }

  return out;
}

function pickByPatterns(files, patterns) {
  for (const pattern of patterns) {
    const match = files.filter((file) => pattern.test(file)).sort()[0];
    if (match) {
      return match;
    }
  }
  return null;
}

function buildModelMissingHint(modelDir, missing) {
  const what = missing.length ? missing.join("、") : "STT 模型文件";
  return [
    `未启用真实 STT：${modelDir} 下缺少 ${what}。`,
    `请下载 sherpa-onnx SenseVoice 多语模型（中英日韩粤）：${RECOMMENDED_STT_MODEL}`,
    `  ${RECOMMENDED_STT_URL}`,
    `解压后把 model.int8.onnx 与 tokens.txt 放到 ${modelDir}/，或运行 npm run setup:speech 查看完整安装步骤。`,
    "已临时回退到 mock 转写。",
  ].join("\n");
}

function buildRuntimeHint(plan, error) {
  if (plan.mode === "command") {
    return [
      `真实 STT 命令执行失败：${plan.command}。`,
      "请确认该命令存在、SHERPA_ONNX_STT_ARGS 参数模板正确；或清空命令改用默认的 python + scripts/speech/sherpa_stt.py。",
      "已回退到 mock 转写。",
    ].join("\n");
  }

  if (error?.code === "ENOENT") {
    return [
      `未找到 Python 解释器「${plan.command}」。`,
      "请安装 Python 3（并设置 SPEECH_STT_PYTHON 指向它），再执行 pip install sherpa-onnx numpy。",
      "已回退到 mock 转写。",
    ].join("\n");
  }

  return [
    `真实 STT 运行失败（${plan.command} ${plan.script}）：${error?.message || "unknown error"}。`,
    "常见原因：未 pip install sherpa-onnx / numpy，或音频不是 16k 单声道 wav 且缺少 ffmpeg 转码。",
    "已回退到 mock 转写。",
  ].join("\n");
}

function mockAudioFallback(audio, { error, hint } = {}) {
  return {
    ...createTranscriptResult({
      transcript: mockAudioTranscript(audio),
      source: "mock_audio_stt",
      confidence: 0.45,
      audio,
    }),
    ok: false,
    provider: "mock",
    error,
    hint,
  };
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

function shouldAttemptRealStt(provider) {
  return provider === "sherpa" || provider === "auto";
}

function shouldRetryWithAutoLanguage(plan, error) {
  return (
    plan.language !== "auto" &&
    /invalid unordered_map/i.test(error?.message || "")
  );
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
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
  return (
    value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) || []
  );
}

async function cleanupTempFiles(paths) {
  await Promise.all(
    paths.map(async (target) => {
      try {
        await fs.rm(target, { force: true });
      } catch {
        // Best-effort cleanup; ignore failures.
      }
    })
  );
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
