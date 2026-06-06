package com.firstaid.copilot.live

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveAsrFinalGateTest {
    @Test
    fun rejectsAsrFinalWhileAssistantIsSpeakingOrServerAudioIsPlaying() {
        val gate = LiveAsrFinalGate()

        assertFalse(
            gate.shouldAccept(
                text = "没有呼吸",
                state = LiveUiState(micState = MicState.Speaking),
                nowMs = 1_000L,
            ),
        )

        assertFalse(
            gate.shouldAccept(
                text = "没有呼吸",
                state = LiveUiState(isLiveAudioPlaying = true),
                nowMs = 1_100L,
            ),
        )
    }

    @Test
    fun allowsCriticalUnresponsiveFinalDuringResponseCheckPlayback() {
        val gate = LiveAsrFinalGate()
        val state = LiveUiState(
            currentStage = "S2_CHECK_RESPONSE",
            micState = MicState.Speaking,
            isLiveAudioPlaying = true,
        )

        assertTrue(
            gate.shouldAccept(
                text = "没有反应",
                state = state,
                nowMs = 1_000L,
                intent = "patient_unresponsive",
                confidence = 0.86,
            ),
        )
        assertFalse(
            gate.shouldAccept(
                text = "没有 反应。",
                state = state,
                nowMs = 1_200L,
                intent = "patient_unresponsive",
                confidence = 0.86,
            ),
        )
    }

    @Test
    fun keepsPlaybackGateClosedForLowConfidenceOrWrongStage() {
        val gate = LiveAsrFinalGate()

        assertFalse(
            gate.shouldAccept(
                text = "没有反应",
                state = LiveUiState(currentStage = "S2_CHECK_RESPONSE", micState = MicState.Speaking),
                nowMs = 1_000L,
                intent = "patient_unresponsive",
                confidence = 0.6,
            ),
        )
        assertFalse(
            gate.shouldAccept(
                text = "没有反应",
                state = LiveUiState(currentStage = "S3_CHECK_BREATHING", micState = MicState.Speaking),
                nowMs = 1_100L,
                intent = "patient_unresponsive",
                confidence = 0.86,
            ),
        )
    }

    @Test
    fun dropsShortWindowDuplicateButAllowsLaterRepeat() {
        val gate = LiveAsrFinalGate(duplicateWindowMs = 4_000L)
        val state = LiveUiState(micState = MicState.Listening)

        assertTrue(gate.shouldAccept("没有呼吸", state, nowMs = 1_000L))
        assertFalse(gate.shouldAccept("没有 呼吸。", state, nowMs = 2_000L))
        assertTrue(gate.shouldAccept("没有呼吸", state, nowMs = 5_500L))
    }

    @Test
    fun resetAllowsSameFinalAgainImmediately() {
        val gate = LiveAsrFinalGate(duplicateWindowMs = 4_000L)
        val state = LiveUiState(micState = MicState.Listening)

        assertTrue(gate.shouldAccept("开始", state, nowMs = 1_000L))
        gate.reset()
        assertTrue(gate.shouldAccept("开始", state, nowMs = 1_100L))
    }
}
