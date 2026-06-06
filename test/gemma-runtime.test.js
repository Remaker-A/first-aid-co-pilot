import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GemmaRuntime,
  GEMMA_SYSTEM_PROMPT,
  OPEN_QUESTION_GEMMA_SYSTEM_PROMPT_FILE,
  buildGemmaServeArgs,
  buildGemmaPrompt,
  buildLiteRtLmArgs,
  createGemmaServerRunner,
  evaluateGemmaModelCheck,
  findGemmaModelFile,
  parseGemmaNluResponse,
  parseGemmaResponse,
  resolveGemmaConfig,
  shutdownGemmaServers
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

const VALID_NLU = Object.freeze({
  intent: "no_normal_breathing",
  slots: {
    normal_breathing: { value: false, confidence: 0.91 },
    agonal_breathing: { value: true, confidence: 0.83 }
  },
  overall_confidence: 0.89,
  needs_clarification: false
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
      GEMMA_TIMEOUT_MS: "45000",
      GEMMA_COMMAND: "python",
      GEMMA_COMMAND_PREFIX_ARGS: "-m litert_lm_cli.main"
    },
    cwd: "D:\\test-workspace"
  });

  assert.equal(config.modelRepo, GEMMA_4_REPO);
  assert.equal(config.backend, "gpu");
  assert.equal(config.timeoutMs, 45000);
  assert.equal(config.command, "python");
  assert.deepEqual(config.commandPrefixArgs, ["-m", "litert_lm_cli.main"]);
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

test("evaluateGemmaModelCheck fails a placeholder model in strict mode", () => {
  const result = evaluateGemmaModelCheck(
    {
      found: true,
      file: "D:\\models\\gemma\\gemma-4-E2B-it.litertlm",
      bytes: 512,
      placeholder: true
    },
    { requireRealGemma: true }
  );

  assert.equal(result.status, "fail");
  assert.match(result.detail, /placeholder|2\.6 GB/i);
});

test("evaluateGemmaModelCheck reports a usable model file size", () => {
  const result = evaluateGemmaModelCheck({
    found: true,
    file: "D:\\models\\gemma\\gemma-4-E2B-it.litertlm",
    bytes: 2.59 * 1024 * 1024 * 1024,
    placeholder: false
  });

  assert.equal(result.status, "pass");
  assert.match(result.detail, /2\.59 GB/);
});

test("buildLiteRtLmArgs includes model, backend, and timeout inputs", () => {
  const args = buildLiteRtLmArgs({
    modelFile: "D:\\models\\gemma\\gemma-4-E2B-it-q4_k_m.litertlm",
    backend: "cpu",
    timeoutMs: 120000,
    commandPrefixArgs: ["-m", "litert_lm_cli.main"]
  });

  assert.ok(Array.isArray(args));
  assert.deepEqual(args.slice(0, 3), ["-m", "litert_lm_cli.main", "run"]);
  assert.ok(args.some((arg) => String(arg).includes("gemma-4-E2B-it-q4_k_m.litertlm")));
  assert.ok(args.some((arg) => String(arg).includes("cpu")));
});

test("buildGemmaServeArgs starts the OpenAI-compatible server without run-only flags", () => {
  const args = buildGemmaServeArgs({
    modelFile: "D:\\models\\gemma\\gemma-4-E2B-it-q4_k_m.litertlm",
    backend: "gpu",
    serveHost: "127.0.0.1",
    servePort: 8788,
    serveApi: "openai",
    commandPrefixArgs: ["-m", "litert_lm_cli.main"],
  });

  assert.deepEqual(args.slice(0, 3), ["-m", "litert_lm_cli.main", "serve"]);
  assert.ok(args.includes("--api"));
  assert.ok(args.includes("openai"));
  assert.ok(args.includes("--host"));
  assert.ok(args.includes("127.0.0.1"));
  assert.ok(args.includes("--port"));
  assert.ok(args.includes("8788"));
  assert.equal(args.some((arg) => String(arg).includes("gemma-4-E2B-it-q4_k_m.litertlm")), false);
  assert.equal(args.includes("--backend=gpu"), false);
});

