export function generateHandoverReport(logInput = {}, state = {}, options = {}) {
  const entries = normalizeEntries(logInput);
  const json = generateHandoverJson(entries, state, options);
  const text = generateHandoverText(json);

  return {
    text,
    json
  };
}

export function generateHandoverJson(entries = [], state = {}, options = {}) {
  const facts = state.confirmed_facts || {};
  const cprState = state.cpr_state || {};
  const toolState = state.tool_state || {};
  const qualitySamples = collectQualitySamples(entries);
  const interruptions = collectInterruptions(entries);
  const corrections = collectCorrections(entries);
  const aedStatus = detectAedStatus(entries, state);
  const videoStatus = detectVideoStatus(toolState);

  return {
    schema: "firstaid_handover_report_v1",
    session_id: state.session_id || inferSessionId(entries) || "sess_unknown",
    patient_id: options.patientId || "anonymous",
    generated_at: options.generatedAt || new Date().toISOString(),
    initial_assessment_time: findInitialAssessmentTime(entries),
    cpr_started_at: findCprStartTime(entries, state),
    current_stage: state.current_stage || null,
    symptoms: {
      responsive: facts.responsive ?? null,
      normal_breathing: facts.normal_breathing ?? null,
      agonal_breathing: facts.agonal_breathing ?? null,
      suspected_cardiac_arrest: facts.suspected_cardiac_arrest ?? null,
      summary: buildSymptomSummary(facts)
    },
    cpr: {
      total_compressions: cprState.total_compressions ?? estimateCompressions(entries),
      current_rate: cprState.current_rate ?? null,
      average_rate: cprState.average_rate ?? averageNumber(qualitySamples.map((item) => item.rate)),
      quality_score: cprState.quality_score ?? averageNumber(qualitySamples.map((item) => item.score)),
      interruptions,
      corrections
    },
    aed: {
      status: aedStatus
    },
    rescuer: {
      fatigue_level: state.rescuer_state?.fatigue_level || inferLastRescuerFatigue(entries),
      emotion: state.rescuer_state?.emotion || inferLastRescuerEmotion(entries)
    },
    tools: {
      emergency_call_status: toolState.emergency_call_status || inferEmergencyCallStatus(entries),
      gps_attached: toolState.gps_attached ?? null,
      recording_status: toolState.recording_status || null,
      video_record: videoStatus
    },
    timeline: buildTimeline(entries)
  };
}

export function generateHandoverText(report = {}) {
  const lines = [
    "\u4ea4\u63a5\u62a5\u544a",
    `\u60a3\u8005ID\uff1a${report.patient_id === "anonymous" ? "\u533f\u540d" : report.patient_id}`,
    `\u4f1a\u8bddID\uff1a${report.session_id || "\u672a\u77e5"}`,
    `\u521d\u5224\u65f6\u95f4\uff1a${formatDisplayTime(report.initial_assessment_time)}`,
    `\u75c7\u72b6\uff1a${report.symptoms?.summary || "\u6682\u65e0\u5b8c\u6574\u5224\u65ad"}`,
    `CPR \u5f00\u59cb\uff1a${formatDisplayTime(report.cpr_started_at)}`,
    `\u7d2f\u8ba1\u6309\u538b\uff1a${formatCount(report.cpr?.total_compressions, "\u6b21")}`,
    `\u5e73\u5747\u9891\u7387\uff1a${formatRate(report.cpr?.average_rate)}`,
    `\u8d28\u91cf\u8bc4\u5206\uff1a${formatScore(report.cpr?.quality_score)}`,
    `\u4e2d\u65ad\u4e8b\u4ef6\uff1a${formatInterruptions(report.cpr?.interruptions || [])}`,
    `\u7ea0\u9519\u4e8b\u4ef6\uff1a${formatCorrections(report.cpr?.corrections || [])}`,
    `AED\uff1a${report.aed?.status || "\u672a\u77e5"}`,
    `\u65bd\u6551\u8005\u72b6\u6001\uff1a${formatRescuer(report.rescuer || {})}`,
    `\u89c6\u9891\u8bb0\u5f55\uff1a${report.tools?.video_record || "\u672a\u77e5"}`
  ];

  return lines.join("\n");
}

