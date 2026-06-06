import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve("scripts", "analyzeVivoLiveVoiceRound.mjs");

const REQUIRED_INTENTS = [
  "scene_safe",
  "patient_unresponsive",
  "agonal_breathing",
  "continue_cpr",
  "aed_available",
  "paramedics_arrived",
];

const REQUIRED_STAGES = [
  "S6_CPR_READY",
  "S7_CPR_LOOP",
  "S8_ASSISTANCE",
  "S9_HANDOVER",
];

test("vivo live audit passes only with two complete independent spoken summaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-vivo-audit-"));
  const round1 = path.join(dir, "round1-summary.json");
  const round2 = path.join(dir, "round2-summary.json");
  const outputJson = path.join(dir, "audit.json");

  await fs.writeFile(round1, `\uFEFF${JSON.stringify(makeCompleteSummary("r1"), null, 2)}`, "utf8");
  await fs.writeFile(round2, JSON.stringify(makeCompleteSummary("r2"), null, 2), "utf8");

  const { stdout } = await execFileAsync(process.execPath, [
    SCRIPT,
    round1,
    round2,
    "--output-json",
    outputJson,
  ]);

  assert.match(stdout, /Vivo live voice audit: PASS/);
  assert.match(stdout, /\[PASS\] round_summaries expected >=2; actual 2/);

  const audit = JSON.parse(await fs.readFile(outputJson, "utf8"));
  assert.equal(audit.ok, true);
  assert.equal(audit.thresholds.minRounds, 2);
  assert.equal(audit.aggregate.counts.asrFinals, 12);
  assert.equal(audit.aggregate.openQuestionWait.p95, 1600);
});

test("vivo live audit rejects one summary even when repeated events meet aggregate counts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "firstaid-vivo-audit-"));
  const summary = path.join(dir, "single-summary.json");
  const bloated = makeCompleteSummary("single", {
    metricsMultiplier: 2,
    countMultiplier: 2,
  });
  await fs.writeFile(summary, JSON.stringify(bloated, null, 2), "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, summary]),
    (error) => {
      assert.equal(error.code, 1);
      const output = `${error.stdout}\n${error.stderr}`;
      assert.match(output, /Vivo live voice audit: FAIL/);
      assert.match(output, /\[FAIL\] round_summaries expected >=2; actual 1/);
      assert.match(output, /\[FAIL\] intent:scene_safe expected >=2; actual 1/);
      return true;
    },
  );
});

function makeCompleteSummary(roundId, options = {}) {
  const countMultiplier = options.countMultiplier ?? 1;
  const metricsMultiplier = options.metricsMultiplier ?? 1;
  const asrFinals = REQUIRED_INTENTS.map((intent) => ({
    text: `${roundId}:${intent}`,
    intent,
    confidence: "0.95",
  }));
  const metrics = REQUIRED_INTENTS.flatMap((intent, index) => {
    const stage = REQUIRED_STAGES[index % REQUIRED_STAGES.length];
    const base = {
      turn: index + 1,
      stage,
      source: intent === "paramedics_arrived" ? "state_machine_critical" : "rule_fast_path",
      intent,
      intentSource: "regex",
      totalMs: 420,
      ttsMs: 120,
      audioMs: 80,
      openSegment: "",
      openWaitMs: -1,
      openFallback: false,
    };
    const copies = Array.from({ length: metricsMultiplier }, (_, copyIndex) => ({
      ...base,
      turn: base.turn + copyIndex * REQUIRED_INTENTS.length,
    }));
    return copies;
  });
  metrics[metrics.length - 2] = {
    ...metrics[metrics.length - 2],
    intent: "",
    source: "gemma_open_question_text",
    openSegment: "answer",
    openWaitMs: 1600,
  };

  const count = REQUIRED_INTENTS.length * countMultiplier;
  return {
    ok: true,
    counts: {
      metrics: REQUIRED_INTENTS.length * metricsMultiplier,
      asrPartials: count,
      asrFinals: count,
      utteranceCommits: count,
      ttsStarts: count,
      liveAudioStarts: 0,
      serverAudioBegins: count,
      serverAudioChunks: count * 3,
      serverAudioEnds: count,
      errors: 0,
    },
    websocketOpened: true,
    capture: {
      started: true,
      rmsPeak: { count: 6, p50: 0.03, p95: 0.08, max: 0.1 },
      voiceActiveEvents: count,
    },
    voicePathLatencyMs: {
      voiceActiveToFirstPartial: latency(count, 180, 260),
      speechEndToFinal: latency(count, 220, 400),
      finalToGuidance: latency(count, 120, 240),
      guidanceToAndroidTtsStart: latency(count, 90, 180),
      finalToAndroidTtsStart: latency(count, 260, 520),
      speechEndToAndroidTtsStart: latency(count, 480, 760),
    },
    latencyMs: {
      openQuestionWait: { count: countMultiplier, p50: 1500, p95: 1600, max: 1600 },
    },
    intents: REQUIRED_INTENTS,
    stages: REQUIRED_STAGES,
    asrFinals,
    asrPartials: ["partial"],
    metrics,
    errors: [],
  };
}

function latency(count, p50, p95) {
  return { count, p50, p95, max: p95 };
}
