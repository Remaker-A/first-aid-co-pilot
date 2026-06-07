import { AgentStage } from "../domain/stages.js";
import { createGuidanceAction } from "../domain/actionFactories.js";
import { CprStartDecision, decideCprStart, getCprStartReasonCodes } from "./cprStartRule.js";
import { isActionableCprQualityEvent } from "./cprEventGuards.js";
import { createRuleFeedbackAction } from "./ruleFeedbackEngine.js";
import { generateCallBrief } from "../report/callBrief.js";

// Opening line kept verbatim so existing "我将为你拨打 120 / 免提 / 胸外按压" TTS
// substring assertions stay green; the 120 briefing script is appended after it.
const S5_CALL_OPENING_TTS = "我将为你拨打 120，请保持手机免提。现在准备胸外按压。";
const S5_CALL_BRIEFING_PREFIX = "向 120 播报：";

export function advanceStateMachine(state = {}, event = null) {
  const currentStage = state.current_stage ?? AgentStage.S0_INIT;
  const decision = decideCprStart(state);
  const nextStage = getNextStage(state, event, decision);

  if (currentStage === AgentStage.S7_CPR_LOOP && nextStage === AgentStage.S7_CPR_LOOP) {
    const feedbackAction = createRuleFeedbackAction(state, event);
    if (feedbackAction) {
      return { current_stage: currentStage, next_stage: nextStage, decision, action: feedbackAction };
    }
  }

  return {
    current_stage: currentStage,
    next_stage: nextStage,
    decision,
    action: buildStateAction(state, currentStage, nextStage, decision, event),
  };
}

export function runStateMachine(state = {}, event = null) {
  return advanceStateMachine(state, event).action;
}

export const stateMachine = runStateMachine;
export const getStateMachineAction = runStateMachine;

export function getNextStage(state = {}, event = null, decision = decideCprStart(state)) {
  const currentStage = state.current_stage ?? AgentStage.S0_INIT;
  const facts = state.confirmed_facts ?? {};
  const scope = state.scope ?? {};
  const toolState = state.tool_state ?? {};

  if (isHandoverRequested(event)) return AgentStage.S9_HANDOVER;
  if (decision === CprStartDecision.RECHECK_ON_CONFLICT) return currentStage;
  if (decision === CprStartDecision.OUT_OF_SCOPE) return currentStage;

  switch (currentStage) {
    case AgentStage.S0_INIT:
      return AgentStage.S1_SCENE_SAFE;
    case AgentStage.S1_SCENE_SAFE:
      if (scope.scene_safe === true || event?.metadata?.scene_safe === true) {
        return AgentStage.S2_CHECK_RESPONSE;
      }
      return AgentStage.S1_SCENE_SAFE;
    case AgentStage.S2_CHECK_RESPONSE:
      if (facts.responsive === true) return AgentStage.MONITOR_RESPONSE;
      if (facts.responsive === false) return AgentStage.S3_CHECK_BREATHING;
      return AgentStage.S2_CHECK_RESPONSE;
    case AgentStage.S3_CHECK_BREATHING:
      if (facts.normal_breathing === true) return AgentStage.MONITOR_BREATHING;
      if (hasBreathingObservation(facts) && decision === CprStartDecision.START_CPR) {
        return AgentStage.S4_SUSPECTED_ARREST;
      }
      return AgentStage.S3_CHECK_BREATHING;
    case AgentStage.S4_SUSPECTED_ARREST:
      return decision === CprStartDecision.START_CPR
        ? AgentStage.S5_CALL_EMERGENCY
        : currentStage;
    case AgentStage.S5_CALL_EMERGENCY:
      return isEmergencyCallStarted(toolState, event) ? AgentStage.S6_CPR_READY : currentStage;
    case AgentStage.S6_CPR_READY:
      return state.cpr_state?.started === true || isActionableCprQualityEvent(event)
        ? AgentStage.S7_CPR_LOOP
        : currentStage;
    case AgentStage.S7_CPR_LOOP:
      // Return of signs of life (ROSC): stop compressions and move to monitoring.
      // The actual decision stays deterministic and event-driven here.
      if (isSignsOfLifeEvent(event)) return AgentStage.MONITOR_BREATHING;
      return isAssistanceEvent(state, event) ? AgentStage.S8_ASSISTANCE : AgentStage.S7_CPR_LOOP;
    case AgentStage.S8_ASSISTANCE:
      return isActionableCprQualityEvent(event) || isAssistanceComplete(event)
        ? AgentStage.S7_CPR_LOOP
        : AgentStage.S8_ASSISTANCE;
    case AgentStage.MONITOR_RESPONSE:
    case AgentStage.MONITOR_BREATHING:
      // ROSC is reversible: a recovered patient can deteriorate again. Restart
      // is intentionally low-threshold ("易开难停") — compressions resuming,
      // "没有呼吸", "又没反应了", or an explicit restart re-enters the CPR loop.
      return isCprRestartEvent(state, event) ? AgentStage.S7_CPR_LOOP : currentStage;
    case AgentStage.S9_HANDOVER:
      return currentStage;
    default:
      return AgentStage.S0_INIT;
  }
}

