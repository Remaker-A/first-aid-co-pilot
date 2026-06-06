import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildGemmaMessages, buildGemmaPrompt } from "./promptBuilder.js";
import { buildGemmaNluMessages } from "./nluPrompt.js";
import { parseGemmaNluResponse } from "./nluResponseParser.js";
import { parseGemmaResponse } from "./responseParser.js";
import {
  buildHandoverNarrativeMessages,
  parseHandoverNarrativeResponse
} from "./handoverNarrativePrompt.js";
import { createGemmaFallbackPatch } from "./fallbackPolicy.js";
import { requestGemma } from "./gemmaServer.js";
import {
  DEFAULT_GEMMA_MODEL_FILE_PATTERN,
  DEFAULT_GEMMA_TIMEOUT_MS,
  GEMMA_PLACEHOLDER_MIN_BYTES,
  describeGemmaModelSetup,
  describeMissingGemmaModel,
  resolveGemmaConfig
} from "./modelConfig.js";

export const DEFAULT_GEMMA_NLU_TIMEOUT_MS = 600;
export const DEFAULT_GEMMA_WARMUP_TIMEOUT_MS = 30000;
export const DEFAULT_GEMMA_NARRATIVE_TIMEOUT_MS = 8000;

const GEMMA_WARMUP_MESSAGES = Object.freeze([
  { role: "system", content: "warmup" },
  { role: "user", content: "warmup" }
]);

export class GemmaRuntime {
  constructor(options = {}) {
    this.options = options.config ? { ...options.config, ...options } : options;
    this.runner = options.runner || spawnLiteRtLm;
    this.serverRunner = options.serverRunner || requestGemma;
  }

  async generatePatch(frame, callOptions = {}) {
    return this.run(frame, callOptions);
  }

  async generateText(messages, callOptions = {}) {
    return this.runText(messages, callOptions);
  }

  async parseUserIntent(frame) {
    const config = resolveGemmaConfig(this.options);
    const nluTimeoutMs = resolveGemmaNluTimeoutMs(this.options);
    const requestConfig = {
      ...config,
      timeoutMs: nluTimeoutMs,
      serveRequestTimeoutMs: nluTimeoutMs
    };
    const modelFile = await resolveModelFile(config);

    if (!modelFile) {
      return createNluFallbackResult(frame, "model_missing", {
        message: `No Gemma model file found in ${config.modelDir}.`
      });
    }

    const promptOptions = this.options.nluPromptOptions || this.options.promptOptions || {};
    const messages = buildGemmaNluMessages(frame, promptOptions);
    const prompt = config.supportsMessages
      ? null
      : buildCombinedPrompt(frame, messages, promptOptions);
    const args = buildLiteRtLmArgs({
      ...requestConfig,
      modelFile,
      messages,
      prompt
    });

    let result = null;
    if (config.daemon) {
      try {
        result = await this.serverRunner({
          config: requestConfig,
          messages,
          prompt,
          modelFile,
          timeoutMs: nluTimeoutMs
        });
      } catch {
        result = null;
      }
    }

    if (!result) {
      try {
        result = await this.runner({
          command: config.command,
          args,
          timeoutMs: nluTimeoutMs,
          cwd: config.cwd,
          env: config.env,
          messages,
          prompt,
          modelFile,
          backend: config.backend
        });
      } catch (error) {
        return createNluFallbackResult(frame, classifyRunnerError(error), error);
      }
    }

    if (result?.timedOut) {
      return createNluFallbackResult(frame, "timeout", {
        message: `Gemma NLU exceeded ${nluTimeoutMs}ms.`
      });
    }

    if (result?.exitCode !== 0) {
      return createNluFallbackResult(frame, "cli_exit_nonzero", {
        message: result?.stderr || `Gemma CLI exited with code ${result?.exitCode}.`,
        exitCode: result?.exitCode,
        stderr: result?.stderr
      });
    }

    const parsed = parseGemmaNluResponse(result?.stdout || "", frame);
    if (!parsed.ok) {
      return createNluFallbackResult(frame, parsed.error || "invalid_json", {
        message: parsed.error || "Gemma NLU output was not a valid observation frame.",
        violations: parsed.violations
      });
    }

    return parsed;
  }

