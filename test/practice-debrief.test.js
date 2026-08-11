import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePracticeDebrief } from "../src/report/practiceDebrief.js";
import { SessionMode, createInitialSessionState } from "../src/domain/types.js";
import { AgentStage } from "../src/domain/stages.js";
import { runStateMachine } from "../src/engine/stateMachine.js";
import { validateAction } from "../src/engine/actionValidator.js";
import { reduceSession } from "../src/engine/sessionReducer.js";

function practiceState(overrides = {}) {
  return createInitialSessionState({
    sessionMode: SessionMode.PRACTICE,
    ...overrides,
  });
}

function cprReadyFacts() {
  return {
    confirmed_facts: { responsive: false, normal_breathing: false },
    tool_state: { emergency_call_status: "started" },
  };
}

// ── 复盘报告生成器 ──

test("空 entries 不崩溃，返回带空数组的结构化报告", () => {
  const result = generatePracticeDebrief([], practiceState());

  assert.equal(result.json.schema, "practice_debrief_v1");
  assert.equal(result.json.session_mode, "practice");
  assert.ok(Array.isArray(result.json.coaching.strengths));
  assert.ok(Array.isArray(result.json.coaching.improvements));
  assert.deepEqual(result.json.stage_timeline, []);
  assert.ok(typeof result.text === "string" && result.text.length > 0);
});

test("从 SessionLog.toJSON() 格式读取 entries 并折叠阶段时间线", () => {
  const logLike = {
    entries: [
      {
        log_id: "log_0001",
        sequence_id: 1,
        timestamp: "2026-01-01T00:00:00Z",
        category: "action",
        stage: "S2_CHECK_RESPONSE",
        payload: { intent: "ask_response_check" },
      },
      {
        log_id: "log_0002",
        sequence_id: 2,
        timestamp: "2026-01-01T00:00:10Z",
        category: "action",
        stage: "S7_CPR_LOOP",
        payload: { intent: "start_cpr_loop" },
      },
    ],
  };

  const result = generatePracticeDebrief(logLike, practiceState());

  assert.equal(result.json.stage_timeline.length, 2);
  assert.equal(result.json.stage_timeline[0].stage, "S2_CHECK_RESPONSE");
  assert.equal(result.json.stage_timeline[0].duration_seconds, 10);
  assert.equal(result.json.time_to_cpr_seconds, 10);
});

test("复盘结束时间优先取日志最后时间，避免 demo/replay 负时长", () => {
  const result = generatePracticeDebrief(
    {
      entries: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          category: "action",
          stage: "S7_CPR_LOOP",
          payload: { intent: "start_cpr_loop" },
        },
        {
          timestamp: "2026-01-01T00:00:30Z",
          category: "action",
          stage: "S9_HANDOVER",
          payload: { intent: "generate_practice_debrief" },
        },
      ],
    },
    practiceState({ updatedAt: "2025-12-31T23:59:00Z" }),
  );

  assert.equal(result.json.ended_at, "2026-01-01T00:00:30Z");
  assert.equal(result.json.duration_seconds, 30);
  assert.ok(result.json.stage_timeline.every((item) => item.duration_seconds >= 0));
});

test("纠错事件被正确统计", () => {
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00Z",
      category: "action",
      stage: "S7_CPR_LOOP",
      payload: { intent: "correct_hand_position", log_event: { detail: "hand_position_left_offset" } },
    },
    {
      timestamp: "2026-01-01T00:00:05Z",
      category: "action",
      stage: "S7_CPR_LOOP",
      payload: { intent: "correct_compression_rate", log_event: { detail: "compression_rate_low" } },
    },
  ];

  const result = generatePracticeDebrief(entries, practiceState());

  assert.equal(result.json.cpr_summary.correction_count, 2);
  assert.equal(result.json.cpr_summary.correction_breakdown.hand_position, 1);
  assert.equal(result.json.cpr_summary.correction_breakdown.rate, 1);
  assert.equal(result.json.cpr_summary.correction_breakdown.arm, 0);
  assert.ok(result.json.coaching.improvements.some((item) => item.includes("手位偏移 1 次")));
});

