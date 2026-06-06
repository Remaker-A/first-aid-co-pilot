package com.firstaid.copilot.live

import com.firstaid.copilot.live.audio.LiveAudioLogger
import com.firstaid.copilot.live.audio.LiveAudioMetadata
import com.firstaid.copilot.live.audio.LiveAudioPlayer
import com.firstaid.copilot.live.audio.LiveAudioSink
import com.firstaid.copilot.live.audio.LiveAudioSinkFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description

@OptIn(ExperimentalCoroutinesApi::class)
class LiveSessionTimingTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun startFirstAid_recordsSessionStartedAtInOfflinePath() = runTest {
        val viewModel = LiveSessionViewModel(
            transport = OfflineTransport(),
            liveChannel = FakeLiveAgentChannel(),
            sessionId = "timing_test",
            autoStartProactiveMonitor = false,
        )

        assertNull(viewModel.uiState.value.sessionStartedAtMs)

        viewModel.startFirstAid()

        assertNotNull(viewModel.uiState.value.sessionStartedAtMs)
    }

    @Test
    fun criticalUnresponsiveAsrFinalDuringPlaybackSendsBargeInAndCommitsOnce() = runTest {
        val channel = FakeLiveAgentChannel()
        val viewModel = LiveSessionViewModel(
            transport = OfflineTransport(),
            liveChannel = channel,
            liveAudioPlayer = testLiveAudioPlayer(),
            sessionId = "asr_gate_test",
            autoStartProactiveMonitor = false,
        )

        advanceUntilIdle()
        channel.emit(LiveAgentEvent.ConnectionChanged(connected = true))
        channel.emit(LiveAgentEvent.State(currentStage = "S2_CHECK_RESPONSE"))
        advanceUntilIdle()
        viewModel.setMicState(MicState.Speaking)

        assertEquals(ConnectionState.Online, viewModel.uiState.value.connectionState)
        assertEquals("S2_CHECK_RESPONSE", viewModel.uiState.value.currentStage)
        assertEquals(MicState.Speaking, viewModel.uiState.value.micState)

        viewModel.submitLiveText(text = "没有反应", fromAsr = true, nowMs = 1_000L)

        assertEquals(1, channel.bargeInCount)
        assertEquals(listOf("没有反应" to "patient_unresponsive"), channel.commits)

        viewModel.submitLiveText(text = "没有 反应。", fromAsr = true, nowMs = 1_100L)

        assertEquals(1, channel.commits.size)
    }
}

private fun testLiveAudioPlayer(): LiveAudioPlayer =
    LiveAudioPlayer(
        sinkFactory = object : LiveAudioSinkFactory {
            override fun create(metadata: LiveAudioMetadata): LiveAudioSink = NoopLiveAudioSink
        },
        clockMs = { 0L },
        logger = object : LiveAudioLogger {
            override fun info(message: String) = Unit
            override fun warn(message: String) = Unit
        },
    )

private object NoopLiveAudioSink : LiveAudioSink {
    override fun start() = Unit
    override fun writePcm(bytes: ByteArray): Int = bytes.size
    override fun finish() = Unit
    override fun flushAndStop() = Unit
    override fun release() = Unit
}

@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    private val dispatcher: TestDispatcher = UnconfinedTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}

private class OfflineTransport : AgentTransport {
    override suspend fun turn(request: TurnRequest): TurnResult =
        TurnResult.Failure(TransportError(TransportErrorKind.NETWORK, "offline"))

    override suspend fun reset(sessionId: String) = Unit

    override suspend fun health(): Boolean = false
}

private class FakeLiveAgentChannel : LiveAgentChannel {
    private val eventFlow = MutableSharedFlow<LiveAgentEvent>(replay = 16, extraBufferCapacity = 16)
    override val events: Flow<LiveAgentEvent> = eventFlow
    val commits = mutableListOf<Pair<String, String?>>()
    var bargeInCount = 0

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

    override fun sendBargeIn() {
        bargeInCount += 1
    }

    override fun reset() = Unit

    override fun close() = Unit
}