  // Process reuse: in daemon mode (`GEMMA_DAEMON`), `parseUserIntent`/`run`
  // already reuse a single resident `serve` process — the daemon is cached in
  // gemmaServer.js keyed by config + model file, so calls hit a warm process
  // instead of cold-starting a 2.4GB model each turn. `prewarm` lets a caller
  // pay the model-load cost up front (e.g. at session start) so the first real
  // NLU turn is fast. It is best-effort and never throws: a failed warmup just
  // means the first turn loads lazily, and one-shot (non-daemon) mode is left
  // untouched so we never spawn a heavyweight child just to warm nothing.
  async prewarm(options = {}) {
    const config = resolveGemmaConfig(this.options);
    if (!config.daemon) {
      return { ok: true, warmed: false, reason: "daemon_disabled" };
    }

    let modelFile = null;
    try {
      modelFile = await resolveModelFile(config);
    } catch {
      modelFile = null;
    }
    if (!modelFile) {
      return { ok: true, warmed: false, reason: "model_missing" };
    }

    const warmupTimeoutMs = positiveWarmupTimeout(
      options.timeoutMs ?? options.warmupTimeoutMs,
      config.serveReadyTimeoutMs,
      config.serveRequestTimeoutMs
    );
    const messages = Array.isArray(options.messages) ? options.messages : GEMMA_WARMUP_MESSAGES;

    try {
      await this.serverRunner({
        config: { ...config, serveRequestTimeoutMs: warmupTimeoutMs },
        messages,
        prompt: null,
        modelFile,
        timeoutMs: warmupTimeoutMs
      });
      return { ok: true, warmed: true, daemon: true };
    } catch (error) {
      return { ok: true, warmed: false, reason: "warmup_failed", error: normalizeError(error) };
    }
  }

  async run(frame, callOptions = {}) {
    const config = resolveGemmaConfig(this.options);
    const timeoutMs = resolveGemmaCallTimeoutMs(callOptions, this.options, config);
    const realtimeBudget = hasExplicitRealtimeBudget(callOptions);
    const requestConfig = {
      ...config,
      timeoutMs,
      serveRequestTimeoutMs: timeoutMs
    };
    const modelFile = await resolveModelFile(config);

    if (!modelFile) {
      return createFallbackResult(frame, "model_missing", {
        message: `No Gemma model file found in ${config.modelDir}.`
      });
    }

    // Per-call prompt overrides (e.g. the WB controlled open-question system prompt)
    // layer over the runtime-level promptOptions without changing the default path.
    const promptOptions = { ...(this.options.promptOptions || {}), ...(callOptions.promptOptions || {}) };
    const messages = buildGemmaMessages(frame, promptOptions);
    const prompt = config.supportsMessages
      ? null
      : buildCombinedPrompt(frame, messages, promptOptions);
    const args = buildLiteRtLmArgs({
      ...requestConfig,
      modelFile,
      messages,
      prompt
    });

    let result = null;
    if (config.daemon) {
      try {
        result = await this.serverRunner({
          config: requestConfig,
          messages,
          prompt,
          modelFile,
          timeoutMs,
        });
      } catch (error) {
        if (realtimeBudget) {
          return createFallbackResult(frame, classifyRunnerError(error), error);
        }
        result = null;
      }
    }

    if (!result) {
      try {
        result = await this.runner({
          command: requestConfig.command,
          args,
          timeoutMs,
          cwd: requestConfig.cwd,
          env: requestConfig.env,
          messages,
          prompt,
          modelFile,
          backend: requestConfig.backend
        });
      } catch (error) {
        return createFallbackResult(frame, classifyRunnerError(error), error);
      }
    }

    if (result?.timedOut) {
      return createFallbackResult(frame, "timeout", {
        message: `Gemma CLI exceeded ${timeoutMs}ms.`
      });
    }

    if (result?.exitCode !== 0) {
      return createFallbackResult(frame, "cli_exit_nonzero", {
        message: result?.stderr || `Gemma CLI exited with code ${result?.exitCode}.`,
        exitCode: result?.exitCode,
        stderr: result?.stderr
      });
    }

    const parsed = parseGemmaResponse(result?.stdout || "", frame);
    if (!parsed.ok) {
      return createFallbackResult(frame, parsed.error || "invalid_json", {
        message: parsed.error || "Gemma CLI output was not a valid patch.",
        violations: parsed.violations
      });
    }

    return parsed;
  }

