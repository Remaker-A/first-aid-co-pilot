import assert from "node:assert/strict";
import test from "node:test";
import {
  createMetricsAggregator,
  summarize,
  percentile,
} from "../src/voice/metricsAggregator.js";

function metricsEvent(overrides = {}) {
  return {
    type: "metrics",
    timings: { total_ms: 100 },
    tts: { spoke: true, cache_hit: true },
    intent: { source: "rule_fast_path" },
    gemma: {},
    review: null,
    guidance_source: "rule_flow_fast_path",
    ...overrides,
  };
}

test("percentile uses nearest-rank and handles empty input", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 100);
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile([], 50), null);
});

test("summarize reports count/p50/p95/max/mean", () => {
  assert.deepEqual(summarize([]), { count: 0, p50: null, p95: null, max: null, mean: null });
  const s = summarize([100, 200, 300]);
  assert.equal(s.count, 3);
  assert.equal(s.max, 300);
  assert.equal(s.mean, 200);
  assert.equal(s.p50, 200);
});

test("ignores non-metrics events", () => {
  const agg = createMetricsAggregator();
  agg.record({ type: "final", text: "他没有反应" });
  agg.record(null);
  agg.record(undefined);
  assert.equal(agg.snapshot().turns, 0);
});

test("aggregates latency, tts hit-rate, intent sources, gemma, open questions, review, guidance", () => {
  const agg = createMetricsAggregator();
  agg.record(metricsEvent({ timings: { total_ms: 100, gemma_ms: 50 }, tts: { spoke: true, cache_hit: true } }));
  agg.record(metricsEvent({ timings: { total_ms: 300, gemma_ms: 90 }, tts: { spoke: true, cache_hit: false } }));
  agg.record(
    metricsEvent({
      timings: { total_ms: 200, open_question_answer_wait_ms: 40 },
      tts: { spoke: true, cache_hit: true },
      intent: { source: "gemma_nlu" },
      gemma: { skipped: true, stale: true, open_question: true, open_question_cache_hit: true },
      open_question: { segment: "answer", pending: true, cache_hit: true, fallback: true, reason: "gemma_open_question_timeout" },
      review: { triggered: true, corrected: true, breathing_polarity_flip: true },
      guidance_source: "state_machine_critical",
      auto_advance: true,
    })
  );
  agg.record(
    metricsEvent({
      timings: { total_ms: 40 },
      tts: { spoke: true, cache_hit: true },
      gemma: { open_question: true },
      open_question: { segment: "ack", cache_hit: null },
      guidance_source: "open_question_ack",
    })
  );

  const snap = agg.snapshot();
  assert.equal(snap.turns, 4);
  assert.equal(snap.auto_advance_turns, 1);

  // latency: total_ms collected on all 4, gemma_ms on 2, open-question wait on 1.
  assert.equal(snap.latency_ms.total_ms.count, 4);
  assert.equal(snap.latency_ms.total_ms.max, 300);
  assert.equal(snap.latency_ms.gemma_ms.count, 2);
  assert.equal(snap.latency_ms.open_question_answer_wait_ms.count, 1);

  // tts: 3 cache hits, 1 miss → hit-rate 3/4.
  assert.equal(snap.tts.cache_hit, 3);
  assert.equal(snap.tts.cache_miss, 1);
  assert.equal(snap.tts.cache_hit_rate, round2(3 / 4));

  // intent source fallback distribution.
  assert.equal(snap.intent_sources.rule_fast_path, 3);
  assert.equal(snap.intent_sources.gemma_nlu, 1);

  // gemma + open-question + review + guidance counters.
  assert.equal(snap.gemma.skipped, 1);
  assert.equal(snap.gemma.stale, 1);
  assert.equal(snap.gemma.open_question, 2);
  assert.equal(snap.gemma.open_question_cache_hit, 1);
  assert.equal(snap.open_question.answer, 1);
  assert.equal(snap.open_question.ack, 1);
  assert.equal(snap.open_question.pending, 1);
  assert.equal(snap.open_question.cache_hit, 1);
  assert.equal(snap.open_question.fallback, 1);
  assert.equal(snap.open_question.timeout, 1);
  assert.equal(snap.review.triggered, 1);
  assert.equal(snap.review.corrected, 1);
  assert.equal(snap.review.breathing_polarity_flip, 1);
  assert.equal(snap.guidance_sources.rule_flow_fast_path, 2);
  assert.equal(snap.guidance_sources.state_machine_critical, 1);
  assert.equal(snap.guidance_sources.open_question_ack, 1);
});

test("latency samples are bounded by sampleCap", () => {
  const agg = createMetricsAggregator({ sampleCap: 5 });
  for (let i = 1; i <= 50; i += 1) {
    agg.record(metricsEvent({ timings: { total_ms: i } }));
  }
  const snap = agg.snapshot();
  assert.equal(snap.turns, 50);
  // Only the most recent 5 samples are retained (46..50), so max stays 50 and count caps at 5.
  assert.equal(snap.latency_ms.total_ms.count, 5);
  assert.equal(snap.latency_ms.total_ms.max, 50);
});

function round2(value) {
  return Math.round(value * 100) / 100;
}
