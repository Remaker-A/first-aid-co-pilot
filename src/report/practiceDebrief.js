// 演练复盘报告生成器（M2）。
//
// 与 handoverReportGenerator 的分工：交接报告面向急救员，输出医学摘要；本文件面向
// 学习者，输出教学反馈（流程时间线、质量趋势、教练评价）。只在 session_mode
// === "practice" 的会话里被状态机 S9 调用。
//
// 教练反馈是纯规则、确定性的：相同输入必然产出相同输出，不经过 Gemma，便于审核。

const RATE_TARGET_MIN = 100;
const RATE_TARGET_MAX = 120;
const FAST_CPR_START_SECONDS = 60;
const GOOD_QUALITY_SCORE = 80;
const WEAK_QUALITY_SCORE = 60;

const CORRECTION_INTENTS = Object.freeze([
  "correct_hand_position",
  "correct_compression_rate",
  "correct_arm_posture",
  "correct_compression_interruption"
]);

export function generatePracticeDebrief(logInput = {}, state = {}) {
  const entries = normalizeEntries(logInput);
  const json = generateDebriefJson(entries, state);
  const text = generateDebriefText(json);

  return { text, json };
}

export function generateDebriefJson(entries = [], state = {}) {
  const cprState = state.cpr_state ?? {};
  const startedAt = findSessionStart(entries) ?? state.started_at ?? null;
  const endedAt = state.updated_at ?? new Date().toISOString();
  const stageTimeline = buildStageTimeline(entries, startedAt, endedAt);
  const corrections = collectCorrections(entries);
  const interruptions = collectInterruptions(entries);
  const qualityTrend = collectQualityTrend(entries);
  const cprStartTime = findCprStartTime(entries, state);
  const assessmentStartTime = findAssessmentStartTime(entries);

  return {
    schema: "practice_debrief_v1",
    session_id: state.session_id ?? inferSessionId(entries) ?? "sess_unknown",
    session_mode: "practice",
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: calcDurationSeconds(startedAt, endedAt),
    time_to_cpr_seconds: calcDurationSeconds(assessmentStartTime, cprStartTime),
    stage_timeline: stageTimeline,
    cpr_summary: {
      total_compressions: cprState.total_compressions ?? estimateCompressions(entries),
      average_rate: cprState.average_rate ?? averageNumber(qualityTrend.map((sample) => sample.rate)),
      final_quality_score: cprState.quality_score ?? null,
      quality_trend: qualityTrend,
      interruption_count: interruptions.length,
      correction_count: corrections.length,
      correction_breakdown: countCorrectionTypes(corrections)
    },
    coaching: buildCoaching(stageTimeline, corrections, interruptions, qualityTrend, cprState)
  };
}

export function generateDebriefText(report = {}) {
  const lines = [];
  lines.push("演练复盘");
  lines.push("════════");

  if (report.duration_seconds != null) {
    lines.push(`总时长：${formatDuration(report.duration_seconds)}`);
  }
  if (report.time_to_cpr_seconds != null) {
    lines.push(`从评估到开始按压：${formatDuration(report.time_to_cpr_seconds)}`);
  }

  lines.push("");
  lines.push("流程回顾");
  const timeline = report.stage_timeline ?? [];
  if (timeline.length === 0) {
    lines.push("  未记录");
  }
  for (const item of timeline) {
    lines.push(`  ${item.stage} — ${formatDuration(item.duration_seconds ?? 0)}`);
  }

  lines.push("");
  lines.push("CPR 表现");
  const cpr = report.cpr_summary ?? {};
  lines.push(`  累计按压：${cpr.total_compressions ?? "未记录"} 次`);
  lines.push(`  平均频率：${cpr.average_rate ?? "未记录"} 次/分（目标 ${RATE_TARGET_MIN}-${RATE_TARGET_MAX}）`);
  lines.push(`  最终质量分：${cpr.final_quality_score ?? "未记录"}/100`);
  lines.push(`  中断次数：${cpr.interruption_count ?? 0}`);
  const breakdown = cpr.correction_breakdown ?? {};
  lines.push(
    `  纠错：手位 ${breakdown.hand_position ?? 0} 次、频率 ${breakdown.rate ?? 0} 次、` +
      `手臂 ${breakdown.arm ?? 0} 次、中断 ${breakdown.interruption ?? 0} 次`
  );

  lines.push("");
  lines.push("做得好的");
  const strengths = report.coaching?.strengths ?? [];
  if (strengths.length === 0) {
    lines.push("  暂无");
  }
  for (const item of strengths) {
    lines.push(`  • ${item}`);
  }

  lines.push("");
  lines.push("可以改进的");
  const improvements = report.coaching?.improvements ?? [];
  if (improvements.length === 0) {
    lines.push("  暂无");
  }
  for (const item of improvements) {
    lines.push(`  • ${item}`);
  }

  lines.push("");
  lines.push("提醒");
  for (const item of report.coaching?.reminders ?? []) {
    lines.push(`  ⚠ ${item}`);
  }

  lines.push("");
  lines.push(report.coaching?.overall_assessment ?? "");

  return lines.join("\n");
}