test("Gemma server runner posts OpenAI-compatible chat requests with mock fetch", async () => {
  await withMockModelFile(async (modelFile) => {
    const requests = [];
    const runner = createGemmaServerRunner({
      spawnImpl: createFakeSpawn(),
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init });
        if (init.method === "GET") {
          return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(VALID_PATCH) } }],
          }),
          text: async () => "",
        };
      },
    });

    const result = await runner({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_DAEMON: "1",
            GEMMA_BACKEND: "gpu",
            GEMMA_SERVE_PORT: "8799",
          },
          cwd: "D:\\test-workspace",
        }),
        modelFile,
        serveReadyTimeoutMs: 50,
      },
      modelFile,
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 50,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.daemon, true);
    assert.equal(result.stdout, JSON.stringify(VALID_PATCH));
    assert.equal(requests.some((request) => String(request.url).endsWith("/v1/models")), true);
    const post = requests.find((request) => request.init.method === "POST");
    assert.ok(post);
    const body = JSON.parse(post.init.body);
    assert.equal(body.messages[0].content, "hello");
    assert.equal(body.model, modelFile);
    assert.equal(body.model.endsWith(".litertlm"), true);
  });
});

test("Gemma server runner uses the served model id from /v1/models when available", async () => {
  await withMockModelFile(async (modelFile) => {
    const servedModelId = "litert-served-gemma-model";
    const requests = [];
    const runner = createGemmaServerRunner({
      spawnImpl: createFakeSpawn(),
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init });
        if (init.method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: servedModelId }] }),
            text: async () => "",
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(VALID_PATCH) } }],
          }),
          text: async () => "",
        };
      },
    });

    await runner({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_DAEMON: "1",
            GEMMA_SERVE_PORT: "8798",
          },
          cwd: "D:\\test-workspace",
        }),
        modelFile,
        serveReadyTimeoutMs: 50,
      },
      modelFile,
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 50,
      maxTokens: 24,
    });

    const post = requests.find((request) => request.init.method === "POST");
    assert.ok(post);
    const body = JSON.parse(post.init.body);
    assert.equal(body.model, servedModelId);
    assert.equal(body.max_tokens, 24);
  });
});

test("Gemma server runner reads OpenAI streaming deltas and returns after a safe short sentence", async () => {
  await withMockModelFile(async (modelFile) => {
    const servedModelId = "litert-streaming-gemma-model";
    const requests = [];
    let cancelled = false;
    const runner = createGemmaServerRunner({
      spawnImpl: createFakeSpawn(),
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init });
        if (init.method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: servedModelId }] }),
            text: async () => "",
          };
        }
        return createSseResponse([
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "继续" } }] },
          { choices: [{ delta: { content: "按压胸骨。" } }] },
          { choices: [{ delta: { content: "这段不应等待。" } }] },
        ], () => {
          cancelled = true;
        });
      },
    });

    try {
      const result = await runner({
        config: {
          ...resolveGemmaConfig({
            env: {
              GEMMA_DAEMON: "1",
              GEMMA_SERVE_PORT: "8808",
            },
            cwd: "D:\\test-workspace",
          }),
          modelFile,
          serveReadyTimeoutMs: 50,
        },
        modelFile,
        messages: [{ role: "user", content: "short answer" }],
        timeoutMs: 50,
        maxTokens: 24,
        stream: true,
        streamMaxChars: 24,
        streamStopPattern: "继续按压",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.daemon, true);
      assert.equal(result.streamed, true);
      assert.equal(result.stdout, "继续按压胸骨。");
      assert.equal(cancelled, false);
      const post = requests.find((request) => request.init.method === "POST");
      const body = JSON.parse(post.init.body);
      assert.equal(body.model, servedModelId);
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, 24);
    } finally {
      shutdownGemmaServers();
    }
  });
});

