import { runAgentPipeline } from "../agent/runPipeline.js";
import { createDecisionFrame } from "../gemma/decisionFrame.js";
import { GemmaRuntime } from "../gemma/runtime.js";
import { createId } from "../domain/types.js";
import { validateAction } from "../engine/actionValidator.js";
import { AgentStage } from "../domain/stages.js";
import { transcribeInput } from "./stt.js";
import { synthesizeSpeech } from "./tts.js";
import {
  LiveResponseType,
  createLiveAgentInput,
  createLiveDriverProposal,
  liveProposalToGuidanceAction,
} from "./liveDriver.js";

const DEFAULT_VOICE_EVENT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_GEMMA_LIVE_TIMEOUT_MS = 1200;

export function createVoiceDemoService(options = {}) {
  const sessions = new Map();
  const runtime = options.runtime || new GemmaRuntime(options.gemma || {});
  const now = options.now || (() => new Date().toISOString());

  return {
    sessions,
    async handleTurn(input = {}) {
      const totalStart = Date.now();
      const timings = {};
      const sessionId = input.sessionId || input.session_id || createId("voice_sess");
      const session = getOrCreateSession(sessions, sessionId, now);
      const stt = await timed(timings, "stt_ms", () => transcribeInput(input, options.stt || {}));
      const event = createVoiceEvent({ sessionId, stt, input, now });

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
          intent_hint: stt.intent,
          confidence: stt.confidence,
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
      });
      const guidanceAction = guidanceDecision.action;
      const spokenText = guidanceAction?.tts?.text || stateAction?.tts?.text || "";
      const tts = await timed(timings, "tts_ms", () => synthesizeSpeech(spokenText, options.tts || {}));
      timings.total_ms = Date.now() - totalStart;
      const response = {
        ok: true,
        session_id: sessionId,
        transcript: stt.transcript,
        stt,
        event,
        state: pipeline.state,
        state_action: stateAction,
        decision_frame: frame,
        action_patch: patch,
        gemma_validation: gemmaValidation,
        live_agent_input: liveInput,
        live_driver_proposal: liveProposal,
        guidance_action: guidanceAction,
        guidance_source: guidanceDecision.source,
        response_type: guidanceDecision.responseType,
        live_driver_source: guidanceDecision.liveDriverSource,
        tts_arbitration_reason: guidanceDecision.reason,
        gemma,
        gemma_live: createGemmaLiveDebug(gemma, gemmaPlan),
        tts,
        timings,
        report: pipeline.report,
      };

      session.lastResponse = response;
      return response;
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

  return {
    run: true,
    reason: null,
    live: cprLive,
    timeoutMs: cprLive ? resolveGemmaLiveTimeoutMs(context.options) : null,
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

async function generateGemmaPatch(runtime, frame, plan = {}) {
  if (!plan.timeoutMs) {
    return runtime.generatePatch(frame);
  }

  return withTimeout(runtime.generatePatch(frame), plan.timeoutMs, "gemma_live_timeout");
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
    event?.stage_hint === AgentStage.S7_CPR_LOOP ||
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

function createVoiceEvent({ sessionId, stt, input, now }) {
  const inferredDeviceState = inferDeviceState(stt.intent);
  const inferredCprQuality = inferCprQuality(stt.intent);
  const source = input.eventSource || input.event_source || inferEventSource(input);
  const eventType =
    input.eventType ||
    input.event_type ||
    inferEventType(input, stt.intent);

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
      intent: stt.intent,
      confidence: stt.confidence,
    },
    patient_state: input.patientState || input.patient_state || null,
    cpr_quality: input.cprQuality || input.cpr_quality || inferredCprQuality,
    rescuer_state: input.rescuerState || input.rescuer_state || null,
    device_state: input.deviceState || input.device_state || inferredDeviceState,
    tool_result: input.toolResult || input.tool_result || null,
    metadata: {
      ...(input.metadata || {}),
      audio: stt.audio,
    },
  };
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
  if (intent !== "continue_cpr") {
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
  if (intent === "continue_cpr") {
    return "cpr_quality_update";
  }
  if (intent === "emergency_called") {
    return "device_state_update";
  }
  return "user_response";
}
