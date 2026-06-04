import { AgentStage } from "./stages.js";
import {
  ActionSource,
  GUIDANCE_ACTION_SCHEMA_VERSION,
  InterruptPolicy,
  LOG_EVENT_SCHEMA_VERSION,
  Priority,
  TtsSpeed,
  TtsTone,
  cloneJson,
  createId,
  nowIso,
} from "./types.js";

export function createLogEvent(input = {}) {
  const timestamp = input.timestamp ?? nowIso();

  return {
    schema_version: LOG_EVENT_SCHEMA_VERSION,
    log_event_id: input.logEventId ?? input.log_event_id ?? createId("log"),
    session_id: input.sessionId ?? input.session_id ?? null,
    timestamp,
    stage: input.stage ?? null,
    intent: input.intent ?? null,
    source: input.source ?? ActionSource.STATE_MACHINE,
    type: input.type ?? "event",
    detail: input.detail ?? null,
    reason_codes: input.reasonCodes ?? input.reason_codes
      ? [...(input.reasonCodes ?? input.reason_codes)]
      : [],
    metadata: cloneJson(input.metadata ?? {}),
  };
}

export function createGuidanceAction(input = {}) {
  const timestamp = input.timestamp ?? nowIso();
  const sessionId = input.sessionId ?? input.session_id ?? null;
  const stage = input.stage ?? AgentStage.S0_INIT;
  const intent = input.intent ?? "unknown";
  const source = input.source ?? ActionSource.STATE_MACHINE;
  const reasonCodes = input.reasonCodes ?? input.reason_codes ?? [];
  const toolActions = input.toolActions ?? input.tool_actions ?? [];

  return {
    schema_version: GUIDANCE_ACTION_SCHEMA_VERSION,
    action_id: input.actionId ?? input.action_id ?? createId("act"),
    session_id: sessionId,
    timestamp,
    stage,
    intent,
    priority: input.priority ?? Priority.NORMAL,
    source,
    reason_codes: [...reasonCodes],
    ttl_ms: input.ttlMs ?? input.ttl_ms ?? 5000,
    throttle_key: input.throttleKey ?? input.throttle_key ?? null,
    min_interval_ms: input.minIntervalMs ?? input.min_interval_ms ?? 0,
    tts: normalizeTts(input.tts),
    ui: normalizeUi(input.ui),
    haptic: normalizeHaptic(input.haptic),
    visual_overlay: input.visualOverlay ?? input.visual_overlay
      ? cloneJson(input.visualOverlay ?? input.visual_overlay)
      : null,
    // Optional emergency-call briefing (location + symptoms script for 120).
    // Only attached when the state machine supplies it (S5), so every other
    // guidance action keeps its existing shape.
    ...(input.callBrief ?? input.call_brief
      ? { call_brief: cloneJson(input.callBrief ?? input.call_brief) }
      : {}),
    tool_actions: Array.isArray(toolActions)
      ? toolActions.map((toolAction) => cloneJson(toolAction))
      : [],
    log_event: input.logEvent ?? input.log_event
      ? createLogEvent({
          ...(input.logEvent ?? input.log_event),
          sessionId,
          timestamp,
          stage,
          intent,
          source,
          reasonCodes: reasonCodes.length > 0
            ? reasonCodes
            : input.logEvent?.reasonCodes ?? input.log_event?.reason_codes,
        })
      : null,
  };
}

export function createGuidanceActionPatch(input = {}) {
  return {
    intent: input.intent ?? "unknown",
    tts: {
      text: input.tts?.text ?? "",
      tone: input.tts?.tone ?? TtsTone.CALM_FIRM,
    },
    ui: {
      main_text: input.ui?.mainText ?? input.ui?.main_text ?? "",
      secondary_text: input.ui?.secondaryText ?? input.ui?.secondary_text ?? "",
    },
    reason: input.reason ?? null,
  };
}

export function createEmergencyCallToolAction(input = {}) {
  return {
    type: "emergency_call",
    target: input.target ?? "120",
    mode: input.mode ?? "demo_configured",
    demo_modes: input.demoModes ?? input.demo_modes ?? [
      "test_auto_call",
      "accessibility_click_120",
      "dial_only_fallback",
    ],
    cancel_window_seconds: input.cancelWindowSeconds ?? input.cancel_window_seconds ?? 3,
    requires_user_confirmation: input.requiresUserConfirmation ?? false,
    speakerphone: input.speakerphone ?? true,
    visible_script_required: input.visibleScriptRequired ?? input.visible_script_required ?? true,
    briefing: {
      mode: input.briefing?.mode ?? "speaker_tts_best_effort",
      repeat_interval_seconds:
        input.briefing?.repeatIntervalSeconds ??
        input.briefing?.repeat_interval_seconds ??
        12,
      visible_script_required:
        input.briefing?.visibleScriptRequired ??
        input.briefing?.visible_script_required ??
        true,
    },
    audit: {
      demo_hack: input.audit?.demoHack ?? input.audit?.demo_hack ?? true,
      real_emergency_test_requires_manual_approval:
        input.audit?.realEmergencyTestRequiresManualApproval ??
        input.audit?.real_emergency_test_requires_manual_approval ??
        true,
    },
    demo_safe: input.demoSafe ?? false,
  };
}

