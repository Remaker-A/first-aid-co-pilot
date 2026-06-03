import { AgentStage } from "../domain/stages.js";
import { createGuidanceAction } from "../domain/actionFactories.js";
import { CprStartDecision, decideCprStart, getCprStartReasonCodes } from "./cprStartRule.js";
import { createRuleFeedbackAction } from "./ruleFeedbackEngine.js";

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
      return state.cpr_state?.started === true || Boolean(event?.cpr_quality)
        ? AgentStage.S7_CPR_LOOP
        : currentStage;
    case AgentStage.S7_CPR_LOOP:
      return isAssistanceEvent(state, event) ? AgentStage.S8_ASSISTANCE : AgentStage.S7_CPR_LOOP;
    case AgentStage.S8_ASSISTANCE:
      return event?.cpr_quality || isAssistanceComplete(event)
        ? AgentStage.S7_CPR_LOOP
        : AgentStage.S8_ASSISTANCE;
    case AgentStage.S9_HANDOVER:
    case AgentStage.MONITOR_RESPONSE:
    case AgentStage.MONITOR_BREATHING:
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
      return action(state, {
        stage: nextStage,
        intent: state.scope?.scene_safe === false ? "warn_scene_unsafe" : "ensure_scene_safe",
        priority: state.scope?.scene_safe === false ? "critical" : "normal",
        reasonCodes: ["session_started"],
        tts: {
          text: state.scope?.scene_safe === false
            ? "先保证自身安全，请呼叫 120。"
            : "先确认周围安全，再靠近患者。",
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
        tts: { text: "请看胸口 5 到 10 秒，有没有正常起伏？", tone: "calm_firm" },
        ui: {
          mainText: "检查呼吸",
          secondaryText: "观察胸口 5-10 秒",
          statusTags: ["看胸口", "正常起伏"],
          primaryButton: { label: "无正常呼吸", action: "mark_no_normal_breathing" },
        },
        logEvent: { type: "breathing_check_started", detail: "ask_breathing_check" },
      });
    case AgentStage.MONITOR_BREATHING:
      return action(state, {
        stage: nextStage,
        intent: "monitor_breathing_patient",
        priority: "high",
        reasonCodes: ["normal_breathing"],
        tts: { text: "他有正常呼吸，先不要做胸外按压。请呼叫 120 并持续观察。", tone: "calm_firm" },
        ui: {
          mainText: "持续观察呼吸",
          secondaryText: "呼叫 120，不做胸外按压",
          statusTags: ["正常呼吸", "观察", "呼叫120"],
        },
        toolActions: [emergencyCallTool()],
        logEvent: { type: "monitor_breathing", detail: "normal_breathing" },
      });
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
    case AgentStage.S5_CALL_EMERGENCY:
      return action(state, {
        stage: nextStage,
        intent: "start_emergency_call_and_cpr",
        priority: "critical",
        reasonCodes: getCprStartReasonCodes(state),
        throttleKey: "stage.call_emergency",
        tts: { text: "我将为你拨打 120，请保持手机免提。现在准备胸外按压。", tone: "calm_firm" },
        ui: {
          mainText: "正在呼叫 120",
          secondaryText: "保持免提，准备胸外按压",
          statusTags: ["呼叫120", "GPS", "录制"],
          primaryButton: { label: "已拨打120", action: "mark_emergency_called" },
        },
        visualOverlay: { mode: "prepare_cpr_position", highlight_target: "chest_center" },
        toolActions: [
          emergencyCallTool(),
          { type: "start_local_recording", requires_user_confirmation: false },
          { type: "attach_gps_location", requires_user_confirmation: false },
        ],
        logEvent: { type: "emergency_call_started", detail: "call_120_gps_recording" },
      });
    case AgentStage.S6_CPR_READY:
      return action(state, {
        stage: nextStage,
        intent: "guide_cpr_position",
        priority: "critical",
        reasonCodes: ["emergency_call_started", "prepare_cpr"],
        tts: { text: "让他平躺在硬地面，双手掌根放在胸口中央。", tone: "calm_firm" },
        ui: {
          mainText: "准备按压",
          secondaryText: "平躺硬地面，按胸口中央",
          statusTags: ["硬地面", "胸口中央"],
          primaryButton: { label: "准备好了", action: "mark_cpr_ready" },
        },
        visualOverlay: { mode: "prepare_cpr_position", highlight_target: "chest_center" },
        logEvent: { type: "cpr_ready_guidance", detail: "guide_chest_center" },
      });
    case AgentStage.S7_CPR_LOOP:
      return action(state, {
        stage: nextStage,
        intent: currentStage === AgentStage.S6_CPR_READY ? "start_cpr_loop" : "continue_cpr_loop",
        priority: currentStage === AgentStage.S6_CPR_READY ? "critical" : "normal",
        reasonCodes: ["cpr_loop"],
        throttleKey: currentStage === AgentStage.S6_CPR_READY ? "stage.cpr_loop" : "stage.continue_cpr",
        minIntervalMs: currentStage === AgentStage.S6_CPR_READY ? 0 : 8000,
        tts: {
          text: currentStage === AgentStage.S6_CPR_READY
            ? "现在开始胸外按压，跟着震动快速有力地按。"
            : "继续保持这个节奏。",
          tone: "calm_firm",
        },
        ui: {
          mainText: currentStage === AgentStage.S6_CPR_READY ? "开始按压" : "持续 CPR",
          secondaryText: "目标 100-120 次/分钟",
          statusTags: ["快速有力", "跟着震动"],
          qualityScore: state.cpr_state?.quality_score ?? null,
        },
        haptic: { enabled: true, pattern: "metronome", bpm: 110 },
        visualOverlay: { mode: "cpr_loop", highlight_target: "chest_center" },
        toolActions: [{ type: "start_haptic_metronome", bpm: 110, requires_user_confirmation: false }],
        logEvent: { type: currentStage === AgentStage.S6_CPR_READY ? "cpr_started" : "cpr_continued", detail: "cpr_loop" },
      });
    case AgentStage.S8_ASSISTANCE:
      return action(state, {
        stage: nextStage,
        intent: isAedEvent(event) ? "assist_aed" : "assist_rescuer_fatigue",
        priority: "normal",
        reasonCodes: isAedEvent(event) ? ["aed_event"] : ["rescuer_fatigue"],
        throttleKey: isAedEvent(event) ? "assistance.aed" : "assistance.fatigue",
        minIntervalMs: 15000,
        tts: {
          text: isAedEvent(event)
            ? "有人取到 AED 时，你继续按压，听设备提示。"
            : "如果旁边有人，请准备换手。",
          tone: "calm_firm",
        },
        ui: {
          mainText: isAedEvent(event) ? "AED 到达" : "准备换手",
          secondaryText: "继续胸外按压",
          statusTags: isAedEvent(event) ? ["AED", "继续按压"] : ["换手", "不要中断"],
        },
        haptic: { enabled: true, pattern: "metronome", bpm: 110 },
        visualOverlay: { mode: isAedEvent(event) ? "aed_assistance" : "rescuer_assistance" },
        logEvent: { type: "assistance", detail: isAedEvent(event) ? "aed_event" : "rescuer_fatigue" },
      });
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
        tts: { text: "急救员到达，我正在生成交接报告。", tone: "calm_firm" },
        ui: {
          mainText: "交接报告",
          secondaryText: "生成现场处置摘要",
          statusTags: ["交接报告", "急救员"],
        },
        toolActions: [{ type: "generate_handover_report", requires_user_confirmation: false }],
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
  const fatigue = event?.rescuer_state?.fatigue_level ?? state.rescuer_state?.fatigue_level;
  return fatigue === "high" || fatigue === "exhausted" || isAedEvent(event);
}

function isAssistanceComplete(event) {
  return (
    event?.event_type === "assistance_completed" ||
    event?.user_input?.intent === "assistance_completed" ||
    event?.user_input?.intent === "continue_cpr"
  );
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
