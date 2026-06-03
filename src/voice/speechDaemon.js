import { spawn } from "node:child_process";
import path from "node:path";

const DAEMONS = new Map();
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
let cleanupRegistered = false;

export function isSpeechDaemonEnabled(value = process.env.SPEECH_DAEMON) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

export function canUseSpeechDaemon(plan, options = {}) {
  const setting = Object.hasOwn(options, "speechDaemon")
    ? options.speechDaemon
    : process.env.SPEECH_DAEMON;
  return isSpeechDaemonEnabled(setting) && plan?.mode === "script";
}

export async function requestSttDaemon(plan, { audioPath }) {
  const daemon = getDaemon({
    name: "stt",
    command: plan.command,
    args: buildSttServeArgs(plan),
  });
  const response = await daemon.request({ audio: toChildProcessPath(audioPath) }, plan.timeoutMs);
  if (!response?.ok) {
    throw new Error(response?.error || "sherpa-onnx STT daemon failed.");
  }
  return response;
}

export async function requestTtsDaemon(plan, { text, outputPath }) {
  const daemon = getDaemon({
    name: "tts",
    command: plan.command,
    args: buildTtsServeArgs(plan),
  });
  const response = await daemon.request(
    { text, out: toChildProcessPath(outputPath) },
    plan.timeoutMs
  );
  if (!response?.ok) {
    throw new Error(response?.error || "sherpa-onnx TTS daemon failed.");
  }
  return response;
}

export function shutdownSpeechDaemons() {
  for (const daemon of DAEMONS.values()) {
    daemon.stop();
  }
  DAEMONS.clear();
}

function getDaemon({ name, command, args }) {
  registerCleanup();
  const key = JSON.stringify([name, command, args]);
  let daemon = DAEMONS.get(key);
  if (!daemon) {
    daemon = new LineJsonDaemon({ name, command, args });
    DAEMONS.set(key, daemon);
  }
  return daemon;
}

function buildSttServeArgs(plan) {
  const args = [
    toChildProcessPath(plan.script),
    "--model-dir",
    toChildProcessPath(plan.modelDir),
    "--language",
    plan.language || "auto",
    "--serve",
  ];
  if (plan.numThreads) {
    args.push("--num-threads", String(plan.numThreads));
  }
  return args;
}

function buildTtsServeArgs(plan) {
  const args = [
    toChildProcessPath(plan.script),
    "--model-dir",
    toChildProcessPath(plan.modelDir),
    "--serve",
    "--sid",
    String(plan.sid ?? 0),
    "--speed",
    String(plan.speed ?? 1),
  ];
  if (plan.numThreads) {
    args.push("--num-threads", String(plan.numThreads));
  }
  return args;
}

function registerCleanup() {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  process.once("exit", shutdownSpeechDaemons);
}

class LineJsonDaemon {
  constructor({ name, command, args }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.child = null;
    this.buffer = "";
    this.stderr = "";
    this.queue = [];
    this.current = null;
  }

  request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        payload,
        timeoutMs: positiveTimeout(timeoutMs),
        resolve,
        reject,
        timer: null,
      });
      this.pump();
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (this.current) {
      this.finishCurrent(new Error(`${this.name} daemon stopped.`));
    }
    while (this.queue.length) {
      this.queue.shift().reject(new Error(`${this.name} daemon stopped.`));
    }
    child?.kill("SIGTERM");
  }

  pump() {
    if (this.current || this.queue.length === 0) {
      return;
    }

    const current = this.queue.shift();
    try {
      this.ensureChild();
    } catch (error) {
      current.reject(error);
      setImmediate(() => this.pump());
      return;
    }

    this.current = current;
    current.timer = setTimeout(() => {
      this.finishCurrent(
        new Error(`${this.name} daemon timed out after ${current.timeoutMs}ms.`)
      );
      this.restart();
    }, current.timeoutMs);

    this.child.stdin.write(`${JSON.stringify(current.payload)}\n`, "utf8", (error) => {
      if (error) {
        this.finishCurrent(error);
        this.restart();
      }
    });
  }

  ensureChild() {
    if (this.child) {
      return;
    }

    const child = spawn(this.command, this.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    this.stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => this.handleCrash(child, error));
    child.on("close", (exitCode, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${exitCode}`;
      this.handleCrash(child, new Error(`${this.name} daemon exited with ${detail}.`));
    });

    child.unref?.();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!this.current) {
      return;
    }

    try {
      this.finishCurrent(null, JSON.parse(line));
    } catch (error) {
      this.finishCurrent(error);
    }
  }

  handleCrash(child, error) {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.buffer = "";
    const message = this.stderr ? `${error.message}\n${this.stderr}` : error.message;
    if (this.current) {
      this.finishCurrent(new Error(message));
    }
    if (this.queue.length) {
      setImmediate(() => this.pump());
    }
  }

  finishCurrent(error, response) {
    const current = this.current;
    if (!current) {
      return;
    }
    clearTimeout(current.timer);
    this.current = null;

    if (error) {
      current.reject(error);
    } else {
      current.resolve(response);
    }
    setImmediate(() => this.pump());
  }

  restart() {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    child?.kill("SIGTERM");
  }
}

function positiveTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 30000;
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
