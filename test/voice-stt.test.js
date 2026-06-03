import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSttInvocation, inferIntent, resolveSttPlan, transcribeInput } from "../src/index.js";

const STT_ENV_KEYS = [
  "SHERPA_ONNX_STT_COMMAND",
  "SPEECH_STT_COMMAND",
  "SHERPA_ONNX_STT_ARGS",
  "SPEECH_STT_PYTHON",
  "SPEECH_PYTHON",
  "SPEECH_STT_SCRIPT",
  "SPEECH_STT_MODEL_DIR",
  "SPEECH_STT_NUM_THREADS",
  "SPEECH_LANGUAGE",
  "SPEECH_DAEMON",
  "VOICE_STT_PROVIDER",
  "SPEECH_MODE",
  "VOICE_STT_TIMEOUT_MS",
];

test("inferIntent recognizes common zh-CN emergency call confirmations", () => {
  assert.equal(inferIntent("我已经拨打120了"), "emergency_called");
  assert.equal(inferIntent("120已经接通了"), "emergency_called");
  assert.equal(inferIntent("120已经多打。"), "emergency_called");
  assert.equal(inferIntent("急救电话打通了"), "emergency_called");
});

test("inferIntent recognizes common zh-CN handover arrival phrases", () => {
  assert.equal(inferIntent("救护车到了"), "paramedics_arrived");
  assert.equal(inferIntent("救货车到了。"), "paramedics_arrived");
  assert.equal(inferIntent("医生来了"), "paramedics_arrived");
  assert.equal(inferIntent("急救人员到了"), "paramedics_arrived");
  assert.equal(inferIntent("医护人员赶到了"), "paramedics_arrived");
});

test("inferIntent recognizes CPR live question intents", () => {
  assert.equal(inferIntent("我按得对吗"), "ask_cpr_quality");
  assert.equal(inferIntent("我爱你的对吗？"), "ask_cpr_quality");
  assert.equal(inferIntent("我能不能停"), "ask_can_stop");
  assert.equal(inferIntent("我能不能听？"), "ask_can_stop");
  assert.equal(inferIntent("AED 来了怎么办"), "ask_aed_help");
  assert.equal(inferIntent("说颤姨来了怎么办？"), "ask_aed_help");
  assert.equal(inferIntent("出差一来了怎么办？"), "ask_aed_help");
  assert.equal(inferIntent("出差疑来了怎么办？"), "ask_aed_help");
  assert.equal(inferIntent("说差姨来了怎么办？"), "ask_aed_help");
  assert.equal(inferIntent("现在怎么办"), "ask_next_step");
  assert.equal(inferIntent("要不要打120"), "ask_emergency_call");
});

test("inferIntent treats scene-safety facts as flow facts before generic next-step questions", () => {
  assert.equal(inferIntent("周围安全"), "scene_safe");
  assert.equal(inferIntent("环境安全，可以靠近患者了"), "scene_safe");
  assert.equal(inferIntent("我已确认周围安全，并在患者身边，请告诉我接下来怎么做。"), "scene_safe");
  assert.equal(inferIntent("周围没有危险，我可以靠近他。"), "scene_safe");
});

test("inferIntent keeps unsafe-scene phrases from being mistaken as scene_safe", () => {
  assert.equal(inferIntent("周围不安全，别靠近"), "scene_unsafe");
  assert.equal(inferIntent("现场有危险，不可以靠近"), "scene_unsafe");
});

test("inferIntent recognizes design-script abnormal breathing and agonal phrasing", () => {
  assert.equal(inferIntent("没有正常呼吸"), "no_normal_breathing");
  assert.equal(inferIntent("好像没有呼吸，偶尔喘一下"), "agonal_breathing");
  assert.equal(inferIntent("他只有偶尔喘息"), "agonal_breathing");
});

// Keep these tests hermetic regardless of the developer/CI shell environment.
async function withCleanSttEnv(fn) {
  const snapshot = {};
  for (const key of STT_ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of STT_ENV_KEYS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  }
}

