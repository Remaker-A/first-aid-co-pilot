package com.firstaid.copilot.live.edge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Detection + per-stage policy parity with the server live driver. */
class EdgeOpenQuestionTest {

    @Test
    fun looksLikeOpenQuestion_trueForInterrogatives() {
        val questions = listOf(
            "我用力按会不会把肋骨压断？",
            "能不能停一下",
            "现在该怎么办",
            "AED 在哪里",
            "为什么要一直按",
            "这样按对吗？",
            "还要按多久呢",
        )
        questions.forEach { assertTrue("expected question: $it", EdgeOpenQuestionDetector.looksLikeOpenQuestion(it)) }
    }

    @Test
    fun looksLikeOpenQuestion_falseForReportsAndShort() {
        val statements = listOf(
            "按了三十下",
            "放好了",
            "我已经在按了",
            "好",
            "",
            "   ",
        )
        statements.forEach { assertFalse("expected statement: $it", EdgeOpenQuestionDetector.looksLikeOpenQuestion(it)) }
    }

    @Test
    fun openQuestionStage_onlyWhereAnswerIntentsExist() {
        listOf("S0_INIT", "S1_SCENE_SAFE", "S2_CHECK_RESPONSE", "S5_CALL_EMERGENCY", "S6_CPR_READY", "S7_CPR_LOOP", "S8_ASSISTANCE")
            .forEach { assertTrue("stage should open Q&A: $it", EdgeOpenQuestionPolicy.isOpenQuestionStage(it)) }
        // The tightly-gated breathing / arrest checks stay deterministic.
        listOf("S3_CHECK_BREATHING", "S4_SUSPECTED_ARREST", "S9_HANDOVER", null, "UNKNOWN")
            .forEach { assertFalse("stage should NOT open Q&A: $it", EdgeOpenQuestionPolicy.isOpenQuestionStage(it)) }
    }

    @Test
    fun answerIntents_matchServerPerStageSets() {
        assertEquals(
            listOf("answer_current_cpr_question", "encourage_rescuer", "calm_rescuer"),
            EdgeOpenQuestionPolicy.answerIntents("S7_CPR_LOOP"),
        )
        assertEquals(listOf("reassure_rescuer"), EdgeOpenQuestionPolicy.answerIntents("S2_CHECK_RESPONSE"))
        assertTrue(EdgeOpenQuestionPolicy.answerIntents("S3_CHECK_BREATHING").isEmpty())
    }

    @Test
    fun ackAndFallback_differBetweenCprAndNonCpr() {
        assertTrue(EdgeOpenQuestionPolicy.isCprLiveStage("S7_CPR_LOOP"))
        assertTrue(EdgeOpenQuestionPolicy.isCprLiveStage("S8_ASSISTANCE"))
        assertFalse(EdgeOpenQuestionPolicy.isCprLiveStage("S6_CPR_READY"))

        assertEquals(EdgeOpenQuestionPolicy.CPR_ACK_TEXT, EdgeOpenQuestionPolicy.ackText("S7_CPR_LOOP"))
        assertEquals(EdgeOpenQuestionPolicy.NON_CPR_ACK_TEXT, EdgeOpenQuestionPolicy.ackText("S2_CHECK_RESPONSE"))

        assertEquals(EdgeOpenQuestionPolicy.CPR_FALLBACK_TEXT, EdgeOpenQuestionPolicy.fallbackAnswer("S7_CPR_LOOP"))
        assertEquals(EdgeOpenQuestionPolicy.NON_CPR_FALLBACK_TEXT, EdgeOpenQuestionPolicy.fallbackAnswer("S5_CALL_EMERGENCY"))
    }

    @Test
    fun safetyPhrases_presentForCprLoop() {
        assertTrue(EdgeOpenQuestionPolicy.safetyPhrases("S7_CPR_LOOP").isNotEmpty())
        assertTrue(EdgeOpenQuestionPolicy.safetyPhrases("S3_CHECK_BREATHING").isEmpty())
    }
}
