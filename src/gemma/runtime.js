import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildGemmaMessages, buildGemmaPrompt } from "./promptBuilder.js";
import { parseGemmaResponse } from "./responseParser.js";
import { createGemmaFallbackPatch } from "./fallbackPolicy.js";
import {
  DEFAULT_GEMMA_MODEL_FILE_PATTERN,
  GEMMA_PLACEHOLDER_MIN_BYTES,
  describeGemmaModelSetup,
  describeMissingGemmaModel,
  resolveGemmaConfig
} from "./modelConfig.js";

export class GemmaRuntime {
  constructor(options = {}) {
    this.options = options.config ? { ...options.config, ...options } : options;
    this.runner = options.runner || spawnLiteRtLm;
  }

  async generatePatch(frame) {
    return this.run(frame);
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

    let result;
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
  extraArgs = []
} = {}) {
  const args = ["run"];

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
