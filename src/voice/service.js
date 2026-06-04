import { runAgentPipeline } from "../agent/runPipeline.js";
import { createDecisionFrame } from "../gemma/decisionFrame.js";
import { GemmaRuntime } from "../gemma/runtime.js";
import { createNluGovernor } from "../gemma/nluCache.js";
import { createId } from "../domain/types.js";
import { validateAction } from "../engine/actionValidator.js";
import { AgentStage } from "../domain/stages.js";
import { getNluSlotsConfig } from "../knowledge/knowledgeBase.js";
import { transcribeInput } from "./stt.js";
import { synthesizeSpeech } from "./tts.js";
import { resolveUserIntent } from "./intentResolver.js";
import {
  LiveResponseType,
  createLiveAgentInput,
  createLiveDriverProposal,
  liveProposalToGuidanceAction,
} from "./liveDriver.js";

const DEFAULT_VOICE_EVENT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_GEMMA_LIVE_TIMEOUT_MS = 1200;
const DEFAULT_GEMMA_TURN_TIMEOUT_MS = 1000;
const CPR_READINESS_FAST_PATH = "s6_readiness_continue_cpr";

// At the S6 confirm gate, readiness/start phrases ("开始"/"可以了"/"没有呼吸"/
// "准备好了"…) all mean "start compressions now". They sometimes classify as a
// non-continue_cpr intent (e.g. "可以了"->step_done, "没有呼吸"->no_normal_breathing);
// those are advance-compatible and get folded into the continue_cpr start signal.
// Divergent intents (responsive / normal breathing / paramedics / scene unsafe /
// signs of life) are NOT in this set, so they are kept and the flow branches.
const READINESS_FAST_PATH_OVERRIDABLE_INTENTS = new Set([
  "continue_cpr",
  "no_normal_breathing",
  "breathing_absent",
  "agonal_breathing",
  "compressions_reported",
  "step_done",
]);

export function createVoiceDemoService(options = {}) {
  const sessions = new Map();
  const runtime = options.runtime || new GemmaRuntime(options.gemma || {});
  const now = options.now || (() => new Date().toISOString());
  // Per-service NLU governance: an LRU result cache + per-session call budget so
  // repeated/fuzzy utterances skip the slow local model and one session cannot
  // hammer the CPU. Instance-scoped on purpose — no cross-session or cross-test
  // state bleed. Config layering: options > env > nlu_slots.json baseline.
  const { cache: nluCache, budget: nluBudget } = createNluGovernor({
    ...options,
    baseline: resolveNluRuntimeBaseline(),
    env: options.env || process.env,
  });
  const coreOptions = { ...options, nluCache, nluBudget };

  return {
    sessions,
    async handleTurn(input = {}) {
      const totalStart = Date.now();
      const timings = {};
      const sessionId = input.sessionId || input.session_id || createId("voice_sess");
      const session = getOrCreateSession(sessions, sessionId, now);
      const stt = await timed(timings, "stt_ms", () => transcribeInput(input, options.stt || {}));
      const guidance = await runVoiceGuidanceCore({
        sessionId,
        session,
        stt,
        input,
        runtime,
        options: coreOptions,
        now,
        timings,
      });
      const guidanceAction = guidance.guidanceAction;
      const spokenText = guidanceAction?.tts?.text || guidance.stateAction?.tts?.text || "";
      const tts = await timed(timings, "tts_ms", () => synthesizeSpeech(spokenText, options.tts || {}));
      timings.total_ms = Date.now() - totalStart;
      const response = {
        ok: true,
        session_id: sessionId,
        transcript: stt.transcript,
        stt,
        intent_resolution: guidance.intentResolution,
        event: guidance.event,
        state: guidance.pipeline.state,
        state_action: guidance.stateAction,
        decision_frame: guidance.frame,
        action_patch: guidance.patch,
        gemma_validation: guidance.gemmaValidation,
        live_agent_input: guidance.liveInput,
        live_driver_proposal: guidance.liveProposal,
        guidance_action: guidanceAction,
        guidance_source: guidance.guidanceDecision.source,
        response_type: guidance.guidanceDecision.responseType,
        live_driver_source: guidance.guidanceDecision.liveDriverSource,
        tts_arbitration_reason: guidance.guidanceDecision.reason,
        gemma: guidance.gemma,
        gemma_live: createGemmaLiveDebug(guidance.gemma, guidance.gemmaPlan),
        tts,
        timings,
        report: guidance.pipeline.report,
      };

      session.lastResponse = response;
      return response;
    },
    async createGuidance(input = {}, stt, timings = {}) {
      const sessionId = input.sessionId || input.session_id || createId("voice_sess");
      const session = getOrCreateSession(sessions, sessionId, now);
      const resolvedStt = stt || await timed(timings, "stt_ms", () => transcribeInput(input, options.stt || {}));
      const guidance = await runVoiceGuidanceCore({
        sessionId,
        session,
        stt: resolvedStt,
        input,
        runtime,
        options: coreOptions,
        now,
        timings,
      });
      session.lastResponse = createGuidanceResponseSnapshot(guidance);
      return guidance;
    },
    reset(sessionId) {
      if (sessionId) {
        sessions.delete(sessionId);
      } else {
        sessions.clear();
      }
      return { ok: true, session_id: sessionId || null };
    },
    getSession(sessionId) {
      return sessions.get(sessionId) || null;
    },
    // Best-effort: pay the resident-daemon model-load cost up front so the first
    // real NLU turn is fast. No-op in one-shot (non-daemon) mode. Never throws.
    async prewarm(prewarmOptions = {}) {
      if (runtime && typeof runtime.prewarm === "function") {
        return runtime.prewarm(prewarmOptions);
      }
      return { ok: true, warmed: false, reason: "runtime_prewarm_unsupported" };
    },
  };
}