test("resolveSttPlan defaults to bundled python sherpa_stt.py and honors explicit command override", async () => {
  await withCleanSttEnv(() => {
    const plan = resolveSttPlan({});
    assert.equal(plan.mode, "script");
    assert.match(plan.command, /python3?$/);
    assert.match(plan.script, /scripts[\\/]speech[\\/]sherpa_stt\.py$/);
    assert.match(plan.modelDir, /models[\\/]speech[\\/]stt$/);
    assert.equal(plan.language, "auto");
    assert.equal(plan.numThreads, 2);
    assert.equal(plan.timeoutMs, 20000);

    const overridden = resolveSttPlan({ sherpaCommand: "sherpa-onnx-offline.exe", sherpaArgs: "--wave {audio}" });
    assert.equal(overridden.mode, "command");
    assert.equal(overridden.command, "sherpa-onnx-offline.exe");
    assert.equal(overridden.argsTemplate, "--wave {audio}");

    process.env.SHERPA_ONNX_STT_COMMAND = "env-stt.exe";
    const fromEnv = resolveSttPlan({});
    assert.equal(fromEnv.mode, "command");
    assert.equal(fromEnv.command, "env-stt.exe");
  });
});

test("buildSttInvocation constructs the python argv and honors a command template", () => {
  const scriptInvocation = buildSttInvocation(
    {
      mode: "script",
      command: "python",
      script: "/opt/scripts/sherpa_stt.py",
      modelDir: "/models/stt",
      language: "zh",
      numThreads: 4,
    },
    { audioPath: "/tmp/clip.wav", outputPath: "/tmp/clip.txt" }
  );

  assert.equal(scriptInvocation.command, "python");
  assert.deepEqual(scriptInvocation.args, [
    path.resolve("/opt/scripts/sherpa_stt.py"),
    "--model-dir",
    path.resolve("/models/stt"),
    "--audio",
    path.resolve("/tmp/clip.wav"),
    "--language",
    "zh",
    "--num-threads",
    "4",
  ]);

  const commandInvocation = buildSttInvocation(
    {
      mode: "command",
      command: "sherpa-onnx-offline",
      argsTemplate: "--wave {audio} --model {model_dir} --lang {language} --out {out}",
      modelDir: "/models/stt",
      language: "en",
    },
    { audioPath: "/tmp/clip.wav", outputPath: "/tmp/clip.txt" }
  );

  assert.deepEqual(commandInvocation.args, [
    "--wave",
    path.resolve("/tmp/clip.wav"),
    "--model",
    path.resolve("/models/stt"),
    "--lang",
    "en",
    "--out",
    path.resolve("/tmp/clip.txt"),
  ]);
});

