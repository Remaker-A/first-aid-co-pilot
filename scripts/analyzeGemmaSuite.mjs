#!/usr/bin/env node
// 离线分析器：把 device 产出的 gemma-suite JSON 报告渲染成中文可读摘要。
// 纯 ESM，Node>=20，无第三方依赖。只读不写（除可选 --json 走 stdout）。
//
// 用法:
//   node scripts/analyzeGemmaSuite.mjs [path]
//     - 省略 path 时自动取 artifacts/ 下最新的 gemma-suite-*.json
//       （含 *-PARTIAL-crash.json 这种崩溃前的部分报告）。
//     - path 也可传一个目录，会在其中找最新的 gemma-suite-*.json。
//   --json    输出精简后的机器可读摘要（JSON），默认输出人类可读中文文本。
//   --max-failures N   每个 case 最多展示的失败样本数（默认 5）。
//   --help

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// 四功能的规范顺序与中文名（缺失时标“未执行”）。
const CANONICAL_FUNCTIONS = [
  { id: "patch", cn: "急救引导补丁" },
  { id: "nlu", cn: "呼吸观测 NLU" },
  { id: "open_question", cn: "受控开放问答" },
  { id: "handover", cn: "交接叙述" },
];

// gate.recommendation 的中文释义（与 harness 的 Format-Recommendation 对齐）。
const RECOMMENDATION_CN = {
  near_realtime_ok: "近实时可用",
  ack_then_async: "先应答后异步",
};

// 失败码释义表。键为基础码（冒号前部分）。cat 用于区分“模型输出问题”还是“判分边界”。
const FAILURE_GLOSSARY = {
  json_parse_failed: {
    cat: "模型输出问题",
    text: "模型输出无法解析为 JSON（常见于输出为空、被截断或混入多余文字）。",
  },
  empty_text: {
    cat: "模型输出问题",
    text: "本次未产出任何文本（可能超时、驱动未返回或进程崩溃）。",
  },
  missing_intent: { cat: "模型输出问题", text: "输出缺少 intent 意图字段。" },
  intent_not_allowed: {
    cat: "模型输出问题/判分边界",
    text: "意图不在允许集合内；若与期望意图语义相近，则更可能是判分边界。",
  },
  missing_tts_text: { cat: "模型输出问题", text: "缺少需要语音播报的 tts.text。" },
  tts_text_too_long: { cat: "判分边界", text: "语音文本超过字数上限，内容可能正确但偏长。" },
  stop_compression_word: {
    cat: "模型输出问题",
    text: "输出包含“停/别按/停止按压”等危险措辞（安全红线）。",
  },
  forbidden_key: { cat: "模型输出问题", text: "NLU 输出包含被禁止的字段键。" },
  missing_slot: { cat: "模型输出问题", text: "缺少必需的槽位字段。" },
  slot_value_mismatch: {
    cat: "判分边界",
    text: "槽位布尔值与期望不一致（语义判断差异，建议人工复核）。",
  },
  missing_narrative: { cat: "模型输出问题", text: "缺少 narrative 交接叙述正文。" },
  fabricated_number: {
    cat: "模型输出问题",
    text: "交接叙述出现未授权数字，疑似模型编造。",
  },
  missing_number: {
    cat: "判分边界",
    text: "期望出现的数字未在叙述中匹配到；模型可能换了说法表达，建议人工复核。",
  },
  unknown_kind: { cat: "配置/判分", text: "用例 kind 未知，判分器无法识别（多为配置问题）。" },
  banned: { cat: "模型输出问题", text: "命中违禁词（如 suspected_cardiac_arrest）。" },
};

