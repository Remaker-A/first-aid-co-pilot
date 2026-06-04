import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferIntent } from "./stt.js";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(VOICE_DIR, "..", "..");
const DEFAULT_STREAM_STT_SCRIPT = path.join(REPO_ROOT, "scripts", "speech", "sherpa_stt_stream.py");
const DEFAULT_STREAM_MODEL_DIR = path.join(REPO_ROOT, "models", "speech", "stt-stream");
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const DEFAULT_READY_TIMEOUT_MS = 15000;

export function createStreamingStt(options = {}) {
  return new StreamingSttSession(options).start();
}

export function resolveStreamingSttPlan(options = {}) {
  const modelDir =
    firstNonEmpty(options.modelDir, process.env.SPEECH_STT_STREAM_MODEL_DIR) ||
    DEFAULT_STREAM_MODEL_DIR;
  const command =
    firstNonEmpty(
      options.python,
      process.env.SPEECH_STT_STREAM_PYTHON,
      process.env.SPEECH_STT_PYTHON,
      process.env.SPEECH_PYTHON
    ) || DEFAULT_PYTHON;
  const script =
    firstNonEmpty(options.script, process.env.SPEECH_STT_STREAM_SCRIPT) ||
    DEFAULT_STREAM_STT_SCRIPT;

  return {
    command,
    script: path.resolve(script),
    modelDir,
    sampleRate: positiveNumber(options.sampleRate, process.env.SPEECH_SAMPLE_RATE, 16000),
    numThreads: positiveNumber(
      options.numThreads,
      process.env.SPEECH_STT_STREAM_NUM_THREADS,
      process.env.SPEECH_STT_NUM_THREADS,
      1
    ),
    provider: firstNonEmpty(options.provider, process.env.SPEECH_STT_STREAM_PROVIDER) || "cpu",
    decodingMethod:
      firstNonEmpty(options.decodingMethod, process.env.SPEECH_STT_STREAM_DECODING_METHOD) ||
      "greedy_search",
    rule1MinTrailingSilence: positiveNumber(
      options.rule1MinTrailingSilence,
      process.env.SPEECH_STT_STREAM_RULE1_MIN_TRAILING_SILENCE,
      2.4
    ),
    // Trailing silence (seconds) after non-empty text that marks "sentence
    // finished". This is what actually decides streaming endpointing, so a low
    // value chops the speaker off mid-sentence on every breath/pause. Keep in
    // sync with sherpa_stt_stream.py's default; override per-deployment via env.
    rule2MinTrailingSilence: positiveNumber(
      options.rule2MinTrailingSilence,
      process.env.SPEECH_STT_STREAM_RULE2_MIN_TRAILING_SILENCE,
      0.8
    ),
    rule3MinUtteranceLength: positiveNumber(
      options.rule3MinUtteranceLength,
      process.env.SPEECH_STT_STREAM_RULE3_MIN_UTTERANCE_LENGTH,
      20
    ),
    tailPaddingSeconds: positiveNumber(
      options.tailPaddingSeconds,
      process.env.SPEECH_STT_STREAM_TAIL_PADDING_SECONDS,
      0.2
    ),
    readyTimeoutMs: positiveNumber(
      options.readyTimeoutMs,
      process.env.SPEECH_STT_STREAM_READY_TIMEOUT_MS,
      DEFAULT_READY_TIMEOUT_MS
    ),
  };
}

export function buildStreamingSttInvocation(plan) {
  const args = [
    toChildProcessPath(plan.script),
    "--model-dir",
    toChildProcessPath(path.resolve(plan.modelDir)),
    "--sample-rate",
    String(plan.sampleRate),
    "--num-threads",
    String(plan.numThreads),
    "--provider",
    plan.provider,
    "--decoding-method",
    plan.decodingMethod,
    "--rule1-min-trailing-silence",
    String(plan.rule1MinTrailingSilence),
    "--rule2-min-trailing-silence",
    String(plan.rule2MinTrailingSilence),
    "--rule3-min-utterance-length",
    String(plan.rule3MinUtteranceLength),
    "--tail-padding-seconds",
    String(plan.tailPaddingSeconds),
  ];

  return { command: plan.command, args };
}

