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
const timeoutMs = positiveInt(args["text-timeout-ms"], 1_800);
const streamMaxChars = positiveInt(args["text-stream-max-chars"], 44);
const prewarmTimeoutMs = positiveInt(args["prewarm-timeout-ms"], 60_000);
const realGemma = args["fake-gemma"] !== "true";
const questionLimit = positiveInt(args.limit, QUESTIONS.length);

await main();

async function main() {
  const runtime = realGemma ? createObservedGemmaRuntime() : createFakeRuntime();
  const service = createVoiceDemoService({
    runtime,
    tts: { provider: "mock" },
    waitForOpenQuestionAnswer: true,
    gemma_open_question_text_timeout_ms: timeoutMs,
    gemma_open_question_text_stream: true,
    gemma_open_question_text_stream_max_chars: streamMaxChars,
    env: { ...process.env, GEMMA_DAEMON: realGemma ? "1" : "0", INTENT_NLU: "off" },
  });

  const prewarmStart = performance.now();
  const prewarm = realGemma && typeof service.prewarm === "function"
    ? await service.prewarm({ timeoutMs: prewarmTimeoutMs })
    : { ok: true, warmed: false, reason: "fake_runtime" };
  const prewarmMs = Math.round(performance.now() - prewarmStart);

  const sessionId = `oq_batch_${Date.now().toString(36)}`;
  const preparedStage = await prepareS7(service, sessionId);
  const rows = [];
  for (const question of QUESTIONS.slice(0, questionLimit)) {
    const before = runtime.calls.length;
    const started = performance.now();
    const response = await service.handleTurn({
      sessionId,
      text: question.text,
      waitForOpenQuestionAnswer: true,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const answer = response.open_question_answer || null;
    const gemma = runtime.calls.length > before ? runtime.calls.at(-1) : null;
    rows.push({
      id: question.id,
      text: question.text,
      expected_focus: question.focus,
      intent: response.intent_resolution?.intent || response.stt?.intent || null,
      open_question: response.open_question === true,
      source: answer?.source || response.guidance_source || null,
      reason: answer?.reason || null,
      final_tts: answer?.action?.tts?.text || response.guidance_action?.tts?.text || "",
      raw_gemma_text: gemma?.text || "",
      raw_gemma_reason: gemma?.reason || null,
      raw_gemma_ms: gemma?.ms ?? null,
      answer_wait_ms: answer?.wait_ms ?? null,
      total_ms: response.timings?.total_ms ?? elapsedMs,
      elapsed_ms: elapsedMs,
    });
  }

  const summary = summarize({ rows, prewarm, prewarmMs, preparedStage });
  await fs.mkdir(artifactsDir, { recursive: true });
  const reportPath = path.join(
    artifactsDir,
    `open-question-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await fs.writeFile(reportPath, JSON.stringify({ summary, rows }, null, 2), "utf8");
  printReport(summary, rows, reportPath);
}

function createObservedGemmaRuntime() {
  const inner = new GemmaRuntime({ daemon: true });
  const calls = [];
  return {
    calls,
    prewarm: (options) => inner.prewarm(options),
    async generateText(messages, options) {
      const started = performance.now();
      const result = await inner.generateText(messages, options);
      calls.push({
        ms: Math.round(performance.now() - started),
        ok: result?.ok === true,
        reason: result?.reason || result?.skipReason || null,
        text: result?.text || "",
        streamed: result?.streamed === true,
      });
      return result;
    },
    generatePatch: (...callArgs) => inner.generatePatch(...callArgs),
  };
}

function createFakeRuntime() {
  const calls = [];
  return {
    calls,
    async generateText(_messages, _options) {
      const call = {
        ms: 20,
        ok: true,
        reason: null,
        text: "继续按压，让旁人拿 AED 并准备换手。",
        streamed: true,
      };
      calls.push(call);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, text: call.text, streamed: true };
    },
    async generatePatch() {
      return new Promise(() => {});
    },
  };
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
  return last?.state?.current_stage || null;
}

function summarize({ rows, prewarm, prewarmMs, preparedStage }) {
  const openRows = rows.filter((row) => row.open_question);
  const gemmaRows = rows.filter((row) => String(row.source || "").startsWith("gemma_open_question"));
  const repairRows = rows.filter((row) => row.source === "open_question_repair_template");
  const fallbackRows = rows.filter((row) => row.source === "open_question_fallback");
  return {
    ok: preparedStage === AgentStage.S7_CPR_LOOP && rows.every((row) => row.open_question),
    real_gemma: realGemma,
    prepared_stage: preparedStage,
    prewarm_ms: prewarmMs,
    prewarm,
    total_questions: rows.length,
    open_questions: openRows.length,
    gemma_answers: gemmaRows.length,
    repair_answers: repairRows.length,
    fallback_answers: fallbackRows.length,
    latency_ms: percentileSummary(rows.map((row) => row.total_ms)),
    answer_wait_ms: percentileSummary(rows.map((row) => row.answer_wait_ms).filter(Number.isFinite)),
    source_counts: countBy(rows.map((row) => row.source || "none")),
  };
}

function printReport(summary, rows, reportPath) {
  console.log(`Open question batch: ${summary.ok ? "PASS" : "CHECK"}`);
  console.log(
    `questions=${summary.total_questions} real_gemma=${summary.real_gemma} stage=${summary.prepared_stage} ` +
      `prewarm=${summary.prewarm_ms}ms`,
  );
  console.log(`sources=${JSON.stringify(summary.source_counts)} latency=${JSON.stringify(summary.latency_ms)}`);
  console.log(`report=${reportPath}`);
  for (const row of rows) {
    console.log(
      `[${row.source || "none"}] ${row.total_ms}ms wait=${row.answer_wait_ms ?? "n/a"}ms ` +
        `${row.text} -> ${row.final_tts}`,
    );
  }
}

function percentileSummary(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null, max: null };
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    parsed[key] = value ?? "true";
  }
  return parsed;
}

const QUESTIONS = [
  { id: "cause", text: "他为什么会突然倒下？", focus: "原因解释" },
  { id: "survival", text: "他还有救吗？", focus: "情绪安抚" },
  { id: "rib", text: "我会不会把他按坏？", focus: "按压顾虑" },
  { id: "fatigue", text: "我按累了怎么办？", focus: "施救者体力" },
  { id: "helpers", text: "旁边的人现在最好帮我做什么？", focus: "旁人分工" },
  { id: "before_ems", text: "急救员接手前我应该注意什么？", focus: "等待急救员" },
  { id: "before_ambulance", text: "救护车来之前我还需要留意什么？", focus: "未到达急救车" },
  { id: "family", text: "我现在要不要告诉家属发生了什么？", focus: "家属通知" },
  { id: "aed_missing", text: "AED 还没到怎么办？", focus: "AED 未到" },
  { id: "mouth", text: "他嘴里好像有东西怎么办？", focus: "异物担忧" },
  { id: "cyanosis", text: "他脸色发紫是不是很严重？", focus: "症状焦虑" },
  { id: "alone", text: "我一个人能坚持多久？", focus: "单人施救" },
  { id: "fracture_fear", text: "我怕压断肋骨怎么办？", focus: "肋骨恐惧" },
  { id: "noisy_aed", text: "周围很吵听不清 AED 怎么办？", focus: "AED 环境噪音" },
  { id: "depth", text: "我怎么知道按得够不够深？", focus: "按压质量" },
  { id: "water", text: "我需要给他喝水吗？", focus: "错误照护" },
  { id: "gasping", text: "他偶尔喘一下是不是好转了？", focus: "濒死喘息误解" },
  { id: "tell_120", text: "我应该跟 120 说什么？", focus: "120 沟通" },
];