export async function runVoiceGuidanceCore({
  sessionId,
  session,
  stt,
  input = {},
  runtime,
  options = {},
  now = () => new Date().toISOString(),
  timings = {},
} = {}) {
  const priorState = getPriorSessionState(session, input);
  const resolverStage = resolveIntentStage(priorState, input, session);
  const rawIntentResolution = await timed(timings, "intent_resolution_ms", () => resolveUserIntent({
    transcript: stt.transcript,
    stage: resolverStage,
    runtime,
    options: {
      ...options,
      sessionId,
      facts: priorState?.confirmed_facts || {},
      perceptionSummary: input.perceptionSummary || input.perception_summary,
      recentTts: priorState?.dialogue_state?.recent_tts,
    },
  }));
  const intentResolution = applyCprReadinessFastPath(rawIntentResolution, {
    stt,
    stage: resolverStage,
  });
  const event = createVoiceEvent({ sessionId, stt, input, now, intentResolution });

  session.events.push(event);

  // The voice service runs its own Gemma supplement below (runtime +
  // ActionValidator), so it needs the pipeline's deterministic,
  // synchronous state-machine actions. Now that runAgentPipeline defaults
  // Gemma ON, opt out explicitly to keep the synchronous contract.
  const pipeline = await timed(timings, "agent_pipeline_ms", () => runAgentPipeline({
    events: session.events,
    mode: "demo_assisted",
    sessionId,
    now,
    useGemma: false,
  }));
  const stateAction = pipeline.actions[pipeline.actions.length - 1] || null;
  const frame = createDecisionFrame({
    state: pipeline.state,
    event,
    userInput: {
      stt_text: stt.transcript,
      intent_hint: event.user_input?.intent,
      confidence: event.user_input?.confidence,
    },
    perceptionSummary: input.perceptionSummary || input.perception_summary,
  });
  const liveInput = createLiveAgentInput({
    sessionState: pipeline.state,
    latestEvent: event,
    latestUserUtterance: frame.user_input,
    pendingFlowAction: stateAction,
    pendingRuleFeedback: stateAction?.source === "rule_feedback" ? stateAction : null,
    recentTts: frame.recent_tts,
    allowedIntents: frame.allowed_intents,
  });
  const liveProposal = createLiveDriverProposal(liveInput);
  const gemmaPlan = planGemmaSupplement(stateAction, stt, {
    state: pipeline.state,
    event,
    liveProposal,
    options,
  });
  const gemma = gemmaPlan.run
    ? await timed(timings, "gemma_ms", () => generateGemmaPatch(runtime, frame, gemmaPlan))
    : createSkippedGemma(gemmaPlan.reason);
  const patch = gemma.patch || null;
  const gemmaValidation = patch
    ? validateAction(toGuidanceCandidate(patch, pipeline.state, sessionId), pipeline.state)
    : null;
  const guidanceDecision = arbitrateGuidanceAction({
    stateAction,
    gemmaValidation,
    liveProposal,
    state: pipeline.state,
    sessionId,
    allowIntentChange: false,
    userIntent: event.user_input?.intent ?? null,
    event,
  });

  return {
    sessionId,
    stt,
    intentResolution,
    event,
    pipeline,
    stateAction,
    frame,
    liveInput,
    liveProposal,
    gemmaPlan,
    gemma,
    patch,
    gemmaValidation,
    guidanceDecision,
    guidanceAction: guidanceDecision.action,
  };
}

