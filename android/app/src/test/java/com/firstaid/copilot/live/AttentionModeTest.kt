package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Test

class AttentionModeTest {
    @Test
    fun s7CompressionFeedbackMapsToEyesOff() {
        val inputs = AttentionModeInputs(
            currentStage = "S7_CPR_LOOP",
            visualOverlayMode = "hand_position_feedback",
        )

        assertEquals(AttentionMode.EyesOff, inputs.toAttentionMode())
    }

    @Test
    fun s8AssistanceMapsToGlanceable() {
        val inputs = AttentionModeInputs(
            currentStage = "S8_ASSISTANCE",
            visualOverlayMode = "aed_assistance",
        )

        assertEquals(AttentionMode.Glanceable, inputs.toAttentionMode())
    }

    @Test
    fun legacyCprQualityFeedbackMapsToEyesOffInS7() {
        val inputs = AttentionModeInputs(
            currentStage = "S7_CPR_LOOP",
            visualOverlayMode = "cpr_quality_feedback",
        )

        assertEquals("rate_feedback", normalizeOverlayMode("cpr_quality_feedback"))
        assertEquals(AttentionMode.EyesOff, inputs.toAttentionMode())
    }

    @Test
    fun earlyStagesStayCoach() {
        val inputs = AttentionModeInputs(
            currentStage = "S3_CHECK_BREATHING",
            visualOverlayMode = "prepare_cpr_position",
        )

        assertEquals(AttentionMode.Coach, inputs.toAttentionMode())
    }
}
