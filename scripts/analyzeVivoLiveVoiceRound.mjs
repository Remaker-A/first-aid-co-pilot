#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const DEFAULT_REQUIRED_INTENTS = [
  "scene_safe",
  "patient_unresponsive",
  "agonal_breathing",
  "continue_cpr",
  "aed_available",
  "paramedics_arrived",
];

const DEFAULT_REQUIRED_STAGES = [
  "S6_CPR_READY",
  "S7_CPR_LOOP",
  "S8_ASSISTANCE",
  "S9_HANDOVER",
];

const options = parseArgs(process.argv.slice(2));
const summaryPaths = await resolveSummaryPaths(options.inputs, options.latest ?? options.minRounds);
if (summaryPaths.length === 0) {
  console.error("No vivo live summary files found. Pass a summary.json path or an artifacts/vivo-live-* directory.");
  process.exit(2);
}

const summaries = [];
for (const summaryPath of summaryPaths) {
  const summary = JSON.parse(stripBom(await fs.readFile(summaryPath, "utf8")));
  summaries.push({ path: summaryPath, summary });
}

const audit = evaluateSummaries(summaries, options);
printAudit(audit);

if (options.outputJson) {
  await fs.writeFile(options.outputJson, JSON.stringify(audit, null, 2), "utf8");
}

process.exitCode = audit.ok ? 0 : 1;

function parseArgs(args) {
  const parsed = {
    inputs: [],
    latest: null,
    minRounds: 2,
    minFinals: null,
    minMetrics: null,
    minVoiceActive: null,
    minOpenAnswers: null,
    maxCriticalP95Ms: 1000,
    maxOpenQuestionP95Ms: 3000,
    requiredIntents: DEFAULT_REQUIRED_INTENTS,
    requiredStages: DEFAULT_REQUIRED_STAGES,
    outputJson: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed.inputs.push(arg);
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (inlineValue === undefined && takesValue(key)) index += 1;

    switch (key) {
      case "latest":
        parsed.latest = Number.parseInt(value, 10);
        break;
      case "min-rounds":
        parsed.minRounds = Number.parseInt(value, 10);
        break;
      case "min-finals":
        parsed.minFinals = Number.parseInt(value, 10);
        break;
      case "min-metrics":
        parsed.minMetrics = Number.parseInt(value, 10);
        break;
      case "min-voice-active":
        parsed.minVoiceActive = Number.parseInt(value, 10);
        break;
      case "min-open-answers":
        parsed.minOpenAnswers = Number.parseInt(value, 10);
        break;
      case "max-critical-p95-ms":
        parsed.maxCriticalP95Ms = Number.parseInt(value, 10);
        break;
      case "max-open-question-p95-ms":
        parsed.maxOpenQuestionP95Ms = Number.parseInt(value, 10);
        break;
      case "required-intents":
        parsed.requiredIntents = splitCsv(value);
        break;
      case "required-stages":
        parsed.requiredStages = splitCsv(value);
        break;
      case "output-json":
        parsed.outputJson = path.resolve(root, value);
        break;
      case "help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option --${key}`);
    }
  }
  parsed.minFinals ??= parsed.minRounds * 6;
  parsed.minMetrics ??= parsed.minRounds * 6;
  parsed.minVoiceActive ??= parsed.minRounds * 6;
  parsed.minOpenAnswers ??= parsed.minRounds;
  return parsed;
}

function takesValue(key) {
  return !["help"].includes(key);
}

