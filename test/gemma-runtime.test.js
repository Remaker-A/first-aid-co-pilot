import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GemmaRuntime,
  GEMMA_SYSTEM_PROMPT,
  buildGemmaPrompt,
  buildLiteRtLmArgs,
  findGemmaModelFile,
  parseGemmaResponse,
  resolveGemmaConfig
} from "../src/index.js";

const GEMMA_4_REPO = "litert-community/gemma-4-E2B-it-litert-lm";

const DECISION_FRAME = Object.freeze({
  session_id: "sess_test",
  current_stage: "S2_CHECK_RESPONSE",
  allowed_intents: ["ask_response_check", "parse_response_answer", "fallback_template"],
  facts: {
    responsive: null
  },
  user_input: {
    stt_text: "No response.",
    confidence: 0.91
  },
  safety_phrases: [],
  output_schema: "GuidanceActionPatch",
  language: "en"
});

const VALID_PATCH = Object.freeze({
  intent: "parse_response_answer",
  tts: {
    text: "Check if they respond.",
    tone: "calm_firm",
    speed: "normal"
  },
  ui: {
    main_text: "Check response",
    secondary_text: "Call loudly and tap both shoulders"
  },
  visual_overlay: {
    mode: null,
    highlight_target: null,
    correction_arrow: null
  },
  log_suggestion: {
    type: "response_check",
    detail: "No response reported"
  },
  reason: "rescuer_reported_no_response",
  confidence: 0.88
});

test("Gemma config defaults to Gemma 4 E2B LiteRT-LM on CPU", () => {
  const config = resolveGemmaConfig({
    env: {},
    cwd: "D:\\test-workspace"
  });

  assert.equal(config.modelRepo, GEMMA_4_REPO);
  assert.match(config.modelDir, /models[\\/]gemma[\\/]gemma-4-E2B-it-litert-lm$/);
  assert.equal(config.backend, "cpu");
  assert.equal(config.timeoutMs, 120000);
});

test("Gemma config honors backend and timeout environment overrides", () => {
  const config = resolveGemmaConfig({
    env: {
      GEMMA_BACKEND: "gpu",
      GEMMA_TIMEOUT_MS: "45000"
    },
    cwd: "D:\\test-workspace"
  });

  assert.equal(config.modelRepo, GEMMA_4_REPO);
  assert.equal(config.backend, "gpu");
  assert.equal(config.timeoutMs, 45000);
});