test("CPR 质量趋势被收集，平均频率可从趋势推出", () => {
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00Z",
      category: "event",
      stage: "S7_CPR_LOOP",
      payload: { raw_event: { cpr_quality: { compression_rate: 90, quality_score: 40 } } },
    },
    {
      timestamp: "2026-01-01T00:00:30Z",
      category: "event",
      stage: "S7_CPR_LOOP",
      payload: { raw_event: { cpr_quality: { compression_rate: 110, quality_score: 75 } } },
    },
  ];

  const result = generatePracticeDebrief(entries, practiceState());

  assert.equal(result.json.cpr_summary.quality_trend.length, 2);
  assert.equal(result.json.cpr_summary.quality_trend[1].score, 75);
  assert.equal(result.json.cpr_summary.average_rate, 100);
});

test("中断事件计入统计并产出改进项", () => {
  const entries = [
    {
      timestamp: "2026-01-01T00:00:10Z",
      category: "event",
      stage: "S7_CPR_LOOP",
      payload: { raw_event: { cpr_quality: { interruption_seconds: 8 } } },
    },
  ];

  const result = generatePracticeDebrief(entries, practiceState());

  assert.equal(result.json.cpr_summary.interruption_count, 1);
  assert.ok(result.json.coaching.improvements.some((item) => item.includes("按压中断 1 次")));
});

test("低频产生对应教练反馈", () => {
  const result = generatePracticeDebrief(
    [],
    practiceState({ overrides: { cpr_state: { average_rate: 85, quality_score: 50 } } }),
  );

  assert.ok(result.json.coaching.improvements.some((item) => item.includes("偏慢")));
  assert.ok(result.json.coaching.improvements.some((item) => item.includes("注意手位和频率")));
});

test("高频产生对应教练反馈", () => {
  const result = generatePracticeDebrief(
    [],
    practiceState({ overrides: { cpr_state: { average_rate: 135 } } }),
  );

  assert.ok(result.json.coaching.improvements.some((item) => item.includes("偏快")));
});

test("频率在目标范围内产生正面反馈", () => {
  const result = generatePracticeDebrief(
    [],
    practiceState({ overrides: { cpr_state: { average_rate: 110, quality_score: 85 } } }),
  );

  assert.ok(result.json.coaching.strengths.some((item) => item.includes("目标范围")));
  assert.ok(result.json.coaching.strengths.some((item) => item.includes("表现良好")));
});

test("提醒里始终包含实际急救必须拨打 120", () => {
  const result = generatePracticeDebrief([], practiceState());

  assert.ok(result.json.coaching.reminders.some((item) => item.includes("120")));
  assert.match(result.text, /拨打 120 是必须操作/);
});

test("走完 S7 + S9 且表现良好时给出优秀总评", () => {
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00Z",
      category: "action",
      stage: "S7_CPR_LOOP",
      payload: { intent: "start_cpr_loop" },
    },
    {
      timestamp: "2026-01-01T00:00:40Z",
      category: "action",
      stage: "S9_HANDOVER",
      payload: { intent: "generate_practice_debrief" },
    },
  ];

  const result = generatePracticeDebrief(
    entries,
    practiceState({
      overrides: { cpr_state: { average_rate: 110, quality_score: 90 } },
      updatedAt: "2026-01-01T00:01:00Z",
    }),
  );

  assert.equal(result.json.coaching.overall_assessment, "整体表现优秀，保持这个水平。");
  assert.ok(result.json.coaching.strengths.some((item) => item.includes("完整走完")));
});

