package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveFastIntentRouterTest {
    @Test
    fun sceneSafetyAndBreathingHintsMatchCommonChinesePhrases() {
        assertEquals("scene_safe", inferLiveFastIntent("现场安全了")?.intent)
        assertEquals("no_normal_breathing", inferLiveFastIntent("他没有正常呼吸")?.intent)
        assertEquals("normal_breathing", inferLiveFastIntent("他有正常呼吸")?.intent)
    }

    @Test
    fun cprHotQuestionsProduceIntentHintsOnly() {
        val aed = inferLiveFastIntent("AED 来了怎么办")
        val stop = inferLiveFastIntent("我能不能停")

        assertEquals("ask_aed_help", aed?.intent)
        assertEquals("ask_can_stop", stop?.intent)
        assertTrue((aed?.confidence ?: 0.0) > 0.8)
        assertTrue((stop?.confidence ?: 0.0) > 0.8)
    }

    @Test
    fun blankTranscriptDoesNotInventIntent() {
        assertNull(inferLiveFastIntent(" "))
    }
}