test("findGemmaModelFile resolves a Gemma 4 LiteRT-LM file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "firstaid-gemma-runtime-"));

  try {
    const modelPath = join(tempDir, "gemma-4-E2B-it-q4_k_m.litertlm");
    await writeFile(modelPath, "");

    const found = await findGemmaModelFile(tempDir);

    assert.equal(found, modelPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("findGemmaModelFile rejects a directory without Gemma 4 LiteRT-LM files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "firstaid-gemma-runtime-"));

  try {
    await assert.rejects(
      () => findGemmaModelFile(tempDir),
      /gemma-4-E2B-it.*\.litertlm|model file/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildLiteRtLmArgs includes model, backend, and timeout inputs", () => {
  const args = buildLiteRtLmArgs({
    modelFile: "D:\\models\\gemma\\gemma-4-E2B-it-q4_k_m.litertlm",
    backend: "cpu",
    timeoutMs: 120000
  });

  assert.ok(Array.isArray(args));
  assert.ok(args.some((arg) => String(arg).includes("gemma-4-E2B-it-q4_k_m.litertlm")));
  assert.ok(args.some((arg) => String(arg).includes("cpu")));
});

test("GemmaRuntime parses a valid mock runner JSON patch", async () => {
  await withMockModelFile(async (modelFile) => {
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({ env: {}, cwd: "D:\\test-workspace" }),
        modelFile
      },
      runner: async ({ messages }) => {
        assert.equal(messages[0].role, "system");
        assert.equal(messages[1].role, "user");

        return {
          stdout: JSON.stringify(VALID_PATCH),
          stderr: "",
          exitCode: 0
        };
      }
    });

    const result = await runtime.generatePatch(DECISION_FRAME);

    assert.equal(result.ok, true);
    assert.equal(result.fallback ?? false, false);
    assert.equal(result.patch.intent, "parse_response_answer");
    assert.equal(result.patch.tts.text, "Check if they respond.");
  });
});

test("Gemma parser accepts fenced or explained JSON patches", () => {
  const result = parseGemmaResponse(
    [
      "Here is the patch:",
      "```json",
      JSON.stringify(VALID_PATCH),
      "```"
    ].join("\n"),
    DECISION_FRAME
  );

  assert.equal(result.ok, true);
  assert.equal(result.patch.intent, "parse_response_answer");
  assert.equal(result.patch.tts.text, "Check if they respond.");
});

test("Gemma parser unwraps common patch containers", () => {
  for (const key of ["GuidanceActionPatch", "patch", "action"]) {
    const result = parseGemmaResponse(
      JSON.stringify({
        [key]: VALID_PATCH
      }),
      DECISION_FRAME
    );

    assert.equal(result.ok, true);
    assert.equal(result.patch.intent, "parse_response_answer");
  }
});

test("Gemma parser maps string action to intent when no intent is present", () => {
  const result = parseGemmaResponse(
    JSON.stringify({
      action: "parse_response_answer",
      tts: VALID_PATCH.tts,
      ui: VALID_PATCH.ui,
      reason: VALID_PATCH.reason,
      confidence: VALID_PATCH.confidence
    }),
    DECISION_FRAME
  );

  assert.equal(result.ok, true);
  assert.equal(result.patch.intent, "parse_response_answer");
});

test("Gemma parser rejects disallowed fields inside wrappers", () => {
  const result = parseGemmaResponse(
    JSON.stringify({
      patch: {
        ...VALID_PATCH,
        next_stage: "S5_CALL_EMERGENCY",
        tool_actions: [{ type: "emergency_call" }]
      }
    }),
    DECISION_FRAME
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "patch_validation_failed");
  assert.ok(result.violations.includes("disallowed_field:next_stage"));
  assert.ok(result.violations.includes("disallowed_field:tool_actions"));
});

test("Gemma parser rejects corrupt decoded speech text", () => {
  const result = parseGemmaResponse(
    JSON.stringify({
      ...VALID_PATCH,
      tts: {
        ...VALID_PATCH.tts,
        text: "\uFFFD\uFFFD\uFFFD\uFFFD"
      }
    }),
    DECISION_FRAME
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "patch_validation_failed");
  assert.ok(result.violations.includes("corrupt_text"));
});

test("Gemma prompt forbids wrappers and includes a minimal legal zh-CN example", () => {
  const userPrompt = buildGemmaPrompt(DECISION_FRAME);

  assert.match(GEMMA_SYSTEM_PROMPT, /Do not wrap the JSON/);
  assert.match(GEMMA_SYSTEM_PROMPT, /双手掌根放在胸口中央/);
  assert.match(userPrompt, /first character must be \{/);
  assert.match(userPrompt, /Do not use wrapper keys/);
});

test("GemmaRuntime rejects or falls back when mock output includes tool actions and stage transitions", async () => {
  await withMockModelFile(async (modelFile) => {
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({ env: {}, cwd: "D:\\test-workspace" }),
        modelFile
      },
      runner: async () => ({
        stdout: JSON.stringify({
          ...VALID_PATCH,
          next_stage: "S5_CALL_EMERGENCY",
          tool_actions: [{ type: "emergency_call" }]
        }),
        stderr: "",
        exitCode: 0
      })
    });

    const result = await runtime.generatePatch(DECISION_FRAME);

    if (result.ok) {
      assert.equal(result.fallback, true);
      assert.equal(result.patch.intent, "fallback_template");
      assert.ok(result.violations.some((item) => /disallowed_field/.test(item)));
    } else {
      assert.ok(result.violations.includes("disallowed_field:next_stage"));
      assert.ok(result.violations.includes("disallowed_field:tool_actions"));
    }
  });
});

test("GemmaRuntime falls back when the model file is missing", async () => {
  const runtime = new GemmaRuntime({
    config: {
      ...resolveGemmaConfig({ env: {}, cwd: "D:\\test-workspace" }),
      modelFile: ""
    },
    runner: async () => {
      throw new Error("runner should not execute without a model file");
    }
  });

  const result = await runtime.generatePatch(DECISION_FRAME);

  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(result.patch.intent, "fallback_template");
  assert.match(result.reason || result.patch.reason, /model/i);
});

test("GemmaRuntime falls back when the runner fails", async () => {
  await withMockModelFile(async (modelFile) => {
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({ env: {}, cwd: "D:\\test-workspace" }),
        modelFile
      },
      runner: async () => {
        throw new Error("litert-lm failed");
      }
    });

    const result = await runtime.generatePatch(DECISION_FRAME);

    assert.equal(result.ok, true);
    assert.equal(result.fallback, true);
    assert.equal(result.patch.intent, "fallback_template");
    assert.match(result.reason || result.patch.reason, /runner|litert-lm|failed/i);
  });
});

async function withMockModelFile(callback) {
  const tempDir = await mkdtemp(join(tmpdir(), "firstaid-gemma-runtime-"));

  try {
    const modelFile = join(tempDir, "gemma-4-E2B-it-q4_k_m.litertlm");
    await writeFile(modelFile, "");
    return await callback(modelFile);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
