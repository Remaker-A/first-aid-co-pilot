package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.TtsPayload
import com.firstaid.copilot.execution.UiPayload
import com.firstaid.copilot.live.audio.LiveAudioLogger
import com.firstaid.copilot.live.audio.LiveAudioMetadata
import com.firstaid.copilot.live.audio.LiveAudioPlayer
import com.firstaid.copilot.live.audio.LiveAudioSink
import com.firstaid.copilot.live.audio.LiveAudioSinkFactory
import com.firstaid.copilot.live.edge.EdgeOpenQuestionPolicy
import com.firstaid.copilot.live.edge.OpenQuestionSupplementOutcome
import com.firstaid.copilot.live.edge.OpenQuestionSupplementResponder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Phase 2 · C — ViewModel-level wiring tests for the on-device open-question flow:
 * detection -> immediate deterministic ack -> async controlled answer -> Answer,
 * the deterministic fallback when the responder declines, and the dedup that
 * mutes the server's parallel open-question reply.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveOpenQuestionFlowTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun viewModel(
        channel: OqFakeChannel,
        responder: OpenQuestionSupplementResponder? = null,
    ): LiveSessionViewModel {
        val vm = LiveSessionViewModel(
            transport = OqOfflineTransport(),
            liveChannel = channel,
            liveAudioPlayer = noopLiveAudioPlayer(),
            sessionId = "oq_test",
            autoStartProactiveMonitor = false,
        )
        responder?.let { vm.attachOpenQuestionSupplementResponder(it) }
        return vm
    }

    private suspend fun TestScope.bringOnlineInCprLoop(channel: OqFakeChannel) {
        channel.emit(LiveAgentEvent.ConnectionChanged(connected = true))
        channel.emit(LiveAgentEvent.State(currentStage = "S7_CPR_LOOP"))
        advanceUntilIdle()
    }

    @Test
    fun supplementStateIsSeparateFromMainTtsPath() {
        val state = LiveUiState(
            openQuestionPhase = OpenQuestionPhase.Answer,
            ttsText = "rule-first",
            lastActionId = "rule-action",
            openQuestionSupplement = OpenQuestionSupplement(
                id = "open-q-supplement-1",
                text = "gemma-short",
            ),
        )

        assertEquals("rule-first", state.ttsText)
        assertEquals("rule-action", state.lastActionId)
        assertEquals("gemma-short", state.openQuestionSupplement?.text)
        assertEquals(
            "\u8865\u5145\u4e00\u53e5\uff0cgemma-short",
            state.openQuestionSupplement?.toOpenQuestionSupplementTtsText(),
        )
    }

    @Test
    fun detectsQuestionPlaysFastRuleThenAsyncSupplement() = runTest {
        val channel = OqFakeChannel()
        val gate = CompletableDeferred<OpenQuestionSupplementOutcome>()
        val viewModel = viewModel(channel) { _, _ -> gate.await() }
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("肋骨会不会按断？")

        // Immediate rule answer, and the turn was still committed to the server.
        val fastAnswer = EdgeOpenQuestionPolicy.fallbackAnswer("S7_CPR_LOOP", "肋骨会不会按断？")
        val fastActionId = viewModel.uiState.value.lastActionId
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertEquals("open_question_fast_rule", viewModel.uiState.value.guidanceSource)
        assertTrue(fastActionId.orEmpty().contains("fast_rule"))
        assertEquals(null, viewModel.uiState.value.openQuestionSupplement)
        assertEquals(listOf("肋骨会不会按断？" to null), channel.commits)

        gate.complete(
            OpenQuestionSupplementOutcome(
                accepted = true,
                text = "按压是在维持血流",
                latencyMs = 120,
            ),
        )
        advanceUntilIdle()

        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertEquals(fastActionId, viewModel.uiState.value.lastActionId)
        assertEquals("按压是在维持血流", viewModel.uiState.value.openQuestionSupplement?.text)
        assertEquals(false, viewModel.uiState.value.suppressLocalTts)
    }

    @Test
    fun guardRejectOrTimeoutDoesNotSpeakSecondRuleAnswer() = runTest {
        val channel = OqFakeChannel()
        val viewModel = viewModel(channel) { _, _ ->
            OpenQuestionSupplementOutcome(accepted = false, reason = "duplicate_fast_answer", latencyMs = 80)
        }
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("肋骨会不会按断？")
        advanceUntilIdle()

        val fastAnswer = EdgeOpenQuestionPolicy.fallbackAnswer("S7_CPR_LOOP", "肋骨会不会按断？")
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertEquals(null, viewModel.uiState.value.openQuestionSupplement)
        assertEquals("duplicate_fast_answer", viewModel.uiState.value.lastOpenQuestionMetrics?.openQuestion?.reason)
    }

    @Test
    fun ignoresServerOpenQuestionAnswerWhileEdgeOwnsIt() = runTest {
        val channel = OqFakeChannel()
        val viewModel = viewModel(channel)
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("肋骨会不会按断？")
        val fastAnswer = EdgeOpenQuestionPolicy.fallbackAnswer("S7_CPR_LOOP", "肋骨会不会按断？")
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)

        // The server also answers the open question; it must be dropped (dedup).
        channel.emit(
            LiveAgentEvent.Guidance(
                action = guidanceAction(text = "这是服务端的答复，不应播报。"),
                response = null,
                turnSeq = 9,
                guidanceSource = "gemma_open_question",
                responseType = "open_question_answer",
                openQuestionAnswer = true,
            ),
        )
        advanceUntilIdle()

        // State is untouched by the dropped server reply.
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertNotEquals("这是服务端的答复，不应播报。", viewModel.uiState.value.ttsText)
    }

    @Test
    fun localChannelDoesNotMirrorOpenQuestionIntoRuleFlow() = runTest {
        val channel = OqFakeChannel(mirrorsEdgeOpenQuestionTurns = false)
        val gate = CompletableDeferred<OpenQuestionSupplementOutcome>()
        val viewModel = viewModel(channel) { _, _ -> gate.await() }
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("旁边的人现在最好帮我做什么？")

        val fastAnswer = EdgeOpenQuestionPolicy.fallbackAnswer("S7_CPR_LOOP", "旁边的人现在最好帮我做什么？")
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertTrue(channel.commits.isEmpty())

        gate.complete(
            OpenQuestionSupplementOutcome(
                accepted = true,
                text = "旁人也可准备换手",
                latencyMs = 140,
            ),
        )
        advanceUntilIdle()

        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertEquals("旁人也可准备换手", viewModel.uiState.value.openQuestionSupplement?.text)
    }

    @Test
    fun nonQuestionUsesNormalCommitWithoutOpenQuestion() = runTest {
        val channel = OqFakeChannel()
        val viewModel = viewModel(channel)
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("我有点累")
        advanceUntilIdle()

        assertEquals(OpenQuestionPhase.Idle, viewModel.uiState.value.openQuestionPhase)
        assertEquals(listOf("我有点累" to null), channel.commits)
    }

    @Test
    fun withoutResponderQuestionStillSpeaksFastRule() = runTest {
        val channel = OqFakeChannel()
        val viewModel = viewModel(channel, responder = null)
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("肋骨会不会按断？")
        advanceUntilIdle()

        val fastAnswer = EdgeOpenQuestionPolicy.fallbackAnswer("S7_CPR_LOOP", "肋骨会不会按断？")
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)
        assertEquals(fastAnswer, viewModel.uiState.value.ttsText)
        assertEquals(null, viewModel.uiState.value.openQuestionSupplement)
        assertEquals(listOf("肋骨会不会按断？" to null), channel.commits)
    }

    @Test
    fun bargeInSupersedesPendingSupplement() = runTest {
        val channel = OqFakeChannel()
        val gate = CompletableDeferred<OpenQuestionSupplementOutcome>()
        val viewModel = viewModel(channel) { _, _ -> gate.await() }
        bringOnlineInCprLoop(channel)

        viewModel.submitLiveText("肋骨会不会按断？")
        assertEquals(OpenQuestionPhase.Answer, viewModel.uiState.value.openQuestionPhase)

        viewModel.sendLiveBargeIn()
        assertEquals(OpenQuestionPhase.Cancelled, viewModel.uiState.value.openQuestionPhase)

        // A late supplement for the superseded turn must not overwrite the cancellation.
        gate.complete(
            OpenQuestionSupplementOutcome(
                accepted = true,
                text = "迟到的补充",
                latencyMs = 50,
            ),
        )
        advanceUntilIdle()

        assertEquals(OpenQuestionPhase.Cancelled, viewModel.uiState.value.openQuestionPhase)
        assertEquals(null, viewModel.uiState.value.openQuestionSupplement)
        assertNotEquals("迟到的补充", viewModel.uiState.value.ttsText)
    }

    private fun guidanceAction(text: String): GuidanceAction =
        GuidanceAction(
            action_id = "srv_open_q_answer",
            timestamp = "2026-06-06T00:00:00Z",
            stage = "S7_CPR_LOOP",
            intent = "answer_current_cpr_question",
            priority = "normal",
            source = "live_agent",
            tts = TtsPayload(text = text),
            ui = UiPayload(main_text = "服务端", secondary_text = ""),
            haptic = HapticPayload(enabled = false),
            tool_actions = emptyList(),
        )
}

