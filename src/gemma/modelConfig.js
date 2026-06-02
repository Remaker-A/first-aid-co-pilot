import path from "node:path";

export const DEFAULT_GEMMA_MODEL_REPO = "litert-community/gemma-4-E2B-it-litert-lm";
export const DEFAULT_GEMMA_MODEL_DIRNAME = "gemma-4-E2B-it-litert-lm";
export const DEFAULT_GEMMA_BACKEND = "cpu";
export const DEFAULT_GEMMA_TIMEOUT_MS = 120000;
export const DEFAULT_GEMMA_COMMAND = "litert-lm";
export const DEFAULT_GEMMA_MODEL_FILE_PATTERN = /^gemma-4-E2B-it.*\.litertlm$/i;

const VALID_BACKENDS = new Set(["cpu", "gpu", "npu"]);

export function getDefaultGemmaModelDir({ cwd = process.cwd() } = {}) {
  return path.resolve(cwd, "models", "gemma", DEFAULT_GEMMA_MODEL_DIRNAME);
}

export function resolveGemmaConfig(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const modelDir = resolvePathOption(
    options.modelDir ?? env.GEMMA_MODEL_DIR,
    getDefaultGemmaModelDir({ cwd }),
    cwd
  );
  const modelFile = resolveOptionalPath(options.modelFile ?? env.GEMMA_MODEL_FILE, cwd);

  return {
    modelRepo: options.modelRepo || env.GEMMA_MODEL_REPO || DEFAULT_GEMMA_MODEL_REPO,
    modelDir,
    modelFile,
    backend: normalizeBackend(options.backend || env.GEMMA_BACKEND || DEFAULT_GEMMA_BACKEND),
    timeoutMs: normalizeTimeout(options.timeoutMs ?? env.GEMMA_TIMEOUT_MS),
    command: options.command || env.GEMMA_COMMAND || env.LITERT_LM_COMMAND || DEFAULT_GEMMA_COMMAND,
    supportsMessages: parseBoolean(options.supportsMessages ?? env.GEMMA_SUPPORTS_MESSAGES),
    promptArg: options.promptArg || env.GEMMA_PROMPT_ARG || "--prompt",
    extraArgs: normalizeExtraArgs(options.extraArgs ?? env.GEMMA_EXTRA_ARGS),
    cwd,
    env
  };
}

export function normalizeBackend(value) {
  const backend = String(value || DEFAULT_GEMMA_BACKEND).trim().toLowerCase();
  return VALID_BACKENDS.has(backend) ? backend : DEFAULT_GEMMA_BACKEND;
}

export function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_GEMMA_TIMEOUT_MS;
  }

  return Math.floor(timeout);
}

export function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolvePathOption(value, fallback, cwd) {
  if (!value) {
    return fallback;
  }

  return path.resolve(cwd, value);
}

function resolveOptionalPath(value, cwd) {
  if (!value) {
    return null;
  }

  return path.resolve(cwd, value);
}

function normalizeExtraArgs(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }

  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  return value
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}
