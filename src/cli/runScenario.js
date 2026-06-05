#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDemoPipeline, stepAgentTurn } from "../agent/runPipeline.js";
import { loadEnv } from "../config/loadEnv.js";
import { createGuidanceDispatcher, DELIBERATELY_SILENT_INTENTS } from "../dispatch/index.js";
import { AgentStage } from "../domain/stages.js";
import { Mode, createInitialSessionState } from "../domain/types.js";
import { GemmaRuntime } from "../gemma/runtime.js";
import { generateHandoverReport } from "../report/handoverReportGenerator.js";
import { generateHandoverNarrative } from "../report/handoverNarrative.js";
import { createSessionLog } from "../report/sessionLog.js";
import { createLlmSceneBrain, createSceneSimulator } from "../sim/sceneSimulator.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const scenarioPath = resolve(root, "knowledge", "scenario_collapse_vision_v1.json");
const DEFAULT_LIVE_MAX_TURNS = 80;
const DEFAULT_SCENARIO_GEMMA_TIMEOUT_MS = 8000;

loadEnv({ cwd: root });

await main().catch((error) => {
  console.error(`\n场景 CLI 失败：${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === "live") {
    await runLiveScenario();
  } else {
    await runScriptedScenario();
  }
}

function parseMode(argv) {
  const modeFlag = argv.find((arg) => arg === "--mode" || arg.startsWith("--mode="));
  if (!modeFlag) {
    return "scripted";
  }

  const value = modeFlag.includes("=")
    ? modeFlag.slice("--mode=".length)
    : argv[argv.indexOf(modeFlag) + 1];

  if (value === "scripted" || value === "live") {
    return value;
  }

  throw new Error(`不支持的 --mode：${value || "(空)"}。可选值：scripted, live`);
}

async function loadScenarioScript() {
  return JSON.parse(await readFile(scenarioPath, "utf8"));
}

async function runScriptedScenario() {
  const script = await loadScenarioScript();
  const result = runDemoPipeline({
    script,
    sessionId: "sess_scenario_cli_scripted",
    useGemma: false,
  });
  const turns = pairActionsWithEvents(result.log);
  const dispatcher = createGuidanceDispatcher();
  const dispatchResults = [];

  printHeader("scripted", "纯视觉脚本回放，禁用 Gemma，确定性输出");
  result.actions.forEach((action, index) => {
    const dispatchResult = dispatcher.dispatch(action);
    dispatchResults.push(dispatchResult);
    printTurn({
      index: index + 1,
      event: turns[index]?.event ?? null,
      action,
      dispatchResult,
    });
  });

  printReportAndSummary({
    report: result.report,
    finalStage: result.state.current_stage,
    actionCount: result.actions.length,
    dispatchResults,
    extraLines: [`事件数：${result.log.summary.event_count}`],
  });
}

async function runLiveScenario() {
  const sessionId = "sess_scenario_cli_live";
  const now = () => new Date().toISOString();
  const runtime = createScenarioRuntime();
  const sim = createSceneSimulator({
    sessionId,
    mode: Mode.DEMO_ASSISTED,
    brain: createLlmSceneBrain({ runtime }),
  });
  const dispatcher = createGuidanceDispatcher();
  const log = createSessionLog({ sessionId, now });
  let state = createInitialSessionState({ sessionId, mode: Mode.DEMO_ASSISTED });
  let lastDispatchForSim = null;
  const actions = [];
  const dispatchResults = [];
  const fallbackNotes = [];
  const maxTurns = parsePositiveInt(process.env.SCENARIO_LIVE_MAX_TURNS, DEFAULT_LIVE_MAX_TURNS);

  printHeader(
    "live",
    `闭环模拟器 + stepAgentTurn + dispatcher，Gemma 超时 ${runtime.options.timeoutMs}ms 后自动 fallback`
  );

  for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex += 1) {
    const event = await sim.nextEventAsync(lastDispatchForSim);
    if (!event) {
      console.log("\n模拟器已无新事件，结束 live 场景。");
      break;
    }

    const turn = await stepAgentTurnWithFallback({
      state,
      event,
      runtime,
      sessionId,
      now,
      fallbackNotes,
    });
    state = turn.state;
    log.recordEvent(event, state);
    log.recordState(state, event);

    if (!turn.action) {
      printTurn({
        index: turnIndex,
        event,
        action: null,
        dispatchResult: null,
        bystander: event.metadata?.bystander,
      });
    } else {
      const dispatchResult = dispatcher.dispatch(turn.action);
      actions.push(turn.action);
      dispatchResults.push(dispatchResult);
      lastDispatchForSim = dispatchResult;
      log.recordAction(turn.action, state, turn.validation);
      recordGemmaFallback(turn, fallbackNotes);
      printTurn({
        index: turnIndex,
        event,
        action: turn.action,
        dispatchResult,
        bystander: event.metadata?.bystander,
      });
    }

    if (sim.isFinished() && state.current_stage === AgentStage.S9_HANDOVER) {
      break;
    }
  }

  if (!sim.isFinished()) {
    fallbackNotes.push(`live_safety_limit:${maxTurns}`);
    console.log(`\n达到 live 安全上限 ${maxTurns} 轮，停止闭环。`);
  }

  const report = generateHandoverReport(log.toJSON(), state);
  // WD 第五点：交接终态用 Gemma 把结构化报告"叙述化"，数字只能来自报告，过 ActionValidator，
  // 失败回退确定性模板。这里展示叙述与其来源，作为 Agent 能力的可见亮点。
  const handover = await generateHandoverNarrative({ report, state, runtime, sessionId });
  if (handover.fallback && handover.fallbackReason) {
    fallbackNotes.push(`handover_narrative:${handover.fallbackReason}`);
  }
  printReportAndSummary({
    report,
    narrative: handover.narrative,
    narrativeSource: handover.source,
    finalStage: state.current_stage,
    actionCount: actions.length,
    dispatchResults,
    extraLines: [
      `模拟器完成：${sim.isFinished() ? "是" : "否"}`,
      `Gemma fallback/注意事项：${fallbackNotes.length > 0 ? unique(fallbackNotes).join("; ") : "无"}`,
    ],
  });
}

async function stepAgentTurnWithFallback({ state, event, runtime, sessionId, now, fallbackNotes }) {
  try {
    return await stepAgentTurn(state, event, { runtime, sessionId, now });
  } catch (error) {
    const message = error?.message || String(error);
    fallbackNotes.push(`stepAgentTurn_runtime_error:${message}`);
    return stepAgentTurn(state, event, { sessionId, now });
  }
}

function createScenarioRuntime() {
  const timeoutMs = parsePositiveInt(
    process.env.SCENARIO_GEMMA_TIMEOUT_MS,
    DEFAULT_SCENARIO_GEMMA_TIMEOUT_MS
  );
  const inner = new GemmaRuntime({ timeoutMs, cwd: root });
  let disabledReason = null;

  return {
    options: inner.options,
    async generatePatch(frame) {
      if (disabledReason) {
        return {
          fallback: true,
          fallbackReason: `scenario_runtime_disabled:${disabledReason}`,
          patch: null,
        };
      }

      const result = await inner.generatePatch(frame);
      const reason = result?.fallbackReason || result?.reason || null;
      if (result?.fallback && shouldDisableRuntimeAfterFallback(reason)) {
        disabledReason = reason;
      }
      return result;
    },
    async generateNarrative(frame) {
      if (disabledReason) {
        return {
          ok: false,
          fallback: true,
          fallbackReason: `scenario_runtime_disabled:${disabledReason}`,
          narrative: "",
        };
      }

      return inner.generateNarrative(frame);
    },
  };
}

function shouldDisableRuntimeAfterFallback(reason) {
  return [
    "model_missing",
    "timeout",
    "cli_exit_nonzero",
    "runner_error",
    "command_not_found",
  ].includes(reason);
}

function recordGemmaFallback(turn, fallbackNotes) {
  if (turn.gemmaFallbackReason) {
    fallbackNotes.push(`agent:${turn.gemmaFallbackReason}`);
  }
  if (Array.isArray(turn.gemmaViolations) && turn.gemmaViolations.length > 0) {
    fallbackNotes.push(`agent_validation:${turn.gemmaViolations.join(",")}`);
  }
}

function pairActionsWithEvents(log = {}) {
  const turns = [];
  let lastEvent = null;
  for (const entry of log.entries ?? []) {
    if (entry.category === "event") {
      lastEvent = entry.payload?.raw_event ?? null;
    } else if (entry.category === "action") {
      turns.push({
        event: lastEvent,
        action: entry.payload?.action ?? null,
      });
    }
  }
  return turns;
}

function printHeader(mode, subtitle) {
  console.log("FirstAid Copilot 场景验收");
  console.log(`模式：${mode}`);
  console.log(subtitle);
  console.log("输出字段：阶段 / 看到(视觉mock) / 决策intent / 听到(TTS) / 屏幕(UI) / 震动(bpm) / 工具(120/录制/GPS/分享)");
}

function printTurn({ index, event, action, dispatchResult, bystander }) {
  console.log(`\n[${String(index).padStart(2, "0")}] 阶段：${action?.stage ?? event?.stage_hint ?? "继续观察"}`);
  console.log(`看到(视觉mock)：${describeEvent(event)}`);
  if (bystander) {
    console.log(`旁观者：${bystander}`);
  }

  if (!action) {
    console.log("决策intent：无动作，继续观察");
    console.log("听到(TTS)：无");
    console.log("屏幕(UI)：无");
    console.log("震动(bpm)：无");
    console.log("工具(120/录制/GPS/分享)：无");
    return;
  }

  console.log(
    `决策intent：${action.intent}（source=${action.source ?? "unknown"}，priority=${action.priority ?? "normal"}）`
  );
  console.log(`听到(TTS)：${describeTts(dispatchResult, action)}`);
  console.log(`屏幕(UI)：${describeUi(dispatchResult, action)}`);
  console.log(`震动(bpm)：${describeHaptic(dispatchResult, action)}`);
  console.log(`工具(120/录制/GPS/分享)：${describeTools(dispatchResult)}`);

  if (dispatchResult?.warnings?.length > 0) {
    console.log(`dispatcher warnings：${dispatchResult.warnings.join(", ")}`);
  }
}

function describeEvent(event) {
  if (!event) {
    return "无";
  }

  const parts = [`${event.source ?? "unknown"}/${event.event_type ?? "unknown"}`];
  const metadata = event.metadata ?? {};
  if (metadata.scene_note) parts.push(metadata.scene_note);
  if (metadata.scene_safe === true) parts.push("现场安全=是");
  if (metadata.aed_available === true) parts.push("AED=已到达");
  if (metadata.ems_arrived === true) parts.push("EMS=已到达");
  if (metadata.emergency_call_started === true) parts.push("120=已拨出");
  if (event.patient_state) parts.push(describePatientState(event.patient_state));
  if (event.cpr_quality) parts.push(describeCprQuality(event.cpr_quality));
  if (event.rescuer_state) parts.push(describeRescuerState(event.rescuer_state));
  if (event.device_state) parts.push(describeDeviceState(event.device_state));
  return parts.join(" | ");
}

function describePatientState(patient) {
  const parts = [];
  if (patient.responsive != null) parts.push(`反应=${yesNo(patient.responsive)}`);
  if (patient.normal_breathing != null) parts.push(`正常呼吸=${yesNo(patient.normal_breathing)}`);
  if (patient.agonal_breathing != null) parts.push(`濒死喘息=${yesNo(patient.agonal_breathing)}`);
  if (patient.chest_movement) parts.push(`胸廓=${patient.chest_movement}`);
  if (patient.confidence != null) parts.push(`置信=${formatNumber(patient.confidence)}`);
  return `患者{${parts.join(", ") || "初始观察"}}`;
}

function describeCprQuality(quality) {
  const parts = [
    `rate=${quality.current_rate ?? quality.compression_rate ?? quality.compression_rate_bpm ?? "-"}`,
    `score=${quality.quality_score ?? "-"}`,
    `hand=${quality.hand_position ?? "-"}`,
    `arm=${quality.arm_posture ?? "-"}`,
    `interrupt=${quality.interruption_seconds ?? 0}s`,
  ];
  if (quality.total_compressions != null) {
    parts.push(`total=${quality.total_compressions}`);
  }
  return `按压{${parts.join(", ")}}`;
}

function describeRescuerState(rescuer) {
  const parts = [];
  if (rescuer.fatigue_level) parts.push(`疲劳=${rescuer.fatigue_level}`);
  if (rescuer.emotion) parts.push(`情绪=${rescuer.emotion}`);
  if (rescuer.hesitation_seconds != null) parts.push(`犹豫=${rescuer.hesitation_seconds}s`);
  return `施救者{${parts.join(", ") || "观察中"}}`;
}

function describeDeviceState(device) {
  const parts = [];
  if (device.emergency_call_started != null) parts.push(`120=${yesNo(device.emergency_call_started)}`);
  if (device.recording != null) parts.push(`录制=${yesNo(device.recording)}`);
  if (device.gps_available != null) parts.push(`GPS可用=${yesNo(device.gps_available)}`);
  if (device.network) parts.push(`网络=${device.network}`);
  return `设备{${parts.join(", ") || "无状态"}}`;
}

function describeTts(dispatchResult, action) {
  const delivery = findDelivery(dispatchResult, "tts");
  return delivery?.payload?.text || action?.tts?.text || "无";
}

function describeUi(dispatchResult, action) {
  const payload = findDelivery(dispatchResult, "ui")?.payload;
  const ui = payload ?? action?.ui ?? {};
  const main = ui.main_text || "无主文案";
  const secondary = ui.secondary_text ? ` / ${ui.secondary_text}` : "";
  const tags = Array.isArray(ui.status_tags) && ui.status_tags.length > 0
    ? ` / 标签:${ui.status_tags.join(",")}`
    : "";
  const score = ui.quality_score != null ? ` / 质量:${ui.quality_score}` : "";
  const button = ui.primary_button?.label ? ` / 按钮:${ui.primary_button.label}` : "";
  return `${main}${secondary}${tags}${score}${button}`;
}

function describeHaptic(dispatchResult, action) {
  const delivery = findDelivery(dispatchResult, "haptic");
  if (delivery?.payload) {
    const bpm = delivery.payload.bpm ?? "-";
    return `${delivery.payload.command ?? delivery.command ?? "on"} ${bpm} bpm`;
  }
  if (action?.haptic?.enabled) {
    return `${action.haptic.pattern ?? "metronome"} ${action.haptic.bpm ?? "-"} bpm`;
  }
  return "无";
}

function describeTools(dispatchResult) {
  const tools = findDelivery(dispatchResult, "tool")?.payload?.tools ?? [];
  if (tools.length === 0) {
    return "无";
  }
  return tools.map((tool) => `${toolLabel(tool.type)}:${tool.outcome}`).join("；");
}

function findDelivery(dispatchResult, channel) {
  return dispatchResult?.deliveries?.find((delivery) => delivery.channel === channel) ?? null;
}

function toolLabel(type) {
  const labels = {
    emergency_call: "120",
    mock_emergency_call: "120(mock)",
    start_local_recording: "录制",
    start_recording: "录制",
    attach_gps_location: "GPS",
    attach_gps: "GPS",
    generate_handover_report: "生成交接报告",
    request_share_report: "请求分享报告",
    request_share_video: "请求分享视频",
    share_report: "分享报告",
    share_video: "分享视频",
  };
  return labels[type] ?? type ?? "未知工具";
}

function printReportAndSummary({
  report,
  narrative,
  narrativeSource,
  finalStage,
  actionCount,
  dispatchResults,
  extraLines = [],
}) {
  const summary = summarizeDispatch(dispatchResults);
  console.log("\n交接报告");
  console.log(report.text);
  if (narrative && narrative !== report.text) {
    console.log(`\n交接叙述（Gemma NLG，来源=${narrativeSource ?? "unknown"}）`);
    console.log(narrative);
  }
  console.log("\n验收摘要");
  console.log(`最终 stage：${finalStage}`);
  console.log(`动作数：${actionCount}`);
  console.log(`dispatcher 被吞动作数：${summary.swallowedCount}`);
  console.log(`dispatcher warnings 数：${summary.warningCount}`);
  for (const line of extraLines) {
    console.log(line);
  }
}

function summarizeDispatch(dispatchResults) {
  const swallowed = dispatchResults.filter((result) => {
    const silent = DELIBERATELY_SILENT_INTENTS.has(result.intent) || result.priority === "silent";
    return result.channels.length === 0 && !silent;
  });
  return {
    swallowedCount: swallowed.length,
    warningCount: dispatchResults.reduce((sum, result) => sum + result.warnings.length, 0),
  };
}

function yesNo(value) {
  return value ? "是" : "否";
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : String(value);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