main().catch((error) => {
  console.error(`[analyze-gemma-suite] 出错: ${error?.message ?? error}`);
  process.exit(2);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const reportPath = await resolveReportPath(options.input);
  if (!reportPath) {
    console.error(
      "未找到 gemma-suite 报告。请传入一个 JSON 路径，或确保 artifacts/ 下存在 gemma-suite-*.json。",
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = stripBom(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    console.error(`无法读取报告文件: ${reportPath}\n${error?.message ?? error}`);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    console.error(`报告不是合法 JSON: ${reportPath}\n${error?.message ?? error}`);
    process.exit(2);
  }

  const model = analyze(report, reportPath);

  if (options.json) {
    console.log(JSON.stringify(buildMachineSummary(model, options), null, 2));
  } else {
    console.log(renderHuman(model, options));
  }

  // 退出码：报告完整且 ok=true => 0；否则 1（便于脚本串联，但不强求）。
  process.exitCode = model.ok === true && model.finished ? 0 : 1;
}

function parseArgs(args) {
  const parsed = { input: null, json: false, help: false, maxFailures: 5 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--max-failures") {
      parsed.maxFailures = clampInt(args[(i += 1)], parsed.maxFailures);
    } else if (arg.startsWith("--max-failures=")) {
      parsed.maxFailures = clampInt(arg.split("=", 2)[1], parsed.maxFailures);
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数 ${arg}（可用: --json, --max-failures N, --help）`);
    } else if (parsed.input == null) {
      parsed.input = arg;
    } else {
      throw new Error(`多余的位置参数: ${arg}`);
    }
  }
  return parsed;
}

function clampInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

async function resolveReportPath(input) {
  if (input) {
    const full = path.resolve(root, input);
    const stat = await fs.stat(full).catch(() => null);
    if (stat?.isDirectory()) return findLatestInDir(full);
    if (stat?.isFile()) return full;
    // 路径不存在：直接返回，让上层报“无法读取”。
    return full;
  }
  return findLatestInDir(path.join(root, "artifacts"));
}

async function findLatestInDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^gemma-suite-.*\.json$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat) candidates.push({ full, mtimeMs: stat.mtimeMs, name: entry.name });
  }
  if (candidates.length === 0) return null;
  // 先按 mtime，mtime 相同再按文件名（时间戳命名）兜底，保证“最新”稳定。
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return candidates[0].full;
}

// ---------------------------------------------------------------------------
// 解析报告 -> 中间模型（容错：字段缺失/为 null 时不报错）
// ---------------------------------------------------------------------------

function analyze(report, reportPath) {
  const phase = asStringOrNull(report?.phase);
  const finished = phase === "finished";
  const fileName = path.basename(reportPath);
  const looksCrashed = /partial|crash/i.test(fileName);

  const rawFunctions =
    report?.functions && typeof report.functions === "object" ? report.functions : {};
  const presentIds = Object.keys(rawFunctions);
  const seen = new Set();
  const functions = [];

  const ordered = [
    ...CANONICAL_FUNCTIONS.map((f) => f.id),
    ...presentIds.filter((id) => !CANONICAL_FUNCTIONS.some((f) => f.id === id)),
  ];

  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cn = CANONICAL_FUNCTIONS.find((f) => f.id === id)?.cn ?? "";
    const fn = rawFunctions[id];
    if (fn === undefined) {
      functions.push({ id, cn, executed: false });
      continue;
    }
    functions.push(buildFunction(id, cn, fn));
  }

  // 全局失败汇总。
  const failureCounts = new Map();
  let failingSampleTotal = 0;
  let emptyTextTotal = 0;
  for (const fn of functions) {
    if (!fn.executed) continue;
    for (const c of fn.cases) {
      for (const s of c.allFailingSamples) {
        failingSampleTotal += 1;
        if (s.empty) {
          emptyTextTotal += 1;
          bump(failureCounts, "empty_text");
        }
        for (const code of s.failures) bump(failureCounts, baseCode(code));
      }
    }
  }

  const failureSummary = [...failureCounts.entries()]
    .map(([code, count]) => ({ code, count, ...explainBase(code) }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return {
    reportPath,
    fileName,
    looksCrashed,
    ok: typeof report?.ok === "boolean" ? report.ok : null,
    mode: asStringOrNull(report?.mode),
    phase,
    finished,
    backend: asStringOrNull(report?.backend),
    prewarmOk: typeof report?.prewarmOk === "boolean" ? report.prewarmOk : null,
    prewarmLatencyMs: asNumberOrNull(report?.prewarmLatencyMs),
    runs: asNumberOrNull(report?.runs),
    updatedAtMs: asNumberOrNull(report?.updatedAtMs),
    error: asStringOrNull(report?.error),
    functions,
    failureSummary,
    failingSampleTotal,
    emptyTextTotal,
    executedFunctionCount: functions.filter((f) => f.executed).length,
    executedCaseCount: functions.reduce((n, f) => n + (f.executed ? f.cases.length : 0), 0),
  };
}

function buildFunction(id, cn, fn) {
  const parseOkRate = asNumberOrNull(fn?.parseOkRate);
  const assertPassRate = asNumberOrNull(fn?.assertPassRate);
  const bannedHits = asNumberOrNull(fn?.bannedHits);
  const rawCases = Array.isArray(fn?.cases) ? fn.cases : [];
  const cases = rawCases.map((c) => buildCase(c));
  return {
    id,
    cn,
    executed: true,
    label: asStringOrNull(fn?.label) ?? id,
    parseOkRate,
    assertPassRate,
    bannedHits,
    status: passStatus(parseOkRate, assertPassRate, bannedHits),
    cases,
  };
}

function buildCase(c) {
  const runs = asNumberOrNull(c?.runs);
  const okRuns = asNumberOrNull(c?.okRuns);
  const parseOkRate = asNumberOrNull(c?.parseOkRate);
  const assertPassRate = asNumberOrNull(c?.assertPassRate);
  const bannedHits = asNumberOrNull(c?.bannedHits);
  const latency = c?.latency && typeof c.latency === "object" ? c.latency : {};
  const gate = c?.gate && typeof c.gate === "object" ? c.gate : {};
  const samples = Array.isArray(c?.samples) ? c.samples : [];

  const allFailingSamples = samples
    .filter((s) => s && s.pass !== true)
    .map((s) => ({
      run: asNumberOrNull(s?.run),
      ok: typeof s?.ok === "boolean" ? s.ok : null,
      latencyMs: asNumberOrNull(s?.latencyMs),
      parseOk: typeof s?.parseOk === "boolean" ? s.parseOk : null,
      failures: Array.isArray(s?.failures) ? s.failures.map(String) : [],
      text: typeof s?.text === "string" ? s.text : "",
      empty: !(typeof s?.text === "string" && s.text.trim().length > 0),
    }));

  const recommendation = asStringOrNull(gate?.recommendation);

  return {
    caseId: asStringOrNull(c?.caseId) ?? "(无 caseId)",
    label: asStringOrNull(c?.label) ?? asStringOrNull(c?.caseId) ?? "(无标签)",
    runs,
    okRuns,
    parseOkRate,
    assertPassRate,
    bannedHits,
    p50Ms: asNumberOrNull(latency?.p50Ms),
    p95Ms: asNumberOrNull(latency?.p95Ms),
    recommendation,
    recommendationCn: recommendation ? RECOMMENDATION_CN[recommendation] ?? null : null,
    nearRealtimeCapable:
      typeof gate?.nearRealtimeCapable === "boolean" ? gate.nearRealtimeCapable : null,
    status: caseStatus({ runs, samples, parseOkRate, assertPassRate, bannedHits }),
    sampleCount: samples.length,
    allFailingSamples,
  };
}

// 功能级 PASS/FAIL：解析率与断言率均为 1 且无违禁命中（与 harness Test-FunctionPass 一致）。
function passStatus(parseOkRate, assertPassRate, bannedHits) {
  if (parseOkRate === 1 && assertPassRate === 1 && (bannedHits ?? 0) === 0) return "PASS";
  return "FAIL";
}

function caseStatus({ runs, samples, parseOkRate, assertPassRate, bannedHits }) {
  if ((runs ?? 0) === 0 && samples.length === 0) return "未执行";
  if (parseOkRate === 1 && assertPassRate === 1 && (bannedHits ?? 0) === 0) return "PASS";
  return "FAIL";
}

// ---------------------------------------------------------------------------
// 人类可读中文渲染
// ---------------------------------------------------------------------------

function renderHuman(m, options) {
  const L = [];
  const line = (s = "") => L.push(s);
  const rule = (ch = "=") => line(ch.repeat(70));

  rule();
  line("Gemma Suite 离线分析 · 中文摘要");
  line(`报告文件: ${relForDisplay(m.reportPath)}`);
  rule();
  line();

  // 顶层概况
  line("【顶层概况】");
  line(`  总体 ok            : ${m.ok === null ? "n/a" : m.ok ? "PASS (ok=true)" : "FAIL (ok=false)"}`);
  line(`  模式 mode          : ${m.mode ?? "n/a"}`);
  line(`  阶段 phase         : ${m.phase ?? "n/a"}`);
  if (!m.finished) {
    line("  >> 警告: 报告不完整 / 可能崩溃中断（phase 未到 finished）");
    line(
      `     已累计 ${m.executedFunctionCount} 个功能、${m.executedCaseCount} 个用例的结果（崩溃前检查点）。`,
    );
    if (m.looksCrashed) line("     文件名含 PARTIAL/crash 标记，确认为崩溃前落盘的部分报告。");
  } else {
    line("  报告完整: phase=finished");
  }
  line(`  后端 backend       : ${m.backend ?? "n/a"}`);
  line(`  预热 prewarmOk     : ${formatBool(m.prewarmOk)}`);
  line(`  预热耗时           : ${formatMsWithSec(m.prewarmLatencyMs)}`);
  line(`  每用例运行次数 runs : ${m.runs ?? "n/a"}`);
  line(`  更新时间 updatedAt : ${formatTimestamp(m.updatedAtMs)}`);
  if (m.error) line(`  报告内 error       : ${m.error}`);
  line();

  // 四功能概览表
  line("【四功能 PASS/FAIL 概览】");
  line(`  ${padEnd("功能", 16)}${padEnd("状态", 8)}${padEnd("解析率", 9)}${padEnd("断言率", 9)}${padEnd("违禁", 6)}说明`);
  for (const fn of m.functions) {
    if (!fn.executed) {
      line(
        `  ${padEnd(fn.id, 16)}${padEnd("未执行", 8)}${padEnd("-", 9)}${padEnd("-", 9)}${padEnd("-", 6)}${fn.cn || ""}（本轮未运行）`,
      );
      continue;
    }
    line(
      `  ${padEnd(fn.id, 16)}${padEnd(fn.status, 8)}${padEnd(formatRate(fn.parseOkRate), 9)}` +
        `${padEnd(formatRate(fn.assertPassRate), 9)}${padEnd(String(fn.bannedHits ?? 0), 6)}${fn.cn || fn.label}`,
    );
  }
  line();

  // 逐功能 / 逐用例明细
  line("【逐功能 / 逐用例明细】");
  for (const fn of m.functions) {
    line();
    if (!fn.executed) {
      line(`■ ${fn.id}  ${fn.cn}  [未执行]  —— 本轮报告中没有该功能的结果`);
      continue;
    }
    line(
      `■ ${fn.id}  ${fn.cn || fn.label}  [${fn.status}]  ` +
        `解析 ${formatRate(fn.parseOkRate)} · 断言 ${formatRate(fn.assertPassRate)} · 违禁 ${fn.bannedHits ?? 0}`,
    );
    if (fn.cases.length === 0) {
      line("    （该功能没有 case 明细）");
      continue;
    }
    for (const c of fn.cases) {
      line(`   - ${c.caseId}  ${c.label}  [${c.status}]`);
      line(`       通过 okRuns/runs : ${c.okRuns ?? "n/a"}/${c.runs ?? "n/a"}`);
      line(`       延迟 p50 / p95   : ${formatMs(c.p50Ms)} / ${formatMs(c.p95Ms)}`);
      line(`       闸门建议         : ${formatRecommendation(c)}`);

      const shown = c.allFailingSamples.slice(0, options.maxFailures);
      if (c.allFailingSamples.length > 0) {
        line(`       失败样本 (${c.allFailingSamples.length} 个):`);
        for (const s of shown) {
          const fails = s.failures.length ? s.failures.join(", ") : "(无 failures 字段)";
          line(
            `         · run${s.run ?? "?"}  pass=false  failures=[${fails}]  text=${formatText(s)}`,
          );
        }
        const omitted = c.allFailingSamples.length - shown.length;
        if (omitted > 0) line(`         …… 另有 ${omitted} 个失败样本未展开（--max-failures 调整）`);

        // 该 case 内出现过的失败码释义（去重）。
        const codes = new Set();
        for (const s of c.allFailingSamples) {
          if (s.empty) codes.add("empty_text");
          for (const f of s.failures) codes.add(baseCode(f));
        }
        line("       释义:");
        for (const code of codes) {
          const g = explainBase(code);
          line(`         · ${labelForCode(code)} —【${g.cat}】${g.text}`);
        }
      }
    }
  }
  line();

  // 失败原因汇总
  line("【失败原因汇总（按出现次数，跨全部已执行用例）】");
  if (m.failureSummary.length === 0) {
    line("  无失败样本。");
  } else {
    for (const f of m.failureSummary) {
      line(`  ${labelForCode(f.code)} × ${f.count}  —【${f.cat}】${f.text}`);
    }
  }
  line();

  // 结论提示
  line("【结论提示】");
  for (const note of buildNotes(m)) line(`  - ${note}`);
  rule();

  return L.join("\n");
}

function buildNotes(m) {
  const notes = [];
  if (!m.finished) {
    notes.push(
      `phase 未到 finished：本报告是崩溃/中断前的部分结果，未执行的功能（如 ${
        m.functions.filter((f) => !f.executed).map((f) => f.id).join("、") || "无"
      }）不代表真实表现。`,
    );
  }
  if (m.prewarmOk === true && (m.prewarmLatencyMs ?? 0) >= 10000) {
    notes.push(
      `预热成功但耗时 ${formatMsWithSec(m.prewarmLatencyMs)}，说明模型可加载，问题更可能出在生成/解析环节而非加载本身。`,
    );
  }
  if (m.failingSampleTotal > 0 && m.emptyTextTotal === m.failingSampleTotal) {
    notes.push(
      `全部 ${m.failingSampleTotal} 个失败样本 text 均为空，且多为 json_parse_failed —— 高度疑似“模型输出问题”（驱动/模型未产出文本），而非判分过严。`,
    );
  } else if (m.emptyTextTotal > 0) {
    notes.push(
      `有 ${m.emptyTextTotal}/${m.failingSampleTotal} 个失败样本 text 为空，倾向“模型输出问题”；其余可结合具体 failures 区分判分边界。`,
    );
  }
  const boundaryCodes = m.failureSummary.filter((f) => f.cat.includes("判分边界"));
  if (boundaryCodes.length > 0) {
    notes.push(
      `存在偏“判分边界”的失败（${boundaryCodes.map((f) => f.code).join("、")}），建议人工复核样本 text 再下结论。`,
    );
  }
  if (notes.length === 0) notes.push("未发现明显异常信号。");
  return notes;
}

// ---------------------------------------------------------------------------
// 机器可读摘要
// ---------------------------------------------------------------------------

function buildMachineSummary(m, options) {
  return {
    source: relForDisplay(m.reportPath),
    ok: m.ok,
    finished: m.finished,
    looksCrashed: m.looksCrashed,
    mode: m.mode,
    phase: m.phase,
    backend: m.backend,
    prewarmOk: m.prewarmOk,
    prewarmLatencyMs: m.prewarmLatencyMs,
    runs: m.runs,
    updatedAtMs: m.updatedAtMs,
    error: m.error,
    executedFunctionCount: m.executedFunctionCount,
    executedCaseCount: m.executedCaseCount,
    functions: m.functions.map((fn) =>
      fn.executed
        ? {
            id: fn.id,
            label: fn.label,
            cn: fn.cn,
            executed: true,
            status: fn.status,
            parseOkRate: fn.parseOkRate,
            assertPassRate: fn.assertPassRate,
            bannedHits: fn.bannedHits,
            cases: fn.cases.map((c) => ({
              caseId: c.caseId,
              label: c.label,
              status: c.status,
              runs: c.runs,
              okRuns: c.okRuns,
              parseOkRate: c.parseOkRate,
              assertPassRate: c.assertPassRate,
              bannedHits: c.bannedHits,
              p50Ms: c.p50Ms,
              p95Ms: c.p95Ms,
              recommendation: c.recommendation,
              recommendationCn: c.recommendationCn,
              failingSamples: c.allFailingSamples.slice(0, options.maxFailures).map((s) => ({
                run: s.run,
                failures: s.failures,
                empty: s.empty,
                textPreview: truncate(s.text, 80),
              })),
              failingSampleCount: c.allFailingSamples.length,
            })),
          }
        : { id: fn.id, cn: fn.cn, executed: false, status: "未执行" },
    ),
    failureSummary: m.failureSummary,
    failingSampleTotal: m.failingSampleTotal,
    emptyTextTotal: m.emptyTextTotal,
    notes: buildNotes(m),
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asStringOrNull(value) {
  if (typeof value === "string") return value;
  if (value == null) return null;
  return String(value);
}

function asNumberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function baseCode(code) {
  const idx = String(code).indexOf(":");
  return idx >= 0 ? String(code).slice(0, idx) : String(code);
}

function explainBase(code) {
  return FAILURE_GLOSSARY[code] ?? { cat: "未知", text: "未收录的失败码，请查看样本 text 与 harness 判分逻辑。" };
}

function labelForCode(code) {
  if (code === "empty_text") return "空 text";
  return code;
}

function formatRate(value) {
  if (value == null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
  if (value == null) return "n/a";
  return `${Math.round(value)} ms`;
}

function formatMsWithSec(value) {
  if (value == null) return "n/a";
  const ms = Math.round(value);
  if (ms >= 1000) return `${ms} ms（约 ${(ms / 1000).toFixed(1)} 秒）`;
  return `${ms} ms`;
}

function formatBool(value) {
  if (value === true) return "是 (true)";
  if (value === false) return "否 (false)";
  return "n/a";
}

function formatTimestamp(ms) {
  if (ms == null) return "n/a";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return `${ms}`;
  return `${ms}（UTC ${d.toISOString()}）`;
}

function formatRecommendation(c) {
  if (!c.recommendation) return "n/a";
  const cn = c.recommendationCn;
  return cn ? `${c.recommendation}（${cn}）` : c.recommendation;
}

function formatText(sample) {
  if (sample.empty) return "<空>";
  return `"${truncate(sample.text, 60)}"`;
}

function truncate(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

// 简单的“显示宽度”对齐：中文按 2 列宽计。
function padEnd(text, width) {
  const s = String(text ?? "");
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  const pad = Math.max(0, width - w);
  return s + " ".repeat(pad);
}

function relForDisplay(full) {
  const rel = path.relative(root, full);
  return rel.startsWith("..") ? full : rel.split(path.sep).join("/");
}

function printHelp() {
  console.log(`用法: node scripts/analyzeGemmaSuite.mjs [path] [--json] [--max-failures N]

把 device 产出的 gemma-suite JSON 报告渲染成中文可读摘要。

参数:
  path                 报告 JSON 路径；也可传目录（取其中最新的 gemma-suite-*.json）。
                       省略时自动取 artifacts/ 下最新的 gemma-suite-*.json
                       （含 *-PARTIAL-crash.json）。
  --json               输出精简后的机器可读 JSON 摘要（默认输出中文文本）。
  --max-failures N     每个 case 最多展示的失败样本数（默认 5）。
  --help, -h           显示本帮助。

退出码: 报告 ok=true 且 phase=finished => 0；否则 => 1。`);
}
