import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AgentStage,
  GemmaRuntime,
  buildHandoverNarrativeFrame,
  collectAllowedNumberTokens,
  findFabricatedNumbers,
  generateHandoverNarrative,
  generateHandoverReport,
  runDemoPipeline,
  validateHandoverNarrative
} from "../src/index.js";

// WD 第五点：S9 交接 / 复盘 NLG。
// Gemma 把 handoverReportGenerator 的结构化结果"叙述化"，数字只能来自结构化报告，
// 过 ActionValidator（禁忌话术等），失败回退确定性模板，复用 handover_summary_patch。

const HANDOVER_STATE = Object.freeze({
  session_id: "sess_test_handover",
  current_stage: "S9_HANDOVER",
  confirmed_facts: {
    responsive: false,
    normal_breathing: false,
    agonal_breathing: true,
    suspected_cardiac_arrest: true
  },
  cpr_state: {
    started_at: "2026-06-05T10:00:00.000Z",
    total_compressions: 240,
    average_rate: 112,
    quality_score: 88
  },
  tool_state: {
    emergency_call_status: "started",
    gps_attached: true,
    recording_status: "recording",
    aed_status: "现场有 AED 事件",
    video_shared: true
  }
});

const HANDOVER_ENTRIES = Object.freeze([
  {
    timestamp: "2026-06-05T10:01:00.000Z",
    category: "event",
    stage: "S7_CPR_LOOP",
    payload: { raw_event: { cpr_quality: { interruption_seconds: 8 } } }
  },
  {
    timestamp: "2026-06-05T10:02:00.000Z",
    category: "event",
    stage: "S7_CPR_LOOP",
    payload: { raw_event: { cpr_quality: { interruption_seconds: 5 } } }
  }
]);

const HANDOVER_OPTIONS = Object.freeze({ generatedAt: "2026-06-05T10:05:00.000Z" });

// A grounded narrative: every number (240/112/88/100/2/13/0/120, the 10:00:00
// clock and the 5分0秒 duration) is derivable from the structured report.
const GROUNDED_NARRATIVE =
  "急救员请注意：患者无反应、无正常呼吸、可能濒死喘息，已按疑似心脏骤停处理。" +
  "CPR 从 10:00:00 开始，持续约 5分0秒，累计按压 240 次，平均频率 112 次每分钟，质量评分 88 分（满分 100）。" +
  "期间中断 2 次，共 13 秒，纠错 0 次。已呼叫 120，GPS 已附加，正在录制，现场有 AED 事件，视频已确认分享。";

function buildReport() {
  return generateHandoverReport({ entries: HANDOVER_ENTRIES }, HANDOVER_STATE, HANDOVER_OPTIONS);
}

function narrativeRuntime(narrative, extra = {}) {
  return {
    calls: [],
    async generateNarrative(frame) {
      this.calls.push(frame);
      return { ok: true, narrative, reason: "test", confidence: 0.9, ...extra };
    }
  };
}

function countZhChars(text) {
  const matches = String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu);
  return matches ? matches.length : 0;
}

test("collectAllowedNumberTokens draws only from the structured report and facts", () => {
  const report = buildReport();
  const frame = buildHandoverNarrativeFrame(report.json, { sourceText: report.text });
  const allowed = collectAllowedNumberTokens(report.json, report.text, frame.facts);

  // Real stats are allowed.
  for (const value of [240, 112, 88, 100, 2, 13, 0, 120]) {
    assert.ok(allowed.has(value), `expected ${value} to be allowed`);
  }
  // A value that appears nowhere in the report must NOT be allowed.
  assert.ok(!allowed.has(999));
});

test("findFabricatedNumbers flags numbers absent from the allow-set, matches by value", () => {
  const allowed = new Set([6, 240, 100]);
  // 06 == 6 and 240.0 == 240 are grounded; 999 is fabricated.
  assert.deepEqual(findFabricatedNumbers("06 分，240.0 次，满分 100", allowed), []);
  assert.deepEqual(findFabricatedNumbers("按压 999 次", allowed), ["999"]);
});

