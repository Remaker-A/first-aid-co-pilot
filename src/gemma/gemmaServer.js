import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

const DEFAULT_GEMMA_SERVE_HOST = "127.0.0.1";
const DEFAULT_GEMMA_SERVE_PORT = 8791;
const DEFAULT_GEMMA_SERVE_API = "openai";
const DEFAULT_GEMMA_SERVE_READY_TIMEOUT_MS = 30000;
const DEFAULT_GEMMA_SERVE_REQUEST_TIMEOUT_MS = 30000;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const DAEMONS = new Map();

let cleanupRegistered = false;

export function isGemmaDaemonEnabled(value = process.env.GEMMA_DAEMON) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

export function createGemmaServerRunner(deps = {}) {
  return (request) => requestGemma({ ...request, ...deps });
}

export async function requestGemma({
  config,
  messages,
  timeoutMs,
  modelFile,
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn,
} = {}) {
  if (!config) {
    throw new Error("Gemma server config is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for Gemma daemon mode.");
  }

  const daemon = getGemmaDaemon({ config, modelFile, fetchImpl, spawnImpl });
  return daemon.request({ messages, timeoutMs });
}

export function buildGemmaServeArgs({
  serveApi = DEFAULT_GEMMA_SERVE_API,
  serveHost = DEFAULT_GEMMA_SERVE_HOST,
  servePort = DEFAULT_GEMMA_SERVE_PORT,
  commandPrefixArgs = [],
  serveExtraArgs = [],
} = {}) {
  const args = [...commandPrefixArgs, "serve"];

  if (serveApi) {
    args.push("--api", serveApi);
  }
  if (serveHost) {
    args.push("--host", serveHost);
  }
  if (servePort) {
    args.push("--port", String(servePort));
  }

  args.push(...serveExtraArgs);
  return args;
}

export function shutdownGemmaServers() {
  for (const daemon of DAEMONS.values()) {
    daemon.stop();
  }
  DAEMONS.clear();
}

function getGemmaDaemon({ config, modelFile, fetchImpl, spawnImpl }) {
  registerCleanup();

  const key = JSON.stringify([
    config.command,
    config.commandPrefixArgs,
    config.cwd,
    config.backend,
    config.serveApi,
    config.serveHost,
    config.servePort,
    config.serveModelId,
    config.serveExtraArgs,
    modelFile,
  ]);
  let daemon = DAEMONS.get(key);
  if (!daemon) {
    daemon = new GemmaServerDaemon({ config, modelFile, fetchImpl, spawnImpl });
    DAEMONS.set(key, daemon);
  }
  return daemon;
}

function registerCleanup() {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  process.once("exit", shutdownGemmaServers);
}

class GemmaServerDaemon {
  constructor({ config, modelFile, fetchImpl, spawnImpl }) {
    this.config = config;
    this.modelFile = modelFile;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.starting = null;
    this.stderr = "";
    this.stdout = "";
  }

  async request({ messages, timeoutMs }) {
    await this.ensureStarted();

    const requestTimeoutMs = positiveTimeout(
      timeoutMs,
      this.config.serveRequestTimeoutMs,
      this.config.timeoutMs,
      DEFAULT_GEMMA_SERVE_REQUEST_TIMEOUT_MS
    );
    const abort = createAbort(requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.serveModelId || modelIdFromFile(this.modelFile) || this.config.modelRepo || "gemma",
          messages: messages || [],
          temperature: 0,
        }),
        signal: abort.signal,
      });
    } finally {
      abort.cancel();
    }

    if (!response?.ok) {
      const detail = await readResponseText(response);
      throw new Error(`Gemma daemon HTTP ${response?.status || "failed"}: ${detail}`);
    }

    const json = await response.json();
    const text = extractOpenAiText(json);
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("Gemma daemon returned an empty completion.");
    }

    return {
      stdout: text,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      daemon: true,
    };
  }

  async ensureStarted() {
    if (this.child) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async start() {
    const args = buildGemmaServeArgs({
      ...this.config,
      modelFile: this.modelFile,
    });
    const child = this.spawnImpl(this.config.command, args, {
      cwd: this.config.cwd,
      env: createUtf8ProcessEnv(this.config.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    this.stderr = "";
    this.stdout = "";

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      this.stdout = `${this.stdout}${chunk}`.slice(-4000);
    });
    child.stderr?.on?.("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.on?.("error", (error) => this.handleExit(child, error));
    child.on?.("close", (exitCode, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${exitCode}`;
      this.handleExit(child, new Error(`Gemma daemon exited with ${detail}.`));
    });
    child.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();

    await Promise.race([
      this.waitUntilReady(),
      new Promise((_, reject) => {
        child.once?.("error", reject);
        child.once?.("close", (exitCode, signal) => {
          const detail = signal ? `signal ${signal}` : `code ${exitCode}`;
          reject(new Error(`Gemma daemon exited before ready with ${detail}.`));
        });
      }),
    ]);
  }

  async waitUntilReady() {
    const deadline = Date.now() + positiveTimeout(
      this.config.serveReadyTimeoutMs,
      DEFAULT_GEMMA_SERVE_READY_TIMEOUT_MS
    );
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        if (await this.probeReady()) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(150);
    }

    this.stop();
    throw new Error(
      `Gemma daemon did not become ready within ${this.config.serveReadyTimeoutMs || DEFAULT_GEMMA_SERVE_READY_TIMEOUT_MS}ms.` +
        (lastError?.message ? ` ${lastError.message}` : "")
    );
  }

  async probeReady() {
    for (const path of ["/v1/models", "/health", "/api/health"]) {
      const abort = createAbort(500);
      try {
        const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
          method: "GET",
          signal: abort.signal,
        });
        if (response?.ok) {
          return true;
        }
      } finally {
        abort.cancel();
      }
    }
    return false;
  }

  stop() {
    const child = this.child;
    this.child = null;
    child?.kill?.("SIGTERM");
  }

  handleExit(child, error) {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.stderr = this.stderr || error?.message || "";
  }

  baseUrl() {
    return `http://${this.config.serveHost}:${this.config.servePort}`;
  }
}

function extractOpenAiText(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  return choice?.message?.content ?? choice?.text ?? json?.content ?? json?.text;
}

function modelIdFromFile(modelFile) {
  if (!modelFile) {
    return "";
  }
  return path.basename(modelFile, path.extname(modelFile));
}

async function readResponseText(response) {
  if (!response) {
    return "request failed";
  }
  try {
    return await response.text();
  } catch {
    return response.statusText || "request failed";
  }
}

function createUtf8ProcessEnv(env = process.env) {
  return {
    ...env,
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1",
  };
}

function createAbort(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function positiveTimeout(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number);
    }
  }
  return DEFAULT_GEMMA_SERVE_REQUEST_TIMEOUT_MS;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
