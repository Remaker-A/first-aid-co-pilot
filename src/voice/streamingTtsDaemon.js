import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamingTts } from "./streamingTts.js";
import { normalizeForTts } from "./ttsText.js";

const VOICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(VOICE_DIR, "..", "..");
const DEFAULT_STREAM_TTS_SCRIPT = path.join(REPO_ROOT, "scripts", "speech", "sherpa_tts_stream.py");
const DEFAULT_STREAM_TTS_MODEL_DIR = path.join(REPO_ROOT, "models", "speech", "tts-stream");
const DEFAULT_TTS_MODEL_DIR = path.join(REPO_ROOT, "models", "speech", "tts");
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_SAMPLE_RATE_HINT = 22050;

// Selector: returns the warm sherpa-onnx streaming-TTS daemon when explicitly
// enabled, otherwise the in-process "synthesize whole clause then chunk" variant
// (which itself falls back to mock audio). Default OFF so existing behavior and
// tests are unchanged unless a caller opts in via options.useDaemon or
// SPEECH_TTS_STREAM=1.
export function createLiveTts(options = {}) {
  const resolved = withTtsCacheBundle(options);
  if (shouldUseTtsDaemon(resolved)) {
    return new StreamingTtsDaemon(resolved);
  }
  return new StreamingTts(resolved);
}

// Opt-in: only attach the shipped WA audio bundle when a caller passes a
// directory or sets VOICE_TTS_CACHE_DIR. Left unset, the streamer keeps a
// hermetic per-instance LRU (no disk reads), which is what the test-suite uses.
function withTtsCacheBundle(options = {}) {
  if (options.cache !== undefined || options.cacheBundleDir !== undefined) {
    return options;
  }
  const dir = firstNonEmpty(options.ttsCacheDir, process.env.VOICE_TTS_CACHE_DIR);
  return dir ? { ...options, cacheBundleDir: dir } : options;
}

