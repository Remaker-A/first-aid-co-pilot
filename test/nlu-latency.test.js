import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentStage,
  GemmaRuntime,
  createVoiceDemoService,
  resolveGemmaConfig,
  resolveUserIntent,
} from "../src/index.js";
import {
  createNluBudget,
  createNluCache,
  createNluGovernor,
  nluCacheKey,
} from "../src/gemma/nluCache.js";

// A fuzzy S3 utterance that misses the regex layer and therefore escalates to
// the (mocked) NLU runtime. Kept in one place so the cache-key assumptions are
// obvious across tests.
const FUZZY_S3 = "他好像没气了";

const VALID_BREATHING_NLU = Object.freeze({
  ok: true,
  intent: "no_normal_breathing",
  slots: { normal_breathing: { value: false, confidence: 0.9 } },
  confidence: 0.88,
  needs_clarification: false,
});

// Mirrors test/hybrid-nlu.test.js's nluRuntime but counts calls so we can prove
// the cache/budget actually skip the model. Never touches a real Gemma.
function countingNluRuntime(handler) {
  const runtime = {
    calls: 0,
    lastFrame: null,
    async parseUserIntent(frame) {
      runtime.calls += 1;
      runtime.lastFrame = frame;
      return handler(frame, runtime.calls);
    },
  };
  return runtime;
}

function nluOptions(extra = {}) {
  return {
    intentNlu: true,
    sessionId: "sess_latency",
    nluCache: createNluCache({ maxEntries: 8, ttlMs: 60_000 }),
    nluBudget: createNluBudget({ maxCalls: 10, windowMs: 60_000 }),
    ...extra,
  };
}

test("nluCacheKey trims whitespace and is scoped per stage", () => {
  assert.equal(
    nluCacheKey("  他好像没气了 ", AgentStage.S3_CHECK_BREATHING),
    nluCacheKey("他好像没气了", AgentStage.S3_CHECK_BREATHING),
  );
  assert.notEqual(
    nluCacheKey("他好像没气了", AgentStage.S3_CHECK_BREATHING),
    nluCacheKey("他好像没气了", AgentStage.S2_CHECK_RESPONSE),
  );
});

test("cache hit: an identical transcript+stage skips the runtime on the second turn", async () => {
  const runtime = countingNluRuntime(() => ({ ...VALID_BREATHING_NLU }));
  const options = nluOptions();

  const first = await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });
  assert.equal(first.source, "gemma_nlu");
  assert.equal(first.intent, "no_normal_breathing");
  assert.equal(first.cacheHit ?? false, false);
  assert.equal(runtime.calls, 1);

  const second = await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });
  assert.equal(runtime.calls, 1, "second identical turn must be served from cache");
  assert.equal(second.cacheHit, true);
  assert.equal(second.source, "gemma_nlu");
  assert.equal(second.intent, "no_normal_breathing");
  assert.equal(second.slots.normal_breathing.value, false);
  assert.equal(options.nluCache.size, 1);
});

test("cache is keyed by stage: the same words at a different stage still calls the runtime", async () => {
  const runtime = countingNluRuntime(() => ({ ...VALID_BREATHING_NLU }));
  const options = nluOptions();

  await resolveUserIntent({ transcript: FUZZY_S3, stage: AgentStage.S3_CHECK_BREATHING, runtime, options });
  await resolveUserIntent({ transcript: FUZZY_S3, stage: AgentStage.S4_SUSPECTED_ARREST, runtime, options });

  assert.equal(runtime.calls, 2);
  assert.equal(options.nluCache.size, 2);
});

test("budget: once a session is over budget the resolver falls back to regex without calling the runtime", async () => {
  const runtime = countingNluRuntime(() => ({ ...VALID_BREATHING_NLU }));
  const options = nluOptions({
    sessionId: "sess_budget",
    nluBudget: createNluBudget({ maxCalls: 1, windowMs: 60_000 }),
  });

  const first = await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });
  assert.equal(first.source, "gemma_nlu");
  assert.equal(runtime.calls, 1);

  // A *different* transcript so the cache cannot absorb it; same session so the
  // budget applies and the second escalation is throttled to the regex fallback.
  const second = await resolveUserIntent({
    transcript: "我也说不太清楚",
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });
  assert.equal(runtime.calls, 1, "over-budget turn must not call the runtime");
  assert.equal(second.escalated, true);
  assert.notEqual(second.source, "gemma_nlu");
  assert.equal(second.fallbackReason, "nlu_budget_exceeded");
});