// SessionLog.toJSON() 传 { entries }，直接传 entries 数组也接受。state.handover_timeline
// 的条目形状是 { time, type, detail }（没有 category/payload），这里补一个 timestamp
// 别名，让时长统计在只有 timeline 的降级场景下仍然可用。
function normalizeEntries(logInput) {
  const raw = Array.isArray(logInput)
    ? logInput
    : Array.isArray(logInput?.entries)
      ? logInput.entries
      : [];

  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return {};
    }
    if (entry.timestamp || !entry.time) {
      return entry;
    }
    return { ...entry, timestamp: entry.time };
  });
}

function inferSessionId(entries) {
  return entries.find((entry) => entry.session_id)?.session_id ?? null;
}

function findSessionStart(entries) {
  return entries.find((entry) => entry.timestamp)?.timestamp ?? null;
}

// 阶段时间线：把连续同阶段的条目折叠成一段，记录进入时间、停留时长、距开场秒数。
function buildStageTimeline(entries, startedAt, endedAt) {
  const staged = entries
    .filter((entry) => entry.category === "action" && entry.stage && entry.timestamp)
    .sort((left, right) => compareTime(left.timestamp, right.timestamp));

  const segments = [];
  for (const entry of staged) {
    const last = segments.at(-1);
    if (last && last.stage === entry.stage) {
      continue;
    }
    segments.push({ stage: entry.stage, entered_at: entry.timestamp });
  }

  return segments.map((segment, index) => {
    const nextEnteredAt = segments[index + 1]?.entered_at ?? endedAt;
    return {
      stage: segment.stage,
      entered_at: segment.entered_at,
      duration_seconds: calcDurationSeconds(segment.entered_at, nextEnteredAt),
      time_from_start_seconds: calcDurationSeconds(startedAt, segment.entered_at)
    };
  });
}

// 纠错收集：沿用 handoverReportGenerator 的判定口径（correction. / correct_ 前缀 +
// 显式清单），同时兼容 SessionLog action 条目把 intent 放在 payload 顶层的写法。
function collectCorrections(entries) {
  const corrections = [];
  for (const entry of entries) {
    const payload = entry.payload ?? {};
    const action = payload.action ?? {};
    const logEvent = payload.raw_log_event ?? payload.log_event ?? {};
    const intent = payload.intent || action.intent || logEvent.type || "";

    if (
      intent.startsWith("correction.") ||
      intent.startsWith("correct_") ||
      CORRECTION_INTENTS.includes(intent)
    ) {
      corrections.push({
        time: entry.timestamp ?? null,
        type: intent,
        detail: action.log_event?.detail || payload.log_event?.detail || logEvent.detail || intent
      });
    }
  }

  return corrections;
}

function collectInterruptions(entries) {
  const interruptions = [];
  for (const entry of entries) {
    const payload = entry.payload ?? {};
    const cpr = payload.raw_event?.cpr_quality;
    const logEvent = payload.raw_log_event ?? payload.log_event ?? {};
    const seconds = numberOrNull(cpr?.interruption_seconds);

    if (seconds && seconds > 0) {
      interruptions.push({ time: entry.timestamp ?? null, seconds, detail: "cpr_interruption" });
    }

    if (logEvent.type === "correction.interruption" || logEvent.detail === "interruption") {
      interruptions.push({
        time: entry.timestamp ?? null,
        seconds: null,
        detail: logEvent.detail || logEvent.type
      });
    }
  }

  return interruptions;
}

function collectQualityTrend(entries) {
  const trend = [];
  for (const entry of entries) {
    const cpr = entry.payload?.raw_event?.cpr_quality;
    if (!cpr) {
      continue;
    }

    trend.push({
      time: entry.timestamp ?? null,
      rate: numberOrNull(cpr.compression_rate ?? cpr.compression_rate_bpm),
      score: numberOrNull(cpr.quality_score)
    });
  }

  return trend;
}

function findAssessmentStartTime(entries) {
  return findEntryTime(entries, (entry) =>
    matchesIntent(entry, [
      "ask_response_check",
      "ensure_scene_safe",
      "check_response",
      "patient_unresponsive"
    ])
  );
}

function findCprStartTime(entries, state) {
  if (state.cpr_state?.started_at) {
    return state.cpr_state.started_at;
  }

  return findEntryTime(entries, (entry) =>
    matchesIntent(entry, [
      "start_cpr_loop",
      "cpr_started",
      "start_cpr_guidance",
      "start_emergency_call_and_cpr"
    ])
  );
}

function matchesIntent(entry, wanted) {
  const payload = entry.payload ?? {};
  const logEvent = payload.raw_log_event ?? payload.log_event ?? {};
  return [
    payload.intent,
    payload.action?.intent,
    payload.raw_event?.user_input?.intent,
    logEvent.type,
    logEvent.detail
  ].some((value) => wanted.includes(value));
}

function findEntryTime(entries, predicate) {
  return entries.find(predicate)?.timestamp ?? null;
}