test("Gemma server runner does not early-return streaming text before the required safety anchor", async () => {
  await withMockModelFile(async (modelFile) => {
    const requests = [];
    const runner = createGemmaServerRunner({
      spawnImpl: createFakeSpawn(),
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init });
        if (init.method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "litert-streaming-gemma-model" }] }),
            text: async () => "",
          };
        }
        return createSseResponse([
          { choices: [{ delta: { content: "It looks like a serious issue." } }] },
          { choices: [{ delta: { content: "继续按压胸骨。" } }] },
        ]);
      },
    });

    try {
      const result = await runner({
        config: {
          ...resolveGemmaConfig({
            env: {
              GEMMA_DAEMON: "1",
              GEMMA_SERVE_PORT: "8810",
            },
            cwd: "D:\\test-workspace",
          }),
          modelFile,
          serveReadyTimeoutMs: 50,
        },
        modelFile,
        messages: [{ role: "user", content: "short answer" }],
        timeoutMs: 50,
        maxTokens: 24,
        stream: true,
        streamMaxChars: 8,
        streamStopPattern: "继续按压",
      });

      assert.equal(result.stdout, "It looks like a serious issue.继续按压胸骨。");
    } finally {
      shutdownGemmaServers();
    }
  });
});

test("Gemma server runner restarts the daemon after an aborted request", async () => {
  await withMockModelFile(async (modelFile) => {
    const children = [];
    const requests = [];
    let postAttempts = 0;
    const runner = createGemmaServerRunner({
      spawnImpl: createTrackingFakeSpawn(children),
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init });
        if (init.method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "served-after-timeout" }] }),
            text: async () => "",
          };
        }
        postAttempts += 1;
        if (postAttempts === 1) {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          throw error;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(VALID_PATCH) } }],
          }),
          text: async () => "",
        };
      },
    });
    const config = {
      ...resolveGemmaConfig({
        env: {
          GEMMA_DAEMON: "1",
          GEMMA_SERVE_PORT: "8807",
        },
        cwd: "D:\\test-workspace",
      }),
      modelFile,
      serveReadyTimeoutMs: 50,
    };

    try {
      await assert.rejects(
        () =>
          runner({
            config,
            modelFile,
            messages: [{ role: "user", content: "first" }],
            timeoutMs: 50,
          }),
        /aborted/i
      );

      assert.equal(children.length, 1);
      assert.equal(children[0].killCalls, 1, "timed-out daemon should be killed");

      const result = await runner({
        config,
        modelFile,
        messages: [{ role: "user", content: "second" }],
        timeoutMs: 50,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, JSON.stringify(VALID_PATCH));
      assert.equal(children.length, 2, "next request should spawn a fresh daemon");
      assert.equal(postAttempts, 2);
      const postBodies = requests
        .filter((request) => request.init.method === "POST")
        .map((request) => JSON.parse(request.init.body));
      assert.equal(postBodies[1].messages[0].content, "second");
    } finally {
      shutdownGemmaServers();
    }
  });
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

test("GemmaRuntime generatePatch honors a per-call controlled-prompt override", async () => {
  await withMockModelFile(async (modelFile) => {
    let seenSystemPrompt = null;
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({ env: {}, cwd: "D:\\test-workspace" }),
        modelFile
      },
      runner: async ({ messages }) => {
        seenSystemPrompt = messages[0].content;
        return { stdout: JSON.stringify(VALID_PATCH), stderr: "", exitCode: 0 };
      }
    });

    // Default call keeps the standard driver system prompt.
    await runtime.generatePatch(DECISION_FRAME);
    const defaultPrompt = seenSystemPrompt;
    assert.match(defaultPrompt, /话术驱动层|Gemma Model Driver/);

    // The WB open-question call swaps in the controlled Q&A system prompt.
    await runtime.generatePatch(DECISION_FRAME, {
      promptOptions: { systemPromptFile: OPEN_QUESTION_GEMMA_SYSTEM_PROMPT_FILE }
    });
    assert.notEqual(seenSystemPrompt, defaultPrompt);
    assert.match(seenSystemPrompt, /受控问答/);
  });
});

