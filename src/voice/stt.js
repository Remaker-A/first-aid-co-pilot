import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canUseSpeechDaemon, requestSttDaemon } from "./speechDaemon.js";
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
    intent: "scene_unsafe",
    pattern:
      /(unsafe|danger|不安全|不可以靠近|不能靠近|别靠近|不要靠近|不要接近|(?:现场|周围|环境|这里|附近)(?:有|存在|很|比较)?危险|(?:^|[，。,.！!\s])有危险(?:物|品)?|存在危险|有触电|有火|有车流|有泄漏)/i,
  },
  {
    intent: "scene_safe",
    pattern:
      /(scene\s+safe|safe now|现场.*安全|周围.*安全|环境.*安全|已.*确认.*安全|已经.*确认.*安全|确认.*安全|安全了|可以.*(?:靠近|接近)|能够.*(?:靠近|接近)|能.*(?:靠近|接近)|(?:没有|无).*危险|靠近患者|接近患者|在患者身边|到患者身边)/i,
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
    intent: "agonal_breathing",
    pattern: /(gasping|agonal|喘息|濒死呼吸|喘一下|偶尔喘|只是?喘|只有.*喘|一阵一阵喘)/i,
  },
  {
    intent: "no_normal_breathing",
    pattern: /(not breathing|no breathing|abnormal breathing|没有正常呼吸|没有呼吸|没呼吸|无呼吸|呼吸不正常|不正常呼吸)/i,
  },
  {
    intent: "normal_breathing",
    pattern: /(normal breathing|breathing normally|正常呼吸|有正常呼吸)/i,
  },
  // Return of signs of life / ROSC during CPR ("他动了/他在喘气了/又有呼吸了/恢复了").
  // Placed after the explicit responsive/breathing intents so shared phrases like
  // "清醒了"/"有反应了" still resolve to those; these only own the genuinely new
  // wording. The state machine (S7) uses them to stop compressions and monitor.
  {
    intent: "patient_recovered",
    pattern: /(醒过来了?|苏醒了?|清醒了?|缓过来了?|缓过神|恢复了?(?:意识|知觉|过来)?|活过来了?|有意识了)/,
  },
  {
    intent: "signs_of_life",
    pattern: /(?:他|她)?(?:又|开始|现在)?(?:动了|动一下|动了一下|有动静|睁眼了?|睁开眼了?|有反应了|有脉搏|脉搏回来|心跳(?:回来|恢复)了?|又有呼吸|又能呼吸|有呼吸了|开始呼吸了?|在喘气|喘气了|会动了)/,
  },
  {
    intent: "ask_cpr_quality",
    pattern: /(按得对|按的对|这样.*(可以|对吗|行吗)|我.*按.*(对吗|可以吗|行吗)|我爱你的对吗|位置.*对吗|节奏.*对吗|质量.*怎么样)/i,
  },
  {
    intent: "ask_can_stop",
    pattern: /(能不能停|能不能听|可不可以停|可以停|能停|要不要停|是不是.*停|还要(?:再|继续)?按(?:吗|多久)?|还要按多久|按到什么时候|一直(?:这样|这么)?按(?:吗|下去)?|要一直按|就这样一直按|一直按到什么时候|一直按多久)/i,
  },
  {
    intent: "aed_available",
    pattern: /(?:aed|a\s*e\s*d|除颤仪|除颤器|自动体外除颤(?:仪|器)?|电击器|[说需]?[除出]?颤[仪姨器]|出差[一姨仪疑]|说?差[一姨仪疑]).*?(来了|到了|到达|拿来|拿来了|取来|取来了|送来|送来了)|(?:来了|到了|到达|拿来了|取来了|送来了).*?(aed|a\s*e\s*d|除颤仪|除颤器|自动体外除颤(?:仪|器)?|电击器|[说需]?[除出]?颤[仪姨器]|出差[一姨仪疑]|说?差[一姨仪疑])/i,
  },
  {
    intent: "ask_aed_cpr_alternation",
    pattern: /(?:(?:aed|a\s*e\s*d|除颤仪|除颤器|自动体外除颤(?:仪|器)?|电击器|[说需]?[除出]?颤[仪姨器]|出差[一姨仪疑]|说?差[一姨仪疑]).*?(?:按压|CPR|心肺复苏).*?(?:交替|轮换|配合|怎么交替|怎么配合)|(?:按压|CPR|心肺复苏).*?(?:aed|a\s*e\s*d|除颤仪|除颤器|自动体外除颤(?:仪|器)?|电击器|[说需]?[除出]?颤[仪姨器]|出差[一姨仪疑]|说?差[一姨仪疑]).*?(?:交替|轮换|配合|怎么交替|怎么配合))/i,
  },
  {
    intent: "ask_aed_help",
    pattern: /(?:aed|a\s*e\s*d|除颤仪|除颤器|自动体外除颤(?:仪|器)?|电击器|[说需]?[除出]?颤[仪姨器]|出差[一姨仪疑]|说?差[一姨仪疑]).*?(怎么办|怎么用|要怎么做|怎么做|在哪|在哪里|贴哪|怎么贴|怎么打开)/i,
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
    pattern: /(called|call connected|120.*(已打|打了|拨打|已拨|接通|多打)|(?:已|已经)?(?:拨打|拨通|打了?|呼叫|多打)120|急救电话.*(通|打))/i,
  },
  {
    intent: "continue_cpr",
    pattern: /(continue cpr|start cpr|start pressing|keep pressing|开始按|开始 CPR|开始心肺复苏|继续按|继续 CPR|继续心肺复苏)/i,
  },
  {
    intent: "paramedics_arrived",
    pattern: /(paramedics|ems arrived|ambulance arrived|(?:120|幺二零|一二零).*(到|来|到了|来了|到达)|急救员.*(到|来)|急救人员.*(到|来|大佬)|救[护货]车.*(到|来)|医生.*(到|来)|医护.*(到|来|赶到)|救援.*(到|来))/i,
  },
  // "你说我做" CPR coach feedback intents. Placed last so they only win when no
  // existing flow intent matches (ties resolve to lower rule_index). Note:
  // compressions_reported must NOT match continue_cpr phrases ("开始按"/"继续按"),
  // and step_done must NOT match "准备好了" because S6 readiness is handled by
  // service.js with a stage-gated continue_cpr fast path.
  {
    intent: "compressions_reported",
    pattern: /(按了\s*\d+\s*[次下]?|压了\s*\d+\s*[次下]?|按了三十|压了三十|已经按了|已经在按|在按了|按完了|压完了|按了|压了)/,
  },
  {
    intent: "step_done",
    pattern: /(放好了|摆好了|做好了|弄好了|放好啦|明白了?|懂了|知道了|可以了|完成了|搞定了?|好啦|(?<!准备)好了)/,
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

export function classifyIntent(transcript = "") {
  const text = normalizeText(transcript);
  if (!text) {
    return {
      intent: null,
      score: 0,
      candidates: []
    };
  }

  const candidates = [];
  for (const [index, rule] of INTENT_RULES.entries()) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      candidates.push({
        intent: rule.intent,
        score: normalizeIntentRuleScore(rule.score),
        rule_index: index
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.rule_index - right.rule_index;
  });

  const best = candidates[0] || null;
  return {
    intent: best?.intent || null,
    score: best?.score || 0,
    candidates
  };
}

export function inferIntent(transcript = "") {
  return classifyIntent(transcript).intent;
}

// Resolve how to invoke the real STT engine. An explicit command (set by an
// advanced user) always wins for backward compatibility; otherwise we default
// to the bundled Python sherpa-onnx wrapper.
export function resolveSttPlan(options = {}) {
  const modelDir = firstNonEmpty(options.modelDir, process.env.SPEECH_STT_MODEL_DIR) || DEFAULT_MODEL_DIR;
  const language = firstNonEmpty(options.language, process.env.SPEECH_LANGUAGE) || "auto";
  const timeoutMs = positiveNumber(options.timeoutMs, process.env.VOICE_STT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const numThreads = positiveNumber(options.numThreads, process.env.SPEECH_STT_NUM_THREADS, 2);

  const explicitCommand = firstNonEmpty(
    options.sherpaCommand,
    process.env.SHERPA_ONNX_STT_COMMAND,
    process.env.SPEECH_STT_COMMAND
  );
  const explicitArgs = firstNonEmpty(options.sherpaArgs, process.env.SHERPA_ONNX_STT_ARGS);
  if (explicitCommand) {
    const wrapperScript = resolveBundledWrapperScript(explicitArgs, "sherpa_stt.py");
    if (wrapperScript) {
      return {
        mode: "script",
        command: explicitCommand,
        script: wrapperScript,
        modelDir,
        language,
        numThreads,
        timeoutMs,
      };
    }

    return {
      mode: "command",
      command: explicitCommand,
      argsTemplate: explicitArgs,
      modelDir,
      language,
      timeoutMs,
    };
  }

  const python =
    firstNonEmpty(options.python, process.env.SPEECH_STT_PYTHON, process.env.SPEECH_PYTHON) || DEFAULT_PYTHON;
  const script = firstNonEmpty(options.script, process.env.SPEECH_STT_SCRIPT) || DEFAULT_STT_SCRIPT;

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
    if (canUseSpeechDaemon(plan)) {
      try {
        const response = await requestSttDaemon(plan, { audioPath });
        const transcript = normalizeText(response.text || response.transcript || response.result);
        if (!transcript) {
          throw new Error("sherpa-onnx STT daemon did not produce transcript text.");
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
          daemon: true,
        };
      } catch {
        // Fall through to the one-shot CLI path so daemon startup/crash/timeout
        // never makes real STT less reliable than the previous behavior.
      }
    }

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
  const intentClassification = classifyIntent(transcript);

  return {
    transcript,
    intent: intentClassification.intent,
    confidence,
    source,
    audio,
    intent_classification: intentClassification,
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

function normalizeIntentRuleScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) {
    return 0.9;
  }
  return Math.min(1, score);
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
