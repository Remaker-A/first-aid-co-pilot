package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import kotlinx.coroutines.flow.Flow

/**
 * The D3 transport abstraction seam between the Live ViewModel and the agent.
 *
 * The ViewModel only ever talks to this interface. The default Android live flow
 * now uses [LocalAgentTransport] on device; [HttpAgentTransport] remains the
 * optional thin-client transport for Node `/api/turn` demos. Implementations must
 * be safe to call from a coroutine; they own their own threading (e.g.
 * [kotlinx.coroutines.Dispatchers.IO]).
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

    /**
     * Whether an edge-owned open-question turn should still be mirrored through
     * this channel. WebSocket mirrors to keep the server session in sync; the
     * local channel must not, otherwise its deterministic CPR-loop response races
     * and overwrites the edge Gemma answer.
     */
    val mirrorsEdgeOpenQuestionTurns: Boolean get() = true

    fun connect(sessionId: String, mode: String = "demo_assisted")

    fun updateContext(request: TurnRequest)

    fun sendTurn(request: TurnRequest)

    fun sendPcm(pcm16: ByteArray)

    fun commitText(text: String, intent: String? = null)

    fun sendBargeIn()

    fun reset()

    fun close()
}

sealed interface LiveAgentEvent {
    data class ConnectionChanged(val connected: Boolean, val message: String? = null) : LiveAgentEvent

    data class Thinking(val turnSeq: Int?) : LiveAgentEvent

    data class PartialTranscript(val text: String) : LiveAgentEvent

    data class FinalTranscript(val text: String, val intent: String?) : LiveAgentEvent

    data class Guidance(
        val action: GuidanceAction,
        val response: TurnResponse?,
        val turnSeq: Int? = null,
        val guidanceSource: String? = null,
        val responseType: String? = null,
        val suppressLocalTts: Boolean = false,
        val autoAdvanceBridge: Boolean = false,
        val openQuestionAnswer: Boolean = false,
    ) : LiveAgentEvent

    data class State(val currentStage: String?) : LiveAgentEvent

    data class Metrics(val metrics: LiveTurnMetrics) : LiveAgentEvent

    data class AudioBegin(
        val actionId: String?,
        val turnSeq: Int?,
        val sampleRate: Int,
        val channels: Int,
        val bitsPerSample: Int,
        val format: String,
        val streamId: String? = null,
        val sessionId: String? = null,
        val flushQueue: Boolean = false,
    ) : LiveAgentEvent

    data class AudioChunk(val bytes: ByteArray) : LiveAgentEvent

    data class AudioEnd(val actionId: String?, val turnSeq: Int?) : LiveAgentEvent

    data class AudioCancel(val reason: String?) : LiveAgentEvent

    data class AudioUnavailable(val reason: String?, val actionId: String? = null) : LiveAgentEvent

    data class Error(val message: String) : LiveAgentEvent
}
