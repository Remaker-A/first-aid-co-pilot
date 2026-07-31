package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.HapticPayload
import com.firstaid.copilot.execution.ToolAction
import com.firstaid.copilot.execution.TtsPayload
import com.firstaid.copilot.execution.UiPayload
import org.json.JSONArray
import org.json.JSONObject

object GuidanceActionJson {
    fun parseTurnResponse(raw: String): VoiceTurnResponse {
        val root = JSONObject(raw)
        val guidanceAction = root.optObject("guidance_action")?.let(::parseGuidanceAction)
        val stateAction = root.optObject("state_action")?.let(::parseGuidanceAction)
        return VoiceTurnResponse(
            ok = root.optBoolean("ok", false),
            sessionId = root.optStringOrNull("session_id") ?: root.optStringOrNull("sessionId"),
            transcript = root.optStringOrNull("transcript").orEmpty(),
            state = root.optObject("state")?.toMap().orEmpty(),
            event = root.optObject("event")?.toMap().orEmpty(),
            guidanceAction = guidanceAction,
            stateAction = stateAction,
            responseType = root.optStringOrNull("response_type").orEmpty(),
            guidanceSource = root.optStringOrNull("guidance_source").orEmpty(),
            timings = parseTimings(root.optObject("timings")),
            raw = raw,
        )
    }

    fun parseGuidanceAction(json: JSONObject): GuidanceAction =
        GuidanceAction(
            schema_version = json.optStringOrNull("schema_version") ?: "guidance_action.v0.1",
            action_id = json.optStringOrNull("action_id") ?: "missing_action_id",
            session_id = json.optStringOrNull("session_id"),
            timestamp = json.optStringOrNull("timestamp").orEmpty(),
            stage = json.optStringOrNull("stage").orEmpty(),
            intent = json.optStringOrNull("intent").orEmpty(),
            priority = json.optStringOrNull("priority") ?: "normal",
            source = json.optStringOrNull("source") ?: "unknown",
            reason_codes = json.optArray("reason_codes").toStringList(),
            ttl_ms = json.optLong("ttl_ms", 5000L),
            throttle_key = json.optStringOrNull("throttle_key"),
            min_interval_ms = json.optLong("min_interval_ms", 0L),
            tts = parseTts(json.optObject("tts")),
            ui = parseUi(json.optObject("ui")),
            haptic = parseHaptic(json.optObject("haptic")),
            visual_overlay = json.optObject("visual_overlay")?.toMap(),
            tool_actions = json.optArray("tool_actions").toToolActions(),
            log_event = json.optObject("log_event")?.toMap(),
        )

    fun payloadToJson(
        sessionId: String,
        text: String?,
        audio: AudioTurn?,
        presetPayload: Map<String, Any?>,
    ): String {
        val json = JSONObject()
        json.put("sessionId", sessionId)
        if (!text.isNullOrBlank()) {
            json.put("text", text)
        }
        if (audio != null) {
            json.put("audioBase64", audio.base64)
            json.put("mimeType", audio.mimeType)
        }
        for ((key, value) in presetPayload) {
            json.put(key, value.toJsonValue())
        }
        return json.toString()
    }

    private fun parseTts(json: JSONObject?): TtsPayload {
        if (json == null) return TtsPayload()
        return TtsPayload(
            text = json.optStringOrNull("text").orEmpty(),
            tone = json.optStringOrNull("tone") ?: "calm_firm",
            speed = json.optStringOrNull("speed") ?: "normal",
            interrupt_policy = json.optStringOrNull("interrupt_policy") ?: "do_not_interrupt_critical",
        )
    }

    private fun parseUi(json: JSONObject?): UiPayload {
        if (json == null) return UiPayload()
        return UiPayload(
            main_text = json.optStringOrNull("main_text").orEmpty(),
            secondary_text = json.optStringOrNull("secondary_text").orEmpty(),
            status_tags = json.optArray("status_tags").toStringList(),
            quality_score = json.optNumber("quality_score")?.let(::normalizeScore),
            primary_button = json.optObject("primary_button")?.toMap(),
        )
    }

    private fun parseHaptic(json: JSONObject?): HapticPayload {
        if (json == null) return HapticPayload()
        return HapticPayload(
            enabled = json.optBoolean("enabled", false),
            pattern = json.optStringOrNull("pattern"),
            bpm = json.optNumber("bpm")?.toInt(),
        )
    }

    private fun JSONArray?.toToolActions(): List<ToolAction> {
        if (this == null) return emptyList()
        return buildList {
            for (index in 0 until length()) {
                val json = optJSONObject(index) ?: continue
                add(
                    ToolAction(
                        type = json.optStringOrNull("type").orEmpty(),
                        requires_user_confirmation = json.optBoolean("requires_user_confirmation", false),
                        confirmed = json.optBoolean("confirmed", false),
                        user_confirmed = json.optBoolean("user_confirmed", false),
                        confirmed_by_user = json.optBoolean("confirmed_by_user", false),
                        confirmation = json.optObject("confirmation")?.toMap().orEmpty(),
                        bpm = json.optNumber("bpm")?.toInt(),
                        payload = json.optObject("payload")?.toMap().orEmpty(),
                    )
                )
            }
        }
    }

    private fun parseTimings(json: JSONObject?): TurnTimings {
        if (json == null) return TurnTimings()
        return TurnTimings(
            totalMs = json.optNumber("total_ms")?.toInt(),
            sttMs = json.optNumber("stt_ms")?.toInt(),
            ttsMs = json.optNumber("tts_ms")?.toInt(),
            gemmaMs = json.optNumber("gemma_ms")?.toInt(),
        )
    }
}

fun JSONObject.toMap(): Map<String, Any?> = buildMap {
    val iterator = keys()
    while (iterator.hasNext()) {
        val key = iterator.next()
        put(key, opt(key).fromJsonValue())
    }
}

private fun JSONArray.toListValue(): List<Any?> = buildList {
    for (index in 0 until length()) {
        add(opt(index).fromJsonValue())
    }
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optString(index, "").takeIf { it.isNotBlank() }?.let(::add)
        }
    }
}

private fun Any?.fromJsonValue(): Any? = when (this) {
    null, JSONObject.NULL -> null
    is JSONObject -> toMap()
    is JSONArray -> toListValue()
    else -> this
}

private fun Any?.toJsonValue(): Any = when (this) {
    null -> JSONObject.NULL
    is Map<*, *> -> JSONObject().also { json ->
        for ((key, value) in this) {
            json.put(key.toString(), value.toJsonValue())
        }
    }
    is List<*> -> JSONArray().also { array ->
        for (value in this) {
            array.put(value.toJsonValue())
        }
    }
    else -> this
}

private fun JSONObject.optObject(name: String): JSONObject? =
    if (has(name) && !isNull(name)) optJSONObject(name) else null

private fun JSONObject.optArray(name: String): JSONArray? =
    if (has(name) && !isNull(name)) optJSONArray(name) else null

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) optString(name) else null

private fun JSONObject.optNumber(name: String): Number? {
    if (!has(name) || isNull(name)) return null
    return when (val value = opt(name)) {
        is Number -> value
        is String -> value.toDoubleOrNull()
        else -> null
    }
}

fun normalizeScore(number: Number): Int {
    val value = number.toDouble()
    val normalized = if (value in 0.0..1.0) value * 100.0 else value
    return normalized.toInt().coerceIn(0, 100)
}