function splitCsv(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

async function resolveSummaryPaths(inputs, latest) {
  if (inputs.length > 0) {
    const resolved = [];
    for (const input of inputs) {
      const full = path.resolve(root, input);
      const stat = await fs.stat(full);
      resolved.push(stat.isDirectory() ? path.join(full, "summary.json") : full);
    }
    return resolved;
  }

  const artifactsDir = path.join(root, "artifacts");
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("vivo-live-")) continue;
    const summaryPath = path.join(artifactsDir, entry.name, "summary.json");
    const stat = await fs.stat(summaryPath).catch(() => null);
    if (stat) candidates.push({ path: summaryPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, latest || 1).map((item) => item.path);
}

function evaluateSummaries(items, opts) {
  const checks = [];
  const aggregate = aggregateSummaries(items);

  addCheck(checks, "summaries_present", items.length > 0, ">0", String(items.length));
  addCheck(checks, "round_summaries", items.length >= opts.minRounds, `>=${opts.minRounds}`, String(items.length));
  addCheck(checks, "all_websocket_opened", aggregate.websocketOpened === items.length, String(items.length), String(aggregate.websocketOpened));
  addCheck(checks, "all_capture_started", aggregate.captureStarted === items.length, String(items.length), String(aggregate.captureStarted));
  addCheck(checks, "no_errors", aggregate.errors === 0, "0", String(aggregate.errors));
  addCheck(checks, "asr_finals", aggregate.counts.asrFinals >= opts.minFinals, `>=${opts.minFinals}`, String(aggregate.counts.asrFinals));
  addCheck(checks, "utterance_commits", aggregate.counts.utteranceCommits >= opts.minFinals, `>=${opts.minFinals}`, String(aggregate.counts.utteranceCommits));
  addCheck(checks, "voice_active_events", aggregate.voiceActiveEvents >= opts.minVoiceActive, `>=${opts.minVoiceActive}`, String(aggregate.voiceActiveEvents));
  addCheck(checks, "metrics", aggregate.counts.metrics >= opts.minMetrics, `>=${opts.minMetrics}`, String(aggregate.counts.metrics));
  addCheck(checks, "open_question_answers", aggregate.openAnswerCount >= opts.minOpenAnswers, `>=${opts.minOpenAnswers}`, String(aggregate.openAnswerCount));

  for (const intent of opts.requiredIntents) {
    const count = aggregate.intentCounts[intent] || 0;
    addCheck(checks, `intent:${intent}`, count >= opts.minRounds, `>=${opts.minRounds}`, `${count} (${[...aggregate.intents].sort().join(",") || "<none>"})`);
  }
  for (const stage of opts.requiredStages) {
    const count = aggregate.stageCounts[stage] || 0;
    addCheck(checks, `stage:${stage}`, count >= opts.minRounds, `>=${opts.minRounds}`, `${count} (${[...aggregate.stages].sort().join(",") || "<none>"})`);
  }

  const criticalLatencyKeys = [
    "voiceActiveToFirstPartial",
    "speechEndToFinal",
    "finalToGuidance",
    "guidanceToAndroidTtsStart",
    "finalToAndroidTtsStart",
    "speechEndToAndroidTtsStart",
  ];
  for (const key of criticalLatencyKeys) {
    const stat = aggregate.voicePathLatencyMs[key] || emptyLatency();
    addCheck(checks, `latency:${key}:present`, stat.count > 0, ">0", String(stat.count));
    addCheck(checks, `latency:${key}:p95`, stat.count > 0 && stat.p95 <= opts.maxCriticalP95Ms, `<=${opts.maxCriticalP95Ms}ms`, formatLatency(stat));
  }

  const openStat = aggregate.latencyMs.openQuestionWait || emptyLatency();
  addCheck(
    checks,
    "latency:openQuestionWait:p95",
    openStat.count >= opts.minOpenAnswers && openStat.p95 <= opts.maxOpenQuestionP95Ms,
    `count>=${opts.minOpenAnswers}, p95<=${opts.maxOpenQuestionP95Ms}ms`,
    formatLatency(openStat),
  );

  return {
    ok: checks.every((check) => check.ok),
    summary_paths: items.map((item) => item.path),
    thresholds: {
      minFinals: opts.minFinals,
      minRounds: opts.minRounds,
      minMetrics: opts.minMetrics,
      minVoiceActive: opts.minVoiceActive,
      minOpenAnswers: opts.minOpenAnswers,
      maxCriticalP95Ms: opts.maxCriticalP95Ms,
      maxOpenQuestionP95Ms: opts.maxOpenQuestionP95Ms,
      requiredIntents: opts.requiredIntents,
      requiredStages: opts.requiredStages,
    },
    aggregate: {
      counts: aggregate.counts,
      websocketOpened: aggregate.websocketOpened,
      captureStarted: aggregate.captureStarted,
      voiceActiveEvents: aggregate.voiceActiveEvents,
      errors: aggregate.errors,
      intents: [...aggregate.intents].sort(),
      intentCounts: aggregate.intentCounts,
      stages: [...aggregate.stages].sort(),
      stageCounts: aggregate.stageCounts,
      voicePathLatencyMs: aggregate.voicePathLatencyMs,
      openQuestionWait: aggregate.latencyMs.openQuestionWait || emptyLatency(),
    },
    checks,
  };
}

function aggregateSummaries(items) {
  const aggregate = {
    counts: {
      metrics: 0,
      asrPartials: 0,
      asrFinals: 0,
      utteranceCommits: 0,
      ttsStarts: 0,
      liveAudioStarts: 0,
      serverAudioBegins: 0,
      serverAudioChunks: 0,
      serverAudioEnds: 0,
      errors: 0,
    },
    websocketOpened: 0,
    captureStarted: 0,
    voiceActiveEvents: 0,
    errors: 0,
    openAnswerCount: 0,
    intents: new Set(),
    intentCounts: {},
    stages: new Set(),
    stageCounts: {},
    voicePathLatencyMs: {},
    latencyMs: {},
  };

  for (const { summary } of items) {
    const summaryIntents = new Set();
    const summaryStages = new Set();
    for (const key of Object.keys(aggregate.counts)) {
      aggregate.counts[key] += Number(summary.counts?.[key] || 0);
    }
    aggregate.errors += Number(summary.counts?.errors || 0);
    if (summary.websocketOpened) aggregate.websocketOpened += 1;
    if (summary.capture?.started) aggregate.captureStarted += 1;
    aggregate.voiceActiveEvents += Number(summary.capture?.voiceActiveEvents || 0);
    for (const item of summary.asrFinals || []) {
      if (item?.intent) summaryIntents.add(item.intent);
    }
    for (const metric of summary.metrics || []) {
      if (metric?.intent) summaryIntents.add(metric.intent);
      if (metric?.stage) summaryStages.add(metric.stage);
      if (metric?.openSegment === "answer") aggregate.openAnswerCount += 1;
    }
    for (const stage of summary.stages || []) summaryStages.add(stage);
    for (const intent of summaryIntents) addCountedSetValue(aggregate.intents, aggregate.intentCounts, intent);
    for (const stage of summaryStages) addCountedSetValue(aggregate.stages, aggregate.stageCounts, stage);
    mergeLatencyMaps(aggregate.voicePathLatencyMs, summary.voicePathLatencyMs || {});
    mergeLatencyMaps(aggregate.latencyMs, summary.latencyMs || {});
  }

  return aggregate;
}

function addCountedSetValue(set, counts, value) {
  set.add(value);
  counts[value] = (counts[value] || 0) + 1;
}

function mergeLatencyMaps(target, source) {
  for (const [key, stat] of Object.entries(source)) {
    target[key] = combineLatency(target[key], stat);
  }
}

function combineLatency(left = emptyLatency(), right = emptyLatency()) {
  const count = Number(left.count || 0) + Number(right.count || 0);
  return {
    count,
    p50: maxNullable(left.p50, right.p50),
    p95: maxNullable(left.p95, right.p95),
    max: maxNullable(left.max, right.max),
  };
}

function maxNullable(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

function emptyLatency() {
  return { count: 0, p50: null, p95: null, max: null };
}

function addCheck(checks, name, ok, expected, actual) {
  checks.push({ name, ok, expected, actual });
}

function formatLatency(stat) {
  return `count=${stat.count}, p50=${stat.p50 ?? "null"}, p95=${stat.p95 ?? "null"}, max=${stat.max ?? "null"}`;
}

function printAudit(audit) {
  console.log(`Vivo live voice audit: ${audit.ok ? "PASS" : "FAIL"}`);
  console.log(`summaries=${audit.summary_paths.length}`);
  for (const item of audit.summary_paths) console.log(`summary=${item}`);
  console.log(
    `counts=${JSON.stringify(audit.aggregate.counts)} voiceActive=${audit.aggregate.voiceActiveEvents} ` +
      `intents=${audit.aggregate.intents.join(",") || "<none>"} stages=${audit.aggregate.stages.join(",") || "<none>"}`,
  );
  for (const check of audit.checks) {
    const marker = check.ok ? "PASS" : "FAIL";
    console.log(`[${marker}] ${check.name} expected ${check.expected}; actual ${check.actual}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/analyzeVivoLiveVoiceRound.mjs [summary.json|vivo-live-dir ...]

Options:
  --latest N                      Audit the N latest artifacts/vivo-live-* summaries when no paths are passed.
  --min-rounds N                  Minimum independent spoken rounds/summaries. Default 2.
  --min-finals N                  Minimum ASR final count. Default min-rounds * 6.
  --min-metrics N                 Minimum Live metrics count. Default min-rounds * 6.
  --min-voice-active N            Minimum voice active events. Default min-rounds * 6.
  --min-open-answers N            Minimum open-question answer metrics. Default min-rounds.
  --max-critical-p95-ms N         P95 ceiling for critical voice path latencies. Default 1000.
  --max-open-question-p95-ms N    P95 ceiling for open question answer wait. Default 3000.
  --required-intents a,b,c        Required ASR/metric intents.
  --required-stages a,b,c         Required stages.
  --output-json path              Write the audit JSON.
`);
}
