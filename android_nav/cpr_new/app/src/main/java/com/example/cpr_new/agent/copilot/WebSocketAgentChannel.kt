package com.example.cpr_new.agent.copilot

import android.os.Handler
import android.os.Looper
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

class WebSocketAgentChannel(
    private val wsUrl: String,
    private val client: OkHttpClient = defaultClient(),
) {
    private val _events = MutableSharedFlow<LiveAgentEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events: Flow<LiveAgentEvent> = _events

    private val _connected = AtomicBoolean(false)
    val isConnected: Boolean get() = _connected.get()

    private val reconnectHandler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var sessionId: String = ""
    private var mode: String = "demo_assisted"
    private var userClosed = false
    private var reconnectAttempts = 0
    private var lastContextRequest: TurnRequest? = null

    fun connect(sessionId: String, mode: String = "demo_assisted") {
        this.sessionId = sessionId
        this.mode = mode
        userClosed = false
        reconnectAttempts = 0
        reconnectHandler.removeCallbacksAndMessages(null)
        openSocket()
    }

    fun updateContext(request: TurnRequest) {
        lastContextRequest = request
        sendJson(
            JSONObject()
                .put("type", "context")
                .put("payload", request.toJson()),
        )
    }

    fun sendTurn(request: TurnRequest) {
        sendJson(
            JSONObject()
                .put("type", "turn")
                .put("payload", request.toJson()),
        )
    }

    fun commitText(text: String, intent: String? = null) {
        if (text.isBlank()) return
        val payload = JSONObject().put("type", "commit_text").put("text", text)
        intent?.takeIf { it.isNotBlank() }?.let { payload.put("intent", it) }
        sendJson(payload)
    }

    fun sendPcm(pcm16: ByteArray) {
        if (pcm16.isEmpty()) return
        socket?.send(pcm16.toByteString())
    }

    fun sendBargeIn() = sendJson(JSONObject().put("type", "barge_in"))

    /** 一句话结束，触发 Node 缓冲 STT / 流式 STT endpoint（mock 环境必需）。 */
    fun commitAudio() = sendJson(JSONObject().put("type", "commit"))

    fun reset() = sendJson(JSONObject().put("type", "reset"))

    fun close() {
        userClosed = true
        reconnectHandler.removeCallbacksAndMessages(null)
        _connected.set(false)
        socket?.close(1000, "client closing")
        socket = null
    }

    private fun openSocket() {
        socket?.close(1000, "reconnect")
        socket = client.newWebSocket(Request.Builder().url(wsUrl).build(), Listener())
    }

    private fun scheduleReconnect() {
        if (userClosed || sessionId.isBlank()) return
        val delayMs = minOf(30_000L, 1_000L shl reconnectAttempts.coerceAtMost(5))
        reconnectAttempts++
        reconnectHandler.postDelayed(
            {
                if (!userClosed && sessionId.isNotBlank()) {
                    openSocket()
                }
            },
            delayMs,
        )
    }

    private fun sendStart() {
        sendJson(
            JSONObject()
                .put("type", "start")
                .put("sessionId", sessionId)
                .put("mode", mode),
        )
        lastContextRequest?.let { updateContext(it) }
    }

    private fun sendJson(json: JSONObject) {
        val sent = socket?.send(json.toString()) ?: false
        if (!sent) {
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = "WebSocket 未连接"))
            emit(LiveAgentEvent.Error("WebSocket 未连接"))
        }
    }

    private fun emit(event: LiveAgentEvent) {
        _events.tryEmit(event)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            _connected.set(true)
            reconnectAttempts = 0
            emit(LiveAgentEvent.ConnectionChanged(connected = true))
            sendStart()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching { handleJson(JSONObject(text)) }
                .onFailure { emit(LiveAgentEvent.Error(it.message ?: "无法解析 WS 事件")) }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            emit(LiveAgentEvent.AudioChunk(bytes.toByteArray()))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            _connected.set(false)
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = reason.takeIf { it.isNotBlank() }))
            if (!userClosed) scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            _connected.set(false)
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = t.message))
            emit(LiveAgentEvent.Error(t.message ?: "WebSocket 连接失败"))
            if (!userClosed) scheduleReconnect()
        }
    }

    private fun handleJson(json: JSONObject) {
        when (json.optString("type")) {
            "thinking" -> emit(LiveAgentEvent.Thinking(json.intOrNull("turn_seq")))
            "partial" -> emit(LiveAgentEvent.PartialTranscript(json.optString("text", "")))
            "final" -> emit(
                LiveAgentEvent.FinalTranscript(
                    text = json.optString("text", ""),
                    intent = json.stringOrNull("intent"),
                ),
            )
            "guidance" -> {
                val actionJson = json.optJSONObject("action") ?: return
                val action = runCatching { parseCopilotAction(actionJson) }.getOrNull() ?: return
                val response = json.optJSONObject("response")
                emit(
                    LiveAgentEvent.Guidance(
                        action = action,
                        currentStage = json.stringOrNull("current_stage")
                            ?: response?.optJSONObject("state")?.stringOrNull("current_stage"),
                        guidanceSource = json.stringOrNull("source") ?: json.stringOrNull("guidance_source"),
                        responseType = json.stringOrNull("response_type") ?: json.stringOrNull("responseType"),
                        turnSeq = json.intOrNull("turn_seq"),
                        suppressLocalTts = json.booleanOrDefault(false, "suppress_local_tts", "suppressLocalTts"),
                        openQuestionAnswer = json.optBoolean("open_question_answer", false),
                        ttsAudioSrc = response?.optJSONObject("tts")
                            ?.optJSONObject("audio")
                            ?.let { audio ->
                                audio.stringOrNull("url") ?: audio.stringOrNull("data_url")
                            },
                    ),
                )
            }
            "state" -> emit(LiveAgentEvent.State(json.stringOrNull("current_stage")))
            "audio_begin" -> emit(
                LiveAgentEvent.AudioBegin(
                    actionId = json.stringOrNull("action_id"),
                    sampleRate = json.intOrDefault(DEFAULT_AUDIO_SAMPLE_RATE, "sample_rate", "sampleRate"),
                    channels = json.intOrDefault(DEFAULT_AUDIO_CHANNELS, "channels"),
                    bitsPerSample = json.intOrDefault(DEFAULT_AUDIO_BITS_PER_SAMPLE, "bits_per_sample", "bitsPerSample"),
                    flushQueue = json.booleanOrDefault(false, "flush_queue", "flushQueue"),
                ),
            )
            "audio_end" -> emit(
                LiveAgentEvent.AudioEnd(
                    actionId = json.stringOrNull("action_id"),
                    turnSeq = json.intOrNull("turn_seq"),
                ),
            )
            "audio_cancel" -> emit(LiveAgentEvent.AudioCancel(json.stringOrNull("reason")))
            "audio_unavailable" -> emit(
                LiveAgentEvent.AudioUnavailable(
                    reason = json.stringOrNull("reason"),
                    actionId = json.stringOrNull("action_id"),
                ),
            )
            "error" -> emit(
                LiveAgentEvent.Error(
                    json.optJSONObject("error")?.stringOrNull("message")
                        ?: json.optString("message", "Live 通道错误"),
                ),
            )
        }
    }

    private fun JSONObject.stringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null

    private fun JSONObject.intOrNull(key: String): Int? =
        if (has(key) && !isNull(key)) optInt(key).takeIf { it >= 0 } else null

    private fun JSONObject.intOrDefault(default: Int, vararg keys: String): Int =
        keys.firstNotNullOfOrNull { key ->
            if (has(key) && !isNull(key)) optInt(key).takeIf { it > 0 } else null
        } ?: default

    private fun JSONObject.booleanOrDefault(default: Boolean, vararg keys: String): Boolean =
        keys.firstNotNullOfOrNull { key ->
            if (has(key) && !isNull(key)) optBoolean(key) else null
        } ?: default

    companion object {
        private const val DEFAULT_AUDIO_SAMPLE_RATE = 16_000
        private const val DEFAULT_AUDIO_CHANNELS = 1
        private const val DEFAULT_AUDIO_BITS_PER_SAMPLE = 16

        private fun defaultClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.SECONDS)
                .build()
    }
}
