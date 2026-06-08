package com.example.cpr_new.agent.copilot

import org.json.JSONObject

data class TurnResponse(
    val ok: Boolean,
    val sessionId: String?,
    val transcript: String,
    val currentStage: String?,
    val guidanceAction: CopilotGuidanceAction?,
    val guidanceSource: String?,
    val ttsText: String,
    val ttsAudioUrl: String?,
    val ttsAudioDataUrl: String?,
    val error: String?,
) {
    val ttsAudioSrc: String?
        get() = ttsAudioUrl ?: ttsAudioDataUrl
}

fun parseTurnResponse(json: JSONObject): TurnResponse {
    val state = json.optJSONObject("state")
    val ttsAudio = json.optJSONObject("tts")?.optJSONObject("audio")
    val guidanceAction = parseGuidanceActionField(json.optJSONObject("guidance_action"))
        ?: parseGuidanceActionField(json.optJSONObject("state_action"))

    val ttsText = guidanceAction?.tts?.text?.takeIf { it.isNotBlank() } ?: ""

    return TurnResponse(
        ok = json.optBoolean("ok", false),
        sessionId = json.stringOrNull("session_id"),
        transcript = json.optString("transcript", ""),
        currentStage = state?.stringOrNull("current_stage"),
        guidanceAction = guidanceAction,
        guidanceSource = json.stringOrNull("guidance_source"),
        ttsText = ttsText,
        ttsAudioUrl = ttsAudio?.stringOrNull("url"),
        ttsAudioDataUrl = ttsAudio?.stringOrNull("data_url"),
        error = json.optJSONObject("error")?.stringOrNull("message"),
    )
}

private fun parseGuidanceActionField(json: JSONObject?): CopilotGuidanceAction? =
    json
        ?.takeIf { it.has("action_id") }
        ?.let { runCatching { parseCopilotAction(it) }.getOrNull() }

private fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null