test("budget is per-session: a fresh session still gets its own allowance", async () => {
  const runtime = countingNluRuntime(() => ({ ...VALID_BREATHING_NLU }));
  const budget = createNluBudget({ maxCalls: 1, windowMs: 60_000 });
  const cache = createNluCache({ maxEntries: 8, ttlMs: 60_000 });

  await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options: { intentNlu: true, sessionId: "sess_a", nluCache: cache, nluBudget: budget },
  });
  const other = await resolveUserIntent({
    transcript: "另一个含糊的说法",
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options: { intentNlu: true, sessionId: "sess_b", nluCache: cache, nluBudget: budget },
  });

  assert.equal(runtime.calls, 2, "different sessions each have their own budget");
  assert.equal(other.source, "gemma_nlu");
});

test("timeout fallback: a timed-out runtime falls back to regex safely and is not cached", async () => {
  const runtime = countingNluRuntime(() => ({
    ok: false,
    source: "gemma_nlu",
    fallback: true,
    fallbackReason: "timeout",
    reason: "timeout",
    intent: null,
    slots: {},
    needs_clarification: true,
  }));
  const options = nluOptions({ sessionId: "sess_timeout" });

  const first = await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });
  assert.equal(first.escalated, true);
  assert.equal(first.fallbackReason, "timeout");
  assert.notEqual(first.source, "gemma_nlu");
  assert.equal(runtime.calls, 1);

  // A transient timeout must NOT be cached, otherwise the session would be pinned
  // to the fallback for the whole TTL. The next identical turn retries.
  const second = await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });
  assert.equal(runtime.calls, 2);
  assert.equal(second.fallbackReason, "timeout");
  assert.equal(options.nluCache.size, 0);
});

test("runtime exception: the resolver never throws and falls back to regex", async () => {
  const runtime = countingNluRuntime(() => {
    throw new Error("model crashed");
  });
  const options = nluOptions({ sessionId: "sess_throw" });

  const result = await resolveUserIntent({
    transcript: FUZZY_S3,
    stage: AgentStage.S3_CHECK_BREATHING,
    runtime,
    options,
  });

  assert.equal(result.escalated, true);
  assert.equal(result.fallbackReason, "nlu_runtime_failed");
  assert.notEqual(result.source, "gemma_nlu");
  assert.equal(options.nluCache.size, 0);
});

test("cache TTL: an expired entry forces a fresh runtime call", async () => {
  let clock = 1_000;
  const cache = createNluCache({ maxEntries: 8, ttlMs: 100, now: () => clock });
  const budget = createNluBudget({ maxCalls: 10, windowMs: 60_000, now: () => clock });
  const runtime = countingNluRuntime(() => ({ ...VALID_BREATHING_NLU }));
  const options = { intentNlu: true, sessionId: "sess_ttl", nluCache: cache, nluBudget: budget };

  await resolveUserIntent({ transcript: FUZZY_S3, stage: AgentStage.S3_CHECK_BREATHING, runtime, options });
  assert.equal(runtime.calls, 1);

  clock += 50; // still inside the TTL
  const warm = await resolveUserIntent({ transcript: FUZZY_S3, stage: AgentStage.S3_CHECK_BREATHING, runtime, options });
  assert.equal(runtime.calls, 1);
  assert.equal(warm.cacheHit, true);

  clock += 200; // TTL has now elapsed
  const cold = await resolveUserIntent({ transcript: FUZZY_S3, stage: AgentStage.S3_CHECK_BREATHING, runtime, options });
  assert.equal(runtime.calls, 2);
  assert.equal(cold.cacheHit ?? false, false);
});

test("budget sliding window recovers after the window elapses", () => {
  let clock = 0;
  const budget = createNluBudget({ maxCalls: 1, windowMs: 1_000, now: () => clock });

  assert.equal(budget.tryConsume("s"), true);
  assert.equal(budget.tryConsume("s"), false);
  assert.equal(budget.used("s"), 1);

  clock += 1_500;
  assert.equal(budget.canConsume("s"), true);
  assert.equal(budget.tryConsume("s"), true);
});

