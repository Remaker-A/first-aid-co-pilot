import { DemoEventPlayer } from "../demo/demoEventPlayer.js";
import { AgentStage } from "../domain/stages.js";
import { createInitialSessionState } from "../domain/types.js";
import { advanceStateMachine } from "../engine/stateMachine.js";
import { validateAction } from "../engine/actionValidator.js";
import { sessionReducer } from "../engine/sessionReducer.js";
import { createSessionLog } from "../report/sessionLog.js";
import { generateHandoverReport } from "../report/handoverReportGenerator.js";
import { createDecisionFrame } from "../gemma/decisionFrame.js";
import { GemmaRuntime } from "../gemma/runtime.js";

const defaultNow = () => new Date().toISOString();

// runAgentPipeline keeps the medical flow rule-driven. Gemma is an OPTIONAL,
// non-critical wording supplement controlled by `options.useGemma` (default
// false). When the flag is off, the pipeline behaves EXACTLY as before and runs
// synchronously, returning the result object directly. When the flag is on it
// must await Gemma, so it returns a Promise resolving to the same shape (plus a
// `gemma` summary). Existing callers (voice service, demo replay tests, demo
// CLI) never pass useGemma, so they keep the synchronous contract untouched.
export function runAgentPipeline(options = {}) {
  if (options.useGemma) {
    return runAgentPipelineWithGemma(options);
  }

  return runAgentPipelineSync(options);
}

function runAgentPipelineSync({
  events = [],
  mode = "demo_replay",
  sessionId = "sess_demo_001",
  now = defaultNow
} = {}) {
  const log = createSessionLog({ sessionId });
  let state = createInitialSessionState({ sessionId, mode, now });
  const actions = [];

  for (const event of events) {
    const stepped = stepStateMachine(state, event, now);
    state = stepped.state;
    log.recordEvent(event, state);
    log.recordState(state, event);

    const candidate = stepped.transition.action;
    if (!candidate) {
      continue;
    }

    const validation = validateAction(candidate, state);
    const action = validation.action;
    actions.push(action);
    log.recordAction(action, state, validation);
  }

  return {
    state,
    actions,
    log: log.toJSON(),
    report: generateHandoverReport(log.toJSON(), state)
  };
}

// Async variant that lets Gemma supplement wording on non-critical turns. The
// state machine still owns the medical flow: critical / tool-bearing actions are
// dispatched as-is, every Gemma patch is run through the ActionValidator, and if
// Gemma is unavailable or returns an invalid patch we fall back seamlessly to the
// validated state-machine action (i.e. identical to the no-Gemma behavior).
export async function runAgentPipelineWithGemma({
  events = [],
  mode = "demo_assisted",
  sessionId = "sess_demo_001",
  now = defaultNow,
  gemmaRuntime,
  gemma
} = {}) {
  const runtime = gemmaRuntime || new GemmaRuntime(gemma || {});
  const log = createSessionLog({ sessionId });
  let state = createInitialSessionState({ sessionId, mode, now });
  const actions = [];
  const guidance = [];

  for (const event of events) {
    const stepped = stepStateMachine(state, event, now);
    state = stepped.state;
    log.recordEvent(event, state);
    log.recordState(state, event);

    const candidate = stepped.transition.action;
    if (!candidate) {
      continue;
    }

    const stateValidation = validateAction(candidate, state);
    const stateAction = stateValidation.action;

    const decision = await supplementWithGemma({
      stateAction,
      stateValidation,
      state,
      event,
      runtime,
      sessionId
    });

    actions.push(decision.action);
    log.recordAction(decision.action, state, decision.validation);
    guidance.push({
      stage: state.current_stage,
      intent: decision.action.intent,
      source: decision.source,
      gemma_fallback_reason: decision.gemmaFallbackReason ?? null,
      gemma_violations: decision.gemmaViolations ?? []
    });
  }

  return {
    state,
    actions,
    log: log.toJSON(),
    report: generateHandoverReport(log.toJSON(), state),
    gemma: { used: true, guidance }
  };
}

