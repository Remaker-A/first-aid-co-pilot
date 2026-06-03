import assert from "node:assert/strict";
import test from "node:test";

import { createEmergencyCallToolAction } from "../src/domain/actionFactories.js";
import { AgentStage } from "../src/domain/stages.js";
import { getStateMachineAction } from "../src/engine/stateMachine.js";
import { createToolSink } from "../src/dispatch/sinks/toolSink.js";

const TEST_NUMBER = "15500001120";

function makeEmergencyAction(tool, overrides = {}) {
  return {
    intent: "start_emergency_call_and_cpr",
    priority: "critical",
    stage: AgentStage.S5_CALL_EMERGENCY,
    tool_actions: [tool],
    ...overrides,
  };
}

function dispatchEmergencyTool(tool, context = {}) {
  return createToolSink().deliver(makeEmergencyAction(tool), context);
}

function onlyEmergencyTool(delivery) {
  const tool = delivery.payload.tools.find((item) => item.type === "emergency_call");
  assert.ok(tool, "expected emergency_call tool result");
  return tool;
}

function makeDemoTool(overrides = {}) {
  return createEmergencyCallToolAction({
    mode: overrides.mode,
    target: overrides.target ?? "120",
    demoTestNumber: overrides.demo_test_number ?? overrides.demoTestNumber,
    ...overrides,
  });
}

async function importFirstExisting(paths) {
  for (const path of paths) {
    try {
      return { module: await import(path), path, error: null };
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") {
        return { module: null, path, error };
      }
    }
  }
  return { module: null, path: null, error: null };
}

const callBriefImport = await importFirstExisting([
  "../src/demo/callBrief.js",
  "../src/demo/CallBrief.js",
  "../src/dispatch/sinks/callBrief.js",
  "../src/dispatch/sinks/CallBrief.js",
  "../src/dispatch/sinks/emergencyCallBrief.js",
  "../src/report/callBrief.js",
  "../src/domain/callBrief.js",
]);
const callBriefModule = callBriefImport.module;

const callBriefFactory =
  callBriefModule?.generateCallBrief ??
  callBriefModule?.createCallBrief ??
  callBriefModule?.buildCallBrief ??
  callBriefModule?.formatCallBrief ??
  callBriefModule?.CallBrief?.create ??
  callBriefModule?.default;

function renderCallBrief(input) {
  const result = callBriefFactory(input.state ?? input, input.options ?? {});
  if (typeof result === "string") return result;
  return (
    result?.script ??
    result?.visible_script ??
    result?.text ??
    result?.brief ??
    JSON.stringify(result)
  );
}

test("state machine emergency_call advertises all demo modes and visible script", () => {
  const action = getStateMachineAction({
    session_id: "sess_demo_call_modes",
    current_stage: AgentStage.S4_SUSPECTED_ARREST,
    confirmed_facts: {
      responsive: false,
      normal_breathing: false,
      agonal_breathing: true,
      breathing_source: "vision_mock",
    },
  });

  const call = action.tool_actions.find((tool) => tool.type === "emergency_call");
  assert.ok(call, "S5 call emergency action should include emergency_call");
  assert.equal(call.target, "120");
  assert.deepEqual(call.demo_modes, [
    "test_auto_call",
    "accessibility_click_120",
    "dial_only_fallback",
  ]);
  assert.equal(call.visible_script_required, true);
  assert.equal(call.briefing.visible_script_required, true);
  assert.equal(call.audit.real_emergency_test_requires_manual_approval, true);
});

test("test_auto_call mode uses a test number, never ACTION_CALL directly to 120", () => {
  const delivery = dispatchEmergencyTool(
    makeDemoTool(),
    {
      emergencyCallDemo: {
        mode: "test_auto_call",
        testNumber: TEST_NUMBER,
      },
    }
  );

  const call = onlyEmergencyTool(delivery);
  assert.equal(call.outcome, "executed");
  assert.equal(call.detail.mode, "test_auto_call");
  assert.equal(call.detail.android_intent.action, "Intent.ACTION_CALL");
  assert.equal(call.detail.target, TEST_NUMBER);
  assert.equal(call.detail.android_intent.uri, `tel:${TEST_NUMBER}`);
  assert.notEqual(call.detail.target, "120");
  assert.notEqual(call.detail.android_intent.uri, "tel:120");
  assert.equal(call.detail.audit_flags.uses_test_number, true);
  assert.equal(call.detail.audit_flags.would_place_call, true);
});