test("validateHandoverNarrative accepts a grounded narrative as handover_summary_patch", () => {
  const report = buildReport();
  const frame = buildHandoverNarrativeFrame(report.json, { sourceText: report.text });
  const validation = validateHandoverNarrative(GROUNDED_NARRATIVE, {
    reportJson: report.json,
    reportText: report.text,
    facts: frame.facts,
    state: HANDOVER_STATE
  });

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.violations, []);
  assert.equal(validation.action.intent, "handover_summary_patch");
  assert.equal(validation.action.source, "gemma_agent");
});

test("validateHandoverNarrative does NOT apply the realtime TTS length cap to S9 narration", () => {
  const report = buildReport();
  const frame = buildHandoverNarrativeFrame(report.json, { sourceText: report.text });

  // The grounded narrative is deliberately far longer than the realtime caps
  // (30 normal / 60 critical zh chars), proving the cap is exempt here.
  assert.ok(countZhChars(GROUNDED_NARRATIVE) > 60);

  const validation = validateHandoverNarrative(GROUNDED_NARRATIVE, {
    reportJson: report.json,
    reportText: report.text,
    facts: frame.facts,
    state: HANDOVER_STATE
  });

  assert.equal(validation.ok, true);
  assert.ok(!validation.violations.includes("tts_exceeds_max_chars"));
});

test("validateHandoverNarrative rejects a fabricated number", () => {
  const report = buildReport();
  const frame = buildHandoverNarrativeFrame(report.json, { sourceText: report.text });
  const validation = validateHandoverNarrative("累计按压 999 次，平均频率 112 次每分钟。", {
    reportJson: report.json,
    reportText: report.text,
    facts: frame.facts,
    state: HANDOVER_STATE
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.some((v) => v.startsWith("fabricated_numbers:")));
  assert.ok(validation.violations.some((v) => v.includes("999")));
});

test("validateHandoverNarrative rejects forbidden speech", () => {
  const report = buildReport();
  const frame = buildHandoverNarrativeFrame(report.json, { sourceText: report.text });
  const validation = validateHandoverNarrative("他已经心脏骤停了，没救了。", {
    reportJson: report.json,
    reportText: report.text,
    facts: frame.facts,
    state: HANDOVER_STATE
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("forbidden_speech"));
});

test("validateHandoverNarrative rejects an empty narrative", () => {
  const report = buildReport();
  const validation = validateHandoverNarrative("   ", {
    reportJson: report.json,
    reportText: report.text,
    facts: {},
    state: HANDOVER_STATE
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.violations.includes("empty_narrative"));
});

test("generateHandoverNarrative falls back to the deterministic template when no runtime is given", async () => {
  const report = buildReport();
  const result = await generateHandoverNarrative({ report, state: HANDOVER_STATE });

  assert.equal(result.source, "template_fallback");
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "no_runtime");
  assert.equal(result.narrative, report.text);
  assert.equal(result.intent, "handover_summary_patch");
});

test("generateHandoverNarrative uses a grounded Gemma narrative and reuses handover_summary_patch", async () => {
  const report = buildReport();
  const runtime = narrativeRuntime(GROUNDED_NARRATIVE);
  const result = await generateHandoverNarrative({ report, state: HANDOVER_STATE, runtime });

  assert.equal(result.source, "gemma_agent");
  assert.equal(result.fallback, false);
  assert.equal(result.narrative, GROUNDED_NARRATIVE);
  assert.equal(result.intent, "handover_summary_patch");
  assert.equal(result.action.intent, "handover_summary_patch");
  // The structured report (numbers) is preserved untouched.
  assert.equal(result.json.cpr.total_compressions, 240);
  assert.equal(result.text, report.text);
  // The model actually received the structured facts as its number ground truth.
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].facts.total_compressions, 240);
});

test("generateHandoverNarrative rejects fabricated numbers and falls back to template", async () => {
  const report = buildReport();
  const runtime = narrativeRuntime("累计按压 999 次。");
  const result = await generateHandoverNarrative({ report, state: HANDOVER_STATE, runtime });

  assert.equal(result.source, "template_fallback");
  assert.equal(result.fallbackReason, "narrative_validation_failed");
  assert.equal(result.narrative, report.text);
  assert.ok(result.violations.some((v) => v.startsWith("fabricated_numbers:")));
});

