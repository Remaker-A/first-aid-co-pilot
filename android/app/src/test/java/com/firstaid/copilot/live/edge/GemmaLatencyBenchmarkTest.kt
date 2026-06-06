package com.firstaid.copilot.live.edge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GemmaLatencyBenchmarkTest {
    @Test
    fun percentileUsesNearestRank() {
        val sorted = (1..10).map { (it * 100).toLong() } // 100..1000
        assertEquals(500L, percentileSorted(sorted, 50.0))
        assertEquals(1_000L, percentileSorted(sorted, 95.0))
        assertEquals(100L, percentileSorted(sorted, 0.0))
        assertEquals(1_000L, percentileSorted(sorted, 100.0))
    }

    @Test
    fun percentileHandlesSingleAndEmpty() {
        assertEquals(900L, percentileSorted(listOf(900L), 95.0))
        assertNull(percentileSorted(emptyList(), 50.0))
    }

    @Test
    fun statsSummarizeUnsortedInput() {
        val stats = LatencyStats.of(listOf(900L, 100L, 500L, 300L, 700L))
        assertEquals(5, stats.count)
        assertEquals(100L, stats.minMs)
        assertEquals(900L, stats.maxMs)
        assertEquals(500L, stats.p50Ms)
        assertEquals(900L, stats.p95Ms)
        assertEquals(500.0, stats.avgMs!!, 0.0001)
    }

    @Test
    fun statsOfEmptyIsEmpty() {
        assertEquals(LatencyStats.EMPTY, LatencyStats.of(emptyList()))
        assertNull(LatencyStats.EMPTY.p95Ms)
        assertEquals(0, LatencyStats.EMPTY.count)
    }

    @Test
    fun gatePassesWhenP95WithinThresholdAndAllRunsOk() {
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(800L, 900L, 1_000L, 1_100L, 1_150L),
            totalRuns = 5,
            gateMs = 1_200L,
            budgetMs = 1_500L,
        )
        assertTrue(gate.allRunsOk)
        assertEquals(1_150L, gate.stats.p95Ms)
        assertTrue(gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_NEAR_REALTIME, gate.recommendation)
        assertEquals(5, gate.withinBudgetRuns)
    }

    @Test
    fun gateFailsWhenP95ExceedsThreshold() {
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(900L, 1_000L, 1_300L, 1_400L, 1_800L),
            totalRuns = 5,
            gateMs = 1_200L,
            budgetMs = 1_500L,
        )
        assertFalse(gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_ACK_THEN_ASYNC, gate.recommendation)
        assertEquals(4, gate.withinBudgetRuns) // 1800 exceeds the 1500ms budget
    }

    @Test
    fun gateFailsWhenAnyRunMissing() {
        // Only 4 successes out of 5 attempts -> unreliable -> ack + async.
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(700L, 800L, 850L, 900L),
            totalRuns = 5,
            gateMs = 1_200L,
            budgetMs = 1_500L,
        )
        assertFalse(gate.allRunsOk)
        assertFalse(gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_ACK_THEN_ASYNC, gate.recommendation)
    }

    @Test
    fun gateWithNoSuccessesRecommendsAckThenAsync() {
        val gate = gemmaLatencyGate(okLatenciesMs = emptyList(), totalRuns = 3)
        assertEquals(0, gate.okRuns)
        assertNull(gate.stats.p95Ms)
        assertFalse(gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_ACK_THEN_ASYNC, gate.recommendation)
    }

    @Test
    fun gateUsesDefaultGateAndBudgetConstants() {
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(600L, 700L, 800L),
            totalRuns = 3,
        )
        assertEquals(GEMMA_NEAR_REALTIME_GATE_MS, gate.gateMs)
        assertEquals(GEMMA_GENERATE_BUDGET_MS, gate.budgetMs)
        assertTrue(gate.nearRealtimeCapable)
    }

    @Test
    fun gemmaBackendParserDefaultsToCpuOnly() {
        assertEquals(GemmaBackendPreference.CpuOnly, parseGemmaBackendPreference(null))
        assertEquals(GemmaBackendPreference.CpuOnly, parseGemmaBackendPreference("cpu-only"))
        assertEquals(GemmaBackendPreference.GpuOnly, parseGemmaBackendPreference("gpu-only"))
        assertEquals(GemmaBackendPreference.GpuThenCpu, parseGemmaBackendPreference("auto"))
    }

    @Test
    fun deterministicSamplerParserUsesGreedySettings() {
        assertNull(parseGemmaSamplerSettings(null))
        val sampler = parseGemmaSamplerSettings("deterministic")
        assertEquals(1, sampler?.topK)
        assertEquals(1.0, sampler?.topP ?: 0.0, 0.0001)
        assertEquals(0.0, sampler?.temperature ?: -1.0, 0.0001)
        assertEquals(0, sampler?.seed)
    }
}