export function createStartRecordingToolAction(input = {}) {
  return {
    type: "start_local_recording",
    requires_user_confirmation: input.requiresUserConfirmation ?? false,
  };
}

export function createAttachGpsToolAction(input = {}) {
  return {
    type: "attach_gps_location",
    requires_user_confirmation: input.requiresUserConfirmation ?? false,
  };
}

export function createMetronomeHaptic(input = {}) {
  return {
    enabled: true,
    pattern: input.pattern ?? "metronome",
    bpm: input.bpm ?? 110,
  };
}

export function createStartEmergencyAndCprAction(input = {}) {
  return createGuidanceAction({
    ...input,
    stage: input.stage ?? AgentStage.S5_CALL_EMERGENCY,
    intent: input.intent ?? "start_emergency_call_and_cpr",
    priority: input.priority ?? Priority.CRITICAL,
    source: input.source ?? ActionSource.STATE_MACHINE,
    reasonCodes: input.reasonCodes ?? [
      "adult_scope",
      "unresponsive",
      "no_normal_breathing",
    ],
    throttleKey: input.throttleKey ?? "stage.start_cpr",
    minIntervalMs: input.minIntervalMs ?? 0,
    tts: {
      text:
        input.tts?.text ??
        "Use suspected cardiac arrest handling. Start emergency call and prepare chest compressions.",
      tone: input.tts?.tone ?? TtsTone.CALM_FIRM,
      speed: input.tts?.speed ?? TtsSpeed.NORMAL,
      interruptPolicy:
        input.tts?.interruptPolicy ?? InterruptPolicy.INTERRUPT_LOWER_PRIORITY,
    },
    ui: {
      mainText: input.ui?.mainText ?? "Suspected cardiac arrest",
      secondaryText:
        input.ui?.secondaryText ?? "Calling emergency services and preparing CPR",
      statusTags: input.ui?.statusTags ?? [
        "unresponsive",
        "no_normal_breathing",
        "cpr_ready",
      ],
      qualityScore: input.ui?.qualityScore ?? null,
      primaryButton: input.ui?.primaryButton ?? {
        label: "Emergency call done",
        action: "mark_emergency_called",
      },
    },
    haptic: input.haptic ?? { enabled: false },
    visualOverlay: input.visualOverlay ?? {
      mode: "prepare_cpr_position",
      highlight_target: "chest_center",
    },
    toolActions: input.toolActions ?? [
      createEmergencyCallToolAction(input.emergencyCall ?? {}),
      createStartRecordingToolAction(input.recording ?? {}),
      createAttachGpsToolAction(input.gps ?? {}),
    ],
    logEvent: input.logEvent ?? {
      type: "suspected_cardiac_arrest",
      detail: "unresponsive_and_no_normal_breathing",
    },
  });
}

function normalizeTts(tts = {}) {
  return {
    text: tts.text ?? "",
    tone: tts.tone ?? TtsTone.CALM_FIRM,
    speed: tts.speed ?? TtsSpeed.NORMAL,
    interrupt_policy:
      tts.interruptPolicy ??
      tts.interrupt_policy ??
      InterruptPolicy.DO_NOT_INTERRUPT_CRITICAL,
  };
}

function normalizeUi(ui = {}) {
  return {
    main_text: ui.mainText ?? ui.main_text ?? "",
    secondary_text: ui.secondaryText ?? ui.secondary_text ?? "",
    status_tags: ui.statusTags ?? ui.status_tags ?? [],
    quality_score: ui.qualityScore ?? ui.quality_score ?? null,
    primary_button: ui.primaryButton ?? ui.primary_button ?? null,
  };
}

function normalizeHaptic(haptic = {}) {
  return {
    enabled: haptic.enabled ?? false,
    ...(haptic.pattern ? { pattern: haptic.pattern } : {}),
    ...(haptic.bpm ? { bpm: haptic.bpm } : {}),
  };
}
