package com.firstaid.copilot.live.edge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Production open-question guard (wraps the benchmark grader). */
class EdgeGuidanceGuardTest {

    private val guard = EdgeGuidanceGuard()

    private fun cprFrame(): OpenQuestionFrame =
        OpenQuestionFrame(
            stage = "S7_CPR_LOOP",
            userInput = "会不会把肋骨按断",
            allowedIntents = EdgeOpenQuestionPolicy.answerIntents("S7_CPR_LOOP"),
        )

    @Test
    fun acceptsValidShortAnswerAndExtractsFields() {
        val output =
            """{"intent":"answer_current_cpr_question","tts":{"text":"继续用力按压，等急救员接手。","tone":"calm_firm"},"ui":{"main_text":"继续按压","secondary_text":"等急救员接手"}}"""
        val decision = guard.validateOpenQuestion(output, cprFrame())

        assertTrue(decision.reasons.toString(), decision.accepted)
        assertEquals("answer_current_cpr_question", decision.intent)
        assertEquals("继续用力按压，等急救员接手。", decision.ttsText)
        assertEquals("继续按压", decision.mainText)
        assertEquals("calm_firm", decision.tone)
    }

    @Test
    fun rejectsBannedDiagnosisSubstring() {
        val output = """{"intent":"answer_current_cpr_question","tts":{"text":"这是心梗，快按。","tone":"calm_firm"},"ui":{}}"""
        val decision = guard.validateOpenQuestion(output, cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("心梗") })
    }

    @Test
    fun rejectsStopCompressionWordInCprLoop() {
        val output = """{"intent":"answer_current_cpr_question","tts":{"text":"累了可以停下来歇会儿。","tone":"calm_firm"},"ui":{}}"""
        val decision = guard.validateOpenQuestion(output, cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("stop_compression_word") })
    }

    @Test
    fun rejectsIntentOutsideStageAllowList() {
        val output = """{"intent":"advance_stage","tts":{"text":"继续按压。","tone":"calm_firm"},"ui":{}}"""
        val decision = guard.validateOpenQuestion(output, cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("intent_not_allowed") })
    }

    @Test
    fun rejectsOverlongAnswer() {
        val longText = "继续按压".repeat(12) // 48 chars > 40 cap
        val output = """{"intent":"encourage_rescuer","tts":{"text":"$longText","tone":"calm_firm"},"ui":{}}"""
        val decision = guard.validateOpenQuestion(output, cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("too_long") })
    }

    @Test
    fun rejectsNonJson() {
        val decision = guard.validateOpenQuestion("抱歉我不太确定", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.contains("json_parse_failed"))
    }

    @Test
    fun rejectsBlankTtsForAnswerIntent() {
        val output = """{"intent":"answer_current_cpr_question","tts":{"text":""},"ui":{}}"""
        val decision = guard.validateOpenQuestion(output, cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("tts_text") })
    }

    @Test
    fun nonCprStageAllowsReassureWithoutStopWordRule() {
        val frame = OpenQuestionFrame(
            stage = "S2_CHECK_RESPONSE",
            userInput = "我好慌",
            allowedIntents = EdgeOpenQuestionPolicy.answerIntents("S2_CHECK_RESPONSE"),
        )
        val output = """{"intent":"reassure_rescuer","tts":{"text":"先别慌，我陪你一步步来。","tone":"calm_soft"},"ui":{"main_text":"别慌"}}"""
        val decision = guard.validateOpenQuestion(output, frame)

        assertTrue(decision.reasons.toString(), decision.accepted)
        assertEquals("reassure_rescuer", decision.intent)
        assertEquals("calm_soft", decision.tone)
    }
}