function buildStateAction(state, currentStage, nextStage, decision, event) {
  if (decision === CprStartDecision.OUT_OF_SCOPE) {
    return action(state, {
      stage: currentStage,
      intent: "out_of_scope_adult_cpr",
      priority: "critical",
      reasonCodes: getCprStartReasonCodes(state),
      tts: { text: "本版本只支持成人 CPR 指导。请立即呼叫 120。", tone: "calm_firm" },
      ui: {
        mainText: "请呼叫 120",
        secondaryText: "当前不属于成人 CPR 指导范围",
        statusTags: ["超出范围", "呼叫120"],
      },
      toolActions: [emergencyCallTool()],
      logEvent: { type: "out_of_scope", detail: "adult_scope_not_confirmed" },
    });
  }

  if (decision === CprStartDecision.RECHECK_ON_CONFLICT) {
    return action(state, {
      stage: currentStage,
      intent: "recheck_conflicting_facts",
      priority: "high",
      reasonCodes: getCprStartReasonCodes(state),
      throttleKey: "stage.recheck_conflict",
      minIntervalMs: 3000,
      tts: { text: "请再确认，他是否有反应，是否有正常呼吸？", tone: "calm_firm" },
      ui: {
        mainText: "请复查",
        secondaryText: "确认反应和正常呼吸",
        statusTags: ["复查", "反应", "呼吸"],
      },
      logEvent: { type: "recheck_requested", detail: "conflicting_facts" },
    });
  }

  switch (nextStage) {
    case AgentStage.S1_SCENE_SAFE:
      const sceneSafeText = currentStage === AgentStage.S0_INIT || event?.event_type === "session_started"
        ? "开始录制，先确认周围安全；安全后靠近患者。"
        : "先确认周围安全，再靠近患者。";
      return action(state, {
        stage: nextStage,
        intent: state.scope?.scene_safe === false ? "warn_scene_unsafe" : "ensure_scene_safe",
        priority: state.scope?.scene_safe === false ? "critical" : "normal",
        reasonCodes: ["session_started"],
        tts: {
          text: state.scope?.scene_safe === false
            ? "先保证自身安全，请呼叫 120。"
            : sceneSafeText,
          tone: "calm_firm",
        },
        ui: {
          mainText: state.scope?.scene_safe === false ? "先保证安全" : "确认现场安全",
          secondaryText: state.scope?.scene_safe === false ? "不要进入危险区域" : "安全后靠近患者",
          statusTags: ["现场安全", "靠近患者"],
          primaryButton: { label: "现场安全", action: "mark_scene_safe" },
        },
        toolActions: state.scope?.scene_safe === false ? [emergencyCallTool()] : [],
        logEvent: { type: "scene_safety_check", detail: "ask_scene_safe" },
      });
    case AgentStage.S2_CHECK_RESPONSE:
      return action(state, {
        stage: nextStage,
        intent: "ask_response_check",
        priority: "normal",
        reasonCodes: ["scene_safe"],
        tts: { text: "请大声叫他，并轻拍双肩。", tone: "calm_firm" },
        ui: {
          mainText: "检查反应",
          secondaryText: "呼叫并轻拍双肩",
          statusTags: ["呼叫", "拍肩"],
          primaryButton: { label: "没有反应", action: "mark_unresponsive" },
        },
        logEvent: { type: "response_check_started", detail: "ask_response_check" },
      });
    case AgentStage.MONITOR_RESPONSE:
      return action(state, {
        stage: nextStage,
        intent: "monitor_responsive_patient",
        priority: "normal",
        reasonCodes: ["patient_responsive"],
        tts: { text: "他有反应，先不要做胸外按压。请呼叫 120 并持续观察。", tone: "calm_firm" },
        ui: {
          mainText: "持续观察",
          secondaryText: "呼叫 120，不做胸外按压",
          statusTags: ["有反应", "观察", "呼叫120"],
        },
        toolActions: [emergencyCallTool()],
        logEvent: { type: "monitor_response", detail: "patient_responsive" },
      });
    case AgentStage.S3_CHECK_BREATHING:
      return action(state, {
        stage: nextStage,
        intent: "ask_breathing_check",
        priority: "high",
        reasonCodes: ["unresponsive_or_uncertain"],
        tts: { text: "看他的胸口。只是偶尔大口喘，或者完全不动，都算没有呼吸。", tone: "calm_firm" },
        ui: {
          mainText: "检查呼吸",
          secondaryText: "偶尔大口喘或不动，都算没有呼吸",
          statusTags: ["看胸口", "没有呼吸"],
          primaryButton: { label: "无正常呼吸", action: "mark_no_normal_breathing" },
        },
        logEvent: { type: "breathing_check_started", detail: "ask_breathing_check" },
      });
    case AgentStage.MONITOR_BREATHING: {
      // Two ways in: the S3 breathing gate (patient never arrested) vs ROSC
      // re-entry from the CPR loop (signs of life returned). The ROSC wording
      // stops compressions, puts the patient in the recovery position, and keeps
      // the door open to restart if they deteriorate again.
      const roscReentry = currentStage === AgentStage.S7_CPR_LOOP;
      return action(state, {
        stage: nextStage,
        intent: roscReentry ? "monitor_after_rosc" : "monitor_breathing_patient",
        priority: "high",
        reasonCodes: roscReentry ? ["signs_of_life", "rosc_reentry"] : ["normal_breathing"],
        tts: {
          text: roscReentry
            ? "他有动静了，停止按压。把他翻成侧躺的复原姿势，盯着他的呼吸。他再没反应就立刻重新开始按压。"
            : "他有正常呼吸，先不要做胸外按压。请呼叫 120 并持续观察。",
          tone: "calm_firm",
        },
        ui: {
          mainText: roscReentry ? "停止按压 · 复原卧位" : "持续观察呼吸",
          secondaryText: roscReentry ? "盯住呼吸，再没反应立刻重新按压" : "呼叫 120，不做胸外按压",
          statusTags: roscReentry ? ["有生命迹象", "复原卧位", "随时可重启"] : ["正常呼吸", "观察", "呼叫120"],
        },
        toolActions: roscReentry ? [] : [emergencyCallTool()],
        logEvent: {
          type: roscReentry ? "monitor_after_rosc" : "monitor_breathing",
          detail: roscReentry ? "signs_of_life_reentry" : "normal_breathing",
        },
      });
    }
    case AgentStage.S4_SUSPECTED_ARREST:
      return action(state, {
        stage: nextStage,
        intent: "state_suspected_arrest_handling",
        priority: "critical",
        reasonCodes: getCprStartReasonCodes(state),
        throttleKey: "stage.suspected_arrest",
        tts: { text: "请按疑似心脏骤停处理。现在准备胸外按压。", tone: "calm_firm" },
        ui: {
          mainText: "疑似心脏骤停",
          secondaryText: "准备呼叫 120 和胸外按压",
          statusTags: ["无反应", "无正常呼吸", "CPR准备"],
        },
        visualOverlay: { mode: "prepare_cpr_position", highlight_target: "chest_center" },
        logEvent: { type: "suspected_cardiac_arrest", detail: "unresponsive_and_no_normal_breathing" },
      });
    case AgentStage.S5_CALL_EMERGENCY: {
      // Auto-dial briefing: generate the "location + GPS + symptoms + dispatch"
      // script and surface it three ways — spoken as the second TTS segment,
      // as the visible `call_brief` field, and inside the emergency_call tool's
      // briefing.script. state.location is populated by the reducer from
      // device_state.location / metadata.location (mock GPS in Live context).
      const callbackNumber =
        state.callback_number ?? state.callbackNumber ?? state.tool_state?.callback_number ?? null;
      const callBrief = generateCallBrief(state, { location: state.location, callbackNumber });
      const briefingScript = callBrief.script;
      const callTool = emergencyCallTool();
      callTool.briefing = { ...callTool.briefing, script: briefingScript };
      return action(state, {
        stage: nextStage,
        intent: "start_emergency_call_and_cpr",
        priority: "critical",
        reasonCodes: getCprStartReasonCodes(state),
        throttleKey: "stage.call_emergency",
        callBrief,
        tts: {
          // 只朗读面向施救者的开场句。完整“向 120 播报”词（地址/坐标/症状）保留在
          // call_brief 字段与 emergency_call 工具的 briefing.script 里，不再逐字朗读：
          // 否则坐标会被逐位念成 20 秒以上，听感像“慢放”，体验极差。
          text: S5_CALL_OPENING_TTS,
          tone: "calm_firm",
        },
        ui: {
          mainText: "正在呼叫 120",
          secondaryText: "保持免提，准备胸外按压",
          statusTags: ["呼叫120", "GPS", "录制"],
          primaryButton: { label: "已拨打120", action: "mark_emergency_called" },
        },
        visualOverlay: { mode: "prepare_cpr_position", highlight_target: "chest_center" },
        toolActions: [
          callTool,
          { type: "start_local_recording", requires_user_confirmation: false },
          { type: "attach_gps_location", requires_user_confirmation: false },
        ],
        logEvent: { type: "emergency_call_started", detail: "call_120_gps_recording" },
      });
    }
    case AgentStage.S6_CPR_READY: {
      // The single multimodal confirm gate. Wording = one positioning line +
      // "confirm to start" (decisive instruction, not "you decide"). The button
      // keeps action mark_cpr_ready; "说开始" hits the readiness fast path
      // (service.js) -> continue_cpr -> cpr_state.started -> S6→S7.
      const aedEvent = isAedEvent(event);
      const ttsText = aedEvent
        ? "AED 已经到了，可以先放在旁边准备；双手叠在他胸口中央，胳膊伸直。准备好就说“开始”，或点开始按压。"
        : "双手叠在他胸口中央，胳膊伸直。准备好就说“开始”，或点开始按压。";
      return action(state, {
        stage: nextStage,
        intent: "guide_cpr_position",
        priority: "critical",
        reasonCodes: aedEvent
          ? ["emergency_call_started", "aed_available", "prepare_cpr"]
          : ["emergency_call_started", "prepare_cpr"],
        tts: { text: ttsText, tone: "calm_firm" },
        ui: {
          mainText: aedEvent ? "AED 已到，准备按压" : "双手叠在胸口中央",
          secondaryText: aedEvent ? "先别停在 AED，上手开始 CPR" : "胳膊伸直，准备好就说“开始”",
          statusTags: aedEvent ? ["AED", "胸口中央", "开始按压"] : ["胸口中央", "胳膊伸直", "开始按压"],
          primaryButton: { label: "开始按压", action: "mark_cpr_ready" },
        },
        visualOverlay: { mode: "prepare_cpr_position", highlight_target: "chest_center" },
        logEvent: {
          type: "cpr_ready_guidance",
          detail: aedEvent ? "aed_arrived_prepare_cpr_confirm_to_start" : "hands_chest_center_arms_straight_confirm_to_start",
        },
      });
    }
    case AgentStage.S7_CPR_LOOP: {
      // "Start" wording fires both for the first S6→S7 entry and for a restart
      // from a MONITOR stage (ROSC reversed). Single-voice: the metronome is a
      // sound now, so wording says "跟着节拍" (never "震动"). The internal
      // haptic/start_haptic_metronome contract is intentionally preserved.
      const isCprStart =
        currentStage === AgentStage.S6_CPR_READY ||
        currentStage === AgentStage.MONITOR_BREATHING ||
        currentStage === AgentStage.MONITOR_RESPONSE;
      return action(state, {
        stage: nextStage,
        intent: isCprStart ? "start_cpr_loop" : "continue_cpr_loop",
        priority: isCprStart ? "critical" : "normal",
        reasonCodes: ["cpr_loop"],
        throttleKey: isCprStart ? "stage.cpr_loop" : "stage.continue_cpr",
        minIntervalMs: isCprStart ? 0 : 8000,
        tts: {
          text: isCprStart
            ? "现在开始按压，跟着节拍，用力快压。"
            : "继续保持这个节奏。",
          tone: "calm_firm",
        },
        ui: {
          mainText: isCprStart ? "开始按压" : "持续 CPR",
          secondaryText: "目标 100-120 次/分钟",
          statusTags: ["快速有力", "跟着节拍"],
          qualityScore: state.cpr_state?.quality_score ?? null,
        },
        haptic: { enabled: true, pattern: "metronome", bpm: 110 },
        visualOverlay: { mode: "cpr_loop", highlight_target: "chest_center" },
        toolActions: [{ type: "start_haptic_metronome", bpm: 110, requires_user_confirmation: false }],
        logEvent: { type: isCprStart ? "cpr_started" : "cpr_continued", detail: "cpr_loop" },
      });
    }
    case AgentStage.S8_ASSISTANCE: {
      const aedEvent = isAedEvent(event);
      const fatigueEvent = isFatigueEvent(event);
      const softAedAlias = isSoftAedAliasEvent(event);
      const intent = aedEvent ? "assist_aed" : fatigueEvent ? "assist_rescuer_fatigue" : "continue_cpr";
      const ttsText = aedEvent
        ? softAedAlias
          ? "如果这是 AED 或自动体外除颤器，打开它，跟着它的语音做；你先继续按压。分析或电击时所有人离开，结束后马上继续按压。"
          : "AED 到了，让旁人打开它并跟着语音做；你先继续按压。分析或电击时所有人离开，结束后马上继续按压。"
        : fatigueEvent
          ? "如果旁边有人，请准备换手。"
          : "继续按压，跟着节拍；AED 分析或电击时所有人离开。";
      return action(state, {
        stage: nextStage,
        intent,
        priority: "normal",
        reasonCodes: aedEvent
          ? [softAedAlias ? "aed_soft_alias_event" : "aed_event"]
          : fatigueEvent
            ? ["rescuer_fatigue"]
            : ["assistance_continue_cpr"],
        throttleKey: aedEvent ? "assistance.aed" : fatigueEvent ? "assistance.fatigue" : "assistance.continue_cpr",
        minIntervalMs: aedEvent || fatigueEvent ? 15000 : 3000,
        tts: {
          text: ttsText,
          tone: "calm_firm",
        },
        ui: {
          mainText: aedEvent ? (softAedAlias ? "疑似 AED 到达" : "AED 到达") : fatigueEvent ? "准备换手" : "继续按压",
          secondaryText: aedEvent
            ? "打开 AED，分析/电击时所有人离开"
            : fatigueEvent
              ? "继续胸外按压"
              : "跟着节拍，不要停",
          statusTags: aedEvent ? ["AED", "继续按压"] : fatigueEvent ? ["换手", "不要中断"] : ["继续按压", "AED"],
        },
        haptic: { enabled: true, pattern: "metronome", bpm: 110 },
        visualOverlay: { mode: aedEvent ? "aed_assistance" : fatigueEvent ? "rescuer_assistance" : "cpr_loop" },
        logEvent: {
          type: "assistance",
          detail: aedEvent ? "aed_event" : fatigueEvent ? "rescuer_fatigue" : "continue_cpr",
        },
      });
    }
    case AgentStage.S9_HANDOVER:
      if (isHandoverReportGenerated(event)) {
        return action(state, {
          stage: nextStage,
          intent: "explain_handover",
          priority: "normal",
          reasonCodes: ["handover_report_generated"],
          throttleKey: "stage.handover_ready",
          minIntervalMs: 0,
          tts: { text: "交接报告已生成，视频记录已本地保存。", tone: "calm_firm" },
          ui: {
            mainText: "报告已生成",
            secondaryText: "视频记录已本地保存，分享前需要你确认",
            statusTags: ["报告已生成", "本地保存"],
          },
          toolActions: [],
          logEvent: { type: "report_displayed", detail: "handover_report_and_local_video_ready" },
        });
      }

      return action(state, {
        stage: nextStage,
        intent: "generate_handover_report",
        priority: "critical",
        reasonCodes: ["handover_requested"],
        throttleKey: "stage.handover",
        tts: { text: "急救员到达，把位置让给他们，后面听他们的。我在生成交接报告。", tone: "calm_firm" },
        ui: {
          mainText: "交给急救员",
          secondaryText: "让位并听从急救员，生成交接报告",
          statusTags: ["交接报告", "听急救员"],
        },
        toolActions: [
          { type: "stop_haptic_metronome", requires_user_confirmation: false },
          { type: "generate_handover_report", requires_user_confirmation: false },
        ],
        logEvent: { type: "handover_requested", detail: "generate_handover_report" },
      });
    default:
      return action(state, {
        stage: nextStage,
        intent: "noop",
        priority: "low",
        reasonCodes: ["no_transition"],
        tts: { text: "", tone: "calm_soft" },
        ui: { mainText: "", secondaryText: "", statusTags: [] },
        logEvent: { type: "noop", detail: "no_transition" },
      });
  }
}