export class StreamingSttSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.plan = options.plan || resolveStreamingSttPlan(options);
    this.child = null;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.started = false;
    this.stopped = false;
    this.ready = false;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyTimer = null;
  }

  start() {
    if (this.child) {
      return this;
    }

    this.stopped = false;
    const { command, args } = buildStreamingSttInvocation(this.plan);
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.started = true;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this.rejectReady?.(
          new Error(`streaming STT did not become ready after ${this.plan.readyTimeoutMs}ms.`)
        );
      }
    }, this.plan.readyTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
      this.emit("stderr", chunk);
    });
    child.on("error", (error) => this.handleProcessError(error));
    child.on("close", (exitCode, signal) => this.handleClose(exitCode, signal));

    this.writeJson({ type: "start", sample_rate: this.plan.sampleRate });
    return this;
  }

  waitUntilReady() {
    if (this.ready) {
      return Promise.resolve(this);
    }
    if (!this.readyPromise) {
      this.start();
    }
    return this.readyPromise;
  }

  feed(pcm, options = {}) {
    const data = toBase64Audio(pcm);
    if (!data) {
      return false;
    }
    return this.writeJson({
      type: "audio",
      data,
      sample_rate: positiveNumber(options.sampleRate, this.plan.sampleRate),
    });
  }

  end() {
    return this.writeJson({ type: "end" });
  }

  reset(options = {}) {
    return this.writeJson({
      type: "reset",
      sample_rate: positiveNumber(options.sampleRate, this.plan.sampleRate),
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.readyTimer);
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill("SIGTERM");
    }
  }

  writeJson(payload) {
    if (!this.child) {
      this.start();
    }
    if (!this.child?.stdin?.writable) {
      return false;
    }
    return this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
      if (error) {
        this.emit("error", error);
      }
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.emit("error", new Error(`invalid streaming STT JSON: ${line}`));
      return;
    }

    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "ready") {
      this.ready = true;
      clearTimeout(this.readyTimer);
      this.resolveReady?.(this);
      this.emit("ready", event);
      return;
    }

    if (event.type === "partial") {
      this.emit("partial", normalizeTranscriptEvent(event));
      return;
    }

    if (event.type === "final") {
      const normalized = normalizeTranscriptEvent(event);
      normalized.intent = inferIntent(normalized.text);
      normalized.transcript = normalized.text;
      this.emit("final", normalized);
      this.emit("transcript", normalized);
      return;
    }

    if (event.type === "error") {
      const error = new Error(event.error || "streaming STT error");
      error.event = event;
      this.emit("error", error);
      return;
    }

    this.emit(event.type || "event", event);
  }

  handleProcessError(error) {
    clearTimeout(this.readyTimer);
    this.rejectReady?.(error);
    this.emit("error", error);
  }

  handleClose(exitCode, signal) {
    clearTimeout(this.readyTimer);
    const detail = signal ? `signal ${signal}` : `code ${exitCode}`;
    const error =
      !this.ready && !this.stopped
        ? new Error(`streaming STT exited before ready with ${detail}.${this.stderr ? `\n${this.stderr}` : ""}`)
        : null;

    if (error) {
      this.rejectReady?.(error);
      this.emit("error", error);
    }

    this.child = null;
    this.ready = false;
    this.started = false;
    this.emit("exit", { exitCode, signal });
  }
}

function normalizeTranscriptEvent(event) {
  return {
    ...event,
    text: typeof event.text === "string" ? event.text.trim() : "",
  };
}

function toBase64Audio(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("base64");
  }
  throw new TypeError("streaming STT feed() expects a Buffer, ArrayBuffer, typed array, or base64 string.");
}

function toChildProcessPath(targetPath) {
  if (!targetPath) {
    return targetPath;
  }

  const absolute = path.resolve(targetPath);
  const relative = path.relative(process.cwd(), absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }

  return absolute;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
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