  // generateNarrative is the S9 handover-NLG path. It is deliberately separate
  // from run()/generatePatch() (which own the realtime guidance contract): it
  // uses the handover narrative prompt and returns the raw narrative string
  // (no GuidanceActionPatch). The number guard + ActionValidator enforcement
  // lives in report/handoverNarrative.js, so this method only needs to surface
  // a clean fallback signal whenever the model is missing/slow/invalid.
  async generateNarrative(frame) {
    const config = resolveGemmaConfig(this.options);
    const modelFile = await resolveModelFile(config);

    if (!modelFile) {
      return createNarrativeFallbackResult("model_missing", {
        message: `No Gemma model file found in ${config.modelDir}.`
      });
    }

    const promptOptions = this.options.narrativePromptOptions || this.options.promptOptions || {};
    const messages = buildHandoverNarrativeMessages(frame, promptOptions);
    const prompt = config.supportsMessages ? null : buildCombinedPromptFromMessages(messages);
    const timeoutMs = resolveGemmaNarrativeTimeoutMs(this.options, config);
    const args = buildLiteRtLmArgs({
      ...config,
      modelFile,
      messages,
      prompt
    });

    let result = null;
    if (config.daemon) {
      try {
        result = await this.serverRunner({
          config: { ...config, serveRequestTimeoutMs: timeoutMs },
          messages,
          prompt,
          modelFile,
          timeoutMs
        });
      } catch {
        result = null;
      }
    }

    if (!result) {
      try {
        result = await this.runner({
          command: config.command,
          args,
          timeoutMs,
          cwd: config.cwd,
          env: config.env,
          messages,
          prompt,
          modelFile,
          backend: config.backend
        });
      } catch (error) {
        return createNarrativeFallbackResult(classifyRunnerError(error), error);
      }
    }

    if (result?.timedOut) {
      return createNarrativeFallbackResult("timeout", {
        message: `Gemma narrative exceeded ${timeoutMs}ms.`
      });
    }

    if (result?.exitCode !== 0) {
      return createNarrativeFallbackResult("cli_exit_nonzero", {
        message: result?.stderr || `Gemma CLI exited with code ${result?.exitCode}.`,
        exitCode: result?.exitCode,
        stderr: result?.stderr
      });
    }

    const parsed = parseHandoverNarrativeResponse(result?.stdout || "");
    if (!parsed.ok) {
      return createNarrativeFallbackResult(parsed.error || "narrative_not_found", {
        message: parsed.error || "Gemma narrative output was not valid."
      });
    }

    return {
      ok: true,
      narrative: parsed.narrative,
      reason: parsed.reason,
      confidence: parsed.confidence,
      fallback: false
    };
  }

  async runText(messages, callOptions = {}) {
    const config = resolveGemmaConfig(this.options);
    if (!config.daemon) {
      return {
        ok: false,
        skipped: true,
        skipReason: "gemma_text_daemon_disabled",
        reason: "gemma_text_daemon_disabled",
      };
    }

    const timeoutMs = resolveGemmaCallTimeoutMs(callOptions, this.options, config);
    const requestConfig = {
      ...config,
      timeoutMs,
      serveRequestTimeoutMs: timeoutMs,
    };
    const modelFile = await resolveModelFile(config);

    if (!modelFile) {
      return {
        ok: false,
        skipped: true,
        skipReason: "model_missing",
        reason: "model_missing",
        error: normalizeError({ message: `No Gemma model file found in ${config.modelDir}.` }),
      };
    }

    try {
      const result = await this.serverRunner({
        config: requestConfig,
        messages,
        prompt: null,
        modelFile,
        timeoutMs,
        maxTokens: resolveGemmaTextMaxTokens(callOptions, this.options, config),
        stream: resolveGemmaTextStream(callOptions, this.options, config),
        streamMaxChars: resolveGemmaTextStreamMaxChars(callOptions, this.options, config),
        streamStopPattern: callOptions.streamStopPattern || callOptions.stream_stop_pattern || null,
      });
      const text = String(result?.stdout || "").trim();
      if (!text) {
        return {
          ok: false,
          skipped: true,
          skipReason: "empty_text",
          reason: "empty_text",
        };
      }
      return {
        ok: true,
        text,
        daemon: result?.daemon === true,
        streamed: result?.streamed === true,
      };
    } catch (error) {
      const reason = classifyRunnerError(error);
      return {
        ok: false,
        skipped: true,
        skipReason: reason,
        reason,
        error: normalizeError(error),
      };
    }
  }
}

