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
  maxTokens,
  stream,
  streamMaxChars,
  streamStopPattern,
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
  return daemon.request({ messages, timeoutMs, maxTokens, stream, streamMaxChars, streamStopPattern });
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
    this.modelId = config.serveModelId || "";
  }

  async request({ messages, timeoutMs, maxTokens, stream = false, streamMaxChars, streamStopPattern }) {
    await this.ensureStarted();

    const requestTimeoutMs = positiveTimeout(
      timeoutMs,
      this.config.serveRequestTimeoutMs,
      this.config.timeoutMs,
      DEFAULT_GEMMA_SERVE_REQUEST_TIMEOUT_MS
    );
    const abort = createAbort(requestTimeoutMs);
    const body = {
      model: this.modelId || this.modelFile || modelIdFromFile(this.modelFile) || this.config.modelRepo || "gemma",
      messages: messages || [],
      temperature: 0,
    };
    const normalizedMaxTokens = normalizeMaxTokens(maxTokens);
    if (normalizedMaxTokens) {
      body.max_tokens = normalizedMaxTokens;
    }
    if (stream === true) {
      body.stream = true;
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!response?.ok) {
        const detail = await readResponseText(response);
        throw new Error(`Gemma daemon HTTP ${response?.status || "failed"}: ${detail}`);
      }

      const text = stream === true
        ? await readOpenAiStreamText(response, { maxChars: streamMaxChars, stopPattern: streamStopPattern })
        : extractOpenAiText(await response.json());
      if (typeof text !== "string" || text.trim() === "") {
        throw new Error("Gemma daemon returned an empty completion.");
      }

      return {
        stdout: text,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        daemon: true,
        streamed: stream === true,
      };
    } catch (error) {
      if (isRequestTimeoutError(error)) {
        this.stop();
      }
      throw error;
    } finally {
      abort.cancel();
    }
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
          if (path === "/v1/models" && !this.modelId) {
            this.modelId = await readFirstServedModelId(response).catch(() => "");
          }
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

async function readOpenAiStreamText(response, { maxChars, stopPattern } = {}) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    throw new Error("Gemma daemon streaming response has no readable body.");
  }

  const decoder = new TextDecoder();
  const targetChars = normalizeMaxTokens(maxChars) || 28;
  let buffer = "";
  let text = "";
  const canStop = createStreamStopPredicate(stopPattern);

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let doneByServer = false;
    const parsed = consumeSseLines(buffer, (data) => {
      if (data === "[DONE]") {
        doneByServer = true;
        return;
      }
      const delta = extractOpenAiStreamDelta(data);
      if (delta) {
        text += delta;
      }
    });
    buffer = parsed.remainder;
    if (doneByServer) {
      break;
    }
    const completeEnough = /[。！？!?]/u.test(text) || text.length >= targetChars;
    if (completeEnough && canStop(text)) {
      drainReader(reader);
      return text.trim();
    }
  }

  return text.trim();
}

function createStreamStopPredicate(pattern) {
  if (!pattern) {
    return () => true;
  }
  if (pattern instanceof RegExp) {
    return (text) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    };
  }
  const regex = new RegExp(String(pattern), "u");
  return (text) => regex.test(text);
}

function drainReader(reader) {
  Promise.resolve().then(async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
    } catch {
      // Background drain only protects the daemon from a client-side early cancel.
    }
  });
}

function consumeSseLines(buffer, onData) {
  let remainder = buffer;
  let index = remainder.indexOf("\n");
  while (index >= 0) {
    const line = remainder.slice(0, index).trim();
    remainder = remainder.slice(index + 1);
    if (line.startsWith("data:")) {
      onData(line.slice(5).trim());
    }
    index = remainder.indexOf("\n");
  }
  return { remainder };
}

function extractOpenAiStreamDelta(data) {
  if (!data) {
    return "";
  }
  try {
    const json = JSON.parse(data);
    const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
    return choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? json?.content ?? json?.text ?? "";
  } catch {
    return "";
  }
}

function modelIdFromFile(modelFile) {
  if (!modelFile) {
    return "";
  }
  return path.basename(modelFile, path.extname(modelFile));
}

function normalizeMaxTokens(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function isRequestTimeoutError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    /abort|timeout|timed out/i.test(String(error?.message || ""))
  );
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

async function readFirstServedModelId(response) {
  if (!response || typeof response.json !== "function") {
    return "";
  }
  const json = await response.json();
  const candidates = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : [];
  const first = candidates.find((item) => item && (typeof item === "string" || typeof item.id === "string"));
  if (typeof first === "string") {
    return first;
  }
  return first?.id || "";
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
