package com.firstaid.copilot.live

import com.firstaid.copilot.execution.parseAction
import java.util.concurrent.TimeUnit
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
    private val wsUrl: String = DEFAULT_WS_URL,
    private val client: OkHttpClient = defaultClient(),
) : LiveAgentChannel {

    private val _events = MutableSharedFlow<LiveAgentEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val events: Flow<LiveAgentEvent> = _events

    private var socket: WebSocket? = null
    private var sessionId: String = ""
    private var mode: String = "demo_assisted"

    override fun connect(sessionId: String, mode: String) {
        this.sessionId = sessionId
        this.mode = mode
        close()
        val request = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(request, Listener())
    }

    override fun updateContext(request: TurnRequest) {
        sendJson(
            JSONObject()
                .put("type", "context")
                .put("payload", request.toJson()),
        )
    }

    override fun sendPcm(pcm16: ByteArray) {
        if (pcm16.isEmpty()) return
        socket?.send(pcm16.toByteString())
    }

    override fun sendBargeIn() {
        sendJson(JSONObject().put("type", "barge_in"))
    }

    override fun reset() {
        sendJson(JSONObject().put("type", "reset"))
    }

    override fun close() {
        socket?.close(1000, "client closing")
        socket = null
    }

    private fun sendStart() {
        sendJson(
            JSONObject()
                .put("type", "start")
                .put("sessionId", sessionId)
                .put("mode", mode),
        )
    }

    private fun sendJson(json: JSONObject) {
        socket?.send(json.toString())
    }

    private fun emit(event: LiveAgentEvent) {
        _events.tryEmit(event)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            emit(LiveAgentEvent.ConnectionChanged(connected = true))
            sendStart()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching { handleJson(JSONObject(text)) }
                .onFailure { emit(LiveAgentEvent.Error(it.message ?: "Could not parse live event")) }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            emit(LiveAgentEvent.AudioChunk(bytes.toByteArray()))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = reason.takeIf(String::isNotBlank)))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = t.message))
            emit(LiveAgentEvent.Error(t.message ?: "Live WebSocket failed"))
        }
    }

    private fun handleJson(json: JSONObject) {
        when (json.optString("type")) {
            "partial" -> emit(LiveAgentEvent.PartialTranscript(json.optString("text", "")))
            "final" -> emit(
                LiveAgentEvent.FinalTranscript(
                    text = json.optString("text", ""),
                    intent = json.stringOrNull("intent"),
                ),
            )
            "guidance" -> {
                val actionJson = json.optJSONObject("action") ?: return
                val action = parseAction(actionJson)
                val response = json.optJSONObject("response")
                    ?.let { runCatching { parseTurnResponse(it) }.getOrNull() }
                emit(LiveAgentEvent.Guidance(action, response))
            }
            "state" -> emit(LiveAgentEvent.State(json.stringOrNull("current_stage")))
            "audio_begin", "audio_end", "audio_cancel", "audio_unavailable" -> Unit
            "error" -> emit(
                LiveAgentEvent.Error(
                    json.optJSONObject("error")?.stringOrNull("message")
                        ?: json.optString("message", "Live channel error"),
                ),
            )
        }
    }

    private fun JSONObject.stringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) optString(key).takeIf(String::isNotEmpty) else null

    companion object {
        const val DEFAULT_WS_URL: String = "ws://127.0.0.1:8787/ws/live"

        private fun defaultClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.SECONDS)
                .build()
    }
}
