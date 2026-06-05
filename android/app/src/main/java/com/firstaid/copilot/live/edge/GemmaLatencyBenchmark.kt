package com.firstaid.copilot.live.edge

import kotlin.math.ceil

/**
 * W0 latency-baseline helpers for the on-device Gemma short-answer benchmark.
 *
 * These are intentionally free of Android/`org.json` dependencies so the p50/p95
 * math and the near-realtime decision gate can be exercised by plain JVM unit tests.
 */

/** Near-realtime gate for open Q&A (WB): short-answer p95 must be at or below this. */
const val GEMMA_NEAR_REALTIME_GATE_MS: Long = 1_200L

/** Production generation budget configured on [OnDeviceGemmaDriver.generate] (GPU + speculative). */
const val GEMMA_GENERATE_BUDGET_MS: Long = 1_500L

/** Generous per-call ceiling used only while benchmarking so true latency is captured, not clipped. */
const val GEMMA_BENCH_TIMEOUT_MS: Long = 10_000L

/** Representative open-question prompt that elicits a short, spoken-style answer. */
const val GEMMA_BENCH_DEFAULT_PROMPT: String =
    "\u4f60\u662f\u6025\u6551\u8bed\u97f3\u52a9\u624b\u3002\u7528\u4e00\u53e5\u4e0d\u8d85\u8fc715\u4e2a\u5b57\u7684\u4e2d\u6587\u56de\u7b54\uff1a" +
        "\u6210\u4eba\u5fc3\u80ba\u590d\u82cf\u7684\u6309\u538b\u9891\u7387\u662f\u591a\u5c11\uff1f"

/** Aggregate latency distribution (milliseconds) over a set of measured runs. */
data class LatencyStats(
    val count: Int,
    val avgMs: Double?,
    val minMs: Long?,
    val maxMs: Long?,
    val p50Ms: Long?,
    val p95Ms: Long?,
) {
    companion object {
        val EMPTY = LatencyStats(count = 0, avgMs = null, minMs = null, maxMs = null, p50Ms = null, p95Ms = null)

        /** Summarize an (unsorted) list of latencies; empty input yields [EMPTY]. */
        fun of(latenciesMs: List<Long>): LatencyStats {
            if (latenciesMs.isEmpty()) return EMPTY
            val sorted = latenciesMs.sorted()
            return LatencyStats(
                count = sorted.size,
                avgMs = sorted.sum().toDouble() / sorted.size,
                minMs = sorted.first(),
                maxMs = sorted.last(),
                p50Ms = percentileSorted(sorted, 50.0),
                p95Ms = percentileSorted(sorted, 95.0),
            )
        }
    }
}

/**
 * Nearest-rank percentile over an ascending-sorted list of latencies.
 *
 * `p <= 0` returns the min, `p >= 100` returns the max, and empty input returns null.
 */
fun percentileSorted(sortedAsc: List<Long>, percentile: Double): Long? {
    if (sortedAsc.isEmpty()) return null
    val p = percentile.coerceIn(0.0, 100.0)
    val rank = ceil(p / 100.0 * sortedAsc.size).toInt().coerceIn(1, sortedAsc.size)
    return sortedAsc[rank - 1]
}

/**
 * W0 decision gate: can open Q&A (WB) answer near-realtime on-device, or must it always
 * fall back to "instant ack + async answer"?
 */
data class GemmaLatencyGate(
    val gateMs: Long,
    val budgetMs: Long,
    val totalRuns: Int,
    val okRuns: Int,
    val withinBudgetRuns: Int,
    val stats: LatencyStats,
) {
    /** Every measured run produced an answer. */
    val allRunsOk: Boolean
        get() = totalRuns > 0 && okRuns == totalRuns

    /** p95 of successful short answers is at or under the gate AND every run succeeded. */
    val nearRealtimeCapable: Boolean
        get() = allRunsOk && (stats.p95Ms?.let { it <= gateMs } == true)

    /** Machine-readable WB routing recommendation. */
    val recommendation: String
        get() = if (nearRealtimeCapable) RECOMMEND_NEAR_REALTIME else RECOMMEND_ACK_THEN_ASYNC

    companion object {
        const val RECOMMEND_NEAR_REALTIME = "near_realtime_ok"
        const val RECOMMEND_ACK_THEN_ASYNC = "ack_then_async"
    }
}

/** Build the W0 gate from the successful-run latencies plus the total attempts. */
fun gemmaLatencyGate(
    okLatenciesMs: List<Long>,
    totalRuns: Int,
    gateMs: Long = GEMMA_NEAR_REALTIME_GATE_MS,
    budgetMs: Long = GEMMA_GENERATE_BUDGET_MS,
): GemmaLatencyGate =
    GemmaLatencyGate(
        gateMs = gateMs,
        budgetMs = budgetMs,
        totalRuns = totalRuns,
        okRuns = okLatenciesMs.size,
        withinBudgetRuns = okLatenciesMs.count { it <= budgetMs },
        stats = LatencyStats.of(okLatenciesMs),
    )