function countCorrectionTypes(corrections) {
  const breakdown = { hand_position: 0, rate: 0, arm: 0, interruption: 0 };

  for (const correction of corrections) {
    const type = String(correction.type ?? "");
    if (type.includes("hand_position")) {
      breakdown.hand_position += 1;
    } else if (type.includes("rate")) {
      breakdown.rate += 1;
    } else if (type.includes("arm")) {
      breakdown.arm += 1;
    } else if (type.includes("interruption")) {
      breakdown.interruption += 1;
    }
  }

  return breakdown;
}

function buildCoaching(stageTimeline, corrections, interruptions, qualityTrend, cprState) {
  const strengths = [];
  const improvements = [];
  const reminders = [
    "实际急救中，拨打 120 是必须操作，不能跳过。",
    "实际急救中，尽量让 120 调度员在线指导你。"
  ];

  const stagesPassed = stageTimeline.map((segment) => segment.stage);
  if (stagesPassed.includes("S7_CPR_LOOP") && stagesPassed.includes("S9_HANDOVER")) {
    strengths.push("完整走完了从评估到按压再到交接的流程。");
  }

  const cprStartEntry = stageTimeline.find((segment) => segment.stage === "S7_CPR_LOOP");
  if (cprStartEntry && cprStartEntry.time_from_start_seconds !== null) {
    if (cprStartEntry.time_from_start_seconds <= FAST_CPR_START_SECONDS) {
      strengths.push(`从发现到开始按压仅 ${cprStartEntry.time_from_start_seconds} 秒，反应迅速。`);
    } else {
      improvements.push(`从发现到开始按压花了 ${cprStartEntry.time_from_start_seconds} 秒，可以更快。`);
    }
  }

  const finalScore = cprState.quality_score;
  if (typeof finalScore === "number" && finalScore >= GOOD_QUALITY_SCORE) {
    strengths.push(`按压质量分 ${finalScore}/100，表现良好。`);
  } else if (typeof finalScore === "number" && finalScore < WEAK_QUALITY_SCORE) {
    improvements.push(`按压质量分 ${finalScore}/100，注意手位和频率。`);
  }

  if (interruptions.length === 0) {
    strengths.push("按压过程中没有出现明显中断。");
  } else {
    improvements.push(`按压中断 ${interruptions.length} 次，尽量保持持续按压。`);
  }

  const breakdown = countCorrectionTypes(corrections);
  if (corrections.length === 0) {
    strengths.push("手位、频率、手臂姿态全程达标，未触发纠错。");
  } else {
    const parts = [];
    if (breakdown.hand_position > 0) parts.push(`手位偏移 ${breakdown.hand_position} 次`);
    if (breakdown.rate > 0) parts.push(`频率偏差 ${breakdown.rate} 次`);
    if (breakdown.arm > 0) parts.push(`手臂弯曲 ${breakdown.arm} 次`);
    if (breakdown.interruption > 0) parts.push(`中断纠错 ${breakdown.interruption} 次`);
    improvements.push(`纠错提示：${parts.join("、")}。下次注意。`);
  }

  const avgRate = cprState.average_rate ?? averageNumber(qualityTrend.map((sample) => sample.rate));
  if (typeof avgRate === "number") {
    if (avgRate >= RATE_TARGET_MIN && avgRate <= RATE_TARGET_MAX) {
      strengths.push(`平均频率 ${avgRate} 次/分，在目标范围 ${RATE_TARGET_MIN}-${RATE_TARGET_MAX} 内。`);
    } else if (avgRate < RATE_TARGET_MIN) {
      improvements.push(`平均频率 ${avgRate} 次/分，偏慢，目标 ${RATE_TARGET_MIN}-${RATE_TARGET_MAX}。`);
    } else {
      improvements.push(`平均频率 ${avgRate} 次/分，偏快，目标 ${RATE_TARGET_MIN}-${RATE_TARGET_MAX}。`);
    }
  }

  const overall =
    strengths.length >= 3 && improvements.length <= 1
      ? "整体表现优秀，保持这个水平。"
      : improvements.length >= 3
        ? "有进步空间，建议多练几次，重点关注纠错提示。"
        : "整体表现合格，注意改进项即可提升。";

  return { strengths, improvements, reminders, overall_assessment: overall };
}

function calcDurationSeconds(start, end) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  if (startMs === null || endMs === null) {
    return null;
  }

  return Math.round((endMs - startMs) / 1000);
}

function parseTime(value) {
  if (!value) {
    return null;
  }

  const ms = new Date(value).valueOf();
  return Number.isNaN(ms) ? null : ms;
}

function compareTime(left, right) {
  return (parseTime(left) ?? 0) - (parseTime(right) ?? 0);
}

function estimateCompressions(entries) {
  const latest = [...entries]
    .reverse()
    .find((entry) => typeof entry.payload?.raw_event?.cpr_quality?.total_compressions === "number");

  return latest?.payload?.raw_event?.cpr_quality?.total_compressions ?? null;
}

function averageNumber(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) {
    return null;
  }

  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) {
    return "未记录";
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
}