function action(state, overrides) {
  return createGuidanceAction({
    sessionId: state.session_id ?? null,
    timestamp: overrides.timestamp ?? state.updated_at,
    source: "state_machine",
    ttlMs: 5000,
    ...overrides,
  });
}

function hasBreathingObservation(facts) {
  return (
    facts.breathing_source != null ||
    facts.normal_breathing !== null ||
    facts.agonal_breathing === true
  );
}

function isEmergencyCallStarted(toolState, event) {
  return (
    toolState.emergency_call_status === "started" ||
    toolState.emergency_call_status === "connected" ||
    event?.device_state?.emergency_call_started === true ||
    event?.user_input?.intent === "emergency_called"
  );
}

function isAssistanceEvent(state, event) {
  return isFatigueEvent(event) || isAedEvent(event);
}

function isFatigueEvent(event) {
  const fatigue = event?.rescuer_state?.fatigue_level;
  return fatigue === "high" || fatigue === "exhausted";
}

function isAssistanceComplete(event) {
  return (
    event?.event_type === "assistance_completed" ||
    event?.user_input?.intent === "assistance_completed" ||
    event?.user_input?.intent === "continue_cpr"
  );
}

// Return of spontaneous circulation / signs of life while compressing: the
// patient moved, woke, started breathing again, etc. Recognized both via the
// dedicated signs_of_life / patient_recovered intents (stt.js) and via the
// existing responsive / normal-breathing intents, so any "他动了/他醒了/又有呼吸了"
// utterance during S7 stops compressions and moves to monitoring.
function isSignsOfLifeEvent(event) {
  const intent = event?.user_input?.intent;
  return (
    intent === "signs_of_life" ||
    intent === "patient_recovered" ||
    intent === "patient_responsive" ||
    intent === "responsive" ||
    intent === "normal_breathing" ||
    intent === "normal_breathing_present" ||
    event?.metadata?.signs_of_life === true ||
    event?.patient_state?.signs_of_life === true
  );
}

