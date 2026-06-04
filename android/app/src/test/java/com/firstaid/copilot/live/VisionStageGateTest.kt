package com.firstaid.copilot.live

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VisionStageGateTest {
    @Test
    fun liveCprRecognitionOnlyInjectsDuringCprLoop() {
        assertFalse(isCprLiveRecognitionStage(null))
        assertFalse(isCprLiveRecognitionStage("S6_CPR_READY"))
        assertTrue(isCprLiveRecognitionStage("S7_CPR_LOOP"))
        assertFalse(isCprLiveRecognitionStage("S8_ASSISTANCE"))
    }
}
