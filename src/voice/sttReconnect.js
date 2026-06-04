// Small, dependency-free policy that bounds streaming-STT auto-restart so a
// crashing recognizer can self-heal without turning into a restart storm.
//
// It only owns the counters and backoff math; the LiveSession owns the actual
// (re)spawn. Semantics:
//   - `canRestart()` is true while we are under the configured retry budget.
//   - `registerRestart()` records one attempt and returns the backoff delay the
//     caller should wait before respawning.
//   - `reset()` is called when a (re)connected recognizer becomes *stably*
//     ready, so a later unrelated crash gets a fresh budget instead of being
//     permanently degraded to the buffered fallback.
const DEFAULT_MAX_RESTARTS = 2;
const DEFAULT_BASE_DELAY_MS = 0;
const DEFAULT_MAX_DELAY_MS = 2000;
const DEFAULT_FACTOR = 2;

export function createSttReconnectPolicy(options = {}) {
  return new SttReconnectPolicy(options);
}

export class SttReconnectPolicy {
  constructor(options = {}) {
    this.maxRestarts = normalizeCount(options.maxRestarts, DEFAULT_MAX_RESTARTS);
    this.baseDelayMs = normalizeDelay(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = normalizeDelay(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
    this.factor =
      Number.isFinite(options.factor) && options.factor >= 1 ? options.factor : DEFAULT_FACTOR;
    this.attempts = 0;
  }

  canRestart() {
    return this.attempts < this.maxRestarts;
  }

  // Records one restart attempt; returns its 1-based index plus the backoff
  // delay (ms) the caller should wait before respawning the recognizer.
  registerRestart() {
    this.attempts += 1;
    return { attempt: this.attempts, delayMs: this.delayForAttempt(this.attempts) };
  }

  delayForAttempt(attempt) {
    if (this.baseDelayMs <= 0) {
      return 0;
    }
    const raw = this.baseDelayMs * this.factor ** Math.max(0, attempt - 1);
    return Math.min(this.maxDelayMs, Math.round(raw));
  }

  reset() {
    this.attempts = 0;
  }
}

function normalizeCount(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) {
    return Math.floor(num);
  }
  return fallback;
}

function normalizeDelay(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) {
    return num;
  }
  return fallback;
}
