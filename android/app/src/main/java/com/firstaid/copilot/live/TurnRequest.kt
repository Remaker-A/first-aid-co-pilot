package com.firstaid.copilot.live

import org.json.JSONArray
import org.json.JSONObject

/**
 * Request body for the agent `/api/turn` endpoint.
 *
 * Field names mirror the camelCase keys accepted by the Node voice service
 * (`src/voice/service.js` `createVoiceEvent`), which is also what the browser
 * demo posts. Only non-null fields are serialized.
 *
 * The injection fields ([patientState], [cprQuality], [rescuerState],
 * [deviceState], [metadata], [toolResult]) are raw maps so the later demo /
 * perception phases can forward `PerceptionEvent` payloads verbatim without this
 * foundation phase having to model every variant.
 */
data class TurnRequest(
    val sessionId: String,
    val text: String? = null,
    val audioBase64: String? = null,
    val mimeType: String? = null,
    val eventSource: String? = null,
    val eventType: String? = null,
    val patientState: Map<String, Any?>? = null,
    val cprQuality: Map<String, Any?>? = null,
    val rescuerState: Map<String, Any?>? = null,
    val deviceState: Map<String, Any?>? = null,
    val metadata: Map<String, Any?>? = null,
    val toolResult: Map<String, Any?>? = null,
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
        json.put("sessionId", sessionId)
        text?.let { json.put("text", it) }
        audioBase64?.let { json.put("audioBase64", it) }
        mimeType?.let { json.put("mimeType", it) }
        eventSource?.let { json.put("eventSource", it) }
        eventType?.let { json.put("eventType", it) }
        patientState?.let { json.put("patientState", mapToJson(it)) }
        cprQuality?.let { json.put("cprQuality", mapToJson(it)) }
        rescuerState?.let { json.put("rescuerState", mapToJson(it)) }
        deviceState?.let { json.put("deviceState", mapToJson(it)) }
        metadata?.let { json.put("metadata", mapToJson(it)) }
        toolResult?.let { json.put("toolResult", mapToJson(it)) }
        return json
    }

    fun toJsonString(): String = toJson().toString()
}

private fun mapToJson(map: Map<*, *>): JSONObject {
    val json = JSONObject()
    for ((key, value) in map) {
        json.put(key.toString(), anyToJson(value))
    }
    return json
}

private fun anyToJson(value: Any?): Any =
    when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> mapToJson(value)
        is Iterable<*> -> JSONArray().apply { value.forEach { put(anyToJson(it)) } }
        is Array<*> -> JSONArray().apply { value.forEach { put(anyToJson(it)) } }
        else -> value
    }
