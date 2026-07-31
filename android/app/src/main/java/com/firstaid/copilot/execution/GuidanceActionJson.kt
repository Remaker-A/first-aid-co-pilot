package com.firstaid.copilot.execution

import org.json.JSONArray
import org.json.JSONObject

fun JSONObject.toGuidanceAction(): GuidanceAction =
    GuidanceAction(
        schema_version = optStringValue("schema_version", GUIDANCE_ACTION_SCHEMA_VERSION),
        action_id = optStringValue("action_id", "android_missing_action_id"),
        session_id = optNullableString("session_id"),
        timestamp = optStringValue("timestamp", ""),
        stage = optStringValue("stage", ""),
        intent = optStringValue("intent", "unknown"),
        priority = optStringValue("priority", Priority.NORMAL.value),
        source = optStringValue("source", "unknown"),
        reason_codes = optStringList("reason_codes"),
        ttl_ms = optNullableLong("ttl_ms") ?: 5000L,
        throttle_key = optNullableString("throttle_key"),
        min_interval_ms = optNullableLong("min_interval_ms") ?: 0L,
        tts = optJSONObject("tts")?.toTtsPayload() ?: TtsPayload(),
        ui = optJSONObject("ui")?.toUiPayload() ?: UiPayload(),
        haptic = optJSONObject("haptic")?.toHapticPayload() ?: HapticPayload(),
        visual_overlay = optJSONObject("visual_overlay")?.toAnyMap(),
        tool_actions = optJSONArray("tool_actions")?.toToolActions() ?: emptyList(),
        log_event = optJSONObject("log_event")?.toAnyMap(),
    )

fun JSONObject.toAnyMap(): Map<String, Any?> {
    val output = linkedMapOf<String, Any?>()
    keys().forEach { key ->
        output[key] = jsonValueToAny(opt(key))
    }
    return output
}

private fun JSONObject.toTtsPayload(): TtsPayload =
    TtsPayload(
        text = optStringValue("text", ""),
        tone = optStringValue("tone", "calm_firm"),
        speed = optStringValue("speed", "normal"),
        interrupt_policy = optStringValue("interrupt_policy", "do_not_interrupt_critical"),
    )

private fun JSONObject.toUiPayload(): UiPayload =
    UiPayload(
        main_text = optStringValue("main_text", ""),
        secondary_text = optStringValue("secondary_text", ""),
        status_tags = optStringList("status_tags"),
        quality_score = optNullableInt("quality_score"),
        primary_button = optJSONObject("primary_button")?.toAnyMap(),
    )

private fun JSONObject.toHapticPayload(): HapticPayload =
    HapticPayload(
        enabled = optBoolean("enabled", false),
        pattern = optNullableString("pattern"),
        bpm = optNullableInt("bpm"),
    )

private fun JSONArray.toToolActions(): List<ToolAction> =
    List(length()) { index -> optJSONObject(index) }
        .filterNotNull()
        .map { it.toToolAction() }

private fun JSONObject.toToolAction(): ToolAction {
    val knownKeys = setOf(
        "type",
        "requires_user_confirmation",
        "confirmed",
        "user_confirmed",
        "confirmed_by_user",
        "confirmation",
        "bpm",
        "payload",
    )
    val inlinePayload = toAnyMap().filterKeys { it !in knownKeys }
    val declaredPayload = optJSONObject("payload")?.toAnyMap().orEmpty()

    return ToolAction(
        type = optStringValue("type", "unknown_tool"),
        requires_user_confirmation = optBoolean("requires_user_confirmation", false),
        confirmed = optBoolean("confirmed", false),
        user_confirmed = optBoolean("user_confirmed", false),
        confirmed_by_user = optBoolean("confirmed_by_user", false),
        confirmation = optJSONObject("confirmation")?.toAnyMap().orEmpty(),
        bpm = optNullableInt("bpm"),
        payload = declaredPayload + inlinePayload,
    )
}

private fun JSONObject.optStringList(key: String): List<String> {
    val array = optJSONArray(key) ?: return emptyList()
    return List(array.length()) { index -> array.optString(index) }
        .filter { it.isNotBlank() }
}

private fun JSONObject.optStringValue(key: String, fallback: String): String =
    if (has(key) && !isNull(key)) optString(key, fallback) else fallback

private fun JSONObject.optNullableString(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotBlank() } else null

private fun JSONObject.optNullableInt(key: String): Int? =
    if (has(key) && !isNull(key)) {
        when (val value = opt(key)) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        }
    } else {
        null
    }

private fun JSONObject.optNullableLong(key: String): Long? =
    if (has(key) && !isNull(key)) {
        when (val value = opt(key)) {
            is Number -> value.toLong()
            is String -> value.toLongOrNull()
            else -> null
        }
    } else {
        null
    }

private fun jsonValueToAny(value: Any?): Any? =
    when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> value.toAnyMap()
        is JSONArray -> List(value.length()) { index -> jsonValueToAny(value.opt(index)) }
        else -> value
    }