function normalizeEntries(logInput) {
  if (Array.isArray(logInput)) {
    return logInput;
  }

  if (Array.isArray(logInput.entries)) {
    return logInput.entries;
  }

  return [];
}

function inferSessionId(entries) {
  return entries.find((entry) => entry.session_id)?.session_id || null;
}

function findInitialAssessmentTime(entries) {
  return findEntryTime(entries, (entry) => {
    const event = entry.payload?.raw_event || {};
    const action = entry.payload?.action || {};
    const logEvent = entry.payload?.raw_log_event || {};
    return [
      event.user_input?.intent,
      event.event_type,
      action.intent,
      logEvent.type,
      logEvent.detail
    ].some((value) =>
      ["patient_unresponsive", "normal_breathing_absent", "state_suspected_arrest_handling"].includes(value)
    );
  });
}

function findCprStartTime(entries, state) {
  if (state.cpr_state?.started_at) {
    return state.cpr_state.started_at;
  }

  return findEntryTime(entries, (entry) => {
    const action = entry.payload?.action || {};
    const logEvent = entry.payload?.raw_log_event || {};
    return [
      action.intent,
      logEvent.type,
      logEvent.detail
    ].some((value) =>
      ["start_cpr_guidance", "start_cpr_loop", "start_emergency_call_and_cpr"].includes(value)
    );
  });
}

function findEntryTime(entries, predicate) {
  const match = entries.find(predicate);
  return match?.timestamp || null;
}

function buildSymptomSummary(facts = {}) {
  const parts = [];
  if (facts.responsive === false) {
    parts.push("\u65e0\u53cd\u5e94");
  } else if (facts.responsive === true) {
    parts.push("\u6709\u53cd\u5e94");
  }

  if (facts.normal_breathing === false) {
    parts.push("\u65e0\u6b63\u5e38\u547c\u5438");
  } else if (facts.normal_breathing === true) {
    parts.push("\u6709\u6b63\u5e38\u547c\u5438");
  } else {
    parts.push("\u547c\u5438\u4e0d\u786e\u5b9a");
  }

  if (facts.agonal_breathing === true) {
    parts.push("\u53ef\u80fd\u5598\u606f\u6837\u547c\u5438");
  }

  if (facts.suspected_cardiac_arrest === true) {
    parts.push("\u6309\u7591\u4f3c\u5fc3\u810f\u9aa4\u505c\u5904\u7406");
  }

  return parts.length > 0 ? parts.join("\uff0c") : "\u6682\u65e0\u5b8c\u6574\u5224\u65ad";
}

function collectQualitySamples(entries) {
  const samples = [];
  for (const entry of entries) {
    const cpr = entry.payload?.raw_event?.cpr_quality;
    if (!cpr) {
      continue;
    }

    samples.push({
      time: entry.timestamp,
      rate: numberOrNull(cpr.compression_rate ?? cpr.compression_rate_bpm),
      score: numberOrNull(cpr.quality_score)
    });
  }

  return samples;
}

function collectInterruptions(entries) {
  const interruptions = [];
  for (const entry of entries) {
    const cpr = entry.payload?.raw_event?.cpr_quality;
    const logEvent = entry.payload?.raw_log_event;
    const seconds = numberOrNull(cpr?.interruption_seconds);

    if (seconds && seconds > 0) {
      interruptions.push({
        time: entry.timestamp,
        seconds,
        detail: "cpr_interruption"
      });
    }

    if (logEvent?.type === "correction.interruption" || logEvent?.detail === "interruption") {
      interruptions.push({
        time: entry.timestamp,
        seconds: null,
        detail: logEvent.detail || logEvent.type
      });
    }
  }

  return interruptions;
}

function collectCorrections(entries) {
  const corrections = [];
  for (const entry of entries) {
    const action = entry.payload?.action;
    const logEvent = entry.payload?.raw_log_event;
    const intent = action?.intent || logEvent?.type || "";

    if (
      intent.startsWith("correction.") ||
      intent.startsWith("correct_") ||
      [
        "correct_hand_position",
        "correct_compression_rate",
        "correct_arm_posture",
        "correct_compression_interruption"
      ].includes(intent)
    ) {
      corrections.push({
        time: entry.timestamp,
        type: intent,
        detail: action?.log_event?.detail || logEvent?.detail || intent
      });
    }
  }

  return corrections;
}

