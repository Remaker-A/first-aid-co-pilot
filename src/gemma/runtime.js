import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildGemmaMessages, buildGemmaPrompt } from "./promptBuilder.js";
import { buildGemmaNluMessages } from "./nluPrompt.js";
import { parseGemmaNluResponse } from "./nluResponseParser.js";
import { parseGemmaResponse } from "./responseParser.js";
import { createGemmaFallbackPatch } from "./fallbackPolicy.js";
import { requestGemma } from "./gemmaServer.js";
import {
  DEFAULT_GEMMA_MODEL_FILE_PATTERN,
  GEMMA_PLACEHOLDER_MIN_BYTES,
  describeGemmaModelSetup,
  describeMissingGemmaModel,
  resolveGemmaConfig
} from "./modelConfig.js";

export const DEFAULT_GEMMA_NLU_TIMEOUT_MS = 600;
export const DEFAULT_GEMMA_WARMUP_TIMEOUT_MS = 30000;

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

  async generatePatch(frame) {
    return this.run(frame);
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

  async run(frame) {
    const config = resolveGemmaConfig(this.options);
    const modelFile = await resolveModelFile(config);

    if (!modelFile) {
      return createFallbackResult(frame, "model_missing", {
        message: `No Gemma model file found in ${config.modelDir}.`
      });
    }

    const messages = buildGemmaMessages(frame, this.options.promptOptions || {});
    const prompt = config.supportsMessages
      ? null
      : buildCombinedPrompt(frame, messages, this.options.promptOptions || {});
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
          config,
          messages,
          prompt,
          modelFile,
          timeoutMs: config.serveRequestTimeoutMs,
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
          timeoutMs: config.timeoutMs,
          cwd: config.cwd,
          env: config.env,
          messages,
          prompt,
          modelFile,
          backend: config.backend
        });
      } catch (error) {
        return createFallbackResult(frame, classifyRunnerError(error), error);
      }
    }

    if (result?.timedOut) {
      return createFallbackResult(frame, "timeout", {
        message: `Gemma CLI exceeded ${config.timeoutMs}ms.`
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