export function shouldUseTtsDaemon(options = {}) {
  if (options.useDaemon === true) {
    return true;
  }
  if (options.useDaemon === false) {
    return false;
  }
  const flag = String(process.env.SPEECH_TTS_STREAM || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

export function resolveStreamingTtsPlan(options = {}) {
  const modelDir =
    firstNonEmpty(
      options.modelDir,
      process.env.SPEECH_TTS_STREAM_MODEL_DIR,
      process.env.SPEECH_TTS_MODEL_DIR
    ) || (hasDir(DEFAULT_STREAM_TTS_MODEL_DIR) ? DEFAULT_STREAM_TTS_MODEL_DIR : DEFAULT_TTS_MODEL_DIR);
  const command =
    firstNonEmpty(
      options.python,
      process.env.SPEECH_TTS_STREAM_PYTHON,
      process.env.SPEECH_TTS_PYTHON,
      process.env.SPEECH_PYTHON
    ) || DEFAULT_PYTHON;
  const script =
    firstNonEmpty(options.script, process.env.SPEECH_TTS_STREAM_SCRIPT) || DEFAULT_STREAM_TTS_SCRIPT;

  return {
    command,
    script: path.resolve(script),
    modelDir: path.resolve(modelDir),
    sid: integerOr(options.sid, process.env.SPEECH_TTS_STREAM_SID, 0),
    speed: numberOr(options.speed, process.env.SPEECH_TTS_STREAM_SPEED, 1.1),
    gain: numberOr(options.gain, process.env.SPEECH_TTS_STREAM_GAIN, 1.4),
    numThreads: integerOr(options.numThreads, process.env.SPEECH_TTS_STREAM_NUM_THREADS, 2),
    maxClauseChars: integerOr(options.maxClauseChars, process.env.SPEECH_TTS_STREAM_MAX_CLAUSE_CHARS, 32),
    readyTimeoutMs: integerOr(options.readyTimeoutMs, process.env.SPEECH_TTS_STREAM_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS),
    sampleRateHint: integerOr(options.sampleRateHint, process.env.SPEECH_TTS_STREAM_SAMPLE_RATE, DEFAULT_SAMPLE_RATE_HINT),
  };
}

export function buildStreamingTtsInvocation(plan) {
  const args = [
    toChildProcessPath(plan.script),
    "--model-dir",
    toChildProcessPath(plan.modelDir),
    "--sid",
    String(plan.sid),
    "--speed",
    String(plan.speed),
    "--gain",
    String(plan.gain),
    "--num-threads",
    String(plan.numThreads),
    "--max-clause-chars",
    String(plan.maxClauseChars),
  ];
  return { command: plan.command, args };
}

export class StreamingTtsDaemon {
  constructor(options = {}) {
    this.plan = options.plan || resolveStreamingTtsPlan(options);
    this.fallback = new StreamingTts(options);
    this.child = null;
    this.ready = false;
    this.disabled = false;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyTimer = null;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.idSeq = 0;
    this.jobs = new Map();
    this.lastJob = null;
  }

  cancel(reason = "cancelled") {
    this.fallback.cancel(reason);
    const job = this.lastJob;
    if (job && !job.stopped && !job.settled) {
      job.stopped = true;
      if (!job.cancelSent) {
        this.write({ type: "cancel", id: job.id });
        job.cancelSent = true;
      }
      endJob(job);
    }
  }

  async *speak(text, options = {}) {
    const normalized = normalizeForTts(normalizeText(text));
    if (!normalized) {
      return;
    }

    if (this.disabled) {
      yield* this.fallback.speak(normalized, options);
      return;
    }

    try {
      await this.ensureReady();
    } catch {
      this.disabled = true;
      this.stop();
      yield* this.fallback.speak(normalized, options);
      return;
    }

    await this.drainPrevious();

    const id = `tts-${++this.idSeq}`;
    const job = createJob(id, this.plan.sampleRateHint);
    this.jobs.set(id, job);
    this.lastJob = job;
    this.write({ type: "speak", id, text: normalized, sid: options.sid ?? this.plan.sid, speed: options.speed ?? this.plan.speed, gain: options.gain ?? this.plan.gain });

    try {
      while (true) {
        const item = await nextItem(job);
        if (!item) {
          break;
        }
        yield item;
      }
      if (job.error && !job.stopped) {
        throw job.error;
      }
    } finally {
      job.ended = true;
    }
  }

  ensureReady() {
    if (this.ready) {
      return Promise.resolve(this);
    }
    if (!this.readyPromise) {
      this.start();
    }
    return this.readyPromise;
  }

  start() {
    if (this.child) {
      return;
    }
    const { command, args } = buildStreamingTtsInvocation(this.plan);
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this.rejectReady?.(new Error(`streaming TTS did not become ready after ${this.plan.readyTimeoutMs}ms.`));
      }
    }, this.plan.readyTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(this.readyTimer);
      this.rejectReady?.(error);
      this.failAllJobs(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(this.readyTimer);
      if (!this.ready) {
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        this.rejectReady?.(new Error(`streaming TTS exited before ready with ${detail}.${this.stderr ? `\n${this.stderr}` : ""}`));
      }
      this.child = null;
      this.ready = false;
      this.failAllJobs(new Error("streaming TTS process closed."));
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
    } catch {
      return;
    }
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "ready") {
      this.ready = true;
      clearTimeout(this.readyTimer);
      this.resolveReady?.(this);
      return;
    }

    const job = (event.id && this.jobs.get(event.id)) || null;
    if (!job) {
      return;
    }

    switch (event.type) {
      case "audio_begin":
        job.sampleRate = event.sample_rate || job.sampleRate;
        break;
      case "audio":
        deliver(job, {
          type: "audio",
          chunk: Buffer.from(event.data || "", "base64"),
          sampleRate: event.sample_rate || job.sampleRate,
          channels: 1,
          bitsPerSample: 16,
          clauseIndex: event.clause_index,
        });
        break;
      case "audio_end":
      case "cancelled":
        settleJob(job);
        this.jobs.delete(job.id);
        break;
      case "error":
        job.error = new Error(event.error || "streaming TTS error");
        settleJob(job);
        this.jobs.delete(job.id);
        break;
      default:
        break;
    }
  }

  async drainPrevious() {
    const prev = this.lastJob;
    if (prev && !prev.settled) {
      if (!prev.cancelSent) {
        this.write({ type: "cancel", id: prev.id });
        prev.cancelSent = true;
      }
      await prev.settledPromise;
    }
  }

  failAllJobs(error) {
    for (const job of this.jobs.values()) {
      job.error = job.error || error;
      settleJob(job);
    }
    this.jobs.clear();
  }

  write(payload) {
    if (!this.child) {
      this.start();
    }
    if (!this.child?.stdin?.writable) {
      return false;
    }
    return this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  stop() {
    clearTimeout(this.readyTimer);
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      child.kill("SIGTERM");
    }
  }
}

function createJob(id, sampleRateHint) {
  const job = {
    id,
    queue: [],
    resolveNext: null,
    ended: false,
    stopped: false,
    settled: false,
    cancelSent: false,
    error: null,
    sampleRate: sampleRateHint,
    settleResolve: null,
  };
  job.settledPromise = new Promise((resolve) => {
    job.settleResolve = resolve;
  });
  return job;
}

function nextItem(job) {
  if (job.queue.length) {
    return Promise.resolve(job.queue.shift());
  }
  if (job.ended || job.stopped || job.settled) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    job.resolveNext = resolve;
  });
}

function deliver(job, item) {
  if (job.ended || job.stopped) {
    return;
  }
  if (job.resolveNext) {
    const resolve = job.resolveNext;
    job.resolveNext = null;
    resolve(item);
  } else {
    job.queue.push(item);
  }
}

function endJob(job) {
  if (job.resolveNext) {
    const resolve = job.resolveNext;
    job.resolveNext = null;
    resolve(null);
  }
}

function settleJob(job) {
  if (job.settled) {
    return;
  }
  job.settled = true;
  endJob(job);
  job.settleResolve?.();
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

function integerOr(...values) {
  const fallback = values.pop();
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) {
      return Math.floor(num);
    }
  }
  return fallback;
}

function numberOr(...values) {
  const fallback = values.pop();
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return fallback;
}

function hasDir(dir) {
  try {
    return existsSync(dir);
  } catch {
    return false;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
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
