package com.example.cpr_new.agent.copilot

import org.json.JSONArray
import org.json.JSONObject

fun parseCopilotAction(json: JSONObject): CopilotGuidanceAction =
    CopilotGuidanceAction(
        schemaVersion = json.optString("schema_version", GUIDANCE_ACTION_SCHEMA_VERSION),
        actionId = json.getString("action_id"),
        sessionId = json.optNullableString("session_id"),
        timestamp = json.getString("timestamp"),
        stage = json.getString("stage"),
        intent = json.getString("intent"),
        priority = json.optString("priority", CopilotPriority.NORMAL),
        source = json.optString("source", "unknown"),
        reasonCodes = json.optStringList("reason_codes"),
        ttlMs = json.optLong("ttl_ms", 5000),
        throttleKey = json.optNullableString("throttle_key"),
        minIntervalMs = json.optLong("min_interval_ms", 0),
        tts = parseTts(json.optJSONObject("tts")),
        ui = parseUi(json.optJSONObject("ui")),
        haptic = parseHaptic(json.optJSONObject("haptic")),
        visualOverlay = json.optJSONObject("visual_overlay")?.toMap(),
        toolActions = json.optJSONArray("tool_actions").orEmptyJsonObjects().map(::parseToolAction),
        logEvent = json.optJSONObject("log_event")?.toMap(),
        callBrief = json.optJSONObject("call_brief")?.toMap(),
    )

private fun parseTts(json: JSONObject?): CopilotTtsPayload =
    CopilotTtsPayload(
        text = json?.optString("text", "") ?: "",
        tone = json?.optString("tone", "calm_firm") ?: "calm_firm",
        speed = json?.optString("speed", "normal") ?: "normal",
        interruptPolicy = json?.optString("interrupt_policy", "do_not_interrupt_critical")
            ?: "do_not_interrupt_critical",
    )

private fun parseUi(json: JSONObject?): CopilotUiPayload =
    CopilotUiPayload(
        mainText = json?.optString("main_text", "") ?: "",
        secondaryText = json?.optString("secondary_text", "") ?: "",
        statusTags = json?.optStringList("status_tags") ?: emptyList(),
        qualityScore = json?.optNullableInt("quality_score"),
        primaryButton = json?.optJSONObject("primary_button")?.toMap(),
    )

private fun parseHaptic(json: JSONObject?): CopilotHapticPayload =
    CopilotHapticPayload(
        enabled = json?.optBoolean("enabled", false) ?: false,
        pattern = json?.optNullableString("pattern"),
        bpm = json?.optNullableInt("bpm"),
    )

private fun parseToolAction(json: JSONObject): CopilotToolAction =
    CopilotToolAction(
        type = json.getString("type"),
        requiresUserConfirmation = json.optBoolean("requires_user_confirmation", false),
        confirmed = json.optBoolean("confirmed", false) ||
            json.optBoolean("user_confirmed", false) ||
            json.optBoolean("confirmed_by_user", false),
        bpm = json.optNullableInt("bpm"),
        payload = json.optJSONObject("payload")?.toMap() ?: emptyMap(),
    )

private fun JSONObject.optNullableString(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null

private fun JSONObject.optNullableInt(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null

private fun JSONObject.optStringList(key: String): List<String> =
    optJSONArray(key).orEmptyList().mapNotNull { it as? String }

private fun JSONArray?.orEmptyJsonObjects(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { index -> optJSONObject(index) }
}

private fun JSONArray?.orEmptyList(): List<Any?> {
    if (this == null) return emptyList()
    return (0 until length()).map { index -> normalizeJsonValue(get(index)) }
}

private fun JSONObject.toMap(): Map<String, Any?> =
    keys().asSequence().associateWith { key -> normalizeJsonValue(get(key)) }

private fun normalizeJsonValue(value: Any?): Any? =
    when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> value.toMap()
        is JSONArray -> value.orEmptyList()
        else -> value
    }
