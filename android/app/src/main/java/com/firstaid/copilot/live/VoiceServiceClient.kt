package com.firstaid.copilot.live

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

class VoiceServiceClient(
    endpoint: String = DEFAULT_VOICE_ENDPOINT,
) {
    var endpoint: String = endpoint.trimEnd('/')
        private set

    fun setEndpoint(value: String) {
        endpoint = value.trim().trimEnd('/').ifBlank { DEFAULT_VOICE_ENDPOINT }
    }

    suspend fun health(): Boolean = withContext(Dispatchers.IO) {
        val raw = request("GET", "/api/health", null)
        JSONObject(raw).optBoolean("ok", false)
    }

    suspend fun turn(
        sessionId: String,
        text: String?,
        audio: AudioTurn?,
        presetPayload: Map<String, Any?>,
    ): VoiceTurnResponse = withContext(Dispatchers.IO) {
        val body = GuidanceActionJson.payloadToJson(sessionId, text, audio, presetPayload)
        GuidanceActionJson.parseTurnResponse(request("POST", "/api/turn", body))
    }

    suspend fun reset(sessionId: String): Boolean = withContext(Dispatchers.IO) {
        val body = JSONObject().put("sessionId", sessionId).toString()
        JSONObject(request("POST", "/api/reset", body)).optBoolean("ok", false)
    }

    private fun request(method: String, path: String, body: String?): String {
        val connection = (URL("$endpoint$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 4000
            readTimeout = 65000
            setRequestProperty("accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json; charset=utf-8")
            }
        }

        try {
            if (body != null) {
                OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(body)
                }
            }
            val stream = if (connection.responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream ?: connection.inputStream
            }
            val raw = BufferedReader(stream.reader(Charsets.UTF_8)).use { it.readText() }
            if (connection.responseCode !in 200..299) {
                error("HTTP ${connection.responseCode}: $raw")
            }
            return raw
        } finally {
            connection.disconnect()
        }
    }
}
