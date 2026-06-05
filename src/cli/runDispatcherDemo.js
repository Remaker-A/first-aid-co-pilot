// GuidanceAction Dispatcher 演示入口。
//
// 运行：node src/cli/runDispatcherDemo.js
//
// 它做两件事：
//   A. 构造一组有代表性的「已校验形态」GuidanceAction，逐个走分发器，打印每个通道收到了什么。
//   B. 直接复用 runDemoPipeline（Worker A 的现有导出，只读不改）跑完整 demo 脚本，
//      把流水线产出的真实 validated 动作整体喂给 dispatcher，展示「pipeline -> dispatcher」端到端。
//
// 注：这里手工构造的动作均采用 actionValidator 输出后的字段形态（snake_case），
// 代表「已通过 ActionValidator 的动作」。dispatcher 只消费这种动作。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createGuidanceDispatcher } from "../dispatch/index.js";
import { runDemoPipeline } from "../agent/runPipeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

// 仅 sample 1~6 的 intent 视为「已知」，用于触发 sample 7 的未知 intent 兜底。
const KNOWN_INTENTS = [
  "ask_response_check",
  "start_cpr_loop",
  "stop_cpr_loop",
  "start_emergency_call_and_cpr",
  "share_recorded_video",
];

// 已校验动作的最小骨架，便于按需覆盖字段。
function action(overrides = {}) {
  return {
    action_id: overrides.action_id ?? "act_demo",
    session_id: overrides.session_id ?? "sess_demo",
    stage: overrides.stage ?? "S7_CPR_LOOP",
    intent: overrides.intent ?? "demo_intent",
    priority: overrides.priority ?? "normal",
    source: overrides.source ?? "state_machine",
    tts: overrides.tts ?? { text: "", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
    ui: overrides.ui ?? { main_text: "", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
    haptic: overrides.haptic ?? { enabled: false },
    visual_overlay: overrides.visual_overlay ?? null,
    tool_actions: overrides.tool_actions ?? [],
  };
}

const samples = [
  {
    title: "1. 普通 UI + TTS 指令（检查反应）",
    action: action({
      intent: "ask_response_check",
      priority: "normal",
      stage: "S2_CHECK_RESPONSE",
      tts: { text: "请大声叫他，并轻拍双肩。", tone: "calm_firm", speed: "normal", interrupt_policy: "do_not_interrupt_critical" },
      ui: {
        main_text: "检查反应",
        secondary_text: "呼叫并轻拍双肩",
        status_tags: ["呼叫", "拍肩"],
        quality_score: null,
        primary_button: { label: "没有反应", action: "mark_unresponsive" },
      },
    }),
  },
  {
    title: "2. 节拍器 start（开始按压，跟随节拍）",
    action: action({
      intent: "start_cpr_loop",
      priority: "critical",
      stage: "S7_CPR_LOOP",
      tts: { text: "现在开始按压，跟着节拍，用力快压。", tone: "calm_firm", speed: "normal", interrupt_policy: "interrupt_lower_priority" },
      ui: { main_text: "开始按压", secondary_text: "目标 100-120 次/分钟", status_tags: ["快速有力", "跟着节拍"], quality_score: 32, primary_button: null },
      haptic: { enabled: true, pattern: "metronome", bpm: 110 },
      tool_actions: [{ type: "start_haptic_metronome", bpm: 110, requires_user_confirmation: false }],
    }),
  },
  {
    title: "3. 节拍器 stop（急救员接手，停止节拍）",
    action: action({
      intent: "stop_cpr_loop",
      priority: "normal",
      stage: "S9_HANDOVER",
      tts: { text: "可以停止按压了，急救员接手。", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
      ui: { main_text: "停止按压", secondary_text: "急救员已接手", status_tags: ["停止", "交接"], quality_score: null, primary_button: null },
      tool_actions: [{ type: "stop_haptic_metronome" }],
    }),
  },
  {
    title: "4. critical 拨打 120（+ 本地录制 + GPS）",
    action: action({
      intent: "start_emergency_call_and_cpr",
      priority: "critical",
      stage: "S5_CALL_EMERGENCY",
      tts: { text: "我将为你拨打 120，请保持手机免提。现在准备胸外按压。", tone: "calm_firm", speed: "normal", interrupt_policy: "interrupt_lower_priority" },
      ui: { main_text: "正在呼叫 120", secondary_text: "保持免提，准备胸外按压", status_tags: ["呼叫120", "GPS", "录制"], quality_score: null, primary_button: { label: "已拨打120", action: "mark_emergency_called" } },
      tool_actions: [
        { type: "emergency_call", target: "120", mode: "auto_with_cancel_window", cancel_window_seconds: 3, requires_user_confirmation: false },
        { type: "start_local_recording", requires_user_confirmation: false },
        { type: "attach_gps_location", requires_user_confirmation: false },
      ],
    }),
  },
  {
    title: "5. 未确认的分享视频（应被 block 且上报，不可执行）",
    action: action({
      intent: "share_recorded_video",
      priority: "normal",
      stage: "S9_HANDOVER",
      tts: { text: "是否把现场视频分享给急救团队？", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
      ui: { main_text: "分享视频？", secondary_text: "需要你确认后才会分享", status_tags: ["分享", "待确认"], quality_score: null, primary_button: { label: "确认分享", action: "confirm_share_video" } },
      tool_actions: [{ type: "share_video", requires_user_confirmation: true }],
    }),
  },
  {
    title: "6. 已确认的分享视频（context.confirmations 授予 -> 执行）",
    action: action({
      intent: "share_recorded_video",
      priority: "normal",
      stage: "S9_HANDOVER",
      tts: { text: "好的，正在把现场视频分享给急救团队。", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
      ui: { main_text: "正在分享视频", secondary_text: "已获你确认", status_tags: ["分享", "已确认"], quality_score: null, primary_button: null },
      tool_actions: [{ type: "share_video", requires_user_confirmation: true }],
    }),
    context: { confirmations: new Set(["share_video"]) },
  },
  {
    title: "7. 未知 intent（无任何内容 -> 触发 UI 兜底）",
    action: action({
      intent: "diagnose_and_promise_cure",
      priority: "normal",
      stage: "S7_CPR_LOOP",
    }),
    context: { knownIntents: KNOWN_INTENTS },
  },
];

function printResult(title, result) {
  console.log(`\n── ${title}`);
  console.log(
    `   intent=${result.intent} priority=${result.priority} -> channels=[${result.channels.join(", ") || "(无)"}]` +
      `${result.fallback ? "  [已触发UI兜底]" : ""}${result.unknownIntent ? "  [未知intent]" : ""}`
  );

  for (const delivery of result.deliveries) {
    console.log(`     ${delivery.summary ?? `[${delivery.channel}/${delivery.status}]`}`);
    if (delivery.channel === "tool" && Array.isArray(delivery.payload?.tools)) {
      for (const tool of delivery.payload.tools) {
        const extra = tool.confirmed === false ? "（未确认，已拦截）" : tool.critical ? "（关键，必达）" : "";
        console.log(`        - ${tool.type} -> ${tool.outcome} ${extra}`.trimEnd());
      }
    }
  }

  if (result.warnings.length > 0) {
    console.log(`     warnings: ${result.warnings.join(", ")}`);
  }
}

function runSampleSection() {
  console.log("==================================================================");
  console.log(" A. 代表性示例动作分发（手工构造的 validated 动作）");
  console.log("==================================================================");

  // 同一个 dispatcher 实例：haptic sink 有内存状态，可观察 start -> stop 迁移。
  const dispatcher = createGuidanceDispatcher();

  for (const sample of samples) {
    const result = dispatcher.dispatch(sample.action, sample.context ?? {});
    printResult(sample.title, result);
  }
}

function runPipelineSection() {
  console.log("\n==================================================================");
  console.log(" B. pipeline -> dispatcher 端到端（复用 runDemoPipeline 的真实产出）");
  console.log("==================================================================");

  const scriptPath = resolve(root, "knowledge", "demo_script_cpr_main_v1.json");
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  const result = runDemoPipeline({ script });

  const dispatcher = createGuidanceDispatcher();
  const dispatchResults = dispatcher.dispatchAll(result.actions);

  console.log(`   流水线产出 ${result.actions.length} 个动作，逐个分发：\n`);
  for (const dispatched of dispatchResults) {
    const hapticDelivery = dispatched.deliveries.find((delivery) => delivery.channel === "haptic");
    const toolDelivery = dispatched.deliveries.find((delivery) => delivery.channel === "tool");
    const annotations = [];
    if (hapticDelivery) {
      annotations.push(`haptic:${hapticDelivery.command}`);
    }
    if (toolDelivery) {
      annotations.push(`tool:${toolDelivery.status}`);
    }
    console.log(
      `   - ${dispatched.intent.padEnd(30)} [${dispatched.priority.padEnd(8)}] ` +
        `channels=[${dispatched.channels.join(", ")}]${annotations.length ? "  " + annotations.join(" ") : ""}`
    );
  }

  const swallowed = dispatchResults.filter(
    (dispatched) => dispatched.channels.length === 0 && dispatched.priority !== "silent"
  );
  const withWarnings = dispatchResults.filter((dispatched) => dispatched.warnings.length > 0);

  console.log("");
  console.log(`   汇总：被吞掉(0通道且非silent)的动作 = ${swallowed.length}（期望 0）`);
  console.log(`   汇总：带 warnings 的动作 = ${withWarnings.length}`);
  console.log(`   最终 stage = ${result.state.current_stage}`);
}

console.log("FirstAid Copilot —— GuidanceAction Dispatcher Demo\n");
runSampleSection();
runPipelineSection();
console.log("\n完成。各通道仅为 mock 输出，真实端替换点见各 sink 源码顶部注释。");