// Re-enter the CPR loop from a MONITOR stage. Kept low-threshold on purpose: any
// resumed compressions, a re-confirmed "no normal breathing", a fresh
// "unresponsive", or an explicit continue/restart signal restarts CPR.
function isCprRestartEvent(state, event) {
  const intent = event?.user_input?.intent;
  if (
    intent === "continue_cpr" ||
    intent === "no_normal_breathing" ||
    intent === "breathing_absent" ||
    intent === "agonal_breathing" ||
    intent === "patient_unresponsive" ||
    intent === "unresponsive" ||
    intent === "compressions_reported"
  ) {
    return true;
  }
  if (event?.metadata?.cpr_restart === true) {
    return true;
  }
  return isActionableCprQualityEvent(event);
}

function isAedEvent(event) {
  return (
    event?.metadata?.aed_available === true ||
    event?.metadata?.aed_status === "available" ||
    event?.device_state?.aed_available === true ||
    event?.rescuer_state?.aed_available === true ||
    event?.user_input?.intent === "aed_available"
  );
}

function isSoftAedAliasEvent(event) {
  return (
    event?.metadata?.aed_soft_alias === true ||
    event?.user_input?.stt_text?.includes?.("起搏器") === true
  );
}

function isHandoverRequested(event) {
  return (
    event?.event_type === "handover_requested" ||
    event?.metadata?.ems_arrived === true ||
    event?.user_input?.intent === "paramedics_arrived" ||
    event?.user_input?.intent === "emergency_team_arrived"
  );
}

function isHandoverReportGenerated(event) {
  return (
    event?.event_type === "tool_result" &&
    event?.metadata?.handover_report_generated === true
  );
}

function emergencyCallTool() {
  return {
    type: "emergency_call",
    target: "120",
    mode: "demo_configured",
    demo_modes: ["test_auto_call", "accessibility_click_120", "dial_only_fallback"],
    cancel_window_seconds: 3,
    requires_user_confirmation: false,
    speakerphone: true,
    visible_script_required: true,
    briefing: {
      mode: "speaker_tts_best_effort",
      repeat_interval_seconds: 12,
      visible_script_required: true,
    },
    audit: {
      demo_hack: true,
      real_emergency_test_requires_manual_approval: true,
    },
  };
}

export default runStateMachine;
