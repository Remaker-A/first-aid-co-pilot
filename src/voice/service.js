import { runAgentPipeline } from "../agent/runPipeline.js";
import { createDecisionFrame } from "../gemma/decisionFrame.js";
import { GemmaRuntime } from "../gemma/runtime.js";
import { createId } from "../domain/types.js";
import { validateAction } from "../engine/actionValidator.js";
import { transcribeInput } from "./stt.js";
import { synthesizeSpeech } from "./tts.js";

export function createVoiceDemoService(options = {}) {
  const sessions = new Map();
  const runtime = options.runtime || new GemmaRuntime(options.gemma || {});
  const now = options.now || (() => new Date().toISOString());

  return {
    sessions,
    async handleTurn(input = {}) {
      const sessionId = input.sessionId || input.session_id || createId("voice_sess");
      const session = getOrCreateSession(sessions, sessionId, now);
      const stt = await transcribeInput(input, options.stt || {});
      const event = createVoiceEvent({ sessionId, stt, input, now });

      session.events.push(event);

      const pipeline = runAgentPipeline({
        events: session.events,
        mode: "demo_assisted",
        sessionId,
        now,
      });
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
      const gemma = await runtime.generatePatch(frame);
      const patch = gemma.patch || null;
      const gemmaValidation = patch
        ? validateAction(toGuidanceCandidate(patch, pipeline.state, sessionId), pipeline.state)
        : null;
      const guidanceDecision = resolveGuidanceAction(stateAction, gemmaValidation);
      const guidanceAction = guidanceDecision.action;
      const spokenText = guidanceAction?.tts?.text || stateAction?.tts?.text || "";
      const tts = await synthesizeSpeech(spokenText, options.tts || {});
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
        guidance_action: guidanceAction,
        guidance_source: guidanceDecision.source,
        gemma,
        tts,
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
export function resolveGuidanceAction(stateAction, gemmaValidation) {
  if (stateAction && isCriticalFlowAction(stateAction)) {
    return { action: stateAction, source: "state_machine_critical" };
  }

  if (gemmaValidation?.action) {
    return {
      action: gemmaValidation.action,
      source: gemmaValidation.ok ? "gemma_agent" : "gemma_fallback",
    };
  }

  return { action: stateAction, source: "state_machine" };
}

export function isCriticalFlowAction(action) {
  if (action.priority === "critical") {
    return true;
  }

  const tools = Array.isArray(action.tool_actions)
    ? action.tool_actions
    : action.tool_action
      ? [action.tool_action]
      : [];
  return tools.length > 0;
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
    ttl_ms: 60000,
    metadata: {
      adult_likely: true,
      recording: true,
    },
  };
}

function createVoiceEvent({ sessionId, stt, input, now }) {
  const inferredDeviceState = inferDeviceState(stt.intent);
  const inferredCprQuality = inferCprQuality(stt.intent);

  return {
    schema_version: "perception_event.v0.1",
    event_id: createId("evt"),
    session_id: sessionId,
    timestamp: now(),
    mode: "demo_assisted",
    source: "stt",
    event_type: mapIntentToEventType(stt.intent),
    ttl_ms: 60000,
    user_input: {
      stt_text: stt.transcript,
      intent: stt.intent,
      confidence: stt.confidence,
    },
    patient_state: input.patientState || input.patient_state || null,
    cpr_quality: input.cprQuality || input.cpr_quality || inferredCprQuality,
    rescuer_state: input.rescuerState || input.rescuer_state || null,
    device_state: input.deviceState || input.device_state || inferredDeviceState,
    metadata: {
      ...(input.metadata || {}),
      audio: stt.audio,
    },
  };
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

function mapIntentToEventType(intent) {
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
