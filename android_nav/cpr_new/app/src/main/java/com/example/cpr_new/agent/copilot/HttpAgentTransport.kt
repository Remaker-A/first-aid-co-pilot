package com.example.cpr_new.agent.copilot

import android.util.Log
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class HttpAgentTransport(
    private val baseUrl: String,
    private val client: OkHttpClient = defaultClient(),
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : AgentTransport {

    override suspend fun turn(request: TurnRequest): TurnResult = withContext(ioDispatcher) {
        val jsonBody = request.toJsonString()
        Log.d("HttpTransport", "→ POST $PATH_TURN body=${jsonBody.take(500)}")

        val httpRequest = Request.Builder()
            .url(endpoint(PATH_TURN))
            .post(jsonBody.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(httpRequest).execute().use { response ->
                val body = response.body?.string().orEmpty()
                Log.d("HttpTransport", "← HTTP ${response.code} body=${body.take(500)}")
                when {
                    !response.isSuccessful ->
                        TurnResult.Failure(
                            TransportError(
                                kind = TransportErrorKind.HTTP,
                                message = "Agent returned HTTP ${response.code}",
                                httpStatus = response.code,
                            ),
                        )

                    else -> runCatching { parseTurnResponse(JSONObject(body)) }.fold(
                        onSuccess = { TurnResult.Success(it) },
                        onFailure = {
                            Log.e("HttpTransport", "Parse error: ${it.message}", it)
                            TurnResult.Failure(
                                TransportError(
                                    kind = TransportErrorKind.PARSE,
                                    message = it.message ?: "Could not parse /api/turn response",
                                ),
                            )
                        },
                    )
                }
            }
        } catch (_: SocketTimeoutException) {
            TurnResult.Failure(
                TransportError(TransportErrorKind.TIMEOUT, "连接 Agent 超时"),
            )
        } catch (io: IOException) {
            Log.e("HttpTransport", "Network error: ${io.message}", io)
            TurnResult.Failure(
                TransportError(TransportErrorKind.NETWORK, io.message ?: "无法连接 Agent 服务"),
            )
        }
    }

    override suspend fun reset(sessionId: String) {
        withContext(ioDispatcher) {
            val body = JSONObject().put("sessionId", sessionId).toString().toRequestBody(JSON_MEDIA_TYPE)
            val request = Request.Builder()
                .url(endpoint(PATH_RESET))
                .post(body)
                .build()
            runCatching { client.newCall(request).execute().close() }
        }
    }

    override suspend fun health(): Boolean = withContext(ioDispatcher) {
        val request = Request.Builder()
            .url(endpoint(PATH_HEALTH))
            .get()
            .build()
        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    false
                } else {
                    val body = response.body?.string().orEmpty()
                    runCatching { JSONObject(body).optBoolean("ok", false) }.getOrDefault(false)
                }
            }
        } catch (_: IOException) {
            false
        }
    }

    private fun endpoint(path: String): String = baseUrl.trimEnd('/') + path

    companion object {
        private const val PATH_TURN = "/api/turn"
        private const val PATH_RESET = "/api/reset"
        private const val PATH_HEALTH = "/api/health"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private fun defaultClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()
    }
}
