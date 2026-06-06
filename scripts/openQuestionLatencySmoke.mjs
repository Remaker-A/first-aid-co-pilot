#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../src/config/loadEnv.js";
import { AgentStage, createVoiceDemoService, GemmaRuntime } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const artifactsDir = path.join(root, "artifacts");

loadEnv({ cwd: root });

const args = parseArgs(process.argv.slice(2));
const rounds = positiveInt(args.rounds, 3);
const realGemma = boolArg(args["real-gemma"]);
const requireGemmaAnswer = boolArg(args["require-gemma-answer"]);
const gemmaDelayMs = positiveInt(args["gemma-delay-ms"], 30);
const textTimeoutMs = positiveInt(args["text-timeout-ms"], 800);
const textStream = args["text-stream"] === "false" || boolArg(args["no-text-stream"]) ? false : true;
const maxGemmaAnswerWaitMs = positiveInt(args["max-gemma-answer-wait-ms"], 800);
const maxGemmaTotalMs = positiveInt(args["max-gemma-total-ms"], 1_000);
const sessionPrefix = args.session || `oq_${Date.now().toString(36)}`;

const CASES = [
  {
    id: "closed_quality_mishear",
    text: "我爱的对吗",
    kind: "closed_set",
    expect: {
      openQuestion: false,
      intent: "ask_cpr_quality",
      guidanceSource: "rule_fast_path",
      responseType: "question_answer",
    },
  },
  {
    id: "template_no_breaths",
    text: "为什么不能人工呼吸",
    kind: "template",
    expect: {
      openQuestion: true,
      answerSource: "open_question_template",
      maxAnswerWaitMs: 5,
    },
  },
  {
    id: textStream ? "gemma_text_stream" : "gemma_text",
    text: "为什么他的鞋子湿了",
    kind: "gemma",
    expect: {
      openQuestion: true,
      answerSourceAny: ["gemma_open_question_text_stream", "gemma_open_question_text"],
      fallbackAllowed: !requireGemmaAnswer && realGemma,
      maxAnswerWaitMs: maxGemmaAnswerWaitMs,
      maxTotalMs: maxGemmaTotalMs,
    },
  },
];

await main();

