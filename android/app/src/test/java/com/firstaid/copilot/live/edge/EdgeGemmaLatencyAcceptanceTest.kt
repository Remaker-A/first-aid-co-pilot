package com.firstaid.copilot.live.edge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reuses [gemmaLatencyGate] / [LatencyStats] to express the plan's p50/p95
 * acceptance gates for the two on-device live paths:
 *
 *  - NLU (E): near-realtime target reuses [GEMMA_NEAR_REALTIME_GATE_MS] (1200ms),
 *    per-call budget [GEMMA_GENERATE_BUDGET_MS] (1500ms). Above the gate the
 *    recommendation is `ack_then_async` — the plan's "regex now, Gemma corrects
 *    next turn" degrade path.
 *  - Open question (C): the live acceptance ceiling for the *async answer wait*
 *    is 2000ms; the immediate CPR ack is deterministic and always first.
 */
class EdgeGemmaLatencyAcceptanceTest {

    /** Open-question async answer-wait ceiling for the 1-2s live target. */
    private val openQuestionAnswerGateMs = 2_000L

    @Test
    fun nluLatencyWithinNearRealtimeGateRecommendsNearRealtime() {
        // Representative on-device NLU short-answer latencies (GPU + speculative).
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(700L, 800L, 900L, 1_000L, 1_150L),
            totalRuns = 5,
        )

        assertEquals(GEMMA_NEAR_REALTIME_GATE_MS, gate.gateMs)
        assertEquals(GEMMA_GENERATE_BUDGET_MS, gate.budgetMs)
        assertEquals(900L, gate.stats.p50Ms)
        assertEquals(1_150L, gate.stats.p95Ms)
        assertTrue("p95 within the 1200ms near-realtime gate", gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_NEAR_REALTIME, gate.recommendation)
        assertEquals("all 5 within the 1500ms budget", 5, gate.withinBudgetRuns)
    }

    @Test
    fun nluLatencyAboveGateRecommendsAckThenAsyncCorrection() {
        // CPU-bound device: NLU is too slow to block the turn, so fall back to async correction.
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(900L, 1_000L, 1_300L, 1_400L, 1_800L),
            totalRuns = 5,
        )

        assertEquals(1_300L, gate.stats.p50Ms)
        assertEquals(1_800L, gate.stats.p95Ms)
        assertFalse("p95 exceeds the near-realtime gate", gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_ACK_THEN_ASYNC, gate.recommendation)
        assertEquals("1800ms run exceeds the 1500ms per-call budget", 4, gate.withinBudgetRuns)
    }

    @Test
    fun openQuestionAnswerWaitWithinAcceptanceGatePasses() {
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(900L, 1_200L, 1_500L, 1_700L, 1_900L),
            totalRuns = 5,
            gateMs = openQuestionAnswerGateMs,
            budgetMs = openQuestionAnswerGateMs,
        )

        assertEquals(1_500L, gate.stats.p50Ms)
        assertEquals(1_900L, gate.stats.p95Ms)
        assertTrue("answer-wait p95 under the 2000ms acceptance gate", gate.nearRealtimeCapable)
        assertEquals(5, gate.withinBudgetRuns)
    }

    @Test
    fun openQuestionAnswerWaitExceedingGateFails() {
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(1_200L, 1_700L, 2_100L, 2_500L, 2_800L),
            totalRuns = 5,
            gateMs = openQuestionAnswerGateMs,
            budgetMs = openQuestionAnswerGateMs,
        )

        assertEquals(2_800L, gate.stats.p95Ms)
        assertFalse("answer-wait p95 over 2000ms must fail the gate", gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_ACK_THEN_ASYNC, gate.recommendation)
        assertEquals("only 2 answers landed within 2000ms", 2, gate.withinBudgetRuns)
    }

    @Test
    fun aMissingAnswerForcesAckThenAsyncRegardlessOfFastSamples() {
        // 4 fast answers but 1 attempt produced nothing (timeout) -> unreliable -> ack + async.
        val gate = gemmaLatencyGate(
            okLatenciesMs = listOf(800L, 900L, 1_000L, 1_100L),
            totalRuns = 5,
            gateMs = openQuestionAnswerGateMs,
            budgetMs = openQuestionAnswerGateMs,
        )

        assertFalse(gate.allRunsOk)
        assertFalse(gate.nearRealtimeCapable)
        assertEquals(GemmaLatencyGate.RECOMMEND_ACK_THEN_ASYNC, gate.recommendation)
    }

    @Test
    fun latencyStatsComputeP50AndP95ForNluSamples() {
        // Cross-check the percentile math the gates rely on for NLU sample sets.
        val stats = LatencyStats.of(listOf(1_150L, 700L, 900L, 1_000L, 800L))
        assertEquals(5, stats.count)
        assertEquals(700L, stats.minMs)
        assertEquals(1_150L, stats.maxMs)
        assertEquals(900L, stats.p50Ms)
        assertEquals(1_150L, stats.p95Ms)
        assertEquals(percentileSorted(listOf(700L, 800L, 900L, 1_000L, 1_150L), 50.0), stats.p50Ms)
        assertEquals(percentileSorted(listOf(700L, 800L, 900L, 1_000L, 1_150L), 95.0), stats.p95Ms)
    }
}
