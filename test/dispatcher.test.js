import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createGuidanceDispatcher,
  GuidanceDispatcher,
  DELIBERATELY_SILENT_INTENTS,
} from "../src/dispatch/index.js";
import { validateAction } from "../src/engine/actionValidator.js";
import { createStartEmergencyAndCprAction } from "../src/domain/actionFactories.js";
import { runDemoPipeline } from "../src/agent/runPipeline.js";

// 已校验动作的最小骨架，便于按需覆盖字段。
function makeAction(overrides = {}) {
  return {
    action_id: overrides.action_id ?? "act_test",
    session_id: overrides.session_id ?? "sess_test",
    timestamp: overrides.timestamp ?? "2026-06-02T00:00:00.000Z",
    stage: overrides.stage ?? "S7_CPR_LOOP",
    intent: overrides.intent ?? "test_intent",
    priority: overrides.priority ?? "normal",
    source: overrides.source ?? "state_machine",
    reason_codes: overrides.reason_codes ?? [],
    tts: overrides.tts ?? { text: "", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
    ui: overrides.ui ?? { main_text: "", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
    haptic: overrides.haptic ?? { enabled: false },
    visual_overlay: overrides.visual_overlay ?? null,
    tool_actions: overrides.tool_actions ?? [],
  };
}

function toolDeliveryOf(result) {
  return result.deliveries.find((delivery) => delivery.channel === "tool");
}

function hapticDeliveryOf(result) {
  return result.deliveries.find((delivery) => delivery.channel === "haptic");
}

test("speak-and-show action routes to ui + tts only", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "ask_response_check",
      tts: { text: "请大声叫他，并轻拍双肩。", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
      ui: { main_text: "检查反应", secondary_text: "呼叫并轻拍双肩", status_tags: ["呼叫"], quality_score: null, primary_button: null },
    })
  );

  assert.deepEqual([...result.channels].sort(), ["tts", "ui"]);
  assert.equal(result.fallback, false);
  assert.equal(result.warnings.length, 0);
});

test("pure UI action does not trigger tts/haptic/tool", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "show_status",
      ui: { main_text: "继续观察", secondary_text: "", status_tags: ["观察"], quality_score: null, primary_button: null },
    })
  );

  assert.deepEqual(result.channels, ["ui"]);
});

test("haptic is driven by action.haptic + haptic tool, never by toolSink", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "start_cpr_loop",
      priority: "critical",
      tts: { text: "跟着节拍按。", tone: "calm_firm", speed: "normal", interrupt_policy: "interrupt_lower_priority" },
      ui: { main_text: "开始按压", secondary_text: "", status_tags: [], quality_score: 40, primary_button: null },
      haptic: { enabled: true, pattern: "metronome", bpm: 110 },
      tool_actions: [{ type: "start_haptic_metronome", bpm: 110, requires_user_confirmation: false }],
    })
  );

  assert.ok(result.channels.includes("haptic"));
  assert.ok(result.channels.includes("ui"));
  assert.ok(result.channels.includes("tts"));
  // 仅有 haptic 类工具时，toolSink 不应被触发。
  assert.ok(!result.channels.includes("tool"));
  assert.equal(hapticDeliveryOf(result).command, "start");
});

