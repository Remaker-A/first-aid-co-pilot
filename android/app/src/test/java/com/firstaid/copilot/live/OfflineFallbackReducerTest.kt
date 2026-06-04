package com.firstaid.copilot.live

import org.junit.Assert.assertEquals
import org.junit.Test

class OfflineFallbackReducerTest {
    @Test
    fun networkFailureInCprLoopKeepsCprFallbackAlive() {
        val current = LiveUiState(
            sessionId = "session_test",
            connectionState = ConnectionState.Online,
            currentStage = "S7_CPR_LOOP",
            mainText = "按压偏慢",
            qualityScore = 66,
            haptic = HapticState(enabled = true, bpm = 110),
            isInFlight = true,
        )

        val next = reduceTurnResult(
            current,
            TurnResult.Failure(TransportError(TransportErrorKind.NETWORK, "connection refused")),
        )

        assertEquals(ConnectionState.Offline, next.connectionState)
        assertEquals("继续按压", next.mainText)
        assertEquals("continue_compressions", next.visualOverlayMode)
        assertEquals(66, next.qualityScore)
        assertEquals(true, next.haptic.enabled)
        assertEquals(110, next.haptic.bpm)
        assertEquals(false, next.isInFlight)
    }

    @Test
    fun timeoutInS8UsesOfflineFallback() {
        val next = reduceTurnResult(
            LiveUiState(currentStage = "S8_ASSISTANCE", qualityScore = 80, isInFlight = true),
            TurnResult.Failure(TransportError(TransportErrorKind.TIMEOUT, "timeout")),
        )

        assertEquals(ConnectionState.Offline, next.connectionState)
        assertEquals("继续按压", next.mainText)
        assertEquals(80, next.qualityScore)
        assertEquals(true, next.haptic.enabled)
        assertEquals(110, next.haptic.bpm)
    }

    @Test
    fun repeatedOfflineFailuresKeepTheBeatTickingWithoutServerMessages() {
        // Once the beat is local-self-sustaining, no further server turn is needed
        // to keep it alive: each subsequent offline failure must keep haptic enabled.
        var state = LiveUiState(
            currentStage = "S7_CPR_LOOP",
            haptic = HapticState(enabled = true, bpm = 110),
            isInFlight = true,
        )

        repeat(3) {
            state = reduceTurnResult(
                state,
                TurnResult.Failure(TransportError(TransportErrorKind.NETWORK, "still offline")),
            )
            assertEquals(ConnectionState.Offline, state.connectionState)
            assertEquals(true, state.haptic.enabled)
            assertEquals(110, state.haptic.bpm)
        }
    }

    @Test
    fun httpFailureRemainsError() {
        val next = reduceTurnResult(
            LiveUiState(currentStage = "S7_CPR_LOOP", mainText = "保持"),
            TurnResult.Failure(TransportError(TransportErrorKind.HTTP, "500", httpStatus = 500)),
        )

        assertEquals(ConnectionState.Error, next.connectionState)
        assertEquals("保持", next.mainText)
        assertEquals("500", next.lastErrorMessage)
    }
}