async function supplementWithGemma({ stateAction, stateValidation, state, event, runtime, sessionId }) {
  // Critical / tool-bearing flow stays fully state-machine-driven.
  if (isCriticalFlowAction(stateAction)) {
    return { action: stateAction, validation: stateValidation, source: "state_machine_critical" };
  }

  let gemmaResult = null;
  try {
    const frame = createDecisionFrame({
      state,
      event,
      userInput: event?.user_input
    });
    gemmaResult = await runtime.generatePatch(frame);
  } catch (error) {
    return {
      action: stateAction,
      validation: stateValidation,
      source: "state_machine",
      gemmaFallbackReason: error?.message || "gemma_runtime_error"
    };
  }

  // Gemma unavailable (model missing, CLI failure, invalid JSON, ...) -> keep the
  // validated state-machine action so behavior is identical to the no-Gemma path.
  if (!gemmaResult || gemmaResult.fallback || !gemmaResult.patch) {
    return {
      action: stateAction,
      validation: stateValidation,
      source: "state_machine",
      gemmaFallbackReason: gemmaResult?.fallbackReason || gemmaResult?.reason || null
    };
  }

  const gemmaValidation = validateAction(
    toGemmaGuidanceCandidate(gemmaResult.patch, state, sessionId),
    state
  );

  // Gemma may only supplement when it produces a patch that passes the
  // ActionValidator. An invalid patch never overrides the rule-driven action.
  if (gemmaValidation.ok) {
    return { action: gemmaValidation.action, validation: gemmaValidation, source: "gemma_agent" };
  }

  return {
    action: stateAction,
    validation: stateValidation,
    source: "state_machine",
    gemmaViolations: gemmaValidation.violations || []
  };
}

// Mirrors voice/service.js isCriticalFlowAction. Kept local (not exported) so the
// `src/index.js` star re-exports do not collide with the voice module's export.
function isCriticalFlowAction(action) {
  if (!action) {
    return false;
  }

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

function toGemmaGuidanceCandidate(patch, state, sessionId) {
  return {
    ...patch,
    session_id: sessionId,
    stage: state.current_stage,
    source: "gemma_agent",
    priority: "normal",
    reason_codes: patch.reason ? [patch.reason] : [],
    log_event: {
      type: patch.log_suggestion?.type || patch.intent || "gemma_patch",
      detail: patch.log_suggestion?.detail || patch.reason || patch.intent || "gemma_patch"
    }
  };
}

function stepStateMachine(state, event, now) {
  const reducedState = sessionReducer(state, event, { now });
  const transition = advanceStateMachine(reducedState, event, { now });
  return {
    state: applyTransition(reducedState, transition, now),
    transition
  };
}

function applyTransition(state, transition, now) {
  if (!transition?.next_stage) {
    return state;
  }

  const currentStage = state.current_stage ?? transition.current_stage;
  const nextStage = transition.next_stage;
  const next = {
    ...state,
    previous_stage: currentStage,
    current_stage: nextStage,
    updated_at: now(),
    confirmed_facts: { ...(state.confirmed_facts ?? {}) },
    tool_state: { ...(state.tool_state ?? {}) },
    cpr_state: { ...(state.cpr_state ?? {}) },
  };

  if (
    [
      AgentStage.S4_SUSPECTED_ARREST,
      AgentStage.S5_CALL_EMERGENCY,
      AgentStage.S6_CPR_READY,
      AgentStage.S7_CPR_LOOP,
      AgentStage.S8_ASSISTANCE,
      AgentStage.S9_HANDOVER,
    ].includes(nextStage)
  ) {
    next.confirmed_facts.suspected_cardiac_arrest = true;
  }

  if (nextStage === AgentStage.S9_HANDOVER) {
    next.tool_state.handover_generated = true;
  }

  return next;
}

export function runDemoPipeline({
  script,
  mode = "demo_replay",
  sessionId = "sess_demo_001",
  now,
  useGemma = false,
  gemma,
  gemmaRuntime
} = {}) {
  const player = new DemoEventPlayer({ script, mode, sessionId });
  return runAgentPipeline({
    events: player.events(),
    mode,
    sessionId,
    now,
    useGemma,
    gemma,
    gemmaRuntime
  });
}
