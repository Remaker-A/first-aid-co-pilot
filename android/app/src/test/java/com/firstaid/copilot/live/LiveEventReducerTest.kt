package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.ToolAction
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
        assertEquals("Check response.", next.ttsText)
        assertEquals("Check response", next.mainText)
        assertEquals("rule_fast_path", next.guidanceSource)
        assertEquals("flow_instruction", next.responseType)
        assertEquals(7, next.lastLiveTurnSeq)
        assertFalse(next.suppressLocalTts)
        assertFalse(next.isInFlight)
    }

    @Test
    fun longLiveGuidanceUsesUnifiedLocalTtsVoice() {
        val text = "I will keep coaching you through the next steps while you continue compressions."
        val next = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online, isInFlight = true),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = text,
                    priority = "normal",
                ),
                response = null,
            ),
        )

        assertFalse(next.suppressLocalTts)
        assertEquals(text, next.ttsText)
    }

    @Test
    fun autoAdvanceDeferredGuidanceDoesNotTriggerLocalTts() {
        val next = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online, isInFlight = true),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = "按疑似心脏骤停处理。",
                    intent = "state_suspected_arrest_handling",
                    stage = "S4_SUSPECTED_ARREST",
                ),
                response = null,
                turnSeq = 11,
                suppressLocalTts = true,
            ),
        )

        assertEquals("按疑似心脏骤停处理。", next.ttsText)
        assertTrue(next.suppressLocalTts)
        assertEquals(11, next.lastLiveTurnSeq)
    }

    @Test
    fun autoAdvanceBridgeGuidanceUsesLocalTts() {
        val bridgeText = "按疑似心脏骤停处理。我将打开 120 拨号并保持免提。现在双手放胸口中央，准备好就说开始。"
        val next = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online, suppressLocalTts = true),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = bridgeText,
                    intent = "guide_cpr_position",
                    stage = "S6_CPR_READY",
                ),
                response = null,
                turnSeq = 11,
                autoAdvanceBridge = true,
            ),
        )

        assertEquals(bridgeText, next.ttsText)
        assertFalse(next.suppressLocalTts)
        assertEquals(11, next.lastLiveTurnSeq)
    }

    @Test
    fun openQuestionAckAndAnswerBothUseUnifiedLocalTts() {
        val ack = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online, isInFlight = true),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = "我在，按住别停，听我说。",
                    intent = "answer_current_cpr_question",
                    stage = "S7_CPR_LOOP",
                ),
                response = null,
                turnSeq = 8,
                guidanceSource = "open_question_ack",
                responseType = "open_question_ack",
            ),
        )

        assertEquals(OpenQuestionPhase.Ack, ack.openQuestionPhase)
        assertFalse(ack.suppressLocalTts)
        assertEquals("我在，按住别停，听我说。", ack.ttsText)

        val answer = reduceLiveEvent(
            ack,
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = "继续按压别停，等急救员接手。",
                    intent = "answer_current_cpr_question",
                    stage = "S7_CPR_LOOP",
                ),
                response = null,
                turnSeq = 8,
                guidanceSource = "gemma_open_question",
                responseType = "open_question_answer",
                openQuestionAnswer = true,
            ),
        )

        assertEquals(OpenQuestionPhase.Answer, answer.openQuestionPhase)
        assertFalse(answer.suppressLocalTts)
        assertEquals("继续按压别停，等急救员接手。", answer.ttsText)
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

    @Test
    fun bargeInMarksPendingOpenQuestionCancelledWithoutSurfacingError() {
        val next = reduceLiveEvent(
            LiveUiState(
                isLiveAudioPlaying = true,
                activeAudioActionId = "act_ack",
                micState = MicState.Speaking,
                openQuestionPhase = OpenQuestionPhase.Ack,
            ),
            LiveAgentEvent.AudioCancel("client_barge_in"),
        )

        assertFalse(next.isLiveAudioPlaying)
        assertNull(next.activeAudioActionId)
        assertEquals(MicState.Listening, next.micState)
        assertEquals(OpenQuestionPhase.Cancelled, next.openQuestionPhase)
        assertNull(next.lastErrorMessage)
    }

    @Test
    fun metricsEventRecordsOpenQuestionLatencyAndGemmaRoute() {
        val metrics = LiveTurnMetrics(
            turnSeq = 9,
            currentStage = "S7_CPR_LOOP",
            timings = mapOf(
                "total_ms" to 92L,
                "gemma_ms" to 0L,
                "tts_first_chunk_ms" to 18L,
            ),
            tts = LiveTtsTurnMetrics(provider = "tts_cache", cacheHit = true, spoke = true),
            gemma = LiveGemmaTurnMetrics(
                skipped = true,
                skipReason = "open_question_async",
                openQuestion = true,
            ),
            guidanceSource = "open_question_ack",
        )

        val next = reduceLiveEvent(
            LiveUiState(connectionState = ConnectionState.Online),
            LiveAgentEvent.Metrics(metrics),
        )

        assertEquals("S7_CPR_LOOP", next.currentStage)
        assertEquals(9, next.lastLiveTurnSeq)
        assertEquals(OpenQuestionPhase.Ack, next.openQuestionPhase)
        assertEquals(metrics, next.lastOpenQuestionMetrics)
        assertEquals(18L, next.lastOpenQuestionMetrics?.timings?.get("tts_first_chunk_ms"))
        assertEquals("open_question_async", next.lastOpenQuestionMetrics?.gemma?.skipReason)
    }

    @Test
    fun cprEncouragementWithoutHapticCommandKeepsRunningMetronome() {
        val next = reduceLiveEvent(
            LiveUiState(
                connectionState = ConnectionState.Online,
                currentStage = "S7_CPR_LOOP",
                haptic = HapticState(enabled = true, bpm = 110),
            ),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    text = "Keep the rhythm.",
                    priority = "normal",
                    intent = "encourage_rescuer",
                    stage = "S7_CPR_LOOP",
                    haptic = HapticPayload(enabled = false),
                ),
                response = null,
            ),
        )

        assertTrue(next.haptic.enabled)
        assertEquals(110, next.haptic.bpm)
    }

    @Test
    fun explicitStopHapticCommandStopsMetronomeInCprLoop() {
        val next = reduceLiveEvent(
            LiveUiState(
                connectionState = ConnectionState.Online,
                currentStage = "S7_CPR_LOOP",
                haptic = HapticState(enabled = true, bpm = 110),
            ),
            LiveAgentEvent.Guidance(
                action = guidanceAction(
                    intent = "handover_to_ems",
                    stage = "S7_CPR_LOOP",
                    toolActions = listOf(ToolAction(type = "stop_haptic_metronome")),
                ),
                response = null,
            ),
        )

        assertFalse(next.haptic.enabled)
        assertNull(next.haptic.bpm)
    }

    private fun guidanceAction(
        text: String = "Check response.",
        priority: String = "high",
        intent: String = "check_response",
        stage: String = "S2_CHECK_RESPONSE",
        haptic: HapticPayload = HapticPayload(enabled = false),
        toolActions: List<ToolAction> = emptyList(),
    ): GuidanceAction =
        GuidanceAction(
            action_id = "act_live_test",
            timestamp = "2026-06-05T00:00:00Z",
            stage = stage,
            intent = intent,
            priority = priority,
            source = "unit_test",
            tts = TtsPayload(text = text),
            ui = UiPayload(main_text = "Check response", secondary_text = "Call loudly"),
            haptic = haptic,
            tool_actions = toolActions,
        )
}
