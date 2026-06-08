package com.example.cpr_new.agent.copilot

import kotlinx.coroutines.flow.Flow

/** 支持 `/ws/live` 全双工通道的 Agent 能力。 */
interface LiveAgentCapable {
    val liveEvents: Flow<LiveAgentEvent>
    val isLiveConnected: Boolean
    fun connectLive(sessionId: String)
    fun disconnectLive()
    suspend fun resetSession(sessionId: String)
    fun commitText(text: String, intent: String? = null)
    fun sendTurn(request: TurnRequest)
    fun sendPcm(pcm16: ByteArray)
    fun sendBargeIn()
    fun commitAudio()
}

sealed interface LiveAgentEvent {
    data class ConnectionChanged(val connected: Boolean, val message: String? = null) : LiveAgentEvent

    data class Thinking(val turnSeq: Int? = null) : LiveAgentEvent

    data class Guidance(
        val action: CopilotGuidanceAction,
        val currentStage: String? = null,
        val guidanceSource: String? = null,
        val responseType: String? = null,
        val turnSeq: Int? = null,
        val suppressLocalTts: Boolean = false,
        val openQuestionAnswer: Boolean = false,
        val ttsAudioSrc: String? = null,
    ) : LiveAgentEvent

    data class State(val currentStage: String?) : LiveAgentEvent

    data class PartialTranscript(val text: String) : LiveAgentEvent

    data class FinalTranscript(val text: String, val intent: String?) : LiveAgentEvent

    data class AudioBegin(
        val actionId: String?,
        val sampleRate: Int,
        val channels: Int = 1,
        val bitsPerSample: Int = 16,
        val flushQueue: Boolean = false,
    ) : LiveAgentEvent

    data class AudioChunk(val bytes: ByteArray) : LiveAgentEvent {
        override fun equals(other: Any?): Boolean =
            other is AudioChunk && bytes.contentEquals(other.bytes)

        override fun hashCode(): Int = bytes.contentHashCode()
    }

    data class AudioEnd(val actionId: String?, val turnSeq: Int? = null) : LiveAgentEvent

    data class AudioCancel(val reason: String?) : LiveAgentEvent

    data class AudioUnavailable(val reason: String?, val actionId: String? = null) : LiveAgentEvent

    data class Error(val message: String) : LiveAgentEvent
}