// Medical flow stays state-machine-driven. Gemma may only supplement wording on
// non-critical turns. If the state action is critical or carries tool actions
// (call 120, start CPR, generate report, etc.), the state action is dispatched
// as-is and Gemma never replaces it.
export function resolveGuidanceAction(stateAction, gemmaValidation, options = {}) {
  if (stateAction && isCriticalFlowAction(stateAction)) {
    return { action: stateAction, source: "state_machine_critical" };
  }

  if (gemmaValidation?.ok === false && gemmaValidation.action) {
    return { action: gemmaValidation.action, source: "gemma_fallback" };
  }

  if (
    stateAction &&
    options.allowIntentChange === false &&
    gemmaValidation?.action &&
    gemmaValidation.action.intent !== stateAction.intent
  ) {
    return { action: stateAction, source: "state_machine" };
  }

  if (gemmaValidation?.action) {
    return {
      action: gemmaValidation.action,
      source: gemmaValidation.ok ? "gemma_agent" : "gemma_fallback",
    };
  }

  return { action: stateAction, source: "state_machine" };
}

export function arbitrateGuidanceAction({
  stateAction,
  gemmaValidation,
  liveProposal,
  state = {},
  sessionId = null,
  allowIntentChange = false,
  userIntent = null,
  event = null,
} = {}) {
  if (isCriticalRuleCorrection(stateAction)) {
    return {
      action: stateAction,
      source: "rule_feedback_critical",
      responseType: LiveResponseType.CRITICAL_CORRECTION,
      liveDriverSource: null,
      reason: "critical_rule_feedback",
    };
  }

  if (isCprReadinessFlowFastPath(stateAction, state, userIntent, event)) {
    return {
      action: stateAction,
      source: "rule_flow_fast_path",
      responseType: LiveResponseType.FLOW_INSTRUCTION,
      liveDriverSource: "rule_flow_fast_path",
      reason: "s6_readiness_continue_cpr",
    };
  }

  // "你说我做" CPR coach has been retired: the autonomous loop now drives the
  // CPR phase (silence-by-default + rule corrections), so step_done /
  // compressions_reported no longer voice scripted per-step commands. The
  // continue_cpr readiness fast path above still starts/keeps the loop, and
  // compressions_reported keeps its cpr_state.started link (see inferCprQuality).
  const liveValidation = validateLiveProposal(liveProposal, state, sessionId);
  if (
    liveValidation?.ok &&
    (liveProposal.responseType === LiveResponseType.QUESTION_ANSWER || !isCriticalFlowAction(stateAction))
  ) {
    return {
      action: liveValidation.action,
      source: liveProposal.source || "rule_fast_path",
      responseType: liveProposal.responseType || LiveResponseType.QUESTION_ANSWER,
      liveDriverSource: liveProposal.source || "rule_fast_path",
      reason: "explicit_live_question",
    };
  }

  const gemmaDecision = resolveGuidanceAction(stateAction, gemmaValidation, { allowIntentChange });
  return {
    ...gemmaDecision,
    responseType: responseTypeForAction(gemmaDecision.action, stateAction),
    liveDriverSource: gemmaDecision.source === "gemma_agent" ? "gemma_live_driver" : null,
    reason: gemmaDecision.source,
  };
}