test("haptic sink tracks start -> stop across dispatches on same dispatcher", () => {
  const dispatcher = createGuidanceDispatcher();

  const startResult = dispatcher.dispatch(
    makeAction({
      intent: "start_cpr_loop",
      haptic: { enabled: true, pattern: "metronome", bpm: 110 },
      tool_actions: [{ type: "start_haptic_metronome", bpm: 110 }],
    })
  );
  assert.equal(hapticDeliveryOf(startResult).command, "start");
  assert.equal(hapticDeliveryOf(startResult).payload.running, true);

  const stopResult = dispatcher.dispatch(
    makeAction({
      intent: "stop_cpr_loop",
      ui: { main_text: "停止按压", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
      tool_actions: [{ type: "stop_haptic_metronome" }],
    })
  );
  const stopHaptic = hapticDeliveryOf(stopResult);
  assert.equal(stopHaptic.command, "stop");
  assert.equal(stopHaptic.payload.running, false);
  assert.equal(stopHaptic.payload.was_running, true);
});

test("critical emergency action reaches ui/tts/tool and 120 call always executes", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "start_emergency_call_and_cpr",
      priority: "critical",
      stage: "S5_CALL_EMERGENCY",
      tts: { text: "我将为你拨打 120。", tone: "calm_firm", speed: "normal", interrupt_policy: "interrupt_lower_priority" },
      ui: { main_text: "正在呼叫 120", secondary_text: "保持免提", status_tags: ["呼叫120"], quality_score: null, primary_button: null },
      tool_actions: [
        { type: "emergency_call", target: "120", requires_user_confirmation: false },
        { type: "start_local_recording", requires_user_confirmation: false },
        { type: "attach_gps_location", requires_user_confirmation: false },
      ],
    })
  );

  assert.ok(result.channels.includes("ui"));
  assert.ok(result.channels.includes("tts"));
  assert.ok(result.channels.includes("tool"));

  const tools = toolDeliveryOf(result).payload.tools;
  const call = tools.find((tool) => tool.type === "emergency_call");
  assert.equal(call.outcome, "executed");
  assert.equal(call.critical, true);
  assert.ok(tools.find((tool) => tool.type === "start_local_recording").outcome === "executed");
  assert.ok(tools.find((tool) => tool.type === "attach_gps_location").outcome === "executed");
});

test("critical action is never swallowed: empty critical action gets fallback + warning", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({ intent: "critical_but_empty", priority: "critical" })
  );

  assert.equal(result.fallback, true);
  assert.ok(result.channels.includes("ui"));
  assert.ok(result.warnings.includes("critical_no_channel:critical_but_empty"));
});

test("strictCritical mode throws when a critical action hits no natural channel", () => {
  const dispatcher = new GuidanceDispatcher({ strictCritical: true });
  assert.throws(
    () => dispatcher.dispatch(makeAction({ intent: "critical_but_empty", priority: "critical" })),
    /未能分发到任何通道/
  );
});

test("share tool without confirmation is blocked and reported, not executed", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "share_recorded_video",
      stage: "S9_HANDOVER",
      tts: { text: "是否分享视频？", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
      ui: { main_text: "分享视频？", secondary_text: "需确认", status_tags: [], quality_score: null, primary_button: null },
      tool_actions: [{ type: "share_video", requires_user_confirmation: true }],
    })
  );

  const toolDelivery = toolDeliveryOf(result);
  assert.equal(toolDelivery.status, "blocked");
  const share = toolDelivery.payload.tools.find((tool) => tool.type === "share_video");
  assert.equal(share.outcome, "blocked_requires_confirmation");
  assert.equal(share.confirmed, false);
  assert.ok(result.warnings.includes("tool_blocked_requires_confirmation:share_video"));
  // 工具被拦截，但 ui/tts 仍照常投递 —— 整条动作不被吞掉。
  assert.ok(result.channels.includes("ui"));
  assert.ok(result.channels.includes("tts"));
  assert.ok(!result.channels.includes("tool"));
});

test("share tool executes once confirmed via context.confirmations", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "share_recorded_video",
      stage: "S9_HANDOVER",
      ui: { main_text: "正在分享", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
      tool_actions: [{ type: "share_video", requires_user_confirmation: true }],
    }),
    { confirmations: new Set(["share_video"]) }
  );

  const share = toolDeliveryOf(result).payload.tools.find((tool) => tool.type === "share_video");
  assert.equal(share.outcome, "executed");
  assert.equal(share.confirmed, true);
  assert.ok(result.channels.includes("tool"));
  assert.ok(!result.warnings.includes("tool_blocked_requires_confirmation:share_video"));
});

test("share tool executes when the tool itself carries user confirmation", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "share_recorded_video",
      stage: "S9_HANDOVER",
      ui: { main_text: "正在分享", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
      tool_actions: [{ type: "share_video", requires_user_confirmation: true, user_confirmed: true }],
    })
  );

  const share = toolDeliveryOf(result).payload.tools.find((tool) => tool.type === "share_video");
  assert.equal(share.outcome, "executed");
});

test("request_share_video is a confirmation prompt (delivered, not blocked)", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "request_share_video",
      stage: "S9_HANDOVER",
      ui: { main_text: "需要你确认", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
      tool_actions: [{ type: "request_share_video", requires_user_confirmation: true }],
    })
  );

  const toolDelivery = toolDeliveryOf(result);
  assert.equal(toolDelivery.status, "delivered");
  const prompt = toolDelivery.payload.tools.find((tool) => tool.type === "request_share_video");
  assert.equal(prompt.outcome, "prompted");
  assert.ok(result.channels.includes("tool"));
});