function positiveWarmupTimeout(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number);
    }
  }
  return DEFAULT_GEMMA_WARMUP_TIMEOUT_MS;
}

export function resolveGemmaNluTimeoutMs(options = {}) {
  const env = options.env || process.env;
  const value = Number(
    options.nluTimeoutMs ??
    options.gemmaNluTimeoutMs ??
    options.gemma_nlu_timeout_ms ??
    env.GEMMA_NLU_TIMEOUT_MS
  );

  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_GEMMA_NLU_TIMEOUT_MS;
}

export function resolveGemmaCallTimeoutMs(callOptions = {}, runtimeOptions = {}, config = {}) {
  const value = Number(
    callOptions.timeoutMs ??
    callOptions.gemmaTimeoutMs ??
    runtimeOptions.callTimeoutMs ??
    runtimeOptions.gemmaCallTimeoutMs
  );

  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? Math.floor(config.timeoutMs)
      : DEFAULT_GEMMA_TIMEOUT_MS;
}

function hasExplicitRealtimeBudget(callOptions = {}) {
  const value = Number(callOptions.timeoutMs ?? callOptions.gemmaTimeoutMs);
  return Number.isFinite(value) && value > 0;
}

export function resolveGemmaTextMaxTokens(callOptions = {}, runtimeOptions = {}, config = {}) {
  const env = config.env || runtimeOptions.env || process.env;
  const value = Number(
    callOptions.maxTokens ??
    callOptions.max_tokens ??
    runtimeOptions.textMaxTokens ??
    runtimeOptions.gemmaTextMaxTokens ??
    runtimeOptions.gemma_text_max_tokens ??
    env.GEMMA_TEXT_MAX_TOKENS
  );

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function resolveGemmaTextStream(callOptions = {}, runtimeOptions = {}, config = {}) {
  const env = config.env || runtimeOptions.env || process.env;
  const value =
    callOptions.stream ??
    callOptions.textStream ??
    callOptions.text_stream ??
    runtimeOptions.textStream ??
    runtimeOptions.gemmaTextStream ??
    runtimeOptions.gemma_text_stream ??
    env.GEMMA_TEXT_STREAM;
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

export function resolveGemmaTextStreamMaxChars(callOptions = {}, runtimeOptions = {}, config = {}) {
  const env = config.env || runtimeOptions.env || process.env;
  const value = Number(
    callOptions.streamMaxChars ??
    callOptions.stream_max_chars ??
    runtimeOptions.textStreamMaxChars ??
    runtimeOptions.gemmaTextStreamMaxChars ??
    runtimeOptions.gemma_text_stream_max_chars ??
    env.GEMMA_TEXT_STREAM_MAX_CHARS
  );

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function resolveGemmaNarrativeTimeoutMs(options = {}, config = {}) {
  const env = options.env || process.env;
  const value = Number(
    options.narrativeTimeoutMs ??
    options.gemmaNarrativeTimeoutMs ??
    env.GEMMA_NARRATIVE_TIMEOUT_MS
  );

  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  // The narrative is an S9, non-realtime task; give it a generous budget but
  // honor a larger configured one-shot timeout when present.
  return Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? Math.max(Math.floor(config.timeoutMs), DEFAULT_GEMMA_NARRATIVE_TIMEOUT_MS)
    : DEFAULT_GEMMA_NARRATIVE_TIMEOUT_MS;
}

export async function findGemmaModelFile(
  modelDir,
  { pattern = DEFAULT_GEMMA_MODEL_FILE_PATTERN } = {}
) {
  const matches = [];

  try {
    await collectModelFiles(path.resolve(modelDir), pattern, matches);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const found = matches.sort((left, right) => left.localeCompare(right))[0] || null;
  if (!found) {
    throw new Error(`No Gemma model file matching ${pattern} found in ${modelDir}.`);
  }

  return found;
}

export function buildLiteRtLmArgs({
  modelFile,
  backend,
  prompt,
  messages,
  supportsMessages = false,
  promptArg = "--prompt",
  commandPrefixArgs = [],
  extraArgs = []
} = {}) {
  const args = [...commandPrefixArgs, "run"];

  if (modelFile) {
    args.push(modelFile);
  }

  if (backend) {
    args.push(`--backend=${backend}`);
  }

  if (supportsMessages) {
    args.push(`--messages=${JSON.stringify(messages || [])}`);
  } else {
    args.push(`${promptArg}=${prompt || ""}`);
  }

  args.push(...extraArgs);
  return args;
}

export function buildCombinedPrompt(frame, messages = buildGemmaMessages(frame), options = {}) {
  const [systemMessage, userMessage] = messages;
  const userPrompt = userMessage?.content || buildGemmaPrompt(frame, options);

  return [
    "SYSTEM:",
    systemMessage?.content || "",
    "",
    "USER:",
    userPrompt
  ].join("\n");
}

export function buildCombinedPromptFromMessages(messages = []) {
  const [systemMessage, userMessage] = messages;

  return [
    "SYSTEM:",
    systemMessage?.content || "",
    "",
    "USER:",
    userMessage?.content || ""
  ].join("\n");
}

export function spawnLiteRtLm({ command, args, timeoutMs, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: createUtf8ProcessEnv(env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let settled = false;
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true
      });
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
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut: false
      });
    });
  });
}