function isCprReadinessFlowFastPath(stateAction, state = {}, userIntent = null, event = null) {
  return (
    userIntent === "continue_cpr" &&
    event?.metadata?.rule_flow_fast_path === CPR_READINESS_FAST_PATH &&
    state?.current_stage === AgentStage.S7_CPR_LOOP &&
    stateAction?.stage === AgentStage.S7_CPR_LOOP &&
    stateAction?.intent === "start_cpr_loop"
  );
}

export function isCriticalFlowAction(action) {
  if (action.priority === "critical") {
    return true;
  }

  if (action.source === "state_machine" && action.priority === "high") {
    return true;
  }

  const tools = Array.isArray(action.tool_actions)
    ? action.tool_actions
    : action.tool_action
      ? [action.tool_action]
      : [];
  return tools.length > 0;
}

function planGemmaSupplement(stateAction, stt, context = {}) {
  const cprLive = isCprLiveContext(context.state, context.event);

  if (!stateAction) {
    return cprLive && stt.transcript
      ? { run: true, reason: null, live: true, timeoutMs: resolveGemmaLiveTimeoutMs(context.options) }
      : { run: false, reason: "no_state_action" };
  }

  if (isCriticalRuleCorrection(stateAction)) {
    return { run: false, reason: "critical_rule_feedback_fast_path", live: cprLive };
  }

  if (stateAction.priority === "critical") {
    return { run: false, reason: "critical_or_tool_state_action", live: cprLive };
  }

  if (context.liveProposal) {
    return { run: false, reason: "live_fast_path_selected", live: cprLive };
  }

  if (isCriticalFlowAction(stateAction) && !cprLive) {
    return { run: false, reason: "critical_or_tool_state_action" };
  }

  if (!stt.transcript) {
    return { run: false, reason: "no_user_input" };
  }

  // 方案①（诊断轮即时）：非 CPR-live 的流程引导轮（S1/S2 等标准话术）不为
  // Gemma 润色阻塞，直接用确定性状态机话术即时响应，降低判断阶段延迟。
  // 这些话术是固定的标准流程句，Gemma 润色收益低；Gemma 仍服务于 CPR-live
  // 轮（S7/S8）的自然语言润色与安抚，那里语言价值更高。
  if (!cprLive) {
    return { run: false, reason: "diagnostic_fast_path" };
  }

  return {
    run: true,
    reason: null,
    live: true,
    timeoutMs: resolveGemmaLiveTimeoutMs(context.options),
  };
}

function createSkippedGemma(reason) {
  return {
    ok: true,
    skipped: true,
    skipReason: reason,
    patch: null,
  };
}

function createGemmaLiveDebug(gemma, plan = {}) {
  return {
    skipped: gemma?.skipped === true,
    skipReason: gemma?.skipReason || null,
    timeout_ms: plan.timeoutMs || gemma?.timeout_ms || null,
    stale: gemma?.stale === true,
    live: plan.live === true,
    patch: Boolean(gemma?.patch),
  };
}

function createGuidanceResponseSnapshot(guidance = {}) {
  return {
    ok: true,
    session_id: guidance.sessionId,
    transcript: guidance.stt?.transcript,
    stt: guidance.stt,
    intent_resolution: guidance.intentResolution,
    event: guidance.event,
    state: guidance.pipeline?.state,
    state_action: guidance.stateAction,
    guidance_action: guidance.guidanceAction,
    guidance_source: guidance.guidanceDecision?.source,
    response_type: guidance.guidanceDecision?.responseType,
    report: guidance.pipeline?.report,
  };
}

async function generateGemmaPatch(runtime, frame, plan = {}) {
  if (!plan.timeoutMs) {
    return runtime.generatePatch(frame);
  }

  return withTimeout(
    runtime.generatePatch(frame),
    plan.timeoutMs,
    plan.live ? "gemma_live_timeout" : "gemma_turn_timeout"
  );
}

