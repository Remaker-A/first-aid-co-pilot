package com.firstaid.copilot.live

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

/**
 * [AgentTransport] backed by the Node voice service over HTTP (OkHttp).
 *
 * - All network I/O runs on [ioDispatcher] (defaults to [Dispatchers.IO]).
 * - [baseUrl] defaults to the localhost endpoint that works on a real device
 *   after `adb reverse tcp:8787 tcp:8787`. For emulator-only work, pass
 *   `http://10.0.2.2:8787` or use the same reverse tunnel.
 * - Connectivity failures return [TurnResult.Failure]; they are never thrown.
 */
class HttpAgentTransport(
    private val baseUrl: String = DEFAULT_BASE_URL,
    private val client: OkHttpClient = defaultClient(),
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : AgentTransport {

    override suspend fun turn(request: TurnRequest): TurnResult = withContext(ioDispatcher) {
        val httpRequest = Request.Builder()
            .url(endpoint(PATH_TURN))
            .post(request.toJsonString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        try {
            client.newCall(httpRequest).execute().use { response ->
                val body = response.body?.string().orEmpty()
                when {
                    !response.isSuccessful ->
                        TurnResult.Failure(
                            TransportError(
                                kind = TransportErrorKind.HTTP,
                                message = "Agent returned HTTP ${response.code} for $PATH_TURN",
                                httpStatus = response.code,
                            ),
                        )

                    else -> runCatching { parseTurnResponse(JSONObject(body)) }.fold(
                        onSuccess = { TurnResult.Success(it) },
                        onFailure = {
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
        } catch (timeout: SocketTimeoutException) {
            TurnResult.Failure(
                TransportError(TransportErrorKind.TIMEOUT, timeout.message ?: "Timed out contacting the agent server"),
            )
        } catch (io: IOException) {
            TurnResult.Failure(
                TransportError(TransportErrorKind.NETWORK, io.message ?: "Could not reach the agent server"),
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
            try {
                client.newCall(request).execute().close()
            } catch (io: IOException) {
                // Reset is best-effort; a transient connectivity failure must not crash the caller.
            }
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
        } catch (io: IOException) {
            false
        }
    }

    private fun endpoint(path: String): String = baseUrl.trimEnd('/') + path

    companion object {
        const val DEFAULT_BASE_URL: String = "http://127.0.0.1:8787"
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