async function main() {
  const runtime = realGemma ? new GemmaRuntime({ daemon: true }) : createFakeGemmaRuntime({ delayMs: gemmaDelayMs });
  const service = createVoiceDemoService({
    runtime,
    tts: { provider: "mock" },
    waitForOpenQuestionAnswer: true,
    gemma_open_question_text_timeout_ms: textTimeoutMs,
    gemma_open_question_text_stream: textStream,
    gemma_open_question_text_stream_max_chars: 24,
    // Keep non-open-question turns deterministic; open questions still exercise
    // generateText in the controlled text path.
    env: {
      ...process.env,
      ...(realGemma ? { GEMMA_DAEMON: "1" } : {}),
      INTENT_NLU: "off",
    },
  });

  const prewarmStart = performance.now();
  const prewarm = realGemma && typeof service.prewarm === "function"
    ? await service.prewarm({ timeoutMs: positiveInt(args["prewarm-timeout-ms"], 60_000) })
    : { ok: true, warmed: false, reason: "fake_runtime" };
  const prewarmMs = Math.round(performance.now() - prewarmStart);

  const results = [];
  for (let round = 1; round <= rounds; round += 1) {
    const sessionId = `${sessionPrefix}_r${round}`;
    const ready = await prepareS7(service, sessionId);
    for (const testCase of CASES) {
      const started = performance.now();
      const response = await service.handleTurn({
        sessionId,
        text: testCase.text,
        waitForOpenQuestionAnswer: true,
      });
      const elapsedMs = Math.round(performance.now() - started);
      results.push(evaluateCase({ round, testCase, response, elapsedMs, ready }));
    }
  }

  const summary = summarize(results, {
    rounds,
    realGemma,
    requireGemmaAnswer,
    prewarm,
    prewarmMs,
    textTimeoutMs,
    textStream,
    maxGemmaAnswerWaitMs,
    maxGemmaTotalMs,
  });
  await fs.mkdir(artifactsDir, { recursive: true });
  const outputPath = path.join(
    artifactsDir,
    `open-question-latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await fs.writeFile(outputPath, JSON.stringify({ summary, results }, null, 2), "utf8");
  printSummary(summary, results, outputPath);
  process.exitCode = summary.ok ? 0 : 1;
}

async function prepareS7(service, sessionId) {
  const turns = [
    "现场安全了，我在患者旁",
    "他没有反应",
    "没有呼吸，偶尔喘一下",
    "120 已经拨打",
    "准备好了",
    "开始按压",
  ];
  let last = null;
  for (const text of turns) {
    last = await service.handleTurn({ sessionId, text, waitForOpenQuestionAnswer: true });
  }
  return {
    ok: last?.state?.current_stage === AgentStage.S7_CPR_LOOP,
    stage: last?.state?.current_stage || null,
    intent: last?.guidance_action?.intent || null,
  };
}

function evaluateCase({ round, testCase, response, elapsedMs, ready }) {
  const answer = response.open_question_answer || null;
  const intent = response.intent_resolution?.intent || response.stt?.intent || null;
  const actual = {
    ready,
    text: testCase.text,
    stage: response.state?.current_stage || null,
    intent,
    guidance_intent: response.guidance_action?.intent || null,
    guidance_source: response.guidance_source || null,
    response_type: response.response_type || null,
    open_question: response.open_question === true,
    answer_source: answer?.source || null,
    answer_ok: answer?.ok === true,
    answer_fallback: answer?.fallback === true,
    answer_reason: answer?.reason || null,
    answer_wait_ms: numberOrNull(answer?.wait_ms),
    tts_text: response.guidance_action?.tts?.text || "",
    total_ms: numberOrNull(response.timings?.total_ms) ?? elapsedMs,
    elapsed_ms: elapsedMs,
    timings: response.timings || {},
  };

  const checks = [];
  addCheck(checks, "prepared_s7", ready.ok, "S7_CPR_LOOP", ready.stage);
  addCheck(checks, "stage_stays_live", [AgentStage.S7_CPR_LOOP, AgentStage.S8_ASSISTANCE].includes(actual.stage), "S7/S8", actual.stage);

  const expect = testCase.expect;
  if (typeof expect.openQuestion === "boolean") {
    addCheck(checks, "open_question", actual.open_question === expect.openQuestion, String(expect.openQuestion), String(actual.open_question));
  }
  if (expect.intent) {
    addCheck(checks, "intent", actual.intent === expect.intent, expect.intent, actual.intent);
  }
  if (expect.guidanceSource) {
    addCheck(checks, "guidance_source", actual.guidance_source === expect.guidanceSource, expect.guidanceSource, actual.guidance_source);
  }
  if (expect.responseType) {
    addCheck(checks, "response_type", actual.response_type === expect.responseType, expect.responseType, actual.response_type);
  }
  if (expect.answerSource) {
    addCheck(checks, "answer_source", actual.answer_source === expect.answerSource, expect.answerSource, actual.answer_source);
  }
  if (Array.isArray(expect.answerSourceAny)) {
    const sourceOk = expect.answerSourceAny.includes(actual.answer_source);
    const fallbackOk = expect.fallbackAllowed === true && actual.answer_fallback === true;
    addCheck(
      checks,
      "answer_source",
      sourceOk || fallbackOk,
      `${expect.answerSourceAny.join(" | ")}${expect.fallbackAllowed ? " | fallback" : ""}`,
      actual.answer_source || (actual.answer_fallback ? "fallback" : "<none>")
    );
  }
  if (typeof expect.maxAnswerWaitMs === "number") {
    const fallbackIsAllowed = expect.fallbackAllowed === true && actual.answer_fallback === true;
    addCheck(
      checks,
      "answer_wait",
      fallbackIsAllowed || (actual.answer_wait_ms ?? Infinity) <= expect.maxAnswerWaitMs,
      `<=${expect.maxAnswerWaitMs}ms`,
      `${actual.answer_wait_ms ?? "null"}ms`
    );
  }
  if (typeof expect.maxTotalMs === "number") {
    const fallbackIsAllowed = expect.fallbackAllowed === true && actual.answer_fallback === true;
    addCheck(
      checks,
      "total_latency",
      fallbackIsAllowed || (actual.total_ms ?? Infinity) <= expect.maxTotalMs,
      `<=${expect.maxTotalMs}ms`,
      `${actual.total_ms ?? "null"}ms`
    );
  }

  return {
    round,
    id: testCase.id,
    kind: testCase.kind,
    ok: checks.every((check) => check.ok),
    checks,
    actual,
  };
}

function summarize(results, options) {
  const failed = results.filter((result) => !result.ok);
  const globalFailures = [];
  if (options.realGemma && options.requireGemmaAnswer && options.prewarm?.warmed !== true) {
    globalFailures.push("gemma_prewarm_not_warmed");
  }
  const byKind = {};
  for (const result of results) {
    const bucket = byKind[result.kind] || (byKind[result.kind] = []);
    bucket.push(result.actual.total_ms);
  }
  const latencyByKind = Object.fromEntries(
    Object.entries(byKind).map(([kind, values]) => [kind, percentileSummary(values)])
  );
  const openQuestionWaits = results
    .map((result) => result.actual.answer_wait_ms)
    .filter((value) => typeof value === "number");
  return {
    ok: failed.length === 0 && globalFailures.length === 0,
    rounds: options.rounds,
    real_gemma: options.realGemma,
    require_gemma_answer: options.requireGemmaAnswer,
    text_timeout_ms: options.textTimeoutMs,
    text_stream: options.textStream,
    max_gemma_answer_wait_ms: options.maxGemmaAnswerWaitMs,
    max_gemma_total_ms: options.maxGemmaTotalMs,
    prewarm_ms: options.prewarmMs,
    prewarm: options.prewarm,
    total_cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    global_failures: globalFailures,
    failed_cases: failed.map((result) => `${result.id}@r${result.round}`),
    latency_ms_by_kind: latencyByKind,
    open_question_answer_wait_ms: percentileSummary(openQuestionWaits),
    gemma_sources: countBy(results.map((result) => result.actual.answer_source || (result.actual.answer_fallback ? "fallback" : "none"))),
  };
}

function percentileSummary(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, p50: null, p95: null, max: null };
  }
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function createFakeGemmaRuntime({ delayMs }) {
  return {
    async generatePatch() {
      return { ok: true, skipped: true, skipReason: "fake_runtime", patch: null };
    },
    async parseUserIntent() {
      return { ok: false, reason: "fake_runtime", intent: null, slots: {}, confidence: 0 };
    },
    async prewarm() {
      return { ok: true, warmed: false, reason: "fake_runtime" };
    },
    async generateText(_messages, options = {}) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      return {
        ok: true,
        text: "It looks serious.继续按压胸骨。",
        streamed: options.stream === true,
        reason: options.stream ? "fake_stream" : "fake_text",
      };
    },
  };
}

function printSummary(summary, results, outputPath) {
  console.log(`Open question latency smoke: ${summary.ok ? "PASS" : "FAIL"}`);
  console.log(`rounds=${summary.rounds} real_gemma=${summary.real_gemma} passed=${summary.passed}/${summary.total_cases}`);
  console.log(
    `prewarm=${summary.prewarm_ms}ms text_timeout=${summary.text_timeout_ms}ms ` +
      `text_stream=${summary.text_stream} gemma_wait<=${summary.max_gemma_answer_wait_ms}ms ` +
      `gemma_total<=${summary.max_gemma_total_ms}ms`
  );
  console.log(`latency=${JSON.stringify(summary.latency_ms_by_kind)}`);
  console.log(`answer_wait=${JSON.stringify(summary.open_question_answer_wait_ms)} sources=${JSON.stringify(summary.gemma_sources)}`);
  if (summary.global_failures?.length) {
    console.log(`global_failures=${summary.global_failures.join(",")}`);
  }
  console.log(`report=${outputPath}`);
  for (const result of results) {
    const marker = result.ok ? "PASS" : "FAIL";
    console.log(
      `[${marker}] r${result.round} ${result.id} kind=${result.kind} ` +
        `source=${result.actual.answer_source || result.actual.guidance_source} ` +
        `intent=${result.actual.intent || "none"} total=${result.actual.total_ms}ms wait=${result.actual.answer_wait_ms ?? "n/a"}ms`
    );
    if (!result.ok) {
      for (const check of result.checks.filter((item) => !item.ok)) {
        console.log(`       ${check.name}: expected ${check.expected}; actual ${check.actual}`);
      }
      console.log(`       tts: ${result.actual.tts_text}`);
    }
  }
}

function addCheck(checks, name, ok, expected, actual) {
  checks.push({ name, ok, expected, actual });
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) {
      parsed[body] = "true";
    } else {
      parsed[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boolArg(value) {
  return value === true || value === "true" || value === "1";
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
