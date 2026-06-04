import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getRuntimeDir,
  resolveTtsPlan,
  synthesizeSpeech,
} from "../src/index.js";
import { shutdownSpeechDaemons } from "../src/voice/speechDaemon.js";

const TTS_ENV_KEYS = [
  "SHERPA_ONNX_TTS_COMMAND",
  "SPEECH_TTS_COMMAND",
  "SHERPA_ONNX_TTS_ARGS",
  "SPEECH_TTS_PYTHON",
  "SPEECH_PYTHON",
  "SPEECH_TTS_SCRIPT",
  "SPEECH_TTS_MODEL_DIR",
  "SPEECH_TTS_NUM_THREADS",
  "SPEECH_TTS_SID",
  "SPEECH_TTS_SPEED",
  "SPEECH_TTS_GAIN",
  "SPEECH_DAEMON",
  "VOICE_TTS_PROVIDER",
  "SPEECH_MODE",
  "VOICE_TTS_TIMEOUT_MS",
];

test("resolveTtsPlan defaults to bundled python sherpa_tts.py and recognizes bundled explicit args", async () => {
  await withCleanTtsEnv(() => {
    const plan = resolveTtsPlan({});
    assert.equal(plan.mode, "script");
    assert.match(plan.command, /python3?$/);
    assert.match(plan.script, /scripts[\\/]speech[\\/]sherpa_tts\.py$/);
    assert.match(plan.modelDir, /models[\\/]speech[\\/]tts$/);
    assert.equal(plan.sid, 0);
    assert.equal(plan.speed, 1.1);
    assert.equal(plan.gain, 1.4);
    assert.equal(plan.numThreads, 2);
    assert.equal(plan.timeoutMs, 15000);

    process.env.SHERPA_ONNX_TTS_COMMAND = "python";
    process.env.SHERPA_ONNX_TTS_ARGS =
      'scripts/speech/sherpa_tts.py --model-dir "{model_dir}" --output "{out}" --text "{text}"';
    const bundled = resolveTtsPlan({});
    assert.equal(bundled.mode, "script");
    assert.equal(bundled.command, "python");
    assert.match(bundled.script, /scripts[\\/]speech[\\/]sherpa_tts\.py$/);

    const custom = resolveTtsPlan({
      sherpaCommand: "sherpa-onnx-tts.exe",
      sherpaArgs: "--text {text} --out {out}",
    });
    assert.equal(custom.mode, "command");
    assert.equal(custom.command, "sherpa-onnx-tts.exe");
  });
});

test("TTS adapter uses the daemon path and passes repo-local paths to the child process", async () => {
  await withCleanTtsEnv(async () => {
    const runtimeDir = getRuntimeDir();
    const fixtureDir = path.join(runtimeDir, "tts-daemon-test");
    const scriptPath = path.join(fixtureDir, "fake-tts-daemon.cjs");
    const argvPath = path.join(fixtureDir, "argv.json");
    const payloadPath = path.join(fixtureDir, "payload.json");

    await fs.mkdir(fixtureDir, { recursive: true });
    const fixtureSource =
      'const fs = require("node:fs");\n' +
      `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv), "utf8");\n` +
      'let buffer = "";\n' +
      'process.stdin.setEncoding("utf8");\n' +
      'process.stdin.on("data", (chunk) => {\n' +
      '  buffer += chunk;\n' +
      '  let newline = buffer.indexOf("\\n");\n' +
      '  while (newline >= 0) {\n' +
      '    const line = buffer.slice(0, newline).trim();\n' +
      '    buffer = buffer.slice(newline + 1);\n' +
      '    if (line) {\n' +
      '      const request = JSON.parse(line);\n' +
      `      fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify(request), "utf8");\n` +
      '      fs.writeFileSync(request.out, "RIFF fake wav bytes", "utf8");\n' +
      '      process.stdout.write(JSON.stringify({ ok: true, path: request.out }) + "\\n");\n' +
      '    }\n' +
      '    newline = buffer.indexOf("\\n");\n' +
      '  }\n' +
      '});\n';
    await fs.writeFile(scriptPath, fixtureSource, "utf8");

    process.env.SPEECH_DAEMON = "1";
    const result = await synthesizeSpeech("hello", {
      provider: "sherpa",
      python: process.execPath,
      script: scriptPath,
      modelDir: fixtureDir,
      timeoutMs: 2000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "sherpa-onnx");
    assert.equal(result.daemon, true);

    const recordedArgv = JSON.parse(await fs.readFile(argvPath, "utf8"));
    const args = recordedArgv.slice(2);
    assert.equal(args[0], "--model-dir");
    assert.equal(path.isAbsolute(args[1]), false, "model dir should be relative under the repo");
    assert.ok(args.includes("--serve"));

    const payload = JSON.parse(await fs.readFile(payloadPath, "utf8"));
    assert.equal(payload.text, "hello");
    assert.equal(path.isAbsolute(payload.out), false, "output path should be relative under the repo");
    assert.match(payload.out, /src[\\/]voice[\\/]\.runtime[\\/]tts-/);

    shutdownSpeechDaemons();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });
});

async function withCleanTtsEnv(fn) {
  const snapshot = {};
  for (const key of TTS_ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    shutdownSpeechDaemons();
    for (const key of TTS_ENV_KEYS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  }
}
