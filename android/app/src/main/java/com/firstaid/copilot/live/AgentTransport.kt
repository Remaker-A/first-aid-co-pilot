package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import kotlinx.coroutines.flow.Flow

/**
 * The D3 transport abstraction seam between the Live ViewModel and the agent.
 *
 * The ViewModel only ever talks to this interface, so the current
 * [HttpAgentTransport] (thin client posting to the Node `/api/turn` server) can
 * later be swapped for an on-device `InProcessAgentTransport` without any
 * UI/ViewModel changes. Implementations must be safe to call from a coroutine;
 * they own their own threading (e.g. [kotlinx.coroutines.Dispatchers.IO]).
 *
 * Contract notes for any implementation:
 *  - [turn] must not throw for ordinary connectivity failures; it returns
 *    [TurnResult.Failure] so the caller can drive offline fallback.
 *  - [reset] is best-effort and should not throw on connectivity failures.
 *  - [health] returns false (never throws) when the agent is unreachable.
 */
interface AgentTransport {
    suspend fun turn(request: TurnRequest): TurnResult

    suspend fun reset(sessionId: String)

    suspend fun health(): Boolean
}

/**
 * Full-duplex low-latency voice channel backed by `/ws/live`.
 *
 * It is intentionally separate from [AgentTransport]: HTTP turn/reset/health
 * remain the stable fallback path while the live channel streams raw PCM and
 * emits incremental events for subtitles, guidance, and future server audio.
 */
interface LiveAgentChannel {
    val events: Flow<LiveAgentEvent>

    fun connect(sessionId: String, mode: String = "demo_assisted")

    fun updateContext(request: TurnRequest)

    fun sendPcm(pcm16: ByteArray)

    fun sendBargeIn()

    fun reset()

    fun close()
}

sealed interface LiveAgentEvent {
    data class ConnectionChanged(val connected: Boolean, val message: String? = null) : LiveAgentEvent

    data class PartialTranscript(val text: String) : LiveAgentEvent

    data class FinalTranscript(val text: String, val intent: String?) : LiveAgentEvent

    data class Guidance(val action: GuidanceAction, val response: TurnResponse?) : LiveAgentEvent

    data class State(val currentStage: String?) : LiveAgentEvent

    data class AudioChunk(val bytes: ByteArray) : LiveAgentEvent

    data class Error(val message: String) : LiveAgentEvent
}