test("STT adapter builds and runs the real sherpa command path (mocked engine) and parses its transcript", async () => {
  await withCleanSttEnv(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-stt-"));
    try {
      // Placeholder model files so the pre-flight model check passes without a
      // real ~228MB model. The fake engine never reads them.
      await fs.writeFile(path.join(tmpDir, "model.int8.onnx"), "");
      await fs.writeFile(path.join(tmpDir, "tokens.txt"), "");

      const argvOutPath = path.join(tmpDir, "recorded-argv.json");
      const fixturePath = path.join(tmpDir, "fake-sherpa-stt.cjs");
      const fixtureSource =
        'const fs = require("node:fs");\n' +
        `fs.writeFileSync(${JSON.stringify(argvOutPath)}, JSON.stringify(process.argv), "utf8");\n` +
        'process.stdout.write(Buffer.from(JSON.stringify({ text: "现场安全了" }), "utf8"));\n';
      await fs.writeFile(fixturePath, fixtureSource, "utf8");

      const result = await transcribeInput(
        {
          audioBase64: Buffer.from("RIFF....fake wav bytes", "utf8").toString("base64"),
          mimeType: "audio/wav",
        },
        {
          provider: "sherpa",
          python: process.execPath,
          script: fixturePath,
          modelDir: tmpDir,
          language: "zh",
          numThreads: 2,
        }
      );

      assert.equal(result.ok, true);
      assert.equal(result.provider, "sherpa-onnx");
      assert.equal(result.source, "sherpa_onnx_stt");
      assert.equal(result.transcript, "现场安全了");
      assert.equal(result.intent, "scene_safe");

      const recordedArgv = JSON.parse(await fs.readFile(argvOutPath, "utf8"));
      assert.equal(recordedArgv[1], fixturePath, "script path should be argv[1]");
      const args = recordedArgv.slice(2);
      assert.equal(args[0], "--model-dir");
      assert.equal(args[1], path.resolve(tmpDir));
      assert.equal(args[2], "--audio");
      assert.match(args[3], /\.wav$/);
      assert.equal(args[4], "--language");
      assert.equal(args[5], "zh");
      assert.equal(args[6], "--num-threads");
      assert.equal(args[7], "2");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("STT adapter retries with auto language when sherpa rejects a fixed language", async () => {
  await withCleanSttEnv(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-stt-retry-"));
    try {
      await fs.writeFile(path.join(tmpDir, "model.int8.onnx"), "");
      await fs.writeFile(path.join(tmpDir, "tokens.txt"), "");

      const argvOutPath = path.join(tmpDir, "recorded-argv.jsonl");
      const fixturePath = path.join(tmpDir, "fake-sherpa-stt-retry.cjs");
      const fixtureSource =
        'const fs = require("node:fs");\n' +
        `fs.appendFileSync(${JSON.stringify(argvOutPath)}, JSON.stringify(process.argv) + "\\n", "utf8");\n` +
        'const language = process.argv[process.argv.indexOf("--language") + 1];\n' +
        'if (language === "zh") { process.stderr.write("invalid unordered_map<K, T> key"); process.exit(1); }\n' +
        'process.stdout.write(Buffer.from(JSON.stringify({ text: "还没有反应。" }), "utf8"));\n';
      await fs.writeFile(fixturePath, fixtureSource, "utf8");

      const result = await transcribeInput(
        {
          audioBase64: Buffer.from("RIFF....fake wav bytes", "utf8").toString("base64"),
          mimeType: "audio/wav",
        },
        {
          provider: "sherpa",
          python: process.execPath,
          script: fixturePath,
          modelDir: tmpDir,
          language: "zh",
          numThreads: 2,
        }
      );

      assert.equal(result.ok, true);
      assert.equal(result.provider, "sherpa-onnx");
      assert.equal(result.source, "sherpa_onnx_stt");
      assert.equal(result.transcript, "还没有反应。");
      assert.equal(result.intent, "patient_unresponsive");
      assert.equal(result.language_retry, "auto");

      const invocations = (await fs.readFile(argvOutPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0].at(-2), "--num-threads");
      assert.ok(invocations[0].includes("zh"));
      assert.ok(invocations[1].includes("auto"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("STT adapter falls back to mock with a precise download hint when the model dir is empty", async () => {
  await withCleanSttEnv(async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-stt-empty-"));
    try {
      const result = await transcribeInput(
        {
          audioBase64: Buffer.from("fake wav bytes", "utf8").toString("base64"),
          mimeType: "audio/wav",
        },
        { provider: "sherpa", modelDir: emptyDir }
      );

      assert.equal(result.ok, false);
      assert.equal(result.provider, "mock");
      assert.equal(result.source, "mock_audio_stt");
      assert.equal(result.error.code, "stt_model_missing");
      assert.match(result.transcript, /mock audio transcript/);
      assert.equal(result.audio.mime_type, "audio/wav");

      assert.match(result.hint, /sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/);
      assert.match(result.hint, /releases\/download\/asr-models/);
      assert.match(result.hint, /model\.int8\.onnx/);
      assert.match(result.hint, /tokens\.txt/);
      assert.ok(result.hint.includes(path.resolve(emptyDir)));
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