function detectAedStatus(entries, state) {
  if (state.tool_state?.aed_status) {
    return state.tool_state.aed_status;
  }

  const aedEntry = entries.find((entry) => {
    const raw = entry.payload?.raw_event || {};
    const intent = raw.user_input?.intent || raw.event_type || "";
    return intent.toLowerCase().includes("aed");
  });

  return aedEntry ? "\u73b0\u573a\u6709 AED \u4e8b\u4ef6" : "\u672a\u77e5";
}

function detectVideoStatus(toolState = {}) {
  if (toolState.video_shared === true) {
    return "\u5df2\u83b7\u7528\u6237\u786e\u8ba4\u5e76\u5206\u4eab";
  }

  if (toolState.recording_status === "recording" || toolState.recording_status === "saved") {
    return "\u5df2\u672c\u5730\u4fdd\u5b58\uff0c\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u5206\u4eab";
  }

  return "\u672a\u77e5";
}

function inferLastRescuerFatigue(entries) {
  return inferLastRescuerField(entries, "fatigue_level");
}

function inferLastRescuerEmotion(entries) {
  return inferLastRescuerField(entries, "emotion");
}

function inferLastRescuerField(entries, field) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const value = entries[index].payload?.raw_event?.rescuer_state?.[field];
    if (value) {
      return value;
    }
  }
  return null;
}

function inferEmergencyCallStatus(entries) {
  const action = entries.find((entry) => {
    const action = entry.payload?.action ?? {};
    const tool = action.tool_actions ?? action.tool_action;
    const tools = Array.isArray(tool) ? tool : tool ? [tool] : [];
    return tools.some((item) => ["emergency_call", "mock_emergency_call"].includes(item.type));
  });

  return action ? "started" : null;
}

function buildTimeline(entries) {
  return entries
    .filter((entry) => ["event", "action", "log_event"].includes(entry.category))
    .map((entry) => ({
      time: entry.timestamp,
      category: entry.category,
      stage: entry.stage,
      type:
        entry.payload?.event_type ||
        entry.payload?.intent ||
        entry.payload?.type ||
        entry.payload?.raw_log_event?.type ||
        null,
      detail:
        entry.payload?.detail ||
        entry.payload?.raw_log_event?.detail ||
        entry.payload?.action?.log_event?.detail ||
        null
    }));
}

function estimateCompressions(entries) {
  const latest = [...entries].reverse().find((entry) => {
    const value = entry.payload?.raw_event?.cpr_quality?.total_compressions;
    return typeof value === "number";
  });

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

function formatDisplayTime(value) {
  if (!value) {
    return "\u672a\u8bb0\u5f55";
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }

  return date.toISOString().slice(11, 19);
}

function formatCount(value, unit) {
  return typeof value === "number" ? `${value} ${unit}` : "\u672a\u8bb0\u5f55";
}

function formatRate(value) {
  return typeof value === "number" ? `${value}/min` : "\u672a\u8bb0\u5f55";
}

function formatScore(value) {
  return typeof value === "number" ? `${value}/100` : "\u672a\u8bb0\u5f55";
}

function formatInterruptions(interruptions) {
  if (interruptions.length === 0) {
    return "\u672a\u8bb0\u5f55";
  }

  return interruptions
    .map((item) => {
      const seconds = item.seconds ? ` ${item.seconds} \u79d2` : "";
      return `${formatDisplayTime(item.time)}${seconds}`;
    })
    .join("\uff1b");
}

function formatCorrections(corrections) {
  if (corrections.length === 0) {
    return "\u672a\u8bb0\u5f55";
  }

  return corrections
    .map((item) => `${formatDisplayTime(item.time)} ${item.detail}`)
    .join("\uff1b");
}

function formatRescuer(rescuer) {
  const parts = [];
  if (rescuer.emotion) {
    parts.push(rescuer.emotion);
  }
  if (rescuer.fatigue_level) {
    parts.push(rescuer.fatigue_level);
  }

  return parts.length > 0 ? parts.join("\uff0c") : "\u672a\u8bb0\u5f55";
}
