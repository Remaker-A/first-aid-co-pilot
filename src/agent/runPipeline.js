import { DemoEventPlayer } from "../demo/demoEventPlayer.js";
import { AgentStage } from "../domain/stages.js";
import { createInitialSessionState } from "../domain/types.js";
import { advanceStateMachine } from "../engine/stateMachine.js";
import { validateAction } from "../engine/actionValidator.js";
import { sessionReducer } from "../engine/sessionReducer.js";
import { createSessionLog } from "../report/sessionLog.js";
import { generateHandoverReport } from "../report/handoverReportGenerator.js";

export function runAgentPipeline({
  events = [],
  mode = "demo_replay",
  sessionId = "sess_demo_001",
  now = () => new Date().toISOString()
} = {}) {
  const log = createSessionLog({ sessionId });
  let state = createInitialSessionState({ sessionId, mode, now });
  const actions = [];

  for (const event of events) {
    const reducedState = sessionReducer(state, event, { now });
    const transition = advanceStateMachine(reducedState, event, { now });
    state = applyTransition(reducedState, transition, now);
    log.recordEvent(event, state);
    log.recordState(state, event);

    const candidate = transition.action;
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
  now
} = {}) {
  const player = new DemoEventPlayer({ script, mode, sessionId });
  return runAgentPipeline({
    events: player.events(),
    mode,
    sessionId,
    now
  });
}