test("createNluGovernor layers nlu_slots baseline, env, and disable switches", () => {
  const baseline = {
    cache: { enabled: true, max_entries: 5, ttl_ms: 1_234 },
    budget: { enabled: true, max_calls: 3, window_ms: 5_678 },
  };

  const fromBaseline = createNluGovernor({ baseline, env: {} });
  assert.equal(fromBaseline.cache.maxEntries, 5);
  assert.equal(fromBaseline.cache.ttlMs, 1_234);
  assert.equal(fromBaseline.budget.maxCalls, 3);
  assert.equal(fromBaseline.budget.windowMs, 5_678);

  const disabled = createNluGovernor({ baseline, env: { NLU_CACHE: "off", NLU_BUDGET: "0" } });
  assert.equal(disabled.cache, null);
  assert.equal(disabled.budget, null);

  const envOverride = createNluGovernor({ baseline, env: { NLU_CACHE_MAX_ENTRIES: "99" } });
  assert.equal(envOverride.cache.maxEntries, 99);
});

test("GemmaRuntime.prewarm reuses the resident daemon path in daemon mode", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "firstaid-nlu-warmup-"));
  try {
    const modelFile = join(tempDir, "gemma-4-E2B-it-q4_k_m.litertlm");
    await writeFile(modelFile, "x");

    let serverCalls = 0;
    const runtime = new GemmaRuntime({
      config: {
        ...resolveGemmaConfig({ env: { GEMMA_DAEMON: "1" }, cwd: tempDir }),
        modelFile,
      },
      serverRunner: async () => {
        serverCalls += 1;
        return { stdout: "{}", stderr: "", exitCode: 0, daemon: true };
      },
      runner: async () => {
        throw new Error("one-shot runner must not be used for warmup");
      },
    });

    const result = await runtime.prewarm();

    assert.equal(result.ok, true);
    assert.equal(result.warmed, true);
    assert.equal(serverCalls, 1, "warmup must hit the resident daemon exactly once");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GemmaRuntime.prewarm is a safe no-op when the daemon is disabled", async () => {
  let serverCalls = 0;
  const runtime = new GemmaRuntime({
    config: resolveGemmaConfig({ env: {}, cwd: "D:\\test-workspace" }),
    serverRunner: async () => {
      serverCalls += 1;
      return { stdout: "{}", exitCode: 0 };
    },
  });

  const result = await runtime.prewarm();

  assert.equal(result.ok, true);
  assert.equal(result.warmed, false);
  assert.equal(result.reason, "daemon_disabled");
  assert.equal(serverCalls, 0, "one-shot mode must never spawn a warmup process");
});

test("voice service NLU cache: a repeated low-confidence S3 answer is served from cache", async () => {
  const runtime = serviceCountingNluRuntime({
    [FUZZY_S3]: {
      intent: "no_normal_breathing",
      slots: { normal_breathing: { value: false, confidence: 0.4 } },
      confidence: 0.62,
      needs_clarification: true,
    },
  });
  const service = createVoiceDemoService({
    runtime,
    tts: { provider: "mock" },
    intentNlu: true,
  });
  const sessionId = "sess_service_cache";

  await service.handleTurn({ sessionId, text: "现场安全了" });
  await service.handleTurn({ sessionId, text: "他没有反应" });

  const first = await service.handleTurn({ sessionId, text: FUZZY_S3 });
  assert.equal(first.state.current_stage, AgentStage.S3_CHECK_BREATHING);
  assert.equal(first.intent_resolution.source, "gemma_nlu");
  assert.equal(first.intent_resolution.cacheHit ?? false, false);
  const callsAfterFirst = runtime.calls;

  const second = await service.handleTurn({ sessionId, text: FUZZY_S3 });
  assert.equal(runtime.calls, callsAfterFirst, "second identical S3 turn must hit the NLU cache");
  assert.equal(second.intent_resolution.cacheHit, true);
  assert.equal(second.event.metadata.intent_resolution.cache_hit, true);
  assert.equal(second.state.current_stage, AgentStage.S3_CHECK_BREATHING);
});

function serviceCountingNluRuntime(byTranscript) {
  const runtime = {
    calls: 0,
    async parseUserIntent(frame) {
      runtime.calls += 1;
      const key = frame.user_input?.stt_text || frame.transcript;
      const result = byTranscript[key];
      if (!result) {
        return { ok: false, reason: "unexpected_transcript" };
      }
      return { ok: true, needs_clarification: false, ...result };
    },
    async generatePatch(frame) {
      const intent = frame.allowed_intents?.[0] || "fallback_template";
      return {
        ok: true,
        patch: {
          intent,
          tts: { text: "请按当前步骤继续。", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "继续", secondary_text: "按提示操作" },
          visual_overlay: { mode: null, highlight_target: null, correction_arrow: null },
          log_suggestion: { type: "test", detail: "test" },
          reason: "test_runtime",
          confidence: 0.8,
        },
        violations: [],
      };
    },
  };
  return runtime;
}
