package com.firstaid.copilot.live

import com.firstaid.copilot.execution.GuidanceAction
import com.firstaid.copilot.execution.parseAction
import org.json.JSONObject

/**
 * Parsed view of a successful `/api/turn` HTTP response.
 *
 * Only the fields the Android client needs are surfaced; the [guidanceAction] is
 * the existing validated [GuidanceAction] model (parsed with the same org.json
 * approach as `GuidanceFixtureRepository`), never a fork.
 *
 * Contract source: `src/voice/service.js` (handleTurn response object).
 */
data class TurnResponse(
    val ok: Boolean,
    val sessionId: String?,
    val transcript: String,
    val currentStage: String?,
    val guidanceAction: GuidanceAction?,
    val eventSource: String?,
    val eventMode: String?,
    val responseType: String?,
    val guidanceSource: String?,
    val ttsText: String,
    val ttsAudioUrl: String?,
    val ttsAudioDataUrl: String?,
    val timings: Map<String, Long>,
    val error: String?,
) {
    /** Preferred playable audio source: a runtime URL if present, else a data URL. */
    val ttsAudioSrc: String?
        get() = ttsAudioUrl ?: ttsAudioDataUrl
}

/**
 * Parse a `/api/turn` JSON body into a [TurnResponse].
 *
 * Defensive by design: a missing or malformed `guidance_action` yields a null
 * [TurnResponse.guidanceAction] instead of throwing, so a partial response never
 * crashes the turn loop.
 */
fun parseTurnResponse(json: JSONObject): TurnResponse {
    val state = json.optJSONObject("state")
    val event = json.optJSONObject("event")
    val ttsAudio = json.optJSONObject("tts")?.optJSONObject("audio")

    val guidanceAction = json.optJSONObject("guidance_action")
        ?.takeIf { it.has("action_id") }
        ?.let { runCatching { parseAction(it) }.getOrNull() }

    val ttsText = guidanceAction?.tts?.text?.takeIf(String::isNotBlank)
        ?: json.optJSONObject("state_action")?.optJSONObject("tts")?.stringOrNull("text")
        ?: ""

    return TurnResponse(
        ok = json.optBoolean("ok", false),
        sessionId = json.stringOrNull("session_id"),
        transcript = json.optString("transcript", ""),
        currentStage = state?.stringOrNull("current_stage"),
        guidanceAction = guidanceAction,
        eventSource = event?.stringOrNull("source"),
        eventMode = event?.stringOrNull("mode"),
        responseType = json.stringOrNull("response_type"),
        guidanceSource = json.stringOrNull("guidance_source"),
        ttsText = ttsText,
        ttsAudioUrl = ttsAudio?.stringOrNull("url"),
        ttsAudioDataUrl = ttsAudio?.stringOrNull("data_url"),
        timings = json.optJSONObject("timings").toLongMap(),
        error = json.optJSONObject("error")?.stringOrNull("message"),
    )
}

private fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf(String::isNotEmpty) else null

private fun JSONObject?.toLongMap(): Map<String, Long> {
    if (this == null) return emptyMap()
    val out = LinkedHashMap<String, Long>()
    keys().forEach { key ->
        if (!isNull(key)) {
            out[key] = optLong(key)
        }
    }
    return out
}
