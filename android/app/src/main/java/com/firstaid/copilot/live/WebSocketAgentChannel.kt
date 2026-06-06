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
import android.util.Log

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
        Log.i(TAG, "Connecting live WebSocket url=$wsUrl session=$sessionId mode=$mode")
        socket = client.newWebSocket(request, Listener())
    }

    override fun updateContext(request: TurnRequest) {
        sendJson(
            JSONObject()
                .put("type", "context")
                .put("payload", request.toJson()),
        )
    }

    override fun sendTurn(request: TurnRequest) {
        sendJson(
            JSONObject()
                .put("type", "turn")
                .put("payload", request.toJson()),
        )
    }

    override fun sendPcm(pcm16: ByteArray) {
        if (pcm16.isEmpty()) return
        socket?.send(pcm16.toByteString())
    }

    override fun commitText(text: String, intent: String?) {
        if (text.isBlank()) return
        val payload = JSONObject()
            .put("type", "commit_text")
            .put("text", text)
        intent?.takeIf { it.isNotBlank() }?.let { payload.put("intent", it) }
        sendJson(payload)
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
        val sent = socket?.send(json.toString()) ?: false
        Log.i(
            TAG,
            "Sent live JSON type=${json.optString("type")} ok=$sent " +
                "payloadKeys=${json.optJSONObject("payload")?.names()?.toString().orEmpty()}",
        )
        if (!sent) {
            Log.w(TAG, "Could not send live JSON type=${json.optString("type")}; socket connected=false")
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = "Live WebSocket is not connected"))
            emit(LiveAgentEvent.Error("Live WebSocket is not connected"))
        }
    }

    private fun emit(event: LiveAgentEvent) {
        _events.tryEmit(event)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "Live WebSocket opened code=${response.code}")
            emit(LiveAgentEvent.ConnectionChanged(connected = true))
            sendStart()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            Log.i(TAG, "Received live text ${text.take(300)}")
            runCatching { handleJson(JSONObject(text)) }
                .onFailure {
                    Log.w(TAG, "Could not parse live event: ${it.message}", it)
                    emit(LiveAgentEvent.Error(it.message ?: "Could not parse live event"))
                }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            Log.i(TAG, "Received live audio bytes=${bytes.size}")
            emit(LiveAgentEvent.AudioChunk(bytes.toByteArray()))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "Live WebSocket closed code=$code reason=$reason")
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = reason.takeIf(String::isNotBlank)))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "Live WebSocket failed code=${response?.code} message=${t.message}", t)
            emit(LiveAgentEvent.ConnectionChanged(connected = false, message = t.message))
            emit(LiveAgentEvent.Error(t.message ?: "Live WebSocket failed"))
        }
    }

    private fun handleJson(json: JSONObject) {
        val type = json.optString("type")
        if (type == "error") {
            Log.w(TAG, "Live server error ${json.optJSONObject("error")?.toString() ?: json.toString()}")
        }
        when (type) {
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
                val action = parseAction(actionJson)
                val response = json.optJSONObject("response")
                    ?.let { runCatching { parseTurnResponse(it) }.getOrNull() }
                emit(
                    LiveAgentEvent.Guidance(
                        action = action,
                        response = response,
                        turnSeq = json.intOrNull("turn_seq"),
                        guidanceSource = json.stringOrNull("source")
                            ?: json.stringOrNull("guidance_source"),
                        responseType = json.stringOrNull("response_type")
                            ?: json.stringOrNull("responseType"),
                        suppressLocalTts = json.booleanOrNull("suppress_local_tts")
                            ?: json.booleanOrNull("suppressLocalTts")
                            ?: false,
                        autoAdvanceBridge = json.booleanOrNull("auto_advance_bridge")
                            ?: json.booleanOrNull("autoAdvanceBridge")
                            ?: false,
                        openQuestionAnswer = json.booleanOrNull("open_question_answer")
                            ?: json.booleanOrNull("openQuestionAnswer")
                            ?: false,
                    ),
                )
            }
            "state" -> emit(LiveAgentEvent.State(json.stringOrNull("current_stage")))
            "metrics" -> emit(LiveAgentEvent.Metrics(parseLiveTurnMetrics(json)))
            "audio_begin" -> emit(
                LiveAgentEvent.AudioBegin(
                    streamId = json.stringOrNull("id") ?: json.stringOrNull("stream_id"),
                    sessionId = json.stringOrNull("session_id") ?: json.stringOrNull("sessionId"),
                    actionId = json.stringOrNull("action_id"),
                    turnSeq = json.intOrNull("turn_seq"),
                    sampleRate = json.intOrNull("sample_rate")
                        ?: json.intOrNull("sampleRate")
                        ?: DEFAULT_AUDIO_SAMPLE_RATE,
                    channels = json.intOrNull("channels") ?: DEFAULT_AUDIO_CHANNELS,
                    bitsPerSample = json.intOrNull("bits_per_sample")
                        ?: json.intOrNull("bitsPerSample")
                        ?: DEFAULT_AUDIO_BITS_PER_SAMPLE,
                    format = json.stringOrNull("format") ?: DEFAULT_AUDIO_FORMAT,
                    flushQueue = json.booleanOrNull("flush_queue")
                        ?: json.booleanOrNull("flushQueue")
                        ?: false,
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
                        ?: json.optString("message", "Live channel error"),
                ),
            )
        }
    }

    private fun JSONObject.stringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) optString(key).takeIf(String::isNotEmpty) else null

    private fun JSONObject.intOrNull(key: String): Int? =
        if (has(key) && !isNull(key)) optInt(key) else null

    private fun JSONObject.booleanOrNull(key: String): Boolean? =
        if (has(key) && !isNull(key)) optBoolean(key) else null

    companion object {
        const val DEFAULT_WS_URL: String = "ws://127.0.0.1:8787/ws/live"
        private const val TAG = "WebSocketAgentChannel"
        private const val DEFAULT_AUDIO_FORMAT = "pcm16"
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
