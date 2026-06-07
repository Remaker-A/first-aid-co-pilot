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

    // region plain-text answer path (功能 C 选定方案：模型只回一句话，harness 组装)

    @Test
    fun textAnswerAcceptsPlainSentenceAndAssignsPrimaryIntent() {
        val decision = guard.validateOpenQuestionText("继续用力按压，肋骨响也正常。", cprFrame())

        assertTrue(decision.reasons.toString(), decision.accepted)
        // The harness assigns the stage's primary answer intent (model gave no label).
        assertEquals("answer_current_cpr_question", decision.intent)
        assertTrue(decision.ttsText.contains("继续用力按压"))
        assertEquals("calm_firm", decision.tone)
    }

    @Test
    fun textAnswerRejectsStopCompressionWordInCpr() {
        val decision = guard.validateOpenQuestionText("太累就先停下来歇一会儿。", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("stop_compression_word") })
    }

    @Test
    fun textAnswerAcceptsNegatedStopInCpr() {
        // "不要停下" is the safe "don't stop" phrasing (the app's own fallback uses it),
        // so the negated stop must not trip the CPR-live stop-compression guard.
        val decision = guard.validateOpenQuestionText("继续按压，不要停下。", cprFrame())

        assertTrue(decision.reasons.toString(), decision.accepted)
        assertTrue(decision.reasons.none { it.contains("stop_compression_word") })
    }

    @Test
    fun textAnswerRejectsBannedDiagnosis() {
        val decision = guard.validateOpenQuestionText("别怕，这是心梗，继续按压。", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("心梗") })
    }

    @Test
    fun textAnswerStillExtractsAnswerIfModelReturnsJson() {
        // Robustness: even if the model ignores "no JSON" and emits a fenced object,
        // the harness pulls the spoken sentence from tts.text.
        val json = "```json\n{\"intent\":\"x\",\"tts\":{\"text\":\"继续用力按压，等急救员接手。\"}}\n```"
        val decision = guard.validateOpenQuestionText(json, cprFrame())

        assertTrue(decision.reasons.toString(), decision.accepted)
        assertTrue(decision.ttsText.contains("继续用力按压"))
    }

    @Test
    fun textAnswerRejectsBlankOutput() {
        val decision = guard.validateOpenQuestionText("   \n  ", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.contains("empty_answer"))
    }

    @Test
    fun textAnswerRejectsLowValueUnknownAnswer() {
        val decision = guard.validateOpenQuestionText("继续按压，不知道。", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.contains("low_value_open_question_answer"))
    }

    @Test
    fun textAnswerRejectsMisleadingBreathingWording() {
        val decision = guard.validateOpenQuestionText("继续按压胸骨，保持呼吸。", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.contains("misleading_breathing_wording"))
    }

    @Test
    fun textAnswerRejectsDirectFamilyNoticeWording() {
        val decision = guard.validateOpenQuestionText("继续按压，请立即通知家属。", cprFrame())

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.contains("unsafe_family_notice_wording"))
    }

    // endregion

    // region post-rule supplement path (规则首答 + Gemma 简短补充)

    @Test
    fun supplementAcceptsShortAdditiveText() {
        val decision = guard.validateOpenQuestionSupplement(
            rawText = "按压是在维持血流。",
            frame = cprFrame(),
            fastAnswerText = "继续按压，不要停，我在。",
        )

        assertTrue(decision.reason.orEmpty(), decision.accepted)
        assertEquals("按压是在维持血流", decision.text)
    }

    @Test
    fun supplementRejectsOverEighteenChars() {
        val decision = guard.validateOpenQuestionSupplement(
            rawText = "按压是在帮助他维持血流直到急救员到来接手",
            frame = cprFrame(),
            fastAnswerText = "继续按压，不要停，我在。",
        )

        assertFalse(decision.accepted)
        assertTrue(decision.reason.orEmpty(), decision.reason.orEmpty().startsWith("tts_text_too_long"))
    }

    @Test
    fun supplementRejectsDangerousText() {
        val decision = guard.validateOpenQuestionSupplement(
            rawText = "这可能是心梗。",
            frame = cprFrame(),
            fastAnswerText = "继续按压，不要停，我在。",
        )

        assertFalse(decision.accepted)
        assertTrue(decision.reason.orEmpty(), decision.reason.orEmpty().contains("心梗"))
    }

    @Test
    fun supplementRejectsStopCompressionWordingInCpr() {
        val decision = guard.validateOpenQuestionSupplement(
            rawText = "可以先停一下。",
            frame = cprFrame(),
            fastAnswerText = "继续按压，不要停，我在。",
        )

        assertFalse(decision.accepted)
        assertTrue(decision.reason.orEmpty(), decision.reason.orEmpty().contains("stop_compression_word"))
    }

    @Test
    fun supplementRejectsDuplicateFastAnswer() {
        val decision = guard.validateOpenQuestionSupplement(
            rawText = "继续按压，注意 AED。",
            frame = cprFrame(),
            fastAnswerText = "继续按压，不要停，我在。",
        )

        assertFalse(decision.accepted)
        assertEquals("duplicate_fast_answer", decision.reason)
    }

    // endregion

    // region plain-text NLU label path (功能 E 选定方案：模型只回一个标签)

    private val breathingIntents = listOf("no_normal_breathing", "agonal_breathing", "clarify_breathing")

    @Test
    fun nluTextMatchesExactLabel() {
        val decision = guard.validateNluText("agonal_breathing", breathingIntents)

        assertTrue(decision.accepted)
        assertEquals("agonal_breathing", decision.intent)
        assertFalse(decision.needsClarification)
    }

    @Test
    fun nluTextMatchesLabelWrappedInExtraText() {
        val decision = guard.validateNluText("标签：agonal_breathing。", breathingIntents)

        assertTrue(decision.accepted)
        assertEquals("agonal_breathing", decision.intent)
    }

    @Test
    fun nluTextClarifyLabelSetsNeedsClarification() {
        val decision = guard.validateNluText("clarify_breathing", breathingIntents)

        assertTrue(decision.accepted)
        assertTrue(decision.needsClarification)
    }

    @Test
    fun nluTextRejectsSuspectedCardiacArrestRedLine() {
        val decision = guard.validateNluText("suspected_cardiac_arrest", breathingIntents)

        assertFalse(decision.accepted)
        assertTrue(decision.reasons.any { it.contains("suspected_cardiac_arrest") })
    }

    @Test
    fun nluTextRejectsUnmatchedLabel() {
        val decision = guard.validateNluText("我也说不好他怎么了", breathingIntents)

        assertFalse(decision.accepted)
    }

    // endregion
}
