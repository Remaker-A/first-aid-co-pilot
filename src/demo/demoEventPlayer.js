export const DEMO_MODES = Object.freeze([
  "demo_replay",
  "demo_assisted",
  "real_perception"
]);

export class DemoEventPlayer {
  constructor({
    script = [],
    mode = "demo_replay",
    sessionId = "sess_demo_001",
    startedAt = new Date().toISOString()
  } = {}) {
    this.script = normalizeScript(script);
    this.mode = normalizeMode(mode);
    this.sessionId = sessionId;
    this.startedAt = startedAt;
  }

  events() {
    return this.script.map((step, index) =>
      normalizeEvent(step, {
        mode: this.mode,
        sessionId: this.sessionId,
        startedAt: this.startedAt,
        sequenceId: index + 1
      })
    );
  }

  *[Symbol.iterator]() {
    yield* this.events();
  }
}

export function normalizeMode(mode) {
  return DEMO_MODES.includes(mode) ? mode : "demo_replay";
}

export function normalizeScript(script) {
  const steps = Array.isArray(script)
    ? script
    : Array.isArray(script?.events)
      ? script.events
      : Array.isArray(script?.steps)
        ? script.steps
        : [];

  return [...steps].sort((a, b) => getOffsetMs(a) - getOffsetMs(b));
}

export function normalizeEvent(step = {}, context = {}) {
  const offsetMs = getOffsetMs(step);
  const timestamp = step.timestamp || addMs(context.startedAt, offsetMs);
  const payload = step.event && typeof step.event === "object" ? step.event : step;

  return {
    ...payload,
    event_id:
      payload.event_id ||
      step.event_id ||
      `evt_demo_${String(context.sequenceId || 1).padStart(4, "0")}`,
    session_id: payload.session_id || context.sessionId,
    timestamp,
    mode: payload.mode || context.mode,
    source: payload.source || "demo_script",
    event_type: payload.event_type || step.event_type || "demo_script_event",
    stage_hint: payload.stage_hint || step.stage_hint || null,
    sequence_id: payload.sequence_id || context.sequenceId,
    ttl_ms: payload.ttl_ms ?? step.ttl_ms ?? 5000
  };
}

export function getOffsetMs(step = {}) {
  if (typeof step.offset_ms === "number") {
    return step.offset_ms;
  }

  if (typeof step.at_ms === "number") {
    return step.at_ms;
  }

  if (typeof step.time_ms === "number") {
    return step.time_ms;
  }

  if (typeof step.time === "string") {
    return parseClockOffset(step.time);
  }

  return 0;
}

function parseClockOffset(value) {
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) {
    return 0;
  }

  if (parts.length === 2) {
    return ((parts[0] * 60) + parts[1]) * 1000;
  }

  if (parts.length === 3) {
    return (((parts[0] * 60) + parts[1]) * 60 + parts[2]) * 1000;
  }

  return 0;
}

function addMs(isoString, offsetMs) {
  const base = new Date(isoString);
  if (Number.isNaN(base.valueOf())) {
    return new Date().toISOString();
  }

  return new Date(base.valueOf() + offsetMs).toISOString();
}