test("GemmaRuntime generatePatch honors a per-call timeout override", async () => {
  await withMockModelFile(async (modelFile) => {
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_TIMEOUT_MS: "5000",
          },
          cwd: "D:\\test-workspace"
        }),
        modelFile
      },
      runner: async ({ timeoutMs }) => {
        assert.equal(timeoutMs, 321);
        return { stdout: JSON.stringify(VALID_PATCH), stderr: "", exitCode: 0 };
      }
    });

    const result = await runtime.generatePatch(DECISION_FRAME, { timeoutMs: 321 });

    assert.equal(result.ok, true);
    assert.equal(result.patch.intent, "parse_response_answer");
  });
});

test("GemmaRuntime generateText uses daemon chat with a short token budget", async () => {
  await withMockModelFile(async (modelFile) => {
    let seen = null;
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_DAEMON: "1",
            GEMMA_SERVE_PORT: "8797",
          },
          cwd: "D:\\test-workspace",
        }),
        modelFile
      },
      serverRunner: async (request) => {
        seen = request;
        return {
          stdout: "继续按压，保持节奏。",
          stderr: "",
          exitCode: 0,
          daemon: true,
        };
      }
    });

    const result = await runtime.generateText(
      [{ role: "user", content: "short answer" }],
      { timeoutMs: 987, maxTokens: 32 }
    );

    assert.equal(result.ok, true);
    assert.equal(result.text, "继续按压，保持节奏。");
    assert.equal(seen.timeoutMs, 987);
    assert.equal(seen.maxTokens, 32);
    assert.equal(seen.stream, false);
    assert.deepEqual(seen.messages, [{ role: "user", content: "short answer" }]);
  });
});

test("GemmaRuntime generateText can request streaming text", async () => {
  await withMockModelFile(async (modelFile) => {
    let seen = null;
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_DAEMON: "1",
            GEMMA_SERVE_PORT: "8796",
          },
          cwd: "D:\\test-workspace",
        }),
        modelFile
      },
      serverRunner: async (request) => {
        seen = request;
        return {
          stdout: "继续按压胸骨。",
          stderr: "",
          exitCode: 0,
          daemon: true,
          streamed: true,
        };
      }
    });

    const result = await runtime.generateText(
      [{ role: "user", content: "short answer" }],
      { timeoutMs: 900, maxTokens: 24, stream: true, streamMaxChars: 18 }
    );

    assert.equal(result.ok, true);
    assert.equal(result.text, "继续按压胸骨。");
    assert.equal(result.streamed, true);
    assert.equal(seen.stream, true);
    assert.equal(seen.streamMaxChars, 18);
    assert.equal(seen.streamStopPattern, null);
  });
});

test("GemmaRuntime parses NLU observations with independent timeout", async () => {
  await withMockModelFile(async (modelFile) => {
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_NLU_TIMEOUT_MS: "640"
          },
          cwd: "D:\\test-workspace"
        }),
        modelFile
      },
      runner: async ({ messages, timeoutMs }) => {
        assert.equal(timeoutMs, 640);
        assert.match(messages[0].content, /Gemma NLU|NLU observation parser/);
        assert.match(messages[1].content, /NluFrame|NluObservationFrame/);

        return {
          stdout: JSON.stringify(VALID_NLU),
          stderr: "",
          exitCode: 0
        };
      }
    });

    const result = await runtime.parseUserIntent({
      current_stage: "S3_CHECK_BREATHING",
      allowed_intents: ["no_normal_breathing", "agonal_breathing"],
      allowed_slots: {
        normal_breathing: "boolean",
        agonal_breathing: "boolean"
      },
      user_input: {
        stt_text: "他好像没气了，偶尔喘一下"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.intent, "no_normal_breathing");
    assert.equal(result.slots.normal_breathing.value, false);
    assert.equal(result.confidence, 0.89);
  });
});