async function withTimeout(promise, timeoutMs, reason) {
  let timeout = null;
  const pending = Promise.resolve(promise);
  pending.catch(() => {});

  try {
    return await Promise.race([
      pending,
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            ok: true,
            skipped: true,
            skipReason: reason,
            stale: true,
            timeout_ms: timeoutMs,
            patch: null,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function timed(timings, key, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = Date.now() - start;
  }
}

function validateLiveProposal(liveProposal, state, sessionId) {
  if (!liveProposal) {
    return null;
  }

  const candidate = liveProposalToGuidanceAction(liveProposal, state, sessionId);
  return validateAction(candidate, state);
}

function responseTypeForAction(action, stateAction) {
  if (isCriticalRuleCorrection(action)) {
    return LiveResponseType.CRITICAL_CORRECTION;
  }

  if (action?.source === "gemma_agent") {
    return LiveResponseType.PROACTIVE_COACHING;
  }

  if (stateAction?.intent === action?.intent) {
    return LiveResponseType.FLOW_INSTRUCTION;
  }

  return LiveResponseType.REASSURANCE;
}

function isCriticalRuleCorrection(action) {
  return (
    action?.source === "rule_feedback" &&
    (action.priority === "critical" || action.priority === "high")
  );
}

function isCprLiveContext(state = {}, event = null) {
  return (
    state.current_stage === AgentStage.S7_CPR_LOOP ||
    state.current_stage === AgentStage.S8_ASSISTANCE ||
    event?.stage_hint === AgentStage.S7_CPR_LOOP ||
    event?.stage_hint === AgentStage.S8_ASSISTANCE ||
    isCprVisionEvent(event)
  );
}

function isCprVisionEvent(event = null) {
  return event?.source === "vision_cpr" || event?.event_type === "cpr_quality_update" || Boolean(event?.cpr_quality);
}

function resolveGemmaLiveTimeoutMs(options = {}) {
  const value = Number(options.gemmaLiveTimeoutMs ?? options.gemma_live_timeout_ms ?? process.env.GEMMA_LIVE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_GEMMA_LIVE_TIMEOUT_MS;
}

export function resolveGemmaTurnTimeoutMs(options = {}) {
  const value = Number(options.gemmaTurnTimeoutMs ?? options.gemma_turn_timeout_ms ?? process.env.GEMMA_TURN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_GEMMA_TURN_TIMEOUT_MS;
}

function toGuidanceCandidate(patch, state, sessionId) {
  return {
    ...patch,
    session_id: sessionId,
    stage: state.current_stage,
    source: "gemma_agent",
    priority: "normal",
    reason_codes: patch.reason ? [patch.reason] : [],
    log_event: {
      type: patch.log_suggestion?.type || patch.intent || "gemma_patch",
      detail: patch.log_suggestion?.detail || patch.reason || patch.intent || "gemma_patch",
    },
  };
}

function getOrCreateSession(sessions, sessionId, now) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      createdAt: now(),
      events: [createSessionStartedEvent(sessionId, now)],
      lastResponse: null,
    };
    sessions.set(sessionId, session);
  }

  return session;
}

function createSessionStartedEvent(sessionId, now) {
  return {
    schema_version: "perception_event.v0.1",
    event_id: createId("evt"),
    session_id: sessionId,
    timestamp: now(),
    mode: "demo_assisted",
    source: "voice_server",
    event_type: "session_started",
    ttl_ms: getVoiceEventTtlMs(),
    metadata: {
      adult_likely: true,
      recording: true,
    },
  };
}

function createVoiceEvent({ sessionId, stt, input, now, intentResolution = null }) {
  const resolvedIntent = intentResolution?.intent ?? stt.intent;
  const resolvedConfidence = numberOrNull(intentResolution?.confidence) ?? stt.confidence;
  const resolvedSource = intentResolution?.source || "stt";
  const inferredDeviceState = inferDeviceState(resolvedIntent);
  const inferredCprQuality = inferCprQuality(resolvedIntent);
  const rawSource = input.eventSource || input.event_source || inferEventSource(input);
  const eventType =
    input.eventType ||
    input.event_type ||
    inferEventType(input, resolvedIntent);
  const source = canonicalizeVoiceEventSource(rawSource, eventType, input);
  const sourceMetadata = createCanonicalSourceMetadata(rawSource, source, input.metadata);
  const patientState = mergeResolvedPatientState(
    input.patientState || input.patient_state || null,
    intentResolution,
  );

  return {
    schema_version: "perception_event.v0.1",
    event_id: createId("evt"),
    session_id: sessionId,
    timestamp: now(),
    mode: "demo_assisted",
    source,
    event_type: eventType,
    ttl_ms: input.ttlMs || input.ttl_ms || getVoiceEventTtlMs(),
    user_input: {
      stt_text: stt.transcript,
      intent: resolvedIntent,
      confidence: resolvedConfidence,
      source: resolvedSource,
    },
    patient_state: patientState,
    cpr_quality: input.cprQuality || input.cpr_quality || inferredCprQuality,
    rescuer_state: input.rescuerState || input.rescuer_state || null,
    device_state: input.deviceState || input.device_state || inferredDeviceState,
    tool_result: input.toolResult || input.tool_result || null,
    metadata: {
      ...(input.metadata || {}),
      ...sourceMetadata,
      ...(intentResolution?.fastPath ? { rule_flow_fast_path: intentResolution.fastPath } : {}),
      audio: stt.audio,
      intent_resolution: createIntentResolutionDebug(intentResolution),
    },
  };
}

function applyCprReadinessFastPath(intentResolution, { stt = {}, stage = null } = {}) {
  if (stage !== AgentStage.S6_CPR_READY || !isCprReadinessUtterance(stt.transcript)) {
    return intentResolution;
  }

  const existingIntent = intentResolution?.intent ?? stt.intent ?? null;
  if (existingIntent && !READINESS_FAST_PATH_OVERRIDABLE_INTENTS.has(existingIntent)) {
    return intentResolution;
  }

  return {
    ...(intentResolution || {}),
    ok: true,
    intent: "continue_cpr",
    slots: intentResolution?.slots || {},
    confidence: Math.max(
      numberOrNull(intentResolution?.confidence) ?? 0,
      numberOrNull(stt.confidence) ?? 0,
      0.92,
    ),
    source: "rule_flow_fast_path",
    needsClarification: false,
    needs_clarification: false,
    escalated: intentResolution?.escalated === true,
    fastPath: CPR_READINESS_FAST_PATH,
  };
}

function isCprReadinessUtterance(transcript = "") {
  const text = normalizeReadinessText(transcript);
  return (
    /^(?:我)?(?:已|已经)?准备好了?$/.test(text) ||
    /^(?:我)?准备就绪$/.test(text) ||
    // "开始" / "现在开始" / "这就开始" / "开始吧" / "开始按压" / "开始CPR" …
    /^(?:我|我们)?(?:这就|现在|马上)?开始(?:吧|啊|了|按|按压|心肺复苏|cpr)?$/i.test(text) ||
    // "可以" / "可以了" / "可以开始" / "可以按了"
    /^可以(?:了|的|开始了?|按了?|按压了?)?$/.test(text) ||
    // Re-confirming arrest at the gate also means "start now".
    /^(?:他)?(?:没有|没|无)(?:正常)?呼吸了?$/.test(text) ||
    /^(?:他)?(?:不|没在|没有在)呼吸了?$/.test(text)
  );
}

function normalizeReadinessText(value) {
  return typeof value === "string"
    ? value.trim().replace(/[。！？!,.，、\s]+$/g, "")
    : "";
}

function canonicalizeVoiceEventSource(rawSource, eventType, input = {}) {
  if (
    rawSource === "real_perception" &&
    eventType === "cpr_quality_update" &&
    (input.cprQuality || input.cpr_quality)
  ) {
    return "vision_cpr";
  }
  return rawSource;
}

function createCanonicalSourceMetadata(rawSource, source, inputMetadata = {}) {
  if (!rawSource || rawSource === source) {
    return {};
  }
  return {
    raw_event_source: inputMetadata.raw_event_source || rawSource,
    perception_mode: inputMetadata.perception_mode || rawSource,
  };
}

function mergeResolvedPatientState(inputPatientState, intentResolution) {
  const slots = intentResolution?.slots;
  if (!slots || typeof slots !== "object") {
    return inputPatientState || null;
  }

  const patient = inputPatientState && typeof inputPatientState === "object"
    ? { ...inputPatientState }
    : {};
  let changed = false;

  for (const [slot, rawSlot] of Object.entries(slots)) {
    const normalized = normalizeResolvedSlot(rawSlot, intentResolution.nlu?.slots?.[slot]);
    if (!normalized || Object.prototype.hasOwnProperty.call(patient, slot)) {
      continue;
    }

    patient[slot] = normalized.value;
    patient[`${slot}_confidence`] = normalized.confidence;
    patient[`${slot}_source`] = intentResolution.source || "stt";
    changed = true;
  }

  return changed || inputPatientState ? patient : null;
}

function normalizeResolvedSlot(slot, originalSlot) {
  if (slot === null) {
    return { value: null, confidence: numberOrNull(originalSlot?.confidence) };
  }
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(slot, "value")) {
    return null;
  }
  return {
    value: slot.value,
    confidence: numberOrNull(slot.confidence),
  };
}

function createIntentResolutionDebug(intentResolution) {
  if (!intentResolution) {
    return null;
  }

  return {
    intent: intentResolution.intent || null,
    confidence: numberOrNull(intentResolution.confidence),
    source: intentResolution.source || null,
    needs_clarification: intentResolution.needs_clarification === true,
    escalated: intentResolution.escalated === true,
    escalation_reason: intentResolution.escalationReason || null,
    fallback_reason: intentResolution.fallbackReason || null,
    cache_hit: intentResolution.cacheHit === true,
  };
}

function getPriorSessionState(session, input = {}) {
  return input.sessionState || input.session_state || session?.lastResponse?.state || null;
}

function resolveIntentStage(priorState, input = {}, session = null) {
  const explicitStage = input.stage || input.stage_hint || input.currentStage || input.current_stage;
  if (explicitStage) {
    return explicitStage;
  }
  if (priorState?.current_stage) {
    return priorState.current_stage;
  }
  if (Array.isArray(session?.events) && session.events.length > 0) {
    return AgentStage.S1_SCENE_SAFE;
  }
  return AgentStage.S0_INIT;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveNluRuntimeBaseline() {
  try {
    const config = getNluSlotsConfig();
    return config && typeof config.nlu_runtime === "object" && config.nlu_runtime
      ? config.nlu_runtime
      : {};
  } catch {
    return {};
  }
}

function getVoiceEventTtlMs() {
  const fromEnv = Number(process.env.VOICE_EVENT_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? Math.floor(fromEnv)
    : DEFAULT_VOICE_EVENT_TTL_MS;
}

function inferDeviceState(intent) {
  if (intent !== "emergency_called") {
    return null;
  }

  return {
    emergency_call_started: true,
    emergency_call_status: "started",
    gps_attached: true,
    recording: true,
  };
}

function inferCprQuality(intent) {
  // compressions_reported ("按了30次"/"在按了") reuses the same continue_cpr ->
  // cpr_state.started link so the "你说我做" press_30 step can drive S6 -> S7.
  if (intent !== "continue_cpr" && intent !== "compressions_reported") {
    return null;
  }

  return {
    started: true,
    compression_rate: 110,
    quality_score: 0.72,
  };
}

function inferEventSource(input = {}) {
  if (input.cprQuality || input.cpr_quality) {
    return "vision_cpr";
  }
  if (input.rescuerState || input.rescuer_state) {
    return "vision_rescuer";
  }
  if (input.deviceState || input.device_state || input.toolResult || input.tool_result) {
    return "device";
  }
  if (input.patientState || input.patient_state || input.perceptionSummary || input.perception_summary) {
    return "vision_patient";
  }
  return "stt";
}

function inferEventType(input = {}, intent) {
  if (input.toolResult || input.tool_result) {
    return "tool_result";
  }
  if (input.cprQuality || input.cpr_quality) {
    return "cpr_quality_update";
  }
  if (input.rescuerState || input.rescuer_state) {
    return "rescuer_state_update";
  }
  if (input.deviceState || input.device_state) {
    return "device_state_update";
  }
  if (input.patientState || input.patient_state) {
    const patient = input.patientState || input.patient_state;
    if (
      Object.prototype.hasOwnProperty.call(patient, "normal_breathing") ||
      Object.prototype.hasOwnProperty.call(patient, "agonal_breathing")
    ) {
      return "breathing_update";
    }
    return "patient_state_update";
  }

  if (intent === "paramedics_arrived") {
    return "handover_requested";
  }
  if (intent === "normal_breathing" || intent === "no_normal_breathing") {
    return "breathing_update";
  }
  if (intent === "continue_cpr" || intent === "compressions_reported") {
    return "cpr_quality_update";
  }
  if (intent === "emergency_called") {
    return "device_state_update";
  }
  return "user_response";
}
