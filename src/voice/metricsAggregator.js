/**
 * 服务端 per-turn `metrics` 事件聚合器（P2 可观测性）。
 *
 * LiveSession 每个 guidance 段会 emit 一个 `metrics` 事件（延迟分项、TTS 缓存命中、
 * intent 来源、gemma skip/stale、以及 P0 安全复核计数）。该聚合器把这些事件汇总成
 * 一份可被 `/api/metrics` 读取的快照，用于真机延迟调参与回退率监控。
 *
 * 设计：纯内存、零依赖、有界。每个延迟指标保留最近 `sampleCap` 个样本做分位近似，
 * 避免长会话无界增长；计数器单调累加。`record()` 对非 metrics 事件是 no-op，便于
 * 直接挂在 LiveSession 的 `json` 事件上。
 */

const LATENCY_KEYS = Object.freeze([
  "stt_ms",
  "intent_resolution_ms",
  "agent_pipeline_ms",
  "gemma_ms",
  "open_question_answer_wait_ms",
  "tts_ms",
  "tts_first_chunk_ms",
  "total_ms",
]);

const DEFAULT_SAMPLE_CAP = 2000;

export function createMetricsAggregator(options = {}) {
  return new MetricsAggregator(options);
}

export class MetricsAggregator {
  constructor(options = {}) {
    this.sampleCap = Number.isFinite(options.sampleCap) && options.sampleCap > 0
      ? Math.floor(options.sampleCap)
      : DEFAULT_SAMPLE_CAP;
    this.reset();
  }

  reset() {
    this.turns = 0;
    this.autoAdvanceTurns = 0;
    this.latency = new Map();
    this.tts = { spoke: 0, cache_hit: 0, cache_miss: 0 };
    this.intentSources = new Map();
    this.gemma = { skipped: 0, stale: 0, live: 0, open_question: 0, open_question_cache_hit: 0 };
    this.openQuestion = { ack: 0, answer: 0, pending: 0, cache_hit: 0, fallback: 0, timeout: 0 };
    this.review = { triggered: 0, corrected: 0, breathing_polarity_flip: 0 };
    this.guidanceSources = new Map();
    this.startedAt = Date.now();
  }

  record(event) {
    if (!event || event.type !== "metrics") {
      return;
    }
    this.turns += 1;
    if (event.auto_advance === true) {
      this.autoAdvanceTurns += 1;
    }

    const timings = event.timings || {};
    for (const key of LATENCY_KEYS) {
      const value = Number(timings[key]);
      if (Number.isFinite(value)) {
        this.pushSample(key, value);
      }
    }

    const tts = event.tts || {};
    if (tts.spoke === true) {
      this.tts.spoke += 1;
    }
    if (tts.cache_hit === true) {
      this.tts.cache_hit += 1;
    } else if (tts.cache_hit === false && tts.spoke === true) {
      this.tts.cache_miss += 1;
    }

    const intentSource = event.intent?.source;
    if (intentSource) {
      bump(this.intentSources, intentSource);
    }

    const gemma = event.gemma || {};
    if (gemma.skipped === true) this.gemma.skipped += 1;
    if (gemma.stale === true) this.gemma.stale += 1;
    if (gemma.live === true) this.gemma.live += 1;
    if (gemma.open_question === true) this.gemma.open_question += 1;
    if (gemma.open_question_cache_hit === true) this.gemma.open_question_cache_hit += 1;

    const openQuestion = event.open_question;
    if (openQuestion && typeof openQuestion === "object") {
      if (openQuestion.segment === "ack") this.openQuestion.ack += 1;
      if (openQuestion.segment === "answer") this.openQuestion.answer += 1;
      if (openQuestion.pending === true) this.openQuestion.pending += 1;
      if (openQuestion.cache_hit === true) this.openQuestion.cache_hit += 1;
      if (openQuestion.fallback === true) this.openQuestion.fallback += 1;
      if (typeof openQuestion.reason === "string" && openQuestion.reason.includes("timeout")) {
        this.openQuestion.timeout += 1;
      }
    }

    const review = event.review;
    if (review) {
      if (review.triggered === true) this.review.triggered += 1;
      if (review.corrected === true) this.review.corrected += 1;
      if (review.breathing_polarity_flip === true) this.review.breathing_polarity_flip += 1;
    }

    if (event.guidance_source) {
      bump(this.guidanceSources, event.guidance_source);
    }
  }

  pushSample(key, value) {
    let arr = this.latency.get(key);
    if (!arr) {
      arr = [];
      this.latency.set(key, arr);
    }
    arr.push(value);
    if (arr.length > this.sampleCap) {
      arr.shift();
    }
  }

  snapshot() {
    const latency = {};
    for (const key of LATENCY_KEYS) {
      latency[key] = summarize(this.latency.get(key));
    }

    const ttsClassified = this.tts.cache_hit + this.tts.cache_miss;
    return {
      turns: this.turns,
      auto_advance_turns: this.autoAdvanceTurns,
      uptime_ms: Date.now() - this.startedAt,
      latency_ms: latency,
      tts: {
        ...this.tts,
        cache_hit_rate: ttsClassified > 0 ? round(this.tts.cache_hit / ttsClassified) : null,
      },
      intent_sources: mapToObject(this.intentSources),
      gemma: { ...this.gemma },
      open_question: { ...this.openQuestion },
      review: { ...this.review },
      guidance_sources: mapToObject(this.guidanceSources),
    };
  }
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function mapToObject(map) {
  const out = {};
  for (const [key, value] of map) {
    out[key] = value;
  }
  return out;
}

export function summarize(samples) {
  const arr = Array.isArray(samples) ? samples : [];
  if (arr.length === 0) {
    return { count: 0, p50: null, p95: null, max: null, mean: null };
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: round(sum / sorted.length),
  };
}

// Nearest-rank percentile on an ascending array (small per-session volume makes
// exact ranks fine and avoids interpolation surprises in tests).
export function percentile(sortedArr, p) {
  if (!sortedArr.length) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sortedArr.length);
  const index = Math.min(sortedArr.length - 1, Math.max(0, rank - 1));
  return sortedArr[index];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
