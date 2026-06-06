package com.firstaid.copilot.live

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveTurnMetricsTest {
    @Test
    fun parseLiveTurnMetricsReadsOpenQuestionLatencyAndRoute() {
        val metrics = parseLiveTurnMetrics(
            JSONObject()
                .put("type", "metrics")
                .put("turn_seq", 12)
                .put("current_stage", "S7_CPR_LOOP")
                .put("auto_advance", false)
                .put(
                    "timings",
                    JSONObject()
                        .put("total_ms", 104)
                        .put("gemma_ms", 0)
                        .put("tts_first_chunk_ms", 16),
                )
                .put(
                    "tts",
                    JSONObject()
                        .put("provider", "tts_cache")
                        .put("cache_hit", true)
                        .put("spoke", true),
                )
                .put(
                    "intent",
                    JSONObject()
                        .put("source", "open_question_ack")
                        .put("intent", "answer_current_cpr_question")
                        .put("fast_path", false),
                )
                .put(
                    "gemma",
                    JSONObject()
                        .put("skipped", true)
                        .put("skip_reason", "open_question_async")
                        .put("stale", false)
                        .put("live", false)
                        .put("open_question", true)
                        .put("timeout_ms", 1500),
                )
                .put(
                    "open_question",
                    JSONObject()
                        .put("segment", "answer")
                        .put("cache_hit", true)
                        .put("fallback", false)
                        .put("reason", "open_question_answered")
                        .put("wait_ms", 15)
                        .put("timeout_ms", 800),
                )
                .put("guidance_source", "open_question_ack"),
        )

        assertEquals(12, metrics.turnSeq)
        assertEquals("S7_CPR_LOOP", metrics.currentStage)
        assertFalse(metrics.autoAdvance)
        assertEquals(104L, metrics.timings["total_ms"])
        assertEquals(16L, metrics.timings["tts_first_chunk_ms"])
        assertEquals("tts_cache", metrics.tts.provider)
        assertTrue(metrics.tts.cacheHit == true)
        assertTrue(metrics.tts.spoke)
        assertEquals("answer_current_cpr_question", metrics.intent.intent)
        assertTrue(metrics.gemma.skipped)
        assertEquals("open_question_async", metrics.gemma.skipReason)
        assertTrue(metrics.gemma.openQuestion)
        assertEquals(1500L, metrics.gemma.timeoutMs)
        assertEquals("answer", metrics.openQuestion.segment)
        assertTrue(metrics.openQuestion.cacheHit == true)
        assertFalse(metrics.openQuestion.fallback)
        assertEquals("open_question_answered", metrics.openQuestion.reason)
        assertEquals(15L, metrics.openQuestion.waitMs)
        assertEquals(800L, metrics.openQuestion.timeoutMs)
        assertEquals("open_question_ack", metrics.guidanceSource)
    }
}