test("复盘输出是确定性的：相同输入产出相同报告", () => {
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00Z",
      category: "action",
      stage: "S7_CPR_LOOP",
      payload: { intent: "correct_arm_posture" },
    },
  ];
  const state = practiceState({
    sessionId: "sess_fixed",
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:02:00Z",
    overrides: { cpr_state: { average_rate: 118, quality_score: 82 } },
  });

  const first = generatePracticeDebrief(entries, state);
  const second = generatePracticeDebrief(entries, state);

  assert.deepEqual(first.json, second.json);
  assert.equal(first.text, second.text);
});

test("文本报告包含各个小节标题", () => {
  const result = generatePracticeDebrief([], practiceState());

  for (const heading of ["演练复盘", "流程回顾", "CPR 表现", "做得好的", "可以改进的", "提醒"]) {
    assert.ok(result.text.includes(heading), `缺少小节：${heading}`);
  }
});

// ── 状态机 S9 practice 分支 ──

test("practice 模式 S9 生成复盘请求 action（不触发 generate_handover_report）", () => {
  const state = practiceState({
    currentStage: AgentStage.S9_HANDOVER,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  const action = runStateMachine(state);

  assert.equal(action.intent, "generate_practice_debrief");
  const toolTypes = (action.tool_actions ?? []).map((tool) => tool.type);
  assert.ok(toolTypes.includes("generate_practice_debrief"));
  assert.ok(toolTypes.includes("stop_haptic_metronome"));
  assert.ok(!toolTypes.includes("generate_handover_report"));
});

test("practice 模式 S9 工具回传后展示复盘", () => {
  const state = practiceState({
    currentStage: AgentStage.S9_HANDOVER,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });
  const event = { event_type: "tool_result", metadata: { handover_report_generated: true } };

  const action = runStateMachine(state, event);

  assert.equal(action.intent, "show_practice_debrief");
  assert.match(action.tts.text, /演练/);
  assert.deepEqual(action.tool_actions, []);
});

test("practice 模式 S9 两个 action 都通过安全校验", () => {
  const state = practiceState({
    currentStage: AgentStage.S9_HANDOVER,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  const request = validateAction(runStateMachine(state), state);
  const display = validateAction(
    runStateMachine(state, { event_type: "tool_result", metadata: { handover_report_generated: true } }),
    state,
  );

  assert.equal(request.ok, true, request.violations?.join(","));
  assert.equal(display.ok, true, display.violations?.join(","));
});

test("emergency 模式 S9 仍走交接报告流程（不受 M2 影响）", () => {
  const state = createInitialSessionState({
    currentStage: AgentStage.S9_HANDOVER,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  const action = runStateMachine(state);

  assert.equal(action.intent, "generate_handover_report");
  assert.ok((action.tool_actions ?? []).some((tool) => tool.type === "generate_handover_report"));
});

test("emergency 模式 S9 工具回传后仍是 explain_handover", () => {
  const state = createInitialSessionState({
    currentStage: AgentStage.S9_HANDOVER,
    adultLikely: true,
    overrides: cprReadyFacts(),
  });

  const action = runStateMachine(state, {
    event_type: "tool_result",
    metadata: { handover_report_generated: true },
  });

  assert.equal(action.intent, "explain_handover");
});

// ── reducer：复盘工具回传 ──

test("generate_practice_debrief 工具回传标记 handover_generated", () => {
  const state = practiceState({ currentStage: AgentStage.S9_HANDOVER });

  const next = reduceSession(state, {
    event_type: "tool_result",
    timestamp: "2026-01-01T00:03:00Z",
    tool_result: { type: "generate_practice_debrief", status: "ok" },
  });

  assert.equal(next.tool_state.handover_generated, true);
});

test("generate_practice_debrief 失败回传不标记 handover_generated", () => {
  const state = practiceState({ currentStage: AgentStage.S9_HANDOVER });

  const next = reduceSession(state, {
    event_type: "tool_result",
    timestamp: "2026-01-01T00:03:00Z",
    tool_result: { type: "generate_practice_debrief", status: "failed" },
  });

  assert.equal(next.tool_state.handover_generated, false);
});
