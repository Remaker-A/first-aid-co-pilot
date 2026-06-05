package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.TtsPayload
import com.firstaid.copilot.execution.UiPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveEventReducerTest {
    @Test
    fun shortLiveGuidanceUsesLocalTtsFastPathAndCarriesMetadata() {
        val next = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online, isInFlight = true),
            LiveAgentEvent.Guidance(
                action = guidanceAction(),
                response = null,
                turnSeq = 7,
                guidanceSource = "rule_fast_path",
                responseType = "flow_instruction",
            ),
        )

        assertEquals("act_live_test", next.lastActionId)
        assertEquals("请检查反应。", next.ttsText)
        assertEquals("检查反应", next.mainText)
        assertEquals("rule_fast_path", next.guidanceSource)
        assertEquals("flow_instruction", next.responseType)
        assertEquals(7, next.lastLiveTurnSeq)
        assertFalse(next.suppressLocalTts)
        assertFalse(next.isInFlight)
    }

    @Test
    fun longLiveGuidanceWaitsForServerAudioUntilUnavailable() {
        val next = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online, isInFlight = true),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = "我会继续陪着你完成后续操作，请保持按压节奏，注意让胸廓完全回弹。",
                    priority = "normal",
                ),
                response = null,
            ),
        )

        assertTrue(next.suppressLocalTts)
    }

    @Test
    fun audioUnavailableReenablesLocalTtsFallback() {
        val next = reduceLiveEvent(
            LiveUiState(
                isLiveAudioPlaying = true,
                activeAudioActionId = "act_live_test",
                suppressLocalTts = true,
                lastErrorMessage = null,
            ),
            LiveAgentEvent.AudioUnavailable("tts stream unavailable"),
        )

        assertFalse(next.isLiveAudioPlaying)
        assertNull(next.activeAudioActionId)
        assertFalse(next.suppressLocalTts)
        assertEquals("tts stream unavailable", next.lastErrorMessage)
    }

    @Test
    fun audioUnavailableForLocalFastPathDoesNotSurfaceError() {
        val next = reduceLiveEvent(
            LiveUiState(
                lastActionId = "act_live_test",
                suppressLocalTts = false,
                lastErrorMessage = null,
            ),
            LiveAgentEvent.AudioUnavailable(
                reason = "tts stream unavailable",
                actionId = "act_live_test",
            ),
        )

        assertFalse(next.suppressLocalTts)
        assertNull(next.lastErrorMessage)
    }

    @Test
    fun expectedAudioCancelDoesNotSurfaceAsUserError() {
        val next = reduceLiveEvent(
            LiveUiState(
                isLiveAudioPlaying = true,
                activeAudioActionId = "act_live_test",
                micState = MicState.Speaking,
            ),
            LiveAgentEvent.AudioCancel("client_barge_in"),
        )

        assertFalse(next.isLiveAudioPlaying)
        assertNull(next.activeAudioActionId)
        assertEquals(MicState.Listening, next.micState)
        assertNull(next.lastErrorMessage)
    }

    private fun guidanceAction(
        text: String = "请检查反应。",
        priority: String = "high",
    ): GuidanceAction =
        GuidanceAction(
            action_id = "act_live_test",
            timestamp = "2026-06-05T00:00:00Z",
            stage = "S2_CHECK_RESPONSE",
            intent = "check_response",
            priority = priority,
            source = "unit_test",
            tts = TtsPayload(text = text),
            ui = UiPayload(main_text = "检查反应", secondary_text = "大声叫他"),
            haptic = HapticPayload(enabled = false),
        )
}