test("Gemma NLU parser rejects decision and tool fields", () => {
  const result = parseGemmaNluResponse(
    JSON.stringify({
      ...VALID_NLU,
      next_stage: "S4_SUSPECTED_ARREST",
      tool_actions: [{ type: "emergency_call" }]
    }),
    {
      allowed_intents: ["no_normal_breathing", "agonal_breathing"],
      allowed_slots: {
        normal_breathing: "boolean",
        agonal_breathing: "boolean"
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "nlu_validation_failed");
  assert.ok(result.violations.includes("disallowed_field:next_stage"));
  assert.ok(result.violations.includes("disallowed_field:tool_actions"));
});

test("GemmaRuntime falls back to one-shot runner when daemon runner fails", async () => {
  await withMockModelFile(async (modelFile) => {
    let serverCalls = 0;
    let spawnCalls = 0;
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_DAEMON: "1",
            GEMMA_BACKEND: "gpu",
          },
          cwd: "D:\\test-workspace",
        }),
        modelFile
      },
      serverRunner: async () => {
        serverCalls += 1;
        throw new Error("daemon unavailable");
      },
      runner: async ({ backend }) => {
        spawnCalls += 1;
        assert.equal(backend, "gpu");
        return {
          stdout: JSON.stringify(VALID_PATCH),
          stderr: "",
          exitCode: 0
        };
      }
    });

    const result = await runtime.generatePatch(DECISION_FRAME);

    assert.equal(result.ok, true);
    assert.equal(result.patch.intent, "parse_response_answer");
    assert.equal(serverCalls, 1);
    assert.equal(spawnCalls, 1);
  });
});

test("GemmaRuntime skips one-shot fallback when a realtime timeout budget is explicit", async () => {
  await withMockModelFile(async (modelFile) => {
    let serverCalls = 0;
    let spawnCalls = 0;
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({
          env: {
            GEMMA_DAEMON: "1",
            GEMMA_BACKEND: "gpu",
          },
          cwd: "D:\\test-workspace",
        }),
        modelFile
      },
      serverRunner: async () => {
        serverCalls += 1;
        throw new Error("daemon request timed out");
      },
      runner: async () => {
        spawnCalls += 1;
        return {
          stdout: JSON.stringify(VALID_PATCH),
          stderr: "",
          exitCode: 0
        };
      }
    });

    const result = await runtime.generatePatch(DECISION_FRAME, { timeoutMs: 321 });

    assert.equal(result.ok, true);
    assert.equal(result.fallback, true);
    assert.equal(result.reason, "timeout");
    assert.equal(serverCalls, 1);
    assert.equal(spawnCalls, 0);
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

test("Gemma parser rejects mojibake replacement text", () => {
  const result = parseGemmaResponse(
    JSON.stringify({
      ...VALID_PATCH,
      tts: {
        ...VALID_PATCH.tts,
        text: "锟斤拷锟斤拷锟叫斤拷锟斤拷"
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

function createFakeSpawn() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdout.unref = () => {};
    child.stderr.unref = () => {};
    child.unref = () => {};
    child.kill = () => {
      queueMicrotask(() => child.emit("close", 0, null));
    };
    return child;
  };
}

function createSseResponse(events, onCancel = () => {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= events.length) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const event = events[index];
      index += 1;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    cancel() {
      onCancel();
    },
  });

  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
    text: async () => "",
  };
}

function createTrackingFakeSpawn(children = []) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdout.unref = () => {};
    child.stderr.unref = () => {};
    child.unref = () => {};
    child.killCalls = 0;
    child.kill = (signal) => {
      child.killCalls += 1;
      child.killSignal = signal;
      queueMicrotask(() => child.emit("close", 0, signal || null));
      return true;
    };
    children.push(child);
    return child;
  };
}