test("accessibility_click_120 falls back to dial_only_fallback without permission or allowRealEmergencyTest", () => {
  const cases = [
    {
      name: "missing call permission",
      context: {
        emergencyCallDemo: {
          mode: "accessibility_click_120",
          accessibilityAuthorized: false,
          allowRealEmergencyTest: true,
        },
      },
      expectedWarning: /requires_authorization_and_real_test_flag/,
    },
    {
      name: "real emergency test not allowed",
      context: {
        emergencyCallDemo: {
          mode: "accessibility_click_120",
          accessibilityAuthorized: true,
          allowRealEmergencyTest: false,
        },
      },
      expectedWarning: /requires_authorization_and_real_test_flag/,
    },
  ];

  for (const item of cases) {
    const delivery = dispatchEmergencyTool(
      makeDemoTool({ mode: "accessibility_click_120" }),
      item.context
    );
    const call = onlyEmergencyTool(delivery);

    assert.equal(call.detail.mode, "dial_only_fallback", item.name);
    assert.equal(call.detail.android_intent.action, "Intent.ACTION_DIAL", item.name);
    assert.equal(call.detail.android_intent.uri, "tel:120", item.name);
    assert.ok(
      delivery.warnings.some((warning) => item.expectedWarning.test(warning)),
      `${item.name} should emit a warning`
    );
  }
});

test("accessibility_click_120 with authorization returns ACTION_DIAL plus auto-click audit marks", () => {
  const delivery = dispatchEmergencyTool(
    makeDemoTool(),
    {
      emergencyCallDemo: {
        mode: "accessibility_click_120",
        accessibilityAuthorized: true,
        allowRealEmergencyTest: true,
      },
    }
  );

  const call = onlyEmergencyTool(delivery);
  assert.equal(call.outcome, "executed");
  assert.equal(call.detail.mode, "accessibility_click_120");
  assert.equal(call.detail.android_intent.action, "Intent.ACTION_DIAL");
  assert.equal(call.detail.android_intent.uri, "tel:120");
  assert.equal(call.detail.android_intent.accessibility_click.would_auto_click, true);
  assert.equal(call.detail.audit_flags.would_auto_click, true);
  assert.equal(call.detail.audit_flags.allow_real_emergency_test, true);
  assert.equal(call.detail.audit_flags.demo_only, true);
});

test("dial_only_fallback opens tel:120 and requires a visible script", () => {
  const tool = makeDemoTool({ mode: "dial_only_fallback" });
  const delivery = dispatchEmergencyTool(
    tool,
    { emergencyCallDemo: { mode: "dial_only_fallback" } }
  );

  const call = onlyEmergencyTool(delivery);
  assert.equal(call.outcome, "executed");
  assert.equal(call.detail.mode, "dial_only_fallback");
  assert.equal(call.detail.android_intent.action, "Intent.ACTION_DIAL");
  assert.equal(call.detail.android_intent.uri, "tel:120");
  assert.equal(tool.visible_script_required, true);
  assert.equal(tool.briefing.visible_script_required, true);
  assert.equal(call.detail.visible_script.title, "Emergency call demo");
  assert.ok(
    call.detail.visible_script.lines.some((line) => /manually press the call button/i.test(line))
  );
});

test("CallBrief script includes location, coordinates, injury and low-accuracy warning", {
  skip: !callBriefFactory && !callBriefImport.error,
}, () => {
  if (callBriefImport.error) {
    assert.fail(`failed to import ${callBriefImport.path}: ${callBriefImport.error.message}`);
  }

  const script = renderCallBrief({
    state: {
      location: {
        address_line: "上海市黄浦区人民广场1号",
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy_m: 150,
      },
      scope: { adult_likely: true },
      confirmed_facts: {
        responsive: false,
        normal_breathing: false,
        suspected_cardiac_arrest: true,
      },
      cpr_state: { started: true },
    },
    options: { callbackNumber: "13800138000" },
  });

  assert.match(script, /上海市黄浦区人民广场1号/);
  assert.match(script, /31\.2304/);
  assert.match(script, /121\.4737/);
  assert.match(script, /无反应|无正常呼吸|疑似心脏骤停|胸外按压/);
  assert.match(script, /低精度|精度较低|定位可能不精确|位置可能不准|low accuracy/i);
});
