import path from "node:path";

export const DEFAULT_GEMMA_MODEL_REPO = "litert-community/gemma-4-E2B-it-litert-lm";
export const DEFAULT_GEMMA_MODEL_DIRNAME = "gemma-4-E2B-it-litert-lm";
export const DEFAULT_GEMMA_BACKEND = "cpu";
export const DEFAULT_GEMMA_TIMEOUT_MS = 120000;
export const DEFAULT_GEMMA_COMMAND = "litert-lm";
export const DEFAULT_GEMMA_MODEL_FILE_PATTERN = /^gemma-4-E2B-it.*\.litertlm$/i;
export const DEFAULT_GEMMA_SERVE_HOST = "127.0.0.1";
export const DEFAULT_GEMMA_SERVE_PORT = 8791;
export const DEFAULT_GEMMA_SERVE_API = "openai";
export const DEFAULT_GEMMA_SERVE_READY_TIMEOUT_MS = 30000;
export const DEFAULT_GEMMA_SERVE_REQUEST_TIMEOUT_MS = 30000;

// A genuine Gemma 4 E2B `.litertlm` artifact is ~2.6 GB. Anything dramatically
// smaller (an empty placeholder, a `.metadata` stub, a partial/aborted download)
// is treated as "not a real model" so verification can surface a clear error
// instead of silently handing a broken file to LiteRT-LM.
export const GEMMA_PLACEHOLDER_MIN_BYTES = 1024 * 1024;

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
    commandPrefixArgs: normalizeExtraArgs(
      options.commandPrefixArgs ??
      env.GEMMA_COMMAND_PREFIX_ARGS ??
      env.LITERT_LM_COMMAND_PREFIX_ARGS
    ),
    daemon: parseBoolean(options.daemon ?? env.GEMMA_DAEMON),
    serveHost: options.serveHost || env.GEMMA_SERVE_HOST || DEFAULT_GEMMA_SERVE_HOST,
    servePort: normalizePort(options.servePort ?? env.GEMMA_SERVE_PORT),
    serveApi: options.serveApi || env.GEMMA_SERVE_API || DEFAULT_GEMMA_SERVE_API,
    serveModelId: options.serveModelId || env.GEMMA_SERVE_MODEL_ID || "",
    serveReadyTimeoutMs: normalizeTimeoutValue(
      options.serveReadyTimeoutMs ?? env.GEMMA_SERVE_READY_TIMEOUT_MS,
      DEFAULT_GEMMA_SERVE_READY_TIMEOUT_MS
    ),
    serveRequestTimeoutMs: normalizeTimeoutValue(
      options.serveRequestTimeoutMs ?? env.GEMMA_SERVE_REQUEST_TIMEOUT_MS,
      DEFAULT_GEMMA_SERVE_REQUEST_TIMEOUT_MS
    ),
    serveExtraArgs: normalizeExtraArgs(options.serveExtraArgs ?? env.GEMMA_SERVE_EXTRA_ARGS),
    supportsMessages: parseBoolean(options.supportsMessages ?? env.GEMMA_SUPPORTS_MESSAGES),
    promptArg: options.promptArg || env.GEMMA_PROMPT_ARG || "--prompt",
    extraArgs: normalizeExtraArgs(options.extraArgs ?? env.GEMMA_EXTRA_ARGS),
    cwd,
    env
  };
}

// Human-readable, copy-pasteable instructions for obtaining the restricted
// Gemma weights. Centralized here so the runtime fallback message, verify:local
// output, and setup script all speak with one voice.
export function describeGemmaModelSetup(config = {}) {
  const repo = config.modelRepo || DEFAULT_GEMMA_MODEL_REPO;
  const dir = config.modelDir || getDefaultGemmaModelDir();
  const pattern = DEFAULT_GEMMA_MODEL_FILE_PATTERN.toString();
  return [
    `What to download: the LiteRT-LM weights for ${repo} (the gemma-4-E2B-it*.litertlm artifact, ~2.6 GB).`,
    "How to authorize: accept the Gemma license on Hugging Face, then set HF_TOKEN (or HUGGINGFACE_HUB_TOKEN).",
    `Where it goes: ${dir}`,
    "How to download: npm run setup:gemma",
    "How to import an existing copy: powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setupGemma.ps1 -ModelSource <path-or-zip-or-url>",
    `Detection: the runtime auto-discovers the first file matching ${pattern} under the model dir (override with GEMMA_MODEL_DIR or GEMMA_MODEL_FILE).`,
    "Runner override: set GEMMA_COMMAND to an executable; for module runners use GEMMA_COMMAND_PREFIX_ARGS, for example GEMMA_COMMAND=python and GEMMA_COMMAND_PREFIX_ARGS=\"-m litert_lm_cli.main\".",
    "Verify: npm run verify:local -- --require-real-gemma"
  ].join("\n");
}

export function describeMissingGemmaModel(config = {}) {
  const dir = config.modelDir || getDefaultGemmaModelDir();
  return `No Gemma model file found in ${dir}.\n${describeGemmaModelSetup(config)}`;
}

// Pure decision logic shared by verify:local. Kept side-effect free so it can be
// unit-tested without touching the filesystem or spawning LiteRT-LM.
export function evaluateGemmaModelCheck(inspection = {}, { requireRealGemma = false } = {}) {
  const remediation = inspection.remediation || describeGemmaModelSetup(inspection);

  if (!inspection.found) {
    return {
      status: requireRealGemma ? "fail" : "warn",
      detail: `No ${DEFAULT_GEMMA_MODEL_FILE_PATTERN} model file found in ${inspection.modelDir || getDefaultGemmaModelDir()}.`,
      remediation
    };
  }

  if (inspection.placeholder) {
    return {
      status: requireRealGemma ? "fail" : "warn",
      detail: `Found ${inspection.file} but it is only ${inspection.bytes} bytes (looks like a placeholder, not the ~2.6 GB model).`,
      remediation
    };
  }

  return {
    status: "pass",
    detail: `${inspection.file} (${formatBytes(inspection.bytes)})`,
    remediation: ""
  };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${value} bytes`;
}

export function normalizeBackend(value) {
  const backend = String(value || DEFAULT_GEMMA_BACKEND).trim().toLowerCase();
  return VALID_BACKENDS.has(backend) ? backend : DEFAULT_GEMMA_BACKEND;
}

export function normalizeTimeout(value) {
  return normalizeTimeoutValue(value, DEFAULT_GEMMA_TIMEOUT_MS);
}

function normalizeTimeoutValue(value, fallback) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return fallback;
  }

  return Math.floor(timeout);
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return DEFAULT_GEMMA_SERVE_PORT;
  }

  return port;
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