function createUtf8ProcessEnv(env = process.env) {
  return {
    ...env,
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1"
  };
}

async function resolveModelFile(config) {
  if (config.modelFile) {
    try {
      const stat = await fs.stat(config.modelFile);
      return stat.isFile() ? config.modelFile : null;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  try {
    return await findGemmaModelFile(config.modelDir);
  } catch (error) {
    if (/No Gemma model file/i.test(error?.message || "")) {
      return null;
    }

    throw error;
  }
}

async function collectModelFiles(directory, pattern, matches) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectModelFiles(fullPath, pattern, matches);
    } else if (entry.isFile() && pattern.test(entry.name)) {
      matches.push(fullPath);
    }
  }
}

function createFallbackResult(frame, fallbackReason, error) {
  const patch = {
    ...createGemmaFallbackPatch(frame, fallbackReason),
    intent: "fallback_template"
  };

  return {
    ok: true,
    patch,
    fallback: true,
    fallbackReason,
    reason: fallbackReason,
    error: normalizeError(error),
    violations: Array.isArray(error?.violations) ? error.violations : []
  };
}

function createNarrativeFallbackResult(fallbackReason, error) {
  return {
    ok: false,
    narrative: "",
    fallback: true,
    fallbackReason,
    reason: fallbackReason,
    error: normalizeError(error),
    violations: Array.isArray(error?.violations) ? error.violations : []
  };
}

function createNluFallbackResult(frame, fallbackReason, error) {
  return {
    ok: false,
    source: "gemma_nlu",
    fallback: true,
    fallbackReason,
    reason: fallbackReason,
    intent: null,
    slots: {},
    confidence: 0,
    overall_confidence: 0,
    needsClarification: true,
    needs_clarification: true,
    frame_stage: frame?.current_stage || null,
    error: normalizeError(error),
    violations: Array.isArray(error?.violations) ? error.violations : []
  };
}

function classifyRunnerError(error) {
  if (error?.code === "ENOENT") {
    return "cli_not_found";
  }

  if (error?.name === "AbortError" || /abort|timeout|timed out/i.test(String(error?.message || ""))) {
    return "timeout";
  }

  return "cli_failed";
}

function normalizeError(error) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return error;
  }

  return {
    message: error.message || "Gemma runtime failed.",
    code: error.code,
    exitCode: error.exitCode,
    stderr: error.stderr
  };
}
