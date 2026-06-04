// Short-term governance for Gemma NLU calls.
//
// Two tiny, dependency-free, instance-scoped primitives:
//   * createNluCache  — an LRU + TTL cache of `transcript(+stage) -> result`
//     so an identical fuzzy utterance does not pay for a second 2.4GB CPU
//     inference.
//   * createNluBudget — a per-key sliding-window call budget so a session that
//     keeps missing the regex layer cannot hammer the model and starve the CPU.
//
// They are intentionally NOT module-level singletons: a voice service owns its
// own instances, which keeps state from bleeding across sessions or tests and
// makes the latency behavior deterministic and easy to unit-test.

export const DEFAULT_NLU_CACHE_MAX_ENTRIES = 64;
export const DEFAULT_NLU_CACHE_TTL_MS = 60_000;
export const DEFAULT_NLU_BUDGET_MAX_CALLS = 12;
export const DEFAULT_NLU_BUDGET_WINDOW_MS = 60_000;

const FIELD_SEPARATOR = "\u0000";

// Stage is part of the key because the same words ("他好像没气了") can be a
// different observation depending on which question the agent just asked.
export function nluCacheKey(transcript, stage) {
  const text = typeof transcript === "string" ? transcript.trim() : "";
  const stageKey = typeof stage === "string" && stage ? stage : "S0_INIT";
  return `${stageKey}${FIELD_SEPARATOR}${text}`;
}

export function createNluCache(options = {}) {
  const maxEntries = positiveInt(options.maxEntries ?? options.max_entries, DEFAULT_NLU_CACHE_MAX_ENTRIES);
  const ttlMs = positiveInt(options.ttlMs ?? options.ttl_ms, DEFAULT_NLU_CACHE_TTL_MS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const store = new Map();

  function dropExpired(reference) {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= reference) {
        store.delete(key);
      }
    }
  }

  return {
    get maxEntries() {
      return maxEntries;
    },
    get ttlMs() {
      return ttlMs;
    },
    get size() {
      return store.size;
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      // Touch for LRU recency.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    has(key) {
      return this.get(key) !== undefined;
    },
    set(key, value) {
      if (key === undefined || key === null) {
        return value;
      }
      const reference = now();
      if (store.has(key)) {
        store.delete(key);
      }
      store.set(key, { value, expiresAt: reference + ttlMs });
      if (store.size > maxEntries) {
        dropExpired(reference);
        while (store.size > maxEntries) {
          const oldest = store.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          store.delete(oldest);
        }
      }
      return value;
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

export function createNluBudget(options = {}) {
  const maxCalls = positiveInt(options.maxCalls ?? options.max_calls, DEFAULT_NLU_BUDGET_MAX_CALLS);
  const windowMs = positiveInt(options.windowMs ?? options.window_ms, DEFAULT_NLU_BUDGET_WINDOW_MS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const calls = new Map();

  function recent(key, reference) {
    const stamps = calls.get(key);
    if (!stamps) {
      return [];
    }
    const cutoff = reference - windowMs;
    const kept = stamps.filter((timestamp) => timestamp > cutoff);
    if (kept.length > 0) {
      calls.set(key, kept);
    } else {
      calls.delete(key);
    }
    return kept;
  }

  return {
    get maxCalls() {
      return maxCalls;
    },
    get windowMs() {
      return windowMs;
    },
    // Non-mutating: would the next call be allowed?
    canConsume(key = "__global__") {
      return recent(key, now()).length < maxCalls;
    },
    // Records a call and returns true when under budget; false (no record) when over.
    tryConsume(key = "__global__") {
      const reference = now();
      const kept = recent(key, reference);
      if (kept.length >= maxCalls) {
        return false;
      }
      kept.push(reference);
      calls.set(key, kept);
      return true;
    },
    used(key = "__global__") {
      return recent(key, now()).length;
    },
    reset(key) {
      if (key === undefined) {
        calls.clear();
      } else {
        calls.delete(key);
      }
    },
  };
}

// Bundles a cache + budget from a layered config: explicit options win, then
// environment variables, then the SSOT baseline (knowledge/nlu_slots.json's
// `nlu_runtime` block), then the built-in defaults. Either primitive can be
// disabled independently. Returns `{ cache, budget }` where a disabled
// primitive is `null` (and therefore ignored by the resolver).
export function createNluGovernor(options = {}) {
  const env = options.env || {};
  const baseline = isPlainObject(options.baseline) ? options.baseline : {};
  const cacheBase = isPlainObject(baseline.cache) ? baseline.cache : {};
  const budgetBase = isPlainObject(baseline.budget) ? baseline.budget : {};

  const cacheEnabled = parseFlag(
    firstDefined(options.nluCacheEnabled, options.nlu_cache, env.NLU_CACHE, cacheBase.enabled),
    true
  );
  const budgetEnabled = parseFlag(
    firstDefined(options.nluBudgetEnabled, options.nlu_budget, env.NLU_BUDGET, budgetBase.enabled),
    true
  );

  const cache = cacheEnabled
    ? createNluCache({
        maxEntries: firstPositive(
          options.nluCacheMaxEntries,
          env.NLU_CACHE_MAX_ENTRIES,
          cacheBase.max_entries,
          DEFAULT_NLU_CACHE_MAX_ENTRIES
        ),
        ttlMs: firstPositive(
          options.nluCacheTtlMs,
          env.NLU_CACHE_TTL_MS,
          cacheBase.ttl_ms,
          DEFAULT_NLU_CACHE_TTL_MS
        ),
      })
    : null;

  const budget = budgetEnabled
    ? createNluBudget({
        maxCalls: firstPositive(
          options.nluBudgetMaxCalls,
          env.NLU_BUDGET_MAX_CALLS,
          budgetBase.max_calls,
          DEFAULT_NLU_BUDGET_MAX_CALLS
        ),
        windowMs: firstPositive(
          options.nluBudgetWindowMs,
          env.NLU_BUDGET_WINDOW_MS,
          budgetBase.window_ms,
          DEFAULT_NLU_BUDGET_WINDOW_MS
        ),
      })
    : null;

  return { cache, budget };
}

function positiveInt(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return fallback;
}

function firstPositive(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return Math.floor(num);
    }
  }
  return undefined;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function parseFlag(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