private fun noopLiveAudioPlayer(): LiveAudioPlayer =
    LiveAudioPlayer(
        sinkFactory = object : LiveAudioSinkFactory {
            override fun create(metadata: LiveAudioMetadata): LiveAudioSink = OqNoopSink
        },
        clockMs = { 0L },
        logger = object : LiveAudioLogger {
            override fun info(message: String) = Unit
            override fun warn(message: String) = Unit
        },
    )

private object OqNoopSink : LiveAudioSink {
    override fun start() = Unit
    override fun writePcm(bytes: ByteArray): Int = bytes.size
    override fun finish() = Unit
    override fun flushAndStop() = Unit
    override fun release() = Unit
}

private class OqOfflineTransport : AgentTransport {
    override suspend fun turn(request: TurnRequest): TurnResult =
        TurnResult.Failure(TransportError(TransportErrorKind.NETWORK, "offline"))

    override suspend fun reset(sessionId: String) = Unit

    override suspend fun health(): Boolean = false
}

private class OqFakeChannel(
    override val mirrorsEdgeOpenQuestionTurns: Boolean = true,
) : LiveAgentChannel {
    private val eventFlow = MutableSharedFlow<LiveAgentEvent>(replay = 16, extraBufferCapacity = 16)
    override val events: Flow<LiveAgentEvent> = eventFlow
    val commits = mutableListOf<Pair<String, String?>>()

    fun emit(event: LiveAgentEvent) {
        eventFlow.tryEmit(event)
    }

    override fun connect(sessionId: String, mode: String) = Unit

    override fun updateContext(request: TurnRequest) = Unit

    override fun sendTurn(request: TurnRequest) = Unit

    override fun sendPcm(pcm16: ByteArray) = Unit

    override fun commitText(text: String, intent: String?) {
        commits += text to intent
    }

    override fun sendBargeIn() = Unit

    override fun reset() = Unit

    override fun close() = Unit
}
