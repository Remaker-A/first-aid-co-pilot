package com.firstaid.copilot.live

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * ViewModel-level wiring tests for the Phase D proactive monitor. The auto loop is
 * disabled and [LiveSessionViewModel.proactiveTick] is pumped with an explicit
 * `nowMs` so emission is deterministic without virtual time. Verifies that an
 * eligible CPR session emits a cue into [LiveUiState.proactiveCue], that the hard
 * gate suppresses it while speaking, and that the optional polisher only replaces
 * the template when its rewrite is safe.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ProactiveMonitorTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun newViewModel(channel: ProactiveFakeChannel): LiveSessionViewModel =
        LiveSessionViewModel(
            transport = ProactiveOfflineTransport(),
            liveChannel = channel,
            sessionId = "proactive_test",
            autoStartProactiveMonitor = false,
        )

    private suspend fun TestScope.cprStartedAt(viewModel: LiveSessionViewModel, channel: ProactiveFakeChannel): Long {
        channel.emit(LiveAgentEvent.ConnectionChanged(connected = true))
        channel.emit(LiveAgentEvent.State(currentStage = "S7_CPR_LOOP"))
        advanceUntilIdle()
        return requireNotNull(viewModel.uiState.value.cprStartedAtMs) {
            "cprStartedAtMs should be set on entering S7"
        }
    }

    @Test
    fun disabledByDefaultEmitsNothing() = runTest {
        val channel = ProactiveFakeChannel()
        val viewModel = newViewModel(channel)
        val started = cprStartedAt(viewModel, channel)

        // Feature flag left OFF (default): even a long-running CPR loop stays silent.
        viewModel.proactiveTick(started + 130_000)

        assertNull(viewModel.uiState.value.proactiveCue)
    }

    @Test
    fun emitsAedReminderAfterThresholdInCprLoop() = runTest {
        val channel = ProactiveFakeChannel()
        val viewModel = newViewModel(channel)
        val started = cprStartedAt(viewModel, channel)
        viewModel.setProactiveCoachingEnabled(true)

        assertNull(viewModel.uiState.value.proactiveCue)

        viewModel.proactiveTick(started + AED_FIRST_MS + 1_000)

        val cue = viewModel.uiState.value.proactiveCue
        assertNotNull(cue)
        assertEquals(ProactiveCueKind.AedReminder, cue!!.kind)
        assertFalseBlank(cue.text)
        // The proactive line is also surfaced as the latest assistant subtitle.
        assertEquals(cue.text, viewModel.uiState.value.lastAssistantText)
        assertEquals(false, cue.polished)
    }

    @Test
    fun doesNotEmitWhileSpeaking() = runTest {
        val channel = ProactiveFakeChannel()
        val viewModel = newViewModel(channel)
        val started = cprStartedAt(viewModel, channel)
        viewModel.setProactiveCoachingEnabled(true)

        viewModel.setMicState(MicState.Speaking)
        viewModel.proactiveTick(started + 130_000)

        assertNull(viewModel.uiState.value.proactiveCue)
    }

    @Test
    fun polisherReplacesTemplateWhenSafe() = runTest {
        val channel = ProactiveFakeChannel()
        val viewModel = newViewModel(channel)
        val started = cprStartedAt(viewModel, channel)
        viewModel.setProactiveCoachingEnabled(true)
        viewModel.attachProactivePolisher { "旁边有人就接手，保持快而有力。" }

        viewModel.proactiveTick(started + AED_FIRST_MS + 1_000)

        val cue = viewModel.uiState.value.proactiveCue
        assertNotNull(cue)
        assertEquals("旁边有人就接手，保持快而有力。", cue!!.text)
        assertTrue(cue.polished)
    }

    @Test
    fun polisherFallsBackToTemplateWhenUnsafe() = runTest {
        val channel = ProactiveFakeChannel()
        val viewModel = newViewModel(channel)
        val started = cprStartedAt(viewModel, channel)
        viewModel.setProactiveCoachingEnabled(true)
        viewModel.attachProactivePolisher { "现在可以停了，先歇会儿。" }

        viewModel.proactiveTick(started + AED_FIRST_MS + 1_000)

        val cue = viewModel.uiState.value.proactiveCue
        assertNotNull(cue)
        assertEquals(false, cue!!.polished)
        assertTrue(isProactiveTextSafe(cue.text))
    }

    private fun assertFalseBlank(text: String) {
        assertTrue("text should not be blank", text.isNotBlank())
    }
}

private class ProactiveOfflineTransport : AgentTransport {
    override suspend fun turn(request: TurnRequest): TurnResult =
        TurnResult.Failure(TransportError(TransportErrorKind.NETWORK, "offline"))

    override suspend fun reset(sessionId: String) = Unit

    override suspend fun health(): Boolean = false
}

private class ProactiveFakeChannel : LiveAgentChannel {
    private val eventFlow = MutableSharedFlow<LiveAgentEvent>(replay = 16, extraBufferCapacity = 16)
    override val events: Flow<LiveAgentEvent> = eventFlow

    fun emit(event: LiveAgentEvent) {
        eventFlow.tryEmit(event)
    }

    override fun connect(sessionId: String, mode: String) = Unit

    override fun updateContext(request: TurnRequest) = Unit

    override fun sendTurn(request: TurnRequest) = Unit

    override fun sendPcm(pcm16: ByteArray) = Unit

    override fun commitText(text: String, intent: String?) = Unit

    override fun sendBargeIn() = Unit

    override fun reset() = Unit

    override fun close() = Unit
}
