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
// non-critical wording supplement controlled by `options.useGemma`. As of this
// change the supplement defaults ON for live/CLI callers: omitting `useGemma`
// is treated as enabled. When enabled the pipeline must await Gemma, so it
// returns a Promise resolving to the result shape plus a `gemma` summary.
//
// Deterministic callers must OPT OUT with `useGemma:false`, which restores the
// fully synchronous, rule-only behavior (identical output, no model calls):
//   - demo replay (`runDemoPipeline` defaults useGemma:false) and its tests,
//   - the voice service, which deliberately consumes the deterministic
//     state-machine actions and layers its own Gemma supplement afterwards.
export function runAgentPipeline(options = {}) {
  const useGemma = options.useGemma ?? true;
  if (useGemma) {
    return runAgentPipelineWithGemma(options);
  }

  return runAgentPipelineSync(options);
}

// stepAgentTurn advances a single agent turn: it reduces the event into the
// session state, runs the state machine + rule feedback, validates the candidate
// action, and (when a Gemma `runtime` is supplied) layers the non-critical wording
// supplement. It returns `{ state, action, source, validation, transition }`, where
// `action` is `null` for turns that produce no guidance.
//
// This is the shared per-event core used by BOTH pipelines below, and is exported
// so closed-loop drivers (e.g. the scene simulator) can advance one event at a time.
//
// Sync/async dispatch mirrors `runAgentPipeline`:
//   - no `runtime`  -> fully synchronous, rule-only (returns a plain object),
//   - with `runtime` -> awaits the Gemma supplement (returns a Promise).
export function stepAgentTurn(state, event, options = {}) {
  const { runtime, now = defaultNow } = options;
  const sessionId = options.sessionId ?? state?.session_id ?? null;
  const stepped = stepStateMachine(state, event, now);
  const nextState = stepped.state;
  const candidate = stepped.transition.action;

  if (runtime) {
    return stepAgentTurnWithGemma({
      nextState,
      candidate,
      event,
      runtime,
      sessionId,
      transition: stepped.transition
    });
  }

  return stepAgentTurnRuleOnly({ nextState, candidate, transition: stepped.transition });
}

function stepAgentTurnRuleOnly({ nextState, candidate, transition }) {
  if (!candidate) {
    return { state: nextState, action: null, source: null, validation: null, transition };
  }

  const validation = validateAction(candidate, nextState);
  return {
    state: nextState,
    action: validation.action,
    source: validation.action?.source ?? "state_machine",
    validation,
    transition
  };
}

async function stepAgentTurnWithGemma({ nextState, candidate, event, runtime, sessionId, transition }) {
  if (!candidate) {
    return { state: nextState, action: null, source: null, validation: null, transition };
  }

  const stateValidation = validateAction(candidate, nextState);
  const decision = await supplementWithGemma({
    stateAction: stateValidation.action,
    stateValidation,
    state: nextState,
    event,
    runtime,
    sessionId
  });

  return {
    state: nextState,
    action: decision.action,
    source: decision.source,
    validation: decision.validation,
    gemmaFallbackReason: decision.gemmaFallbackReason ?? null,
    gemmaViolations: decision.gemmaViolations ?? [],
    transition
  };
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
    const turn = stepAgentTurn(state, event, { now });
    state = turn.state;
    log.recordEvent(event, state);
    log.recordState(state, event);

    if (!turn.action) {
      continue;
    }

    actions.push(turn.action);
    log.recordAction(turn.action, state, turn.validation);
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
    const turn = await stepAgentTurn(state, event, { runtime, sessionId, now });
    state = turn.state;
    log.recordEvent(event, state);
    log.recordState(state, event);

    if (!turn.action) {
      continue;
    }

    actions.push(turn.action);
    log.recordAction(turn.action, state, turn.validation);
    guidance.push({
      stage: state.current_stage,
      intent: turn.action.intent,
      source: turn.source,
      gemma_fallback_reason: turn.gemmaFallbackReason ?? null,
      gemma_violations: turn.gemmaViolations ?? []
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
