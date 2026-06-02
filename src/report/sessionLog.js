export class SessionLog {
  constructor({ sessionId = "sess_unknown", startedAt, now } = {}) {
    this.sessionId = sessionId;
    this.now = now || (() => new Date().toISOString());
    this.startedAt = startedAt || this.now();
    this.updatedAt = this.startedAt;
    this.sequence = 0;
    this.entries = [];
  }

  recordEvent(event = {}, state = {}) {
    return this.append("event", {
      event_id: event.event_id || null,
      event_type: event.event_type || null,
      source: event.source || null,
      mode: event.mode || null,
      stage_hint: event.stage_hint || null,
      raw_event: clone(event)
    }, state, {
      timestamp: event.timestamp
    });
  }

  recordState(state = {}, event = {}) {
    return this.append("state", {
      event_id: event.event_id || null,
      current_stage: state.current_stage || null,
      previous_stage: state.previous_stage || null,
      confirmed_facts: clone(state.confirmed_facts || {}),
      tool_state: clone(state.tool_state || {}),
      cpr_state: clone(state.cpr_state || {}),
      dialogue_state: clone(state.dialogue_state || {})
    }, state);
  }

  recordAction(action = {}, state = {}, validation = {}) {
    const entry = this.append("action", {
      action_id: action.action_id || null,
      intent: action.intent || null,
      priority: action.priority || null,
      source: action.source || null,
      validation: {
        ok: validation.ok !== false,
        violations: Array.isArray(validation.violations) ? validation.violations : []
      },
      action: clone(action)
    }, state, {
      timestamp: action.timestamp
    });

    if (action.log_event) {
      this.recordLogEvent(action.log_event, state, {
        related_action_id: action.action_id || null
      });
    }

    return entry;
  }

  recordLogEvent(logEvent = {}, state = {}, meta = {}) {
    return this.append("log_event", {
      type: logEvent.type || null,
      detail: logEvent.detail || null,
      related_action_id: meta.related_action_id || null,
      raw_log_event: clone(logEvent)
    }, state, {
      timestamp: logEvent.timestamp
    });
  }

  append(category, payload = {}, state = {}, options = {}) {
    const timestamp = options.timestamp || this.now();
    const entry = {
      log_id: `log_${String(this.sequence + 1).padStart(4, "0")}`,
      sequence_id: this.sequence + 1,
      session_id: this.sessionId,
      timestamp,
      category,
      stage: state.current_stage || payload.stage || null,
      payload: clone(payload)
    };

    this.sequence += 1;
    this.updatedAt = timestamp;
    this.entries.push(entry);
    return entry;
  }

  toJSON() {
    return {
      session_id: this.sessionId,
      started_at: this.startedAt,
      updated_at: this.updatedAt,
      entries: clone(this.entries),
      summary: summarizeEntries(this.entries)
    };
  }
}

export function createSessionLog(options = {}) {
  return new SessionLog(options);
}

export function summarizeEntries(entries = []) {
  const summary = {
    event_count: 0,
    action_count: 0,
    log_event_count: 0,
    state_count: 0,
    first_event_at: null,
    last_event_at: null,
    last_stage: null
  };

  for (const entry of entries) {
    if (entry.category === "event") {
      summary.event_count += 1;
      summary.first_event_at ||= entry.timestamp;
      summary.last_event_at = entry.timestamp;
    } else if (entry.category === "action") {
      summary.action_count += 1;
    } else if (entry.category === "log_event") {
      summary.log_event_count += 1;
    } else if (entry.category === "state") {
      summary.state_count += 1;
    }

    if (entry.stage) {
      summary.last_stage = entry.stage;
    }
  }

  return summary;
}

function clone(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
