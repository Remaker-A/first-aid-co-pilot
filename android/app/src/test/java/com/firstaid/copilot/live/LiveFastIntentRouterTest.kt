package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveFastIntentRouterTest {
    @Test
    fun noNormalBreathingButtonLabelDoesNotMatchNormalBreathing() {
        assertEquals("no_normal_breathing", inferLiveFastIntent("\u65e0\u6b63\u5e38\u547c\u5438")?.intent)
    }

    @Test
    fun primaryButtonActionsNormalizeToCanonicalIntents() {
        assertEquals("scene_safe", resolvePrimaryButtonIntent("mark_scene_safe"))
        assertEquals("patient_unresponsive", resolvePrimaryButtonIntent("mark_unresponsive"))
        assertEquals("no_normal_breathing", resolvePrimaryButtonIntent("mark_no_normal_breathing"))
        assertEquals("emergency_called", resolvePrimaryButtonIntent("mark_emergency_called"))
        assertEquals("continue_cpr", resolvePrimaryButtonIntent("mark_cpr_ready"))
    }

    @Test
    fun sceneSafetyAndBreathingHintsMatchCommonChinesePhrases() {
        assertEquals("scene_safe", inferLiveFastIntent("现场安全了")?.intent)
        assertEquals("scene_safe", inferLiveFastIntent("确认安全，我已经在患者身旁")?.intent)
        assertEquals("no_normal_breathing", inferLiveFastIntent("他没有正常呼吸")?.intent)
        assertEquals("no_normal_breathing", inferLiveFastIntent("胸口没有起伏")?.intent)
        assertEquals("no_normal_breathing", inferLiveFastIntent("他没气了")?.intent)
        assertEquals("normal_breathing", inferLiveFastIntent("他有正常呼吸")?.intent)
        assertEquals("agonal_breathing", inferLiveFastIntent("只是偶尔点头样呼吸")?.intent)
    }

    @Test
    fun responseCheckAnswersMatchButQuestionsDoNotCreateFacts() {
        assertEquals("patient_unresponsive", inferLiveFastIntent("他没有反应")?.intent)
        assertEquals("patient_unresponsive", inferLiveFastIntent("没反应")?.intent)
        assertEquals("patient_unresponsive", inferLiveFastIntent("还没有反应")?.intent)

        assertNull(inferLiveFastIntent("患者有没有反应"))
        assertNull(inferLiveFastIntent("有没有反应"))
        assertNull(inferLiveFastIntent("是否有反应"))
        assertNull(inferLiveFastIntent("有反应吗"))
    }

    @Test
    fun cprHotQuestionsProduceIntentHintsOnly() {
        val aedQuestion = inferLiveFastIntent("AED 怎么用")
        val aedAlternation = inferLiveFastIntent("AED 和按压怎么交替")
        val aedArrival = inferLiveFastIntent("AED 来了")
        val stop = inferLiveFastIntent("我能不能停")
        val naturalStop = inferLiveFastIntent("我们就一直按吗")
        val quality = inferLiveFastIntent("我爱的对吗")

        assertEquals("ask_aed_help", aedQuestion?.intent)
        assertEquals("ask_aed_cpr_alternation", aedAlternation?.intent)
        assertEquals("aed_available", aedArrival?.intent)
        assertEquals("ask_can_stop", stop?.intent)
        assertEquals("ask_can_stop", naturalStop?.intent)
        assertEquals("ask_cpr_quality", quality?.intent)
        assertTrue((aedQuestion?.confidence ?: 0.0) > 0.8)
        assertTrue((aedAlternation?.confidence ?: 0.0) > 0.8)
        assertTrue((aedArrival?.confidence ?: 0.0) > 0.8)
        assertTrue((stop?.confidence ?: 0.0) > 0.8)
        assertTrue((naturalStop?.confidence ?: 0.0) > 0.8)
        assertTrue((quality?.confidence ?: 0.0) > 0.8)
    }

    @Test
    fun cprHotQuestionsCoverNaturalStopAndAedAlternationVariants() {
        assertEquals("ask_can_stop", inferLiveFastIntent("还要继续按吗")?.intent)
        assertEquals("ask_can_stop", inferLiveFastIntent("按到什么时候")?.intent)
        assertEquals("ask_aed_cpr_alternation", inferLiveFastIntent("按压和 AED 怎么配合")?.intent)
        assertEquals("continue_cpr", inferLiveFastIntent("准备好了")?.intent)
        assertEquals("continue_cpr", inferLiveFastIntent("开始吧")?.intent)
        assertEquals("continue_cpr", inferLiveFastIntent("开始胸外按压")?.intent)
        assertEquals("continue_cpr", inferLiveFastIntent("怎么按压")?.intent)
        assertEquals("continue_cpr", inferLiveFastIntent("按压怎么做")?.intent)
        assertEquals("emergency_called", inferLiveFastIntent("已拨打 120")?.intent)
    }

    @Test
    fun emsArrivalPhrasesInclude120Arrived() {
        assertEquals("paramedics_arrived", inferLiveFastIntent("120 到了")?.intent)
        assertEquals("paramedics_arrived", inferLiveFastIntent("救护车到了")?.intent)
        assertEquals("paramedics_arrived", inferLiveFastIntent("医护人员赶到了")?.intent)
    }

    @Test
    fun cleanUnicodeResponseCheckPhrasesAreCovered() {
        assertEquals("patient_unresponsive", inferLiveFastIntent("\u6ca1\u53cd\u5e94")?.intent)
        assertEquals("patient_unresponsive", inferLiveFastIntent("\u6ca1\u6709\u56de\u5e94")?.intent)

        assertNull(inferLiveFastIntent("\u6709\u6ca1\u6709\u53cd\u5e94"))
        assertNull(inferLiveFastIntent("\u6709\u53cd\u5e94\u5417"))
    }

    @Test
    fun blankTranscriptDoesNotInventIntent() {
        assertNull(inferLiveFastIntent(" "))
    }
}