test("malformed tool (missing type) is surfaced as unknown_tool, not silently dropped", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({
      intent: "weird_action",
      ui: { main_text: "继续", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
      tool_actions: [{ foo: "bar" }],
    })
  );

  assert.ok(result.warnings.includes("unknown_tool:<missing>"));
  const unknown = toolDeliveryOf(result).payload.tools[0];
  assert.equal(unknown.outcome, "unknown_tool");
});

test("unknown intent triggers UI fallback", () => {
  const dispatcher = createGuidanceDispatcher({ knownIntents: ["ask_response_check", "start_cpr_loop"] });
  const result = dispatcher.dispatch(makeAction({ intent: "mystery_intent", priority: "normal" }));

  assert.equal(result.unknownIntent, true);
  assert.equal(result.fallback, true);
  assert.ok(result.channels.includes("ui"));
  assert.ok(result.warnings.includes("unknown_intent:mystery_intent"));

  const uiDelivery = result.deliveries.find((delivery) => delivery.channel === "ui");
  assert.equal(uiDelivery.payload.fallback, true);
  assert.equal(uiDelivery.payload.main_text.length > 0, true);
});

test("known intent with content is not flagged and not fallback", () => {
  const dispatcher = createGuidanceDispatcher({ knownIntents: ["ask_response_check"] });
  const result = dispatcher.dispatch(
    makeAction({
      intent: "ask_response_check",
      tts: { text: "请轻拍双肩。", tone: "calm_firm", speed: "normal", interrupt_policy: "queue" },
      ui: { main_text: "检查反应", secondary_text: "", status_tags: [], quality_score: null, primary_button: null },
    })
  );

  assert.equal(result.unknownIntent, false);
  assert.equal(result.fallback, false);
});

test("deliberately silent action (defer_to_critical_action) produces no channels and no fallback", () => {
  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(
    makeAction({ intent: "defer_to_critical_action", priority: "silent" })
  );

  assert.equal(result.channels.length, 0);
  assert.equal(result.fallback, false);
});

test("dispatcher consumes a real ActionValidator output (validated shape compatibility)", () => {
  const candidate = createStartEmergencyAndCprAction({ sessionId: "sess_v" });
  const validation = validateAction(candidate, { current_stage: "S5_CALL_EMERGENCY" });
  assert.equal(validation.ok, true);

  const dispatcher = createGuidanceDispatcher();
  const result = dispatcher.dispatch(validation.action);

  assert.ok(result.channels.includes("ui"));
  assert.ok(result.channels.includes("tts"));
  assert.ok(result.channels.includes("tool"));
  const call = toolDeliveryOf(result).payload.tools.find((tool) => tool.type === "emergency_call");
  assert.equal(call.outcome, "executed");
});

test("dispatchAll over the full demo pipeline never swallows a non-silent action", async () => {
  const scriptPath = resolve("knowledge", "demo_script_cpr_main_v1.json");
  const script = JSON.parse(await readFile(scriptPath, "utf8"));
  const pipeline = runDemoPipeline({ script });

  const dispatcher = createGuidanceDispatcher();
  const results = dispatcher.dispatchAll(pipeline.actions);

  assert.ok(results.length > 0);
  for (const result of results) {
    const silent = DELIBERATELY_SILENT_INTENTS.has(result.intent) || result.priority === "silent";
    assert.ok(
      result.channels.length > 0 || silent,
      `action ${result.intent} should hit >=1 channel or be deliberately silent`
    );
  }

  // 主线 demo 必然出现拨打 120 与节拍器启动（单声音节拍，不再震动）。
  const hadEmergency = results.some((result) =>
    (toolDeliveryOf(result)?.payload?.tools ?? []).some(
      (tool) => tool.type === "emergency_call" && tool.outcome === "executed"
    )
  );
  const hadHaptic = results.some((result) => hapticDeliveryOf(result)?.command === "start");
  assert.ok(hadEmergency, "demo 主线应触发 emergency_call");
  assert.ok(hadHaptic, "demo 主线应启动 haptic 节拍器");
});