test("generateHandoverNarrative rejects forbidden speech and falls back to template", async () => {
  const report = buildReport();
  const runtime = narrativeRuntime("他已经心脏骤停了。");
  const result = await generateHandoverNarrative({ report, state: HANDOVER_STATE, runtime });

  assert.equal(result.source, "template_fallback");
  assert.equal(result.fallbackReason, "narrative_validation_failed");
  assert.ok(result.violations.includes("forbidden_speech"));
});

test("generateHandoverNarrative falls back when the model is unavailable", async () => {
  const report = buildReport();
  const runtime = {
    async generateNarrative() {
      return { ok: false, fallback: true, fallbackReason: "model_missing", narrative: "" };
    }
  };
  const result = await generateHandoverNarrative({ report, state: HANDOVER_STATE, runtime });

  assert.equal(result.source, "template_fallback");
  assert.equal(result.fallbackReason, "model_missing");
  assert.equal(result.narrative, report.text);
});

test("generateHandoverNarrative never throws when the runtime throws", async () => {
  const report = buildReport();
  const runtime = {
    async generateNarrative() {
      throw new Error("boom");
    }
  };
  const result = await generateHandoverNarrative({ report, state: HANDOVER_STATE, runtime });

  assert.equal(result.source, "template_fallback");
  assert.equal(result.fallbackReason, "boom");
  assert.equal(result.narrative, report.text);
});

test("GemmaRuntime.generateNarrative returns a model_missing fallback when no model is installed", async () => {
  const report = buildReport();
  const frame = buildHandoverNarrativeFrame(report.json, { sourceText: report.text });
  const runtime = new GemmaRuntime({ modelDir: resolve("_does_not_exist_handover_dir") });
  const result = await runtime.generateNarrative(frame);

  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "model_missing");
});

test("runAgentPipelineWithGemma attaches a validated handover narrative at S9", async () => {
  const scriptPath = resolve("knowledge", "demo_script_cpr_main_v1.json");
  const script = JSON.parse(await readFile(scriptPath, "utf8"));

  // A safe, number-free narrative passes the guard regardless of the demo's
  // exact stats, so we can assert the wiring without pinning report numbers.
  const SAFE_NARRATIVE = "急救员您好，交接报告已生成，关键信息请看屏幕，我已配合记录全过程。";
  const runtime = {
    async generatePatch() {
      return {
        ok: true,
        fallback: true,
        fallbackReason: "test_no_supplement",
        patch: {
          intent: "fallback_template",
          tts: { text: "", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "", secondary_text: "" },
          reason: "test",
          confidence: 0.6
        }
      };
    },
    async generateNarrative() {
      return { ok: true, narrative: SAFE_NARRATIVE, reason: "test", confidence: 0.9 };
    }
  };

  const result = await runDemoPipeline({
    script,
    useGemma: true,
    gemmaRuntime: runtime,
    sessionId: "sess_handover_wiring"
  });

  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(result.report.narrative, SAFE_NARRATIVE);
  assert.equal(result.report.narrative_source, "gemma_agent");
  assert.equal(result.report.narrative_intent, "handover_summary_patch");
  assert.equal(result.gemma.handover.source, "gemma_agent");
  // The deterministic report text is still present and unchanged in shape.
  assert.match(result.report.text, /交接报告/);
});

test("runAgentPipelineWithGemma is unaffected when the runtime has no generateNarrative", async () => {
  const scriptPath = resolve("knowledge", "demo_script_cpr_main_v1.json");
  const script = JSON.parse(await readFile(scriptPath, "utf8"));

  const runtime = {
    async generatePatch() {
      return {
        ok: true,
        fallback: true,
        fallbackReason: "test_no_supplement",
        patch: {
          intent: "fallback_template",
          tts: { text: "", tone: "calm_firm", speed: "normal" },
          ui: { main_text: "", secondary_text: "" },
          reason: "test",
          confidence: 0.6
        }
      };
    }
  };

  const result = await runDemoPipeline({
    script,
    useGemma: true,
    gemmaRuntime: runtime,
    sessionId: "sess_handover_no_narrative"
  });

  assert.equal(result.state.current_stage, AgentStage.S9_HANDOVER);
  assert.equal(result.report.narrative, undefined);
  assert.equal(result.gemma.handover, null);
  assert.match(result.report.text, /交接报告/);
});
