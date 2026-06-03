export const CprStartDecision = Object.freeze({
  START_CPR: "START_CPR",
  PREPARE_EMERGENCY_CALL: "PREPARE_EMERGENCY_CALL",
  MONITOR_AND_CALL_HELP: "MONITOR_AND_CALL_HELP",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  RECHECK_ON_CONFLICT: "RECHECK_ON_CONFLICT",
});

export const CPR_START_REASON = Object.freeze({
  ADULT_SCOPE: "adult_scope",
  OUT_OF_SCOPE: "adult_scope_not_confirmed",
  UNRESPONSIVE: "unresponsive",
  RESPONSIVE: "responsive",
  NORMAL_BREATHING: "normal_breathing",
  NO_NORMAL_BREATHING: "no_normal_breathing",
  CONFLICT: "conflicting_facts",
});

export function decideCprStart(state = {}) {
  const scope = state.scope ?? {};
  const facts = state.confirmed_facts ?? {};

  if (hasRecheckConflict(facts)) {
    return CprStartDecision.RECHECK_ON_CONFLICT;
  }

  const adult = scope.adult_likely === true;
  const unresponsive = facts.responsive === false;
  const normalBreathing = facts.normal_breathing === true;
  const noNormalBreathing = facts.normal_breathing === false || facts.agonal_breathing === true;

  if (!adult) {
    return CprStartDecision.OUT_OF_SCOPE;
  }

  if (!unresponsive) {
    return CprStartDecision.MONITOR_AND_CALL_HELP;
  }

  if (normalBreathing) {
    return CprStartDecision.MONITOR_AND_CALL_HELP;
  }

  return noNormalBreathing
    ? CprStartDecision.START_CPR
    : CprStartDecision.PREPARE_EMERGENCY_CALL;
}

export function getCprStartReasonCodes(state = {}) {
  const scope = state.scope ?? {};
  const facts = state.confirmed_facts ?? {};
  const reasonCodes = [];

  if (hasRecheckConflict(facts)) {
    reasonCodes.push(CPR_START_REASON.CONFLICT);
  }

  reasonCodes.push(
    scope.adult_likely === true
      ? CPR_START_REASON.ADULT_SCOPE
      : CPR_START_REASON.OUT_OF_SCOPE,
  );

  if (facts.responsive === false) {
    reasonCodes.push(CPR_START_REASON.UNRESPONSIVE);
  } else if (facts.responsive === true) {
    reasonCodes.push(CPR_START_REASON.RESPONSIVE);
  }

  if (facts.normal_breathing === true) {
    reasonCodes.push(CPR_START_REASON.NORMAL_BREATHING);
  } else if (facts.normal_breathing === false || facts.agonal_breathing === true) {
    reasonCodes.push(CPR_START_REASON.NO_NORMAL_BREATHING);
  }

  return reasonCodes;
}

export function isStartCprDecision(decision) {
  return decision === CprStartDecision.START_CPR;
}

function hasRecheckConflict(facts) {
  if (facts.recheck_required === true) {
    return true;
  }

  if (Array.isArray(facts.conflicts) && facts.conflicts.length > 0) {
    return facts.conflicts.some((conflict) => conflict?.resolved !== true);
  }

  return false;
}

export default decideCprStart;
